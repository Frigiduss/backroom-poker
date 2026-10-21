// Online blackjack: friends at one table, each playing their own hands against the dealer,
// with bots in any spots they leave open. Like the poker tables, everything runs on the
// server: the shoe and the dealer's hole card never leave it. Each round has a betting
// window, then the deal, then each spot in turn, then the dealer.
//
// The table is saved as plain data (the shoe's cards, the round in play) rather than
// replayed, because a shoe lasts many rounds.
import { PERSONA_NAMES } from '../bots/persona';
import { Tally, blackjackTally } from '../accounts/achievements';
import { BJ_DECKS, BJ_LIMITS, BjAction, BjLimits, Round, RoundData, RoundRig, Shoe, ShoeData, bookPlay } from '../engine/blackjack';
import { Card, createRng, shuffle } from '../engine/cards';
import type { AdminCommand, BjAdminInfo, BjMove, BjSpotView, BjTableView, TableSettings } from './protocol';
import type { Member, TableState } from './server';

/** How long betting stays open for people who haven't bet yet. */
export const BJ_BET_MS = 20_000;
/** Most spots at the table, people and bots together. */
export const BJ_SPOTS = 5;
/** Starting stack, in minimum bets. */
const STACK_UNITS = 100;
const GAP_MS = 700;
const RESULT_MS = 4500;
const TURN_MS = 30_000;
const TIMEOUTS_TO_AWAY = 2;
const BOT_NAMES = PERSONA_NAMES;

export class BjError extends Error {}

export interface BjSpot {
  id: string;
  name: string;
  isHuman: boolean;
  stack: number;
  rebuys: number;
  lastBet: number;
}

export interface BjState {
  spots: BjSpot[];
  shoe: ShoeData;
  /** The round in play, or the last one (kept on the table while bets go down). */
  round: RoundData | null;
  /** Spot ids of the round's seats, in order. */
  inRound: string[];
  phase: 'betting' | 'round';
  roundNumber: number;
  bets: Record<string, number>;
  sitOut: string[];
  bettingEndsAt: number;
  /** When the dealer settled the last round. */
  settledAt: number | null;
  /** Bots' random choices. */
  rng: number;
  /** Developer console: cards to deal next round. */
  nextRig?: RoundRig | null;
}

export const bjLimits = (s: TableSettings) => BJ_LIMITS[s.bjLimits ?? 'low'];
export const bjStartingStack = (s: TableSettings): number => bjLimits(s).min * STACK_UNITS;

export function checkBjSettings(s: Partial<TableSettings>): Pick<TableSettings, 'game' | 'bjLimits' | 'bots' | 'seats'> {
  const bjL = (s.bjLimits && s.bjLimits in BJ_LIMITS ? s.bjLimits : 'low') as BjLimits;
  const bots = Math.max(0, Math.min(BJ_SPOTS - 1, Math.round(Number(s.bots) || 0)));
  return { game: 'blackjack', bjLimits: bjL, bots, seats: BJ_SPOTS };
}

// ---------- starting, betting and dealing ----------

/** Seats the people (and the bots the host asked for) and opens betting on the first round. */
export function bjStart(state: TableState, people: Member[], now: number, seed: number) {
  const s = state.settings;
  const rng = createRng(seed ^ 0x2545f491);
  const taken = new Set(people.map((m) => m.name.toLowerCase()));
  const names = shuffle(BOT_NAMES.filter((n) => !taken.has(n.toLowerCase())), rng);
  const stack = bjStartingStack(s);
  const spots: BjSpot[] = people.map((m) => ({ id: '', name: m.name, isHuman: true, stack, rebuys: 0, lastBet: bjLimits(s).min * 2 }));
  for (let i = 0; i < (s.bots ?? 0) && spots.length < BJ_SPOTS; i++) spots.push({ id: '', name: names[i % names.length], isHuman: false, stack, rebuys: 0, lastBet: 0 });
  const order = shuffle(spots.map((_, i) => i), rng);
  const seated = order.map((i, k) => ({ ...spots[i], id: `p${k}` }));
  people.forEach((m, i) => (m.seat = `p${order.indexOf(i)}`));
  const shoe = new Shoe(BJ_DECKS, createRng(seed));
  state.bj = { spots: seated, shoe: shoe.save(), round: null, inRound: [], phase: 'betting', roundNumber: 0, bets: {}, sitOut: [], bettingEndsAt: now, settledAt: null, rng: rng.state };
  state.phase = 'playing';
  openBetting(state, now);
}

