// The online table: rules, bots and dealing, run on the server so no browser ever holds
// another player's cards or the deck. This file is plain game logic over a small storage
// interface; src/online/edge.ts wires it to Supabase as an Edge Function.
//
// A table is saved as the state between hands (a checkpoint) plus the actions of the hand
// in play. Loading it replays those actions, which keeps every rule in the engine instead
// of copying it here, and keeps saves small because the list resets each hand.
//
// The server also credits achievements for online play: every finished hand and tournament
// adds to each person's counters in player_awards, which browsers can read but not write.
import { PERSONA_NAMES, personaFor } from '../bots/persona';
import type { TurnNotice } from './push';
import { cleanAvatar } from '../accounts/avatars';
import { Counters, Tally, combine, handTally, mergeTally, runAfter, titleFor, tournamentTally } from '../accounts/achievements';
import { Bot } from '../bots/bot';
import { buildView } from '../bots/view';
import { Card, Seed, createRng, secureSeed, shuffle, subSeed } from '../engine/cards';
import { Action, Hand, rigProblem } from '../engine/hand';
import { dealtAsSeen } from '../engine/history';
import { BotStyle, CLASSIC_DIFFICULTIES, DIFFICULTIES, Difficulty, hasMaster, PlayerStats, Seat, SeatConfig, Table, TableConfig, emptyStats } from '../engine/table';
import { VARIANTS, VariantId } from '../engine/variants';
import { BjCredits, BjError, BjState, bjAdmin, bjAdminInfo, bjAutoStep, bjBack, bjDeadline, bjFreeSpot, bjMove, bjRebuy, bjResume, bjStart, bjTickAt, bjTurn, bjView, checkBjSettings } from './blackjack';
import { ChatError, ChatState, chatAdmin, chatAdminInfo, chatSay, chatView, findMember } from './chat';
import { AdminCommand, AdminReply, AdminTableInfo, AdminTableSummary, BlindSpeed, HandView, PlayerTag, Request, SeatView, TURN_SECONDS, TableSettings, TableView } from './protocol';

export const BIG_BLIND = 20;
export const HANDS_PER_LEVEL: Record<BlindSpeed, number> = { slow: 15, normal: 10, turbo: 6 };
/** Shortest gap between two bot moves, so people can follow the action. */
export const BOT_GAP_MS = 700;
/** Pause after a hand before the next deal, to read the result. */
export const DEAL_DELAY_MS = 4500;
export const TURN_MS = TURN_SECONDS * 1000;
/** Clock run-outs in a row before a bot takes over the seat. */
const TIMEOUTS_TO_AWAY = 2;
/** Most people watching one table at once. */
export const WATCHERS_MAX = 12;
const NAME_MAX = 14;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BOT_NAMES = PERSONA_NAMES;
const STYLES: BotStyle[] = ['balanced', 'balanced', 'tight', 'loose', 'aggressive', 'passive'];

export interface Member {
  userId: string;
  name: string;
  seat: string | null;
  left: boolean;
  /** The player (profile) in the person's account that online achievements go to. */
  playerId?: string;
  /** Their title, checked against their achievements when they sat down. */
  title?: string | null;
  /** Their face (accounts/avatars.ts), checked for shape when they sat down. */
  avatar?: string | null;
  /** Hands won in a row at this table. */
  run?: number;
  /** Watching without a seat: sees only what the whole table sees. Joining sits them in. */
  watching?: boolean;
}

/** Everything a table needs between hands, in plain data. */
export interface Checkpoint {
  seats: Seat[];
  stats: Record<string, PlayerStats>;
  button: number;
  handNumber: number;
  level: number;
  rng: Seed;
}

export interface TableState {
  phase: 'lobby' | 'playing' | 'over';
  host: string;
  settings: TableSettings;
  members: Member[];
  config: TableConfig | null;
  checkpoint: Checkpoint | null;
  /** The hand in play: dealt, then each action and console change exactly as applied. */
  events: TableEvent[];
  away: Record<string, boolean>;
  timeouts: Record<string, number>;
  pendingRebuys: string[];
  /** People who joined a cash game in progress, seated in place of a bot at the next deal. */
  pendingSits: { userId: string; seat: string }[];
  turnStartedAt: number;
  handEndedAt: number | null;
  lastStepAt: number;
  /** Seats a bot moved for in the hand in play (the person was away), which earn no achievements. */
  autoplayed?: string[];
  /** Developer console: nothing moves on its own while paused. */
  paused?: boolean;
  /** Developer console: cards to deal next hand, by seat id. */
  nextRig?: { hole: Record<string, Card[]>; board: Card[] } | null;
  /** A blackjack table (src/online/blackjack.ts); the poker fields above stay empty. */
  bj?: BjState;
  /** Table chat (src/online/chat.ts). */
  chat?: ChatState;
  /** Whose turn it was at the last save ("hand.events" or "round.spot"), to notice a new one. */
  turnKey?: string;
  /** When each person was last sent a "your turn" notification, epoch ms. */
  pinged?: Record<string, number>;
}

/** The people playing (or about to): everyone at the table who isn't just watching. */
const players = (state: TableState): Member[] => state.members.filter((m) => !m.left && !m.watching);

/** The poker table in play, or null in the lobby and at blackjack. */
export const tableOf = (state: TableState): Table | null => (state.phase === 'lobby' || state.bj ? null : rebuild(state));

/** Changes an admin makes during a hand, replayed with the hand like any action. */
export type AdminEdit =
  | { t: 'stack'; seat: string; n: number }
  | { t: 'bot'; seat: string; d: Difficulty; s: BotStyle }
  | { t: 'level'; n: number };

export type TableEvent =
  | { t: 'deal'; rig?: { hole: Record<string, Card[]>; board: Card[] } | null }
  | { t: 'act'; a: Action }
  | { t: 'board'; cards: Card[] }
  | AdminEdit;

export interface TableRow {
  id: string;
  code: string;
  version: number;
  state: TableState;
}

export interface StoredView {
  userId: string;
  version: number;
  view: TableView;
}

/** Achievement progress to add to one player's online record. */
export interface AwardCredit {
  userId: string;
  playerId: string;
  tally: Tally;
}

/** A player's achievement counters: what this server credited, and what their own saved profile says. */
export interface AwardCounters {
  server: Counters;
  profile: Counters;
}

