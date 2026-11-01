// Player profiles: a name, a chip bank that carries between games, lifetime stats and saved
// settings. Everything here is plain data and pure bookkeeping, so the same rules work with
// browser storage today and an online backend later.
import { Achievement, Counters, Tally, addTally, combine, unlockedIn } from './achievements';
import type { BonusRecord } from './bonus';
import { cleanAvatar } from './avatars';

export const STARTING_BANK = 10_000;
/** A player whose bank (with nothing at a table) drops below this can refill it. */
export const REFILL_BELOW = 1_000;
/** Entry fee for Sit & Go and heads-up tournaments. Every seat pays it into the prize pool. */
export const TOURNAMENT_FEE = 500;
export const NAME_MAX = 14;

export const PROFILE_COLORS = ['#e6b85c', '#7fd39b', '#6fb7ea', '#ef8f52', '#e95a78', '#b59cf0', '#5fd3c8', '#d9c46a'];

/**
 * A player's colour if it's a plain hex colour, else the fallback. Colours go into style
 * attributes, and other people's come from their own saves, so anything else could carry CSS.
 */
export const safeColor = (c: unknown, fallback = PROFILE_COLORS[0]): string =>
  typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : fallback;

export interface ProfileStats {
  hands: number;
  handsWon: number;
  showdownsWon: number;
  /** Largest single pot collected, in chips. */
  biggestPot: number;
  /** Chips won or lost across all cash games (cash-outs minus buy-ins). */
  cashNet: number;
  cashSessions: number;
  tournaments: number;
  tournamentWins: number;
  /** Tournaments finished in a paid place. */
  tournamentCashes: number;
  bestFinish: number | null;
  peakBank: number;
  refills: number;
  /** Hands played per variant id. */
  byVariant: Record<string, number>;
}

/** Progress toward achievements earned in this browser (online tables are counted by the server). */
export interface AchievementRecord {
  counters: Counters;
  /** When each achievement was first seen unlocked, by id. */
  unlocked: Record<string, number>;
  /** Hands won in a row right now. */
  run: number;
}

/** Chips currently committed to a table. Kept on the profile so a closed tab never loses them. */
export interface TableSession {
  kind: 'cash' | 'tournament';
  /** Total paid in: cash buy-ins and rebuys, or the tournament fee. */
  paidIn: number;
  /** Cash games: the player's stack after the last finished hand. */
  stack: number;
}

export interface Profile {
  id: string;
  name: string;
  color: string;
  /** The face on the badge: null for the first letter of the name, or see avatars.ts. */
  avatar: string | null;
  createdAt: number;
  updatedAt: number;
  bank: number;
  table: TableSession | null;
  stats: ProfileStats;
  /** UI settings (lobby choices, table preferences). Opaque to the account layer. */
  settings: Record<string, unknown>;
  achievements: AchievementRecord;
  /** The achievement whose title shows next to the name, or null for none. */
  title: string | null;
  /** The daily chip bonus: when it was last collected and the streak. */
  bonus: BonusRecord;
  /** The player's chips over time as [time, chips] points, oldest first. See noteChips. */
  history: ChipPoint[];
}

/** When the player's chips (bank plus any cash-game stack) changed, and what they came to. */
export type ChipPoint = [time: number, chips: number];

/** Once the chip history reaches this many points, every other older point is dropped. */
export const HISTORY_MAX = 240;

export const emptyProfileStats = (bank = STARTING_BANK): ProfileStats => ({
  hands: 0, handsWon: 0, showdownsWon: 0, biggestPot: 0, cashNet: 0, cashSessions: 0,
  tournaments: 0, tournamentWins: 0, tournamentCashes: 0, bestFinish: null, peakBank: bank, refills: 0, byVariant: {},
});

export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

export function newId(): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `pr_${rand}`;
}

export function createProfile(name: string, opts: { color?: string; settings?: Record<string, unknown>; now?: number } = {}): Profile {
  const now = opts.now ?? Date.now();
  return {
    id: newId(),
    name: cleanName(name) || 'Player',
    color: opts.color ?? PROFILE_COLORS[Math.floor(Math.random() * PROFILE_COLORS.length)],
    avatar: null,
    createdAt: now,
    updatedAt: now,
    bank: STARTING_BANK,
    table: null,
    stats: emptyProfileStats(),
    settings: opts.settings ?? {},
    achievements: { counters: {}, unlocked: {}, run: 0 },
    title: null,
    bonus: { last: null, streak: 0 },
    history: [[now, STARTING_BANK]],
  };
}

/** Starting counters for a player saved before achievements existed, so their history counts. */
function seedCounters(s: ProfileStats): Counters {
  const c: Counters = { hands: s.hands, wins: s.handsWon, showdownWins: s.showdownsWon, peakBank: s.peakBank, cashes: s.tournamentCashes };
  for (const [v, k] of Object.entries(s.byVariant)) c[`play.${v}`] = k;
  return c;
}