function openBetting(state: TableState, now: number) {
  const bj = state.bj!;
  const { min } = bjLimits(state.settings);
  const stack = bjStartingStack(state.settings);
  // People who joined since the last round take a bot's spot, or a free one.
  for (const sit of state.pendingSits) {
    const m = state.members.find((x) => x.userId === sit.userId);
    if (!m || m.left) continue;
    let spot = bj.spots.find((x) => x.id === sit.seat && !x.isHuman);
    if (!spot && bj.spots.length < BJ_SPOTS) {
      spot = { id: nextId(bj), name: '', isHuman: true, stack, rebuys: 0, lastBet: min * 2 };
      bj.spots.push(spot);
    }
    if (!spot) continue;
    Object.assign(spot, { name: m.name, isHuman: true, stack, rebuys: 0, lastBet: min * 2 });
    m.seat = spot.id;
  }
  state.pendingSits = [];
  for (const s of bj.spots) {
    if (!s.isHuman && s.stack < min) {
      s.stack = stack;
      s.rebuys++;
    }
  }
  bj.phase = 'betting';
  bj.bets = {};
  bj.sitOut = [];
  bj.bettingEndsAt = now + BJ_BET_MS;
  state.lastStepAt = now;
}

function nextId(bj: BjState): string {
  for (let k = 0; ; k++) if (!bj.spots.some((s) => s.id === `p${k}`)) return `p${k}`;
}

/** People at the table who could bet: here, not away, with chips for the minimum. */
function bettors(state: TableState): BjSpot[] {
  const { min } = bjLimits(state.settings);
  return state.bj!.spots.filter((s) => s.isHuman && !state.away[s.id] && s.stack >= min && state.members.some((m) => m.seat === s.id && !m.left));
}

const undecided = (state: TableState): BjSpot[] => bettors(state).filter((s) => !(s.id in state.bj!.bets) && !state.bj!.sitOut.includes(s.id));

/** A spot may join the new spot, which the joining code reserves by name. */
export function bjFreeSpot(state: TableState): string | null {
  const bj = state.bj!;
  const bot = bj.spots.find((s) => !s.isHuman && !state.pendingSits.some((p) => p.seat === s.id));
  if (bot) return bot.id;
  const reserved = state.pendingSits.filter((p) => p.seat === 'new').length;
  return bj.spots.length + reserved < BJ_SPOTS ? 'new' : null;
}

/** Deals the round to every person who bet and every bot. False when no person bet. */
function deal(state: TableState, now: number, credits: BjCredits): boolean {
  const bj = state.bj!;
  const { min, max } = bjLimits(state.settings);
  const rng = createRng(bj.rng);
  const shoe = Shoe.load(bj.shoe);
  if (!Object.keys(bj.bets).length) return false;
  const entries = bj.spots.flatMap((s) => {
    if (s.isHuman) return bj.bets[s.id] ? [{ id: s.id, name: s.name, stack: s.stack, bet: bj.bets[s.id] }] : [];
    const units = [1, 1, 2, 2, 3, 5][Math.floor(rng.next() * 6)];
    return [{ id: s.id, name: s.name, stack: s.stack, bet: Math.min(max, s.stack, min * units) }];
  });
  if (shoe.needsShuffle) shoe.shuffle();
  const round = new Round(shoe, entries, bj.nextRig);
  bj.nextRig = null;
  bj.rng = rng.state;
  bj.inRound = entries.map((e) => e.id);
  bj.phase = 'round';
  bj.roundNumber++;
  bj.settledAt = null;
  state.autoplayed = [];
  state.turnStartedAt = now;
  state.lastStepAt = now;
  save(state, shoe, round, now, credits);
  return true;
}