/** Where tables are kept. The real one is Postgres through Supabase's REST API. */
export interface TableDb {
  byId(id: string): Promise<TableRow | null>;
  byCode(code: string): Promise<TableRow | null>;
  /** Null when the code is already taken. */
  insert(code: string, state: TableState): Promise<TableRow | null>;
  /** Saves only if nobody else saved since `version` was read; the row's version becomes version + 1. */
  update(id: string, version: number, state: TableState): Promise<boolean>;
  remove(id: string): Promise<void>;
  /** Each person's view; an older version never replaces a newer one. */
  putViews(tableId: string, views: StoredView[]): Promise<void>;
  dropView(tableId: string, userId: string): Promise<void>;
  /** Clears out tables nobody has touched since `before`. */
  sweep(before: Date): Promise<void>;
  /** A player's achievement counters, to check the title they want to wear. */
  awards(userId: string, playerId: string): Promise<AwardCounters>;
  /** Adds to players' online achievement records. */
  creditAwards(credits: AwardCredit[]): Promise<void>;
  /** Whether this account is in the admins table (supabase/admin.sql). False if that isn't set up. */
  isAdmin(userId: string): Promise<boolean>;
  /** The most recently used tables, newest first. */
  recent(limit: number): Promise<(TableRow & { updatedAt: string })[]>;
  /** Records a developer console change in admin_log. Never throws. */
  logAdmin(userId: string, action: string, detail: Record<string, unknown>): Promise<void>;
}

export class TableError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface Outcome {
  status: number;
  body: unknown;
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const cleanName = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) || 'Player';
const cleanPlayerId = (s: unknown): string | undefined => (typeof s === 'string' && /^[\w-]{1,80}$/.test(s) ? s : undefined);

// ---------- achievements ----------

/** The title a person may wear: only one their achievements have earned. */
async function checkTitle(db: TableDb, userId: string, tag: PlayerTag): Promise<{ playerId?: string; title: string | null; avatar: string | null }> {
  const playerId = cleanPlayerId(tag.playerId);
  const avatar = cleanAvatar(tag.avatar);
  if (!playerId || typeof tag.title !== 'string') return { playerId, title: null, avatar };
  try {
    const a = await db.awards(userId, playerId);
    return { playerId, title: titleFor(tag.title, combine(a.profile, a.server)), avatar };
  } catch {
    return { playerId, title: null, avatar };
  }
}

function addCredit(credits: AwardCredit[] | undefined, m: Member | undefined, tally: Tally) {
  if (!credits || !m?.playerId) return;
  const prev = credits.find((c) => c.userId === m.userId && c.playerId === m.playerId);
  if (prev) prev.tally = mergeTally(prev.tally, tally);
  else credits.push({ userId: m.userId, playerId: m.playerId, tally });
}

/** Seats played by a person who was at the table themselves (not a bot covering while they were away). */
const memberAt = (state: TableState, seatId: string): Member | undefined =>
  state.away[seatId] || state.autoplayed?.includes(seatId) ? undefined : state.members.find((m) => m.seat === seatId && !m.left);

/** Achievements from a finished hand, and from any tournament places it decided. */
function creditHand(state: TableState, t: Table, credits: AwardCredit[] | undefined) {
  const hand = t.hand;
  // A hand an admin rigged from the developer console proves nothing.
  if (!credits || !hand?.isComplete || hand.wasRigged) return;
  const people = hand.players.map((_, i) => memberAt(state, t.handSeats[i]));
  const friends = people.flatMap((m, i) => (m ? [i] : []));
  people.forEach((m, i) => {
    if (!m) return;
    m.run = runAfter(m.run ?? 0, hand, i);
    addCredit(credits, m, mergeTally(handTally(hand, i, { online: true, friends }), { sum: {}, max: { bestRun: m.run } }));
  });
  if (!t.isTournament) return;
  const humans = t.seats.filter((s) => s.isHuman).length;
  const bots = t.seats.filter((s) => !s.isHuman).map((s) => s.difficulty);
  for (const id of t.handSeats) {
    const seat = t.seats.find((s) => s.id === id)!;
    const m = memberAt(state, id);
    if (seat.place && m) addCredit(credits, m, tournamentTally({ format: t.config.format, place: seat.place, cashed: false, bots, online: true, friends: humans - 1 }));
  }
}

/** A game with at least two people in it has started: count it for each of them, and for the host. */
function creditGameStart(state: TableState, people: Member[], credits: AwardCredit[] | undefined) {
  if (people.length < 2) return;
  for (const m of people) addCredit(credits, m, { sum: { 'online.games': 1, ...(m.userId === state.host ? { 'online.hosted': 1 } : {}) }, max: {} });
}

// ---------- settings ----------

export function checkSettings(raw: unknown): TableSettings {
  const s = (raw ?? {}) as Partial<TableSettings>;
  if (s.game === 'blackjack') {
    // The poker fields keep their defaults so nothing that reads them trips.
    return { variant: 'holdem', structure: 'NL', format: 'cash', difficulty: 'medium', stackBB: 100, blindSpeed: 'normal', ...checkBjSettings(s) };
  }
  const v = VARIANTS[s.variant as VariantId];
  if (!v) throw new TableError('Pick a game for the table.');
  const format = s.format === 'sng' || s.format === 'headsup' ? s.format : 'cash';
  const structure = s.structure && v.structures.includes(s.structure) ? s.structure : v.defaultStructure;
  let difficulty = s.difficulty === 'mixed' || DIFFICULTIES.includes(s.difficulty as Difficulty) ? s.difficulty! : 'medium';
  if (difficulty === 'master' && !hasMaster(v.id, structure)) difficulty = 'expert';
  const stackBB = [50, 100, 200].includes(Number(s.stackBB)) ? Number(s.stackBB) : 100;
  const blindSpeed = s.blindSpeed === 'slow' || s.blindSpeed === 'turbo' ? s.blindSpeed : 'normal';
  const seats = format === 'headsup' ? 2 : Math.max(2, Math.min(v.maxPlayers, Math.round(Number(s.seats) || 6)));
  return { variant: v.id, structure, format, difficulty, stackBB, blindSpeed, seats };
}