function normalizeAchievements(raw: unknown, stats: ProfileStats): AchievementRecord {
  const r = (raw && typeof raw === 'object' ? raw : null) as Partial<AchievementRecord> | null;
  if (!r) {
    const rec: AchievementRecord = { counters: seedCounters(stats), unlocked: {}, run: 0 };
    for (const a of unlockedIn(rec.counters)) rec.unlocked[a.id] = 0;
    return rec;
  }
  const counters: Counters = {};
  for (const [k, v] of Object.entries(r.counters ?? {})) if (typeof v === 'number' && Number.isFinite(v)) counters[k] = v;
  const unlocked: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.unlocked ?? {})) if (typeof v === 'number') unlocked[k] = v;
  return { counters, unlocked, run: num(r.run, 0) };
}

const num = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

function normalizeHistory(raw: unknown): ChipPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: ChipPoint[] = [];
  for (const x of raw) {
    if (Array.isArray(x) && typeof x[0] === 'number' && typeof x[1] === 'number' && Number.isFinite(x[0]) && Number.isFinite(x[1])) out.push([x[0], x[1]]);
  }
  return out.sort((a, b) => a[0] - b[0]).slice(-HISTORY_MAX);
}

/** Fills in anything missing from stored or imported data, so older saves keep loading. */
export function normalizeProfile(raw: unknown): Profile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Profile>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null;
  const base = emptyProfileStats();
  const s = (r.stats ?? {}) as Partial<ProfileStats>;
  const stats: ProfileStats = { ...base };
  for (const k of Object.keys(base) as (keyof ProfileStats)[]) {
    if (k === 'byVariant' || k === 'bestFinish') continue;
    (stats[k] as number) = num(s[k], base[k] as number);
  }
  stats.bestFinish = typeof s.bestFinish === 'number' ? s.bestFinish : null;
  stats.byVariant = {};
  for (const [k, v] of Object.entries(s.byVariant ?? {})) if (typeof v === 'number') stats.byVariant[k] = v;
  const t = r.table;
  const table: TableSession | null = t && (t.kind === 'cash' || t.kind === 'tournament')
    ? { kind: t.kind, paidIn: num(t.paidIn, 0), stack: num(t.stack, 0) }
    : null;
  const p: Profile = {
    id: r.id,
    name: cleanName(r.name) || 'Player',
    color: safeColor(r.color),
    avatar: cleanAvatar(r.avatar),
    createdAt: num(r.createdAt, Date.now()),
    updatedAt: num(r.updatedAt, Date.now()),
    bank: Math.max(0, Math.floor(num(r.bank, STARTING_BANK))),
    table,
    stats,
    settings: r.settings && typeof r.settings === 'object' ? { ...r.settings } : {},
    achievements: normalizeAchievements(r.achievements, stats),
    title: typeof r.title === 'string' ? r.title : null,
    bonus: { last: typeof r.bonus?.last === 'number' ? r.bonus.last : null, streak: Math.max(0, Math.floor(num(r.bonus?.streak, 0))) },
    history: normalizeHistory(r.history),
  };
  // Players saved before the chip graph existed start it from where they are now.
  if (!p.history.length) p.history.push([p.updatedAt, chipsOf(p)]);
  return p;
}

// ---------- bank ----------

/** Everything the player owns: the bank plus a cash-game stack still at the table. */
export const chipsOf = (p: Profile): number => p.bank + (p.table?.kind === 'cash' ? p.table.stack : 0);

/**
 * Adds a point to the chip history when the player's chips have changed. When it fills up,
 * every other point is dropped (the first and newest stay), so the graph always covers the
 * whole time played, with older stretches in less detail.
 */
export function noteChips(p: Profile, now = Date.now()): void {
  const h = p.history;
  const chips = chipsOf(p);
  if (h.length && h[h.length - 1][1] === chips) return;
  h.push([now, chips]);
  if (h.length >= HISTORY_MAX) p.history = h.filter((_, k) => k === 0 || k === h.length - 1 || k % 2 === 0);
}

function touch(p: Profile) {
  p.updatedAt = Date.now();
  p.stats.peakBank = Math.max(p.stats.peakBank, p.bank);
  noteChips(p, p.updatedAt);
}

export const canAfford = (p: Profile, amount: number): boolean => p.bank >= amount;

/** Takes a cash-game buy-in (or rebuy) from the bank. Returns false if the bank can't cover it. */
export function buyIn(p: Profile, amount: number): boolean {
  if (p.bank < amount) return false;
  p.bank -= amount;
  if (p.table?.kind === 'cash') {
    p.table.paidIn += amount;
    p.table.stack += amount;
  } else {
    p.table = { kind: 'cash', paidIn: amount, stack: amount };
    p.stats.cashSessions++;
  }
  touch(p);
  return true;
}