/** Writes the round and shoe back, keeps every spot's stack in step, and scores a finished round. */
function save(state: TableState, shoe: Shoe, round: Round, now: number, credits: BjCredits) {
  const bj = state.bj!;
  bj.shoe = shoe.save();
  bj.round = round.save();
  round.seats.forEach((seat, i) => {
    const spot = bj.spots.find((s) => s.id === bj.inRound[i]);
    if (spot) spot.stack = seat.stack;
  });
  if (round.isComplete && bj.settledAt === null) {
    bj.settledAt = now;
    round.seats.forEach((_, i) => {
      const id = bj.inRound[i];
      const m = state.away[id] || state.autoplayed?.includes(id) ? undefined : state.members.find((x) => x.seat === id && !x.left);
      if (!m) return;
      const net = round.net(i);
      m.run = net > 0 ? (m.run ?? 0) + 1 : net < 0 ? 0 : m.run ?? 0;
      credits(m, blackjackTally(round, i, m.run));
    });
  }
}

export type BjCredits = (m: Member, t: Tally) => void;

function load(state: TableState): { shoe: Shoe; round: Round | null } {
  const bj = state.bj!;
  const shoe = Shoe.load(bj.shoe);
  return { shoe, round: bj.phase === 'round' && bj.round ? Round.load(shoe, bj.round) : null };
}

/** Whose spot the round is waiting on, or null when it waits on nobody (the dealer, or done). */
function turnSpot(state: TableState, round: Round): string | null {
  if (round.phase === 'insurance') return state.bj!.inRound[round.insuranceTurn()] ?? null;
  if (round.phase === 'play') return state.bj!.inRound[round.seatTurn] ?? null;
  return null;
}

const isPerson = (state: TableState, spotId: string | null): boolean =>
  !!spotId && !!state.bj!.spots.find((s) => s.id === spotId)?.isHuman && !state.away[spotId];

// ---------- moving the table along ----------

/** A move nobody is waiting on a person for: closing bets, a bot's turn, a run-out clock, the dealer, the next round. */
export function bjAutoStep(state: TableState, now: number, credits: BjCredits): boolean {
  if (state.phase !== 'playing' || state.paused) return false;
  const bj = state.bj!;
  if (bj.phase === 'betting') {
    const waiting = undecided(state);
    if (waiting.length && now < bj.bettingEndsAt) return false;
    for (const s of waiting) {
      state.timeouts[s.id] = (state.timeouts[s.id] ?? 0) + 1;
      if (state.timeouts[s.id] >= TIMEOUTS_TO_AWAY) state.away[s.id] = true;
      bj.sitOut.push(s.id);
    }
    if (deal(state, now, credits)) return true;
    if (!bettors(state).length && !waiting.length) return false;
    // Nobody bet: keep the table open for bets.
    bj.bets = {};
    bj.sitOut = [];
    bj.bettingEndsAt = now + BJ_BET_MS;
    return true;
  }
  const { shoe, round } = load(state);
  if (!round) return false;
  if (round.isComplete) {
    if (now < (bj.settledAt ?? 0) + RESULT_MS) return false;
    openBetting(state, now);
    return true;
  }
  const spot = turnSpot(state, round);
  if (round.phase === 'dealer' || !isPerson(state, spot)) {
    if (now < state.lastStepAt + GAP_MS) return false;
    if (spot && state.bj!.spots.find((s) => s.id === spot)?.isHuman && !state.autoplayed?.includes(spot)) (state.autoplayed ??= []).push(spot);
    if (round.phase === 'insurance') round.insure(round.insuranceTurn(), false);
    else if (round.phase === 'play') round.act(bookPlay(round)!);
    else round.dealerStep();
  } else {
    if (now < state.turnStartedAt + TURN_MS) return false;
    state.timeouts[spot!] = (state.timeouts[spot!] ?? 0) + 1;
    if (state.timeouts[spot!] >= TIMEOUTS_TO_AWAY) state.away[spot!] = true;
    if (round.phase === 'insurance') round.insure(round.insuranceTurn(), false);
    else round.act('stand');
  }
  moved(state, shoe, round, now, credits);
  return true;
}