function checkAction(raw: unknown): Action {
  const a = (raw ?? {}) as { type?: unknown; to?: unknown; discard?: unknown };
  switch (a.type) {
    case 'fold':
    case 'check':
    case 'call':
    case 'bringin':
      return { type: a.type };
    case 'raise': {
      const to = Number(a.to);
      if (!Number.isFinite(to)) throw new TableError('That bet size is not a number.');
      return { type: 'raise', to };
    }
    case 'draw':
      return { type: 'draw', discard: Array.isArray(a.discard) ? a.discard.map(Number).filter((n) => Number.isInteger(n)) : [] };
    default:
      throw new TableError('Unknown move.');
  }
}

export function newCode(rand: () => number = Math.random): string {
  return Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)]).join('');
}

// ---------- the table in play ----------

function snapshot(t: Table): Checkpoint {
  return { seats: clone(t.seats), stats: clone(t.stats), button: t.button, handNumber: t.handNumber, level: t.level, rng: t.rng.state };
}

/** Rebuilds the Table from its checkpoint and replays the hand in play. */
export function rebuild(state: TableState): Table {
  const t = new Table(state.config!);
  const cp = state.checkpoint!;
  t.seats.forEach((s, i) => Object.assign(s, clone(cp.seats[i])));
  for (const id of Object.keys(t.stats)) t.stats[id] = clone(cp.stats[id] ?? emptyStats());
  t.button = cp.button;
  t.handNumber = cp.handNumber;
  t.level = cp.level;
  t.rng.state = cp.rng;
  for (const e of state.events) {
    if (e.t === 'deal') {
      t.nextRig = e.rig ?? null;
      t.nextHand();
    } else if (e.t === 'act') t.hand!.act(e.a);
    else if (e.t === 'board') t.hand!.setBoard(e.cards);
    else applyEdit(t, e);
  }
  if (t.hand?.isComplete) t.finishHand();
  return t;
}

/** Blackjack credits go into the same list as poker's. */
const bjCredits = (credits: AwardCredit[] | undefined): BjCredits => (m, tally) => addCredit(credits, m, tally);

function startGame(state: TableState, now: number, seed: Seed, credits?: AwardCredit[]) {
  const s = state.settings;
  if (s.game === 'blackjack') {
    const people = players(state).slice(0, s.seats);
    seatOthersAsWatchers(state, people);
    bjStart(state, people, now, seed);
    creditGameStart(state, people, credits);
    return;
  }
  const rng = createRng(subSeed(seed, 0x5bd1e995));
  const people = players(state).slice(0, s.seats);
  const taken = new Set(people.map((m) => m.name.toLowerCase()));
  const names = shuffle(BOT_NAMES.filter((n) => !taken.has(n.toLowerCase())), rng);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng.next() * xs.length)];
  const seats: SeatConfig[] = people.map((m) => ({ name: m.name, isHuman: true }));
  while (seats.length < Math.max(2, s.seats)) {
    const name = names[seats.length % names.length];
    // Each regular plays their own style.
    seats.push({ name, isHuman: false, difficulty: s.difficulty === 'mixed' ? pick(CLASSIC_DIFFICULTIES) : s.difficulty, style: personaFor(name)?.style ?? pick(STYLES) });
  }
  // People sit in a random order around the table.
  const order = shuffle(seats.map((_, i) => i), rng);
  const config: TableConfig = {
    variant: s.variant,
    structure: s.structure,
    format: s.format,
    startingStack: s.stackBB * BIG_BLIND,
    bigBlind: BIG_BLIND,
    handsPerLevel: HANDS_PER_LEVEL[s.blindSpeed],
    seats: order.map((i) => seats[i]),
    seed,
  };
  people.forEach((m, i) => (m.seat = `p${order.indexOf(i)}`));
  seatOthersAsWatchers(state, people);
  state.config = config;
  state.phase = 'playing';
  const t = new Table(config);
  state.checkpoint = snapshot(t);
  state.events = [];
  creditGameStart(state, people, credits);
  dealNext(state, t, now, credits);
}

/** Anyone over the seat limit watches instead. */
function seatOthersAsWatchers(state: TableState, people: Member[]) {
  for (const m of state.members) {
    if (people.includes(m)) continue;
    m.seat = null;
    if (!m.left) m.watching = true;
  }
}

/** Settles the last hand and deals the next one. False when there aren't two players with chips. */
function dealNext(state: TableState, t: Table, now: number, credits?: AwardCredit[]): boolean {
  t.finishHand();
  for (const id of state.pendingRebuys) {
    const seat = t.seats.find((s) => s.id === id);
    if (seat && seat.busted) t.rebuy(id);
  }
  state.pendingRebuys = [];
  for (const sit of state.pendingSits) {
    const seat = t.seats.find((s) => s.id === sit.seat);
    const m = state.members.find((x) => x.userId === sit.userId);
    if (!seat || seat.isHuman || !m || m.left) continue;
    Object.assign(seat, { name: m.name, isHuman: true, difficulty: undefined, style: undefined, stack: t.config.startingStack, busted: false, rebuys: 0 });
    t.stats[seat.id] = emptyStats();
    m.seat = seat.id;
    if (state.members.filter((x) => x.seat && !x.left).length >= 2) addCredit(credits, m, { sum: { 'online.games': 1 }, max: {} });
  }
  state.pendingSits = [];
  if (t.isOver) {
    state.phase = 'over';
    return true;
  }
  if (t.liveSeats.length < 2) return false;
  state.checkpoint = snapshot(t);
  const rig = state.nextRig ?? null;
  state.nextRig = null;
  state.events = [rig ? { t: 'deal', rig } : { t: 'deal' }];
  state.autoplayed = [];
  t.nextRig = rig;
  t.nextHand();
  state.turnStartedAt = now;
  state.handEndedAt = null;
  state.lastStepAt = now;
  return true;
}

function apply(state: TableState, t: Table, action: Action, now: number, credits?: AwardCredit[]) {
  const hand = t.hand!;
  const a = hand.normalize(action);
  try {
    hand.act(a);
  } catch (err) {
    throw new TableError((err as Error).message);
  }
  state.events.push({ t: 'act', a });
  state.lastStepAt = now;
  state.turnStartedAt = now;
  if (hand.isComplete) {
    state.handEndedAt = now;
    t.finishHand();
    creditHand(state, t, credits);
    if (t.isOver) state.phase = 'over';
  }
}

const botFor = (seat: Seat, away: boolean): Bot => new Bot(away || !seat.difficulty ? 'medium' : seat.difficulty, seat.style ?? 'balanced');