/** Remembers the player's cash-game stack after a hand, so it can be returned if the tab closes. */
export function setTableStack(p: Profile, stack: number): void {
  if (p.table?.kind !== 'cash') return;
  p.table.stack = stack;
  touch(p);
}

/** Leaves a cash game: the stack goes back to the bank. Returns the session's profit or loss. */
export function cashOut(p: Profile, stack = p.table?.stack ?? 0): number {
  if (p.table?.kind !== 'cash') return 0;
  const net = stack - p.table.paidIn;
  p.bank += stack;
  p.stats.cashNet += net;
  p.table = null;
  touch(p);
  return net;
}

/** Share of the prize pool for each paid place. */
export function payoutShares(field: number): number[] {
  if (field <= 3) return [1];
  if (field <= 6) return [0.7, 0.3];
  return [0.5, 0.3, 0.2];
}

export function prizeFor(place: number, field: number, fee = TOURNAMENT_FEE): number {
  const share = payoutShares(field)[place - 1] ?? 0;
  return Math.round(share * field * fee);
}

export function enterTournament(p: Profile, fee = TOURNAMENT_FEE): boolean {
  if (p.bank < fee) return false;
  p.bank -= fee;
  p.table = { kind: 'tournament', paidIn: fee, stack: 0 };
  p.stats.tournaments++;
  touch(p);
  return true;
}

/** Records a finished tournament and pays any prize into the bank. Returns the prize. */
export function finishTournament(p: Profile, place: number, field: number, fee = TOURNAMENT_FEE): number {
  if (p.table?.kind !== 'tournament') return 0;
  const prize = prizeFor(place, field, fee);
  p.bank += prize;
  if (place === 1) p.stats.tournamentWins++;
  if (prize > 0) p.stats.tournamentCashes++;
  p.stats.bestFinish = p.stats.bestFinish === null ? place : Math.min(p.stats.bestFinish, place);
  p.table = null;
  touch(p);
  return prize;
}

/** Walking away from a tournament before it ends forfeits the fee. */
export function abandonTournament(p: Profile): void {
  if (p.table?.kind !== 'tournament') return;
  p.table = null;
  touch(p);
}

/** Settles a table left open by a closed tab: cash stacks go home, tournaments are forfeited. */
export function settleOpenTable(p: Profile): void {
  if (p.table?.kind === 'cash') cashOut(p);
  else if (p.table) abandonTournament(p);
}

/**
 * Blackjack plays straight from the bank: the table holds it as the player's stack and hands
 * it back after every move, so wagers on a hand still in play are gone if the tab closes.
 */
export function setBlackjackBank(p: Profile, stack: number): void {
  p.bank = Math.max(0, Math.floor(stack));
  touch(p);
}

export const canRefill = (p: Profile): boolean => !p.table && p.bank < REFILL_BELOW;

/** Tops a nearly empty bank back up to the starting amount. */
export function refill(p: Profile): boolean {
  if (!canRefill(p)) return false;
  p.bank = STARTING_BANK;
  p.stats.refills++;
  touch(p);
  return true;
}

// ---------- stats ----------

export interface HandOutcome {
  variant: string;
  /** Stack after the hand minus stack before it. */
  net: number;
  /** Chips collected from the pot (0 if none). */
  collected: number;
  showdownWin: boolean;
}

export function recordHand(p: Profile, h: HandOutcome): void {
  const s = p.stats;
  s.hands++;
  s.byVariant[h.variant] = (s.byVariant[h.variant] ?? 0) + 1;
  if (h.net > 0) {
    s.handsWon++;
    s.biggestPot = Math.max(s.biggestPot, h.collected);
  }
  if (h.showdownWin) s.showdownsWon++;
  touch(p);
}

// ---------- achievements ----------

/** The player's own counters, with the bank's high-water mark from their stats. */
export function profileCounters(p: Profile): Counters {
  const c = { ...p.achievements.counters };
  c.peakBank = Math.max(c.peakBank ?? 0, p.stats.peakBank);
  return c;
}

/** Everything that counts toward achievements: this player's own play plus what the table server credited. */
export const allCounters = (p: Profile, server: Counters = {}): Counters => combine(profileCounters(p), server);

/** Adds a game event to the player's progress. Online counters are left to the server. */
export function credit(p: Profile, t: Tally): void {
  addTally(p.achievements.counters, t);
  touch(p);
}

/** Achievements unlocked since the player last looked, marked as seen now. */
export function takeUnlocks(p: Profile, server: Counters = {}, now = Date.now()): Achievement[] {
  const fresh = unlockedIn(allCounters(p, server)).filter((a) => !(a.id in p.achievements.unlocked));
  for (const a of fresh) p.achievements.unlocked[a.id] = now;
  if (fresh.length) touch(p);
  return fresh;
}