function moved(state: TableState, shoe: Shoe, round: Round, now: number, credits: BjCredits) {
  state.lastStepAt = now;
  state.turnStartedAt = now;
  save(state, shoe, round, now, credits);
}

/** A person's move: a bet (or sitting out), a play on their hand, or insurance. */
export function bjMove(state: TableState, m: Member, req: { round: number; move: BjMove; amount?: number }, now: number, credits: BjCredits) {
  const bj = state.bj!;
  if (state.paused) throw new BjError('The table is paused. Wait for it to carry on.');
  const spot = bj.spots.find((s) => s.id === m.seat);
  if (!spot) throw new BjError("You don't have a spot at this table yet.");
  delete state.away[spot.id];
  state.timeouts[spot.id] = 0;
  if (req.move === 'bet' || req.move === 'sitout') {
    if (bj.phase !== 'betting') throw new BjError('Bets are closed for this round.');
    if (req.move === 'sitout') {
      delete bj.bets[spot.id];
      if (!bj.sitOut.includes(spot.id)) bj.sitOut.push(spot.id);
    } else {
      const { min, max } = bjLimits(state.settings);
      const amount = Math.round(Number(req.amount));
      if (!Number.isFinite(amount) || amount < min || amount > max) throw new BjError(`Bets at this table are ${min} to ${max}.`);
      if (amount > spot.stack) throw new BjError("You don't have the chips for that bet.");
      bj.bets[spot.id] = amount;
      spot.lastBet = amount;
      bj.sitOut = bj.sitOut.filter((x) => x !== spot.id);
    }
    // Everyone has decided: deal now.
    if (!undecided(state).length && !deal(state, now, credits)) {
      bj.bettingEndsAt = Math.max(bj.bettingEndsAt, now);
    }
    return;
  }
  const { shoe, round } = load(state);
  if (!round || round.isComplete || req.round !== bj.roundNumber || turnSpot(state, round) !== spot.id) throw new BjError("It isn't your turn.");
  try {
    if (req.move === 'insure' || req.move === 'noinsure') {
      if (round.phase !== 'insurance') throw new BjError('Insurance is closed.');
      round.insure(round.insuranceTurn(), req.move === 'insure');
    } else {
      if (round.phase !== 'play') throw new BjError("It isn't your turn.");
      round.act(req.move as BjAction);
    }
  } catch (err) {
    throw new BjError((err as Error).message);
  }
  moved(state, shoe, round, now, credits);
}

/** Tops up a person who is out of chips, between rounds or while sitting a round out. */
export function bjRebuy(state: TableState, m: Member) {
  const bj = state.bj!;
  const spot = bj.spots.find((s) => s.id === m.seat);
  const { min } = bjLimits(state.settings);
  if (!spot || spot.stack >= min) throw new BjError('You can buy back in once you are short of the minimum bet.');
  if (bj.phase === 'round' && bj.inRound.includes(spot.id) && bj.round?.phase !== 'done') throw new BjError('Wait for this round to finish.');
  spot.stack = bjStartingStack(state.settings);
  spot.rebuys++;
}

/** Restarts the clock when a person comes back and it is their turn. */
export function bjBack(state: TableState, m: Member, now: number) {
  const { round } = load(state);
  if (round && turnSpot(state, round) === m.seat) state.turnStartedAt = now;
}

// ---------- what each person sees ----------

/** When the server will next accept a tick, or null if it is waiting on a person with no clock running. */
export function bjTickAt(state: TableState): number | null {
  if (state.phase !== 'playing' || state.paused) return null;
  const bj = state.bj!;
  if (bj.phase === 'betting') {
    if (!bettors(state).length) return null;
    return undecided(state).length ? bj.bettingEndsAt : state.lastStepAt;
  }
  const { round } = load(state);
  if (!round) return null;
  if (round.isComplete) return (bj.settledAt ?? 0) + RESULT_MS;
  const spot = turnSpot(state, round);
  return round.phase !== 'dealer' && isPerson(state, spot) ? state.turnStartedAt + TURN_MS : state.lastStepAt + GAP_MS;
}