/** A move nobody is waiting on a person for: a bot's turn, a run-out clock, or the next deal. */
export function autoStep(state: TableState, t: Table, now: number, credits?: AwardCredit[]): boolean {
  if (state.phase !== 'playing' || state.paused) return false;
  const hand = t.hand;
  if (!hand || hand.isComplete) {
    if (hand && now < (state.handEndedAt ?? 0) + DEAL_DELAY_MS) return false;
    const before = JSON.stringify([state.pendingRebuys, state.pendingSits, state.phase]);
    return dealNext(state, t, now, credits) || before !== JSON.stringify([state.pendingRebuys, state.pendingSits, state.phase]);
  }
  const seat = t.seatOf(hand.toAct);
  if (!seat.isHuman || state.away[seat.id]) {
    if (now < state.lastStepAt + BOT_GAP_MS) return false;
    if (seat.isHuman && !state.autoplayed?.includes(seat.id)) (state.autoplayed ??= []).push(seat.id);
    apply(state, t, botFor(seat, !!state.away[seat.id]).decide(buildView(hand, hand.toAct, t.stats)), now, credits);
    return true;
  }
  if (now < state.turnStartedAt + TURN_MS) return false;
  const L = hand.legal();
  const auto: Action = L.kind === 'draw' ? { type: 'draw', discard: [] } : L.kind === 'bet' && L.check ? { type: 'check' } : L.kind === 'bet' && L.bringIn ? { type: 'bringin' } : { type: 'fold' };
  state.timeouts[seat.id] = (state.timeouts[seat.id] ?? 0) + 1;
  if (state.timeouts[seat.id] >= TIMEOUTS_TO_AWAY) state.away[seat.id] = true;
  apply(state, t, auto, now, credits);
  return true;
}

// ---------- what each person sees ----------

function handView(hand: Hand, me: number): HandView {
  return {
    variant: hand.variant.id,
    structure: hand.structure,
    stakes: hand.stakes,
    street: hand.street,
    numStreets: hand.numStreets,
    phase: hand.phase,
    toAct: hand.isComplete ? -1 : hand.toAct,
    button: hand.button,
    board: [...hand.board],
    pot: hand.pot,
    currentBet: hand.currentBet,
    players: hand.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      startStack: p.startStack,
      stack: p.stack,
      cards: p.cards.map((c, k) => (i === me || p.shown || p.faceUp[k] ? c : null)),
      faceUp: [...p.faceUp],
      dealt: dealtAsSeen(p, i === me),
      status: p.status,
      streetBet: p.streetBet,
      totalBet: p.totalBet,
      lastAction: p.lastAction,
      drew: p.drew,
      shown: p.shown,
    })),
    log: hand.log.map((e) => ({ ...e })),
    actions: hand.actions.map((a) => ({ ...a })),
    result: hand.result ? clone(hand.result) : null,
  };
}

/** When the server will next accept a tick, or null if it is waiting on a person. */
function tickAt(state: TableState, t: Table | null, stalled: boolean): number | null {
  if (state.phase !== 'playing' || !t || stalled || state.paused) return null;
  const hand = t.hand;
  if (!hand || hand.isComplete) return (state.handEndedAt ?? 0) + DEAL_DELAY_MS;
  const seat = t.seatOf(hand.toAct);
  if (!seat.isHuman || state.away[seat.id]) return state.lastStepAt + BOT_GAP_MS;
  return state.turnStartedAt + TURN_MS;
}

export function viewFor(row: { id: string; code: string; version: number }, state: TableState, t: Table | null, userId: string, now: number): TableView {
  const me = state.members.find((m) => m.userId === userId);
  // A watcher has no seat, so everything below shows them only what the whole table sees.
  const mySeat = me?.watching ? null : me?.seat ?? null;
  const hand = t?.hand ?? null;
  const hi = hand && mySeat ? t!.handIndexOf(mySeat) : -1;
  const myTurn = !!hand && !hand.isComplete && hi >= 0 && hand.toAct === hi && !state.away[mySeat!];
  const humanTurn = !!hand && !hand.isComplete && t!.seatOf(hand.toAct).isHuman && !state.away[t!.seatOf(hand.toAct).id];
  const stalled = state.phase === 'playing' && !!t && (!hand || hand.isComplete) && t.liveSeats.length < 2 && !state.pendingRebuys.length && !state.pendingSits.length;
  const seats: SeatView[] = (t?.seats ?? []).map((s) => ({
    id: s.id, name: s.name, title: s.isHuman ? state.members.find((m) => m.seat === s.id)?.title ?? null : null,
    avatar: s.isHuman ? cleanAvatar(state.members.find((m) => m.seat === s.id)?.avatar) : null, isHuman: s.isHuman, difficulty: s.isHuman ? undefined : s.difficulty, style: s.isHuman ? undefined : s.style,
    stack: s.stack, busted: s.busted, place: s.place, rebuys: s.rebuys, away: !!state.away[s.id], you: s.id === mySeat,
  }));
  return {
    version: row.version,
    tableId: row.id,
    code: row.code,
    phase: state.phase,
    settings: state.settings,
    members: state.members.map((m) => ({ name: m.name, title: m.title ?? null, avatar: cleanAvatar(m.avatar), host: m.userId === state.host, you: m.userId === userId, seat: m.seat, left: m.left, watching: !!m.watching })),
    isHost: state.host === userId,
    seats,
    mySeat,
    waitingForSeat: state.pendingSits.some((p) => p.userId === userId),
    watching: !!me?.watching,
    canSit: !!me?.watching && !noSeat(state, t),
    handNumber: t?.handNumber ?? 0,
    level: t?.level ?? 0,
    handsUntilNextLevel: t && t.isTournament ? t.handsUntilNextLevel() : null,
    hand: hand ? handView(hand, hi) : null,
    legal: myTurn ? hand!.legal() : null,
    stats: t ? clone(t.stats) : {},
    serverNow: now,
    turnDeadline: humanTurn && !state.paused ? state.turnStartedAt + TURN_MS : null,
    nextDealAt: hand?.isComplete && state.phase === 'playing' && !state.paused ? (state.handEndedAt ?? now) + DEAL_DELAY_MS : null,
    tickAt: tickAt(state, t, stalled),
    rebuyPending: !!mySeat && state.pendingRebuys.includes(mySeat),
    stalled,
    paused: !!state.paused,
    ...chatView(state, userId),
    ...(state.bj ? { bj: bjView(state, userId), tickAt: bjTickAt(state), turnDeadline: bjDeadline(state) } : {}),
  };
}