/** When the person whose turn it is runs out of time, or when betting closes. */
export function bjDeadline(state: TableState): number | null {
  if (state.phase !== 'playing' || state.paused) return null;
  const bj = state.bj!;
  if (bj.phase === 'betting') return undecided(state).length ? bj.bettingEndsAt : null;
  const { round } = load(state);
  if (!round || round.isComplete || round.phase === 'dealer') return null;
  return isPerson(state, turnSpot(state, round)) ? state.turnStartedAt + TURN_MS : null;
}

export function bjView(state: TableState, userId: string): BjTableView | null {
  const bj = state.bj;
  if (!bj) return null;
  const s = state.settings;
  const { min, max } = bjLimits(s);
  const me = state.members.find((m) => m.userId === userId);
  const mySeat = me?.seat ?? null;
  const shoe = Shoe.load(bj.shoe);
  const round = bj.round ? Round.load(shoe, bj.round) : null;
  const live = bj.phase === 'round' && round && !round.isComplete ? round : null;
  const myTurn = !!live && !!mySeat && turnSpot(state, live) === mySeat && !state.away[mySeat];
  const shown = bj.round ? new Set(bj.inRound) : new Set<string>();
  const spots: BjSpotView[] = bj.spots.map((x) => ({
    id: x.id, name: x.name, title: x.isHuman ? state.members.find((m) => m.seat === x.id)?.title ?? null : null,
    isHuman: x.isHuman, stack: x.stack, rebuys: x.rebuys, away: !!state.away[x.id], you: x.id === mySeat,
    bet: bj.phase === 'betting' ? bj.bets[x.id] ?? null : null,
    sittingOut: bj.phase === 'betting' && bj.sitOut.includes(x.id),
    seat: shown.has(x.id) ? bj.inRound.indexOf(x.id) : -1,
  }));
  return {
    limits: s.bjLimits ?? 'low',
    min, max,
    startingStack: bjStartingStack(s),
    phase: bj.phase,
    roundNumber: bj.roundNumber,
    spots,
    round: round ? round.view() : null,
    legal: myTurn && live!.phase === 'play' ? live!.legal() : null,
    insuranceCost: myTurn && live!.phase === 'insurance' ? live!.insuranceCost(live!.seats[live!.insuranceTurn()]) : null,
    bettingEndsAt: bj.phase === 'betting' ? bj.bettingEndsAt : null,
    shoeLeft: shoe.remaining,
    shoeSize: shoe.size,
    lastBet: bj.spots.find((x) => x.id === mySeat)?.lastBet ?? min,
  };
}

// ---------- developer console ----------

export function bjAdminInfo(state: TableState): BjAdminInfo | null {
  const bj = state.bj;
  if (!bj) return null;
  const shoe = Shoe.load(bj.shoe);
  return {
    phase: bj.phase,
    roundNumber: bj.roundNumber,
    spots: bj.spots.map((x) => ({ id: x.id, name: x.name, isHuman: x.isHuman, stack: x.stack, bet: bj.phase === 'betting' ? bj.bets[x.id] ?? null : null, sittingOut: bj.sitOut.includes(x.id), away: !!state.away[x.id] })),
    round: bj.round ? JSON.parse(JSON.stringify(bj.round)) : null,
    inRound: [...bj.inRound],
    upcoming: shoe.upcoming(16),
    shoeLeft: shoe.remaining,
    shoeSize: shoe.size,
    nextRig: bj.nextRig ? JSON.parse(JSON.stringify(bj.nextRig)) : null,
  };
}

function findSpot(bj: BjState, ref: unknown): BjSpot {
  const r = String(ref ?? '').trim().toLowerCase();
  const byId = bj.spots.find((s) => s.id === r);
  if (byId) return byId;
  if (/^\d+$/.test(r) && bj.spots[Number(r)]) return bj.spots[Number(r)];
  const hits = bj.spots.filter((s) => s.name.toLowerCase().startsWith(r));
  if (r && hits.length === 1) return hits[0];
  throw new BjError(hits.length > 1 ? `"${ref}" matches ${hits.map((s) => s.name).join(', ')}.` : `No spot called "${ref}".`);
}