// ---------- requests ----------

export interface ServerOptions {
  now?: () => number;
  /** Table seeds. Tests pass numbers to get the same cards every run; live tables use secureSeed(). */
  seed?: () => Seed;
  /** Called after a save that made it someone's turn (src/online/push.ts sends the notification). Must not throw. */
  notify?: (n: TurnNotice) => void;
}

/** The least time between two "your turn" notifications to one person at one table. */
export const PING_GAP_MS = 45_000;

/** The person the table is waiting on, if it is waiting on a person, and a key that changes each turn. */
function turnHolder(state: TableState, t: Table | null): { userId: string; key: string } | null {
  if (state.phase !== 'playing' || state.paused) return null;
  let seatId: string | null;
  let key: string;
  if (state.bj) {
    const turn = bjTurn(state);
    if (!turn) return null;
    seatId = turn.spot;
    key = `b${turn.round}.${turn.spot}`;
  } else {
    const hand = t?.hand;
    if (!t || !hand || hand.isComplete) return null;
    const seat = t.seatOf(hand.toAct);
    if (!seat.isHuman) return null;
    seatId = seat.id;
    key = `p${t.handNumber}.${state.events.length}`;
  }
  if (state.away[seatId]) return null;
  const m = state.members.find((x) => x.seat === seatId && !x.left && !x.watching);
  return m ? { userId: m.userId, key } : null;
}

/**
 * Notes whose turn it is before a save, and returns a notification to send once it's saved: when
 * the turn has just come round to someone other than the person who made this request, and they
 * weren't told in the last PING_GAP_MS. A person who doesn't come back times out and goes "away"
 * after two turns, which stops the notifications.
 */
function turnPing(state: TableState, t: Table | null, requester: string, at: number): TurnNotice | null {
  const holder = turnHolder(state, t);
  const before = state.turnKey;
  state.turnKey = holder?.key;
  if (!holder || holder.key === before || holder.userId === requester) return null;
  const pinged = (state.pinged ??= {});
  if (at - (pinged[holder.userId] ?? 0) < PING_GAP_MS) return null;
  pinged[holder.userId] = at;
  return { userId: holder.userId, code: '', settings: state.settings };
}

/** Handles one request from a signed-in person. */
export async function handle(db: TableDb, userId: string, raw: unknown, opts: ServerOptions = {}): Promise<Outcome> {
  const now = opts.now ?? Date.now;
  const seed = opts.seed ?? secureSeed;
  try {
    const req = (raw ?? {}) as Request;
    if (req.op === 'create') return await create(db, userId, req, now(), seed);
    if (req.op === 'join') return await join(db, userId, req, now());
    if (req.op === 'watch') return await watch(db, userId, req, now());
    if (req.op === 'admin' || req.op === 'tables') {
      if (!(await db.isAdmin(userId))) throw new TableError('Only admin accounts can do that.', 403);
      return req.op === 'tables' ? await listTables(db) : await adminChange(db, userId, req, now);
    }
    if (!['leave', 'start', 'act', 'bj', 'tick', 'rebuy', 'back', 'chat'].includes(req.op)) throw new TableError('Unknown request.');
    return await change(db, userId, req, now, seed, opts.notify);
  } catch (err) {
    if (err instanceof TableError || err instanceof ChatError) return { status: err.status, body: { ok: false, error: err.message } };
    throw err;
  }
}

async function publish(db: TableDb, row: TableRow, state: TableState, t: Table | null, now: number, userId: string, credits: AwardCredit[] = []): Promise<Outcome> {
  // Achievements first, so a browser that sees the finished hand finds them already counted.
  // They never hold up the game: if they can't be saved, the table carries on.
  if (credits.length) await db.creditAwards(credits).catch(() => undefined);
  const views = state.members.filter((m) => !m.left).map((m) => ({ userId: m.userId, version: row.version, view: viewFor(row, state, t, m.userId, now) }));
  await db.putViews(row.id, views);
  return { status: 200, body: { ok: true, tableId: row.id, code: row.code, view: viewFor(row, state, t, userId, now) } };
}

async function create(db: TableDb, userId: string, req: Extract<Request, { op: 'create' }>, now: number, seed: () => Seed): Promise<Outcome> {
  const settings = checkSettings(req.settings);
  const tag = await checkTitle(db, userId, req);
  const state: TableState = {
    phase: 'lobby', host: userId, settings, members: [{ userId, name: cleanName(req.name), seat: null, left: false, ...tag }],
    config: null, checkpoint: null, events: [], away: {}, timeouts: {}, pendingRebuys: [], pendingSits: [], turnStartedAt: now, handEndedAt: null, lastStepAt: now,
  };
  await db.sweep(new Date(now - 3 * 24 * 3600 * 1000)).catch(() => undefined);
  const rng = createRng(seed());
  for (let i = 0; i < 8; i++) {
    const row = await db.insert(newCode(() => rng.next()), state);
    if (row) return publish(db, row, state, null, now, userId);
  }
  throw new TableError('Could not make a table code. Try again.', 503);
}

const findCode = (code: unknown) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A bot's seat nobody has claimed yet, for someone joining a cash game in progress. */
const freeSeat = (state: TableState, t: Table): Seat | undefined => t.seats.find((s) => !s.isHuman && !state.pendingSits.some((p) => p.seat === s.id));

/** Why someone new (or a watcher) can't sit down now, or null if they can. */
function noSeat(state: TableState, t: Table | null): string | null {
  if (state.phase === 'over') return 'That table has finished its game.';
  if (state.phase === 'lobby') return players(state).length >= state.settings.seats ? 'That table is full.' : null;
  if (state.bj) return bjFreeSpot(state) ? null : 'That table is full.';
  if (t!.isTournament) return 'That tournament has already started.';
  return freeSeat(state, t!) ? null : 'That table is full.';
}

/** Gives a person a place at the table: in the waiting room, or a seat at the next deal. */
function sitDown(state: TableState, t: Table | null, userId: string) {
  const why = noSeat(state, t);
  if (why) throw new TableError(why, 409);
  if (state.phase === 'playing') state.pendingSits.push({ userId, seat: state.bj ? bjFreeSpot(state)! : freeSeat(state, t!)!.id });
}