function cardList(raw: unknown, most: number): Card[] {
  if (!Array.isArray(raw) || !raw.length) throw new BjError('List the cards.');
  if (raw.length > most) throw new BjError(`At most ${most} cards.`);
  return raw.map((c) => {
    const n = Number(c);
    if (!Number.isInteger(n) || n < 0 || n > 51) throw new BjError('That is not a card.');
    return n;
  });
}

/**
 * Runs a developer console command on a blackjack table and says what it did. Pausing,
 * resuming and kicking work the same as at poker, so the table server handles those.
 */
export function bjAdmin(state: TableState, cmd: AdminCommand, now: number, credits: BjCredits): string {
  const bj = state.bj!;
  const live = (): { shoe: Shoe; round: Round } => {
    const { shoe, round } = load(state);
    if (!round || round.isComplete) throw new BjError('No round in play.');
    return { shoe, round };
  };
  switch (cmd.do) {
    case 'rig': {
      const cards = cardList(cmd.cards, 2);
      const rig = bj.nextRig ?? {};
      if (String(cmd.seat).toLowerCase() === 'dealer') {
        bj.nextRig = { ...rig, dealer: cards };
        return cards.length === 2 ? 'The dealer gets those cards next round.' : 'The dealer shows that card next round.';
      }
      const spot = findSpot(bj, cmd.seat);
      bj.nextRig = { ...rig, seats: { ...rig.seats, [spot.id]: cards } };
      return `${spot.name} gets ${cards.length === 2 ? 'those cards' : 'that card first'} next round.`;
    }
    case 'unrig':
      bj.nextRig = null;
      return 'Next round deals from the shoe.';
    case 'stackshoe': {
      const cards = cardList(cmd.cards, 20);
      const shoe = Shoe.load(bj.shoe);
      shoe.stackTop(cards);
      bj.shoe = shoe.save();
      return `Those ${cards.length === 1 ? 'card comes' : `${cards.length} cards come`} out of the shoe next.`;
    }
    case 'hole': {
      const [card] = cardList([cmd.card], 1);
      const { shoe, round } = live();
      try {
        round.setHole(card);
      } catch (err) {
        throw new BjError((err as Error).message);
      }
      save(state, shoe, round, now, credits);
      return "The dealer's hole card is changed.";
    }
    case 'stack': {
      const spot = findSpot(bj, cmd.seat);
      const n = Math.max(0, Math.round(Number(cmd.amount)));
      if (!Number.isFinite(n)) throw new BjError('Give an amount.');
      spot.stack = n;
      const { shoe, round } = load(state);
      const i = bj.inRound.indexOf(spot.id);
      if (round && !round.isComplete && i >= 0) {
        round.seats[i].stack = n;
        save(state, shoe, round, now, credits);
      }
      return `${spot.name} now has ${n} chips.`;
    }
    case 'step': {
      if (bj.phase === 'betting') {
        if (!Object.keys(bj.bets).length) throw new BjError('Nobody has bet yet, so there is no round to deal.');
        // Deal now; anyone still deciding sits this one out, with no mark against them.
        for (const x of undecided(state)) bj.sitOut.push(x.id);
      } else {
        const { round } = load(state);
        if (round && !round.isComplete && round.phase !== 'dealer') {
          const spot = turnSpot(state, round);
          if (isPerson(state, spot)) throw new BjError(`It's ${bj.spots.find((s) => s.id === spot)?.name}'s turn, and they're a person.`);
        }
      }
      const paused = state.paused;
      state.paused = false;
      state.lastStepAt = 0;
      bj.bettingEndsAt = 0;
      if (bj.settledAt !== null) bj.settledAt = 0;
      const moved = bjAutoStep(state, now, credits);
      state.paused = paused;
      if (!moved) throw new BjError('Nothing to do right now.');
      return bj.phase === 'betting' ? 'Next round open for bets.' : 'One move made.';
    }
    default:
      throw new BjError("That command is for poker tables.");
  }
}

/** After a pause, everyone gets a fresh clock. */
export function bjResume(state: TableState, now: number) {
  const bj = state.bj!;
  if (bj.phase === 'betting') bj.bettingEndsAt = now + BJ_BET_MS;
  if (bj.settledAt !== null) bj.settledAt = now;
}