async function join(db: TableDb, userId: string, req: Extract<Request, { op: 'join' }>, now: number): Promise<Outcome> {
  const code = findCode(req.code);
  const tag = await checkTitle(db, userId, req);
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await db.byCode(code);
    if (!row) throw new TableError(`No table has the code ${code || '(blank)'}. Check it with whoever made the table.`, 404);
    const state = row.state;
    const name = cleanName(req.name);
    const t = tableOf(state);
    let m = state.members.find((x) => x.userId === userId);
    if (m) {
      // A watcher sitting in takes a seat like anyone new.
      if (m.watching) {
        sitDown(state, t, userId);
        m.watching = false;
      }
      m.left = false;
      m.title = tag.title;
      m.avatar = tag.avatar;
      if (state.phase === 'lobby' || !m.seat) {
        m.name = name;
        m.playerId = tag.playerId;
      }
      if (m.seat) {
        delete state.away[m.seat];
        delete state.timeouts[m.seat];
      }
    } else {
      sitDown(state, t, userId);
      m = { userId, name, seat: null, left: false, ...tag };
      state.members.push(m);
    }
    if (!(await db.update(row.id, row.version, state))) continue;
    return publish(db, { ...row, version: row.version + 1 }, state, t, now, userId);
  }
  throw new TableError('The table is busy. Try again.', 503);
}

/** Watching a table: no seat and no cards but the ones everybody sees. Works at any point in the game. */
async function watch(db: TableDb, userId: string, req: Extract<Request, { op: 'watch' }>, now: number): Promise<Outcome> {
  const code = findCode(req.code);
  const tag = await checkTitle(db, userId, req);
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await db.byCode(code);
    if (!row) throw new TableError(`No table has the code ${code || '(blank)'}. Check it with whoever made the table.`, 404);
    const state = row.state;
    const t = tableOf(state);
    let m = state.members.find((x) => x.userId === userId);
    // Already here (watching or playing): nothing changes.
    if (m && !m.left) return { status: 200, body: { ok: true, tableId: row.id, code: row.code, view: viewFor(row, state, t, userId, now) } };
    if (m) {
      // Someone back after leaving keeps their seat, if they had one; a bot plays it until they say they're back.
      m.left = false;
      m.title = tag.title;
      m.avatar = tag.avatar;
      if (!m.seat) m.watching = true;
    } else {
      if (state.members.filter((x) => x.watching && !x.left).length >= WATCHERS_MAX) throw new TableError('That table has as many people watching as it can take.', 409);
      m = { userId, name: cleanName(req.name), seat: null, left: false, watching: true, ...tag };
      state.members.push(m);
    }
    if (!(await db.update(row.id, row.version, state))) continue;
    return publish(db, { ...row, version: row.version + 1 }, state, t, now, userId);
  }
  throw new TableError('The table is busy. Try again.', 503);
}

async function change(db: TableDb, userId: string, req: Exclude<Request, { op: 'create' | 'join' | 'watch' | 'admin' | 'tables' }>, now: () => number, seed: () => Seed, notify?: (n: TurnNotice) => void): Promise<Outcome> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await db.byId(String(req.tableId ?? ''));
    if (!row) throw new TableError('That table is gone.', 404);
    const state = row.state;
    const m = state.members.find((x) => x.userId === userId);
    if (!m) throw new TableError("You aren't at that table.", 403);
    const at = now();
    let t = tableOf(state);
    const credits: AwardCredit[] = [];
    const unchanged = () => ({ status: 200, body: { ok: true, tableId: row.id, code: row.code, view: viewFor(row, state, t, userId, at) } });

    switch (req.op) {
      case 'tick':
        if (req.version !== row.version) return unchanged();
        if (state.bj ? !bjAutoStep(state, at, bjCredits(credits)) : !t || !autoStep(state, t, at, credits)) return unchanged();
        break;
      case 'start':
        if (state.host !== userId) throw new TableError('Only the host can start the game.', 403);
        if (state.phase !== 'lobby') return unchanged();
        startGame(state, at, seed(), credits);
        t = tableOf(state);
        break;
      case 'bj':
        if (!state.bj || state.phase !== 'playing') throw new TableError("This isn't a blackjack table in play.", 409);
        try {
          bjMove(state, m, req, at, bjCredits(credits));
        } catch (err) {
          if (err instanceof BjError) throw new TableError(err.message, 409);
          throw err;
        }
        break;
      case 'act': {
        if (state.paused) throw new TableError('The table is paused. Wait for it to carry on.', 409);
        const hand = t?.hand;
        if (!t || !hand || hand.isComplete || !m.seat || req.hand !== t.handNumber || t.handSeats[hand.toAct] !== m.seat) throw new TableError("It isn't your turn.", 409);
        delete state.away[m.seat];
        state.timeouts[m.seat] = 0;
        apply(state, t, checkAction(req.action), at, credits);
        break;
      }
      case 'rebuy': {
        if (state.bj) {
          try {
            bjRebuy(state, m);
          } catch (err) {
            if (err instanceof BjError) throw new TableError(err.message);
            throw err;
          }
          break;
        }
        const seat = t?.seats.find((s) => s.id === m.seat);
        if (!t || !seat || t.isTournament || !seat.busted) throw new TableError('You can only buy back in after going broke in a cash game.');
        if (!state.pendingRebuys.includes(seat.id)) state.pendingRebuys.push(seat.id);
        break;
      }
      case 'back':
        if (!m.seat || !state.away[m.seat]) return unchanged();
        delete state.away[m.seat];
        state.timeouts[m.seat] = 0;
        if (t?.hand && !t.hand.isComplete && t.handSeats[t.hand.toAct] === m.seat) state.turnStartedAt = at;
        if (state.bj) bjBack(state, m, at);
        break;
      case 'chat':
        chatSay(state, m, req, at);
        break;
      case 'leave': {
        if (state.phase === 'lobby') {
          state.members = state.members.filter((x) => x !== m);
          // A waiting room with only watchers left has nobody to start the game.
          if (!players(state).length) {
            await db.remove(row.id);
            return { status: 200, body: { ok: true, tableId: row.id, code: row.code, view: null } };
          }
          if (state.host === userId) state.host = players(state)[0].userId;
        } else {
          m.left = true;
          if (m.seat) state.away[m.seat] = true;
          state.pendingSits = state.pendingSits.filter((p) => p.userId !== userId);
          if (state.host === userId) state.host = players(state)[0]?.userId ?? state.host;
        }
        break;
      }
    }

    const ping = turnPing(state, t, userId, at);
    if (!(await db.update(row.id, row.version, state))) {
      if (req.op === 'tick') {
        const fresh = await db.byId(row.id);
        if (fresh) return { status: 200, body: { ok: true, tableId: fresh.id, code: fresh.code, view: viewFor(fresh, fresh.state, tableOf(fresh.state), userId, at) } };
      }
      continue;
    }
    const saved = { ...row, version: row.version + 1 };
    const out = await publish(db, saved, state, t, at, userId, credits);
    if (req.op === 'leave') await db.dropView(row.id, userId);
    if (ping && notify) notify({ ...ping, code: row.code });
    return out;
  }
  throw new TableError('The table is busy. Try again.', 503);
}

// ---------- developer console ----------

/** Applies an admin change to the table (live, or while replaying the hand). */
function applyEdit(t: Table, e: AdminEdit) {
  if (e.t === 'level') {
    t.level = Math.max(0, e.n);
    return;
  }
  const seat = t.seats.find((x) => x.id === e.seat);
  if (!seat) return;
  if (e.t === 'bot') {
    seat.difficulty = e.d;
    seat.style = e.s;
    return;
  }
  // A finished hand is settled first, so its result doesn't overwrite the new stack.
  if (t.hand?.isComplete) t.finishHand();
  const hi = t.handIndexOf(seat.id);
  if (t.hand && !t.hand.isComplete && hi >= 0) t.hand.players[hi].stack = e.n;
  seat.stack = e.n;
  if (e.n > 0 && seat.busted) {
    seat.busted = false;
    seat.place = undefined;
  }
}

function findSeat(t: Table, ref: unknown): Seat {
  const r = String(ref ?? '').trim().toLowerCase();
  const byId = t.seats.find((s) => s.id === r);
  if (byId) return byId;
  if (/^\d+$/.test(r) && t.seats[Number(r)]) return t.seats[Number(r)];
  const hits = t.seats.filter((s) => s.name.toLowerCase().startsWith(r));
  if (r && hits.length === 1) return hits[0];
  throw new TableError(hits.length > 1 ? `"${ref}" matches ${hits.map((s) => s.name).join(', ')}.` : `No seat called "${ref}".`);
}

function checkCards(raw: unknown): Card[] {
  if (!Array.isArray(raw)) throw new TableError('List the cards.');
  return raw.map((c) => {
    const n = Number(c);
    if (!Number.isInteger(n) || n < 0 || n > 51) throw new TableError('That is not a card.');
    return n;
  });
}

export function adminInfo(row: { id: string; code: string; version: number }, state: TableState, t: Table | null): AdminTableInfo {
  const hand = t?.hand ?? null;
  return {
    tableId: row.id,
    code: row.code,
    version: row.version,
    phase: state.phase,
    paused: !!state.paused,
    settings: state.settings,
    members: state.members.map((m) => ({ name: m.name, userId: m.userId, seat: m.seat, host: m.userId === state.host, left: m.left, away: !!(m.seat && state.away[m.seat]), watching: !!m.watching })),
    handNumber: t?.handNumber ?? 0,
    level: t?.level ?? 0,
    seats: (t?.seats ?? []).map((s) => ({ id: s.id, name: s.name, isHuman: s.isHuman, difficulty: s.difficulty, style: s.style, stack: s.stack, busted: s.busted })),
    hand: hand && t
      ? {
        street: hand.street,
        numStreets: hand.numStreets,
        phase: hand.phase,
        complete: hand.isComplete,
        pot: hand.pot,
        toAct: hand.isComplete || hand.toAct < 0 ? null : t.handSeats[hand.toAct],
        board: [...hand.board],
        players: hand.players.map((p, i) => ({ seat: t.handSeats[i], cards: [...p.cards], status: p.status, stack: p.stack, totalBet: p.totalBet })),
        upcoming: hand.upcoming(16),
        rigBoard: hand.rigged.board,
        coming: hand.coming().map((c) => ({ ...c, players: c.players.map((x) => ({ seat: t.handSeats[x.player], card: x.card })) })),
      }
      : null,
    nextRig: state.nextRig ? clone(state.nextRig) : null,
    bj: bjAdminInfo(state),
    ...chatAdminInfo(state),
  };
}

async function listTables(db: TableDb): Promise<Outcome> {
  const rows = await db.recent(50);
  const tables: AdminTableSummary[] = rows.map((r) => ({
    tableId: r.id,
    code: r.code,
    phase: r.state.phase,
    game: r.state.settings.game === 'blackjack' ? 'Blackjack' : `${r.state.settings.structure} ${VARIANTS[r.state.settings.variant]?.name ?? r.state.settings.variant}`,
    people: r.state.members.filter((m) => !m.left).map((m) => m.name),
    handNumber: r.state.bj?.roundNumber ?? r.state.checkpoint?.handNumber ?? 0,
    paused: !!r.state.paused,
    updatedAt: r.updatedAt,
  }));
  const body: AdminReply = { ok: true, message: `${tables.length} table${tables.length === 1 ? '' : 's'}.`, table: null, tables };
  return { status: 200, body };
}

const DIFFS = new Set<string>(DIFFICULTIES);
const STYLE_SET = new Set<string>(['balanced', 'tight', 'loose', 'aggressive', 'passive']);

async function adminChange(db: TableDb, userId: string, req: Extract<Request, { op: 'admin' }>, now: () => number): Promise<Outcome> {
  const cmd = (req.command ?? {}) as AdminCommand;
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = req.tableId ? await db.byId(String(req.tableId)) : await db.byCode(findCode(req.code));
    if (!row) throw new TableError('No table with that code.', 404);
    const state = row.state;
    const at = now();
    const table = tableOf(state);
    const reply = (message: string, r: { id: string; code: string; version: number } = row, tb: Table | null = table): Outcome => {
      const body: AdminReply = { ok: true, message, table: adminInfo(r, state, tb) };
      return { status: 200, body };
    };
    if (cmd.do === 'inspect') return reply('');
    if (cmd.do === 'close') {
      await db.remove(row.id);
      await db.logAdmin(userId, 'close table', { code: row.code });
      const body: AdminReply = { ok: true, message: `Table ${row.code} closed.`, table: null };
      return { status: 200, body };
    }
    /** Saves the change and tells everyone at the table. Null when someone else saved first. */
    const commit = async (message: string, kicked: string | null = null): Promise<Outcome | null> => {
      if (!(await db.update(row.id, row.version, state))) return null;
      const saved = { ...row, version: row.version + 1 };
      await publish(db, saved, state, table, at, userId);
      if (kicked) await db.dropView(row.id, kicked);
      await db.logAdmin(userId, `table ${cmd.do}`, { code: row.code, ...(cmd as object) });
      return reply(message, saved);
    };
    // Chat can be looked after at any point, the waiting room included.
    if (cmd.do === 'mute' || cmd.do === 'unmute' || cmd.do === 'clearchat') {
      const out = await commit(chatAdmin(state, cmd, at));
      if (out) return out;
      continue;
    }
    if ((!table && !state.bj) || state.phase !== 'playing') throw new TableError(state.phase === 'lobby' ? "That table hasn't started yet." : 'That game is over.', 409);
    if (state.bj && !['pause', 'resume', 'kick'].includes(cmd.do)) {
      let message: string;
      try {
        message = bjAdmin(state, cmd, at, bjCredits(undefined));
      } catch (err) {
        if (err instanceof BjError) throw new TableError(err.message);
        throw err;
      }
      const out = await commit(message);
      if (out) return out;
      continue;
    }
    // A blackjack table only gets here for pause, resume and kick, which don't touch the poker table.
    const t = table as Table;
    const hand = t?.hand ?? null;
    const live = !!hand && !hand.isComplete;
    let message: string;
    let kicked: string | null = null;
    switch (cmd.do) {
      case 'rig': {
        const seat = findSeat(t, cmd.seat);
        const cards = checkCards(cmd.cards);
        if (!cards.length) throw new TableError('List the cards.');
        const rig = state.nextRig ?? { hole: {}, board: [] };
        const hole = { ...rig.hole, [seat.id]: cards };
        const problem = rigProblem({ hole: Object.fromEntries(Object.values(hole).map((c, i) => [i, c])), board: rig.board }, t.variant.shortDeck);
        if (problem) throw new TableError(problem);
        state.nextRig = { hole, board: rig.board };
        message = `${seat.name} gets those cards next hand.`;
        break;
      }
      case 'unrig':
        state.nextRig = null;
        message = 'Next hand deals from the shuffle.';
        break;
      case 'board': {
        const cards = checkCards(cmd.cards);
        if (t.variant.family !== 'flop') throw new TableError('Only community-card games have a board.');
        if (live) {
          try {
            hand!.setBoard(cards);
          } catch (err) {
            throw new TableError((err as Error).message);
          }
          state.events.push({ t: 'board', cards });
          message = cards.length ? 'Board fixed for the rest of this hand.' : 'Board back to the shuffle.';
        } else {
          const rig = state.nextRig ?? { hole: {}, board: [] };
          const problem = rigProblem({ hole: Object.fromEntries(Object.values(rig.hole).map((c, i) => [i, c])), board: cards }, t.variant.shortDeck);
          if (problem) throw new TableError(problem);
          state.nextRig = { ...rig, board: cards };
          message = cards.length ? "Next hand's board is fixed." : "Next hand's board back to the shuffle.";
        }
        break;
      }
      case 'stack': {
        const seat = findSeat(t, cmd.seat);
        const n = Math.max(0, Math.round(Number(cmd.amount)));
        if (!Number.isFinite(n)) throw new TableError('Give an amount.');
        const e: AdminEdit = { t: 'stack', seat: seat.id, n };
        applyEdit(t, e);
        state.events.push(e);
        message = `${seat.name} now has ${n} chips.`;
        break;
      }
      case 'bot': {
        const seat = findSeat(t, cmd.seat);
        if (seat.isHuman) throw new TableError(`${seat.name} is a person.`);
        const d = (cmd.difficulty && DIFFS.has(cmd.difficulty) ? cmd.difficulty : seat.difficulty ?? 'medium') as Difficulty;
        const st = (cmd.style && STYLE_SET.has(cmd.style) ? cmd.style : seat.style ?? 'balanced') as BotStyle;
        const e: AdminEdit = { t: 'bot', seat: seat.id, d, s: st };
        applyEdit(t, e);
        state.events.push(e);
        message = `${seat.name} plays ${d} ${st}.`;
        break;
      }
      case 'level': {
        const n = Math.floor(Number(cmd.level));
        if (!t.isTournament) throw new TableError('Cash games have one blind level.');
        if (!(n >= 1)) throw new TableError('Give a level number, like 5.');
        const e: AdminEdit = { t: 'level', n: n - 1 };
        applyEdit(t, e);
        state.events.push(e);
        message = `Blind level ${n} from the next hand.`;
        break;
      }
      case 'pause':
        state.paused = true;
        message = 'Table paused.';
        break;
      case 'resume':
        if (!state.paused) return reply('The table is already running.');
        state.paused = false;
        // Everyone gets a fresh clock.
        state.turnStartedAt = at;
        state.lastStepAt = at;
        if (state.handEndedAt !== null) state.handEndedAt = at;
        if (state.bj) bjResume(state, at);
        message = 'Table running again.';
        break;
      case 'step': {
        if (live) {
          const seat = t.seatOf(hand!.toAct);
          if (seat.isHuman && !state.away[seat.id]) throw new TableError(`It's ${seat.name}'s turn, and they're a person.`);
        }
        const paused = state.paused;
        state.paused = false;
        state.lastStepAt = 0;
        if (state.handEndedAt !== null) state.handEndedAt = 0;
        const moved = autoStep(state, t, at);
        state.paused = paused;
        if (!moved) throw new TableError('Nothing to do: the table needs two players with chips.');
        message = live ? 'One move made.' : 'Next hand dealt.';
        break;
      }
      case 'kick': {
        const m = findMember(state.members, cmd.member);
        kicked = m.userId;
        m.left = true;
        if (m.seat) state.away[m.seat] = true;
        state.pendingSits = state.pendingSits.filter((p) => p.userId !== m.userId);
        if (state.host === m.userId) state.host = players(state)[0]?.userId ?? state.host;
        message = `${m.name} is off the table; a bot plays their chips.`;
        break;
      }
      default:
        throw new TableError('Unknown console command.');
    }
    const out = await commit(message, kicked);
    if (out) return out;
  }
  throw new TableError('The table is busy. Try again.', 503);
}
