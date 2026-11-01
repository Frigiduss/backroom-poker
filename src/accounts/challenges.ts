// Weekly challenges: three goals a week, each paying chips once.
//
// A week runs Monday 00:00 to Monday 00:00 UTC, so everyone everywhere gets the same three
// goals at the same moment. Which three is picked from the week number alone (an easy one, a
// medium one and a hard poker one), so the browser and the server agree without talking.
//
// Progress reuses the achievement counters: when a player first opens the lobby in a new week
// we note where their counters stand, and a challenge's progress is how far they've moved
// since. So everything that counts for achievements counts here, and nothing else does
// (practice tables, rigged hands and console autopilot never count).
//
// The chips: online players claim through the server (supabase/challenges.sql), which keeps
// which goals each account has been paid for this week, fixes the amounts and makes room for
// the chips in the bank limits (banks.sql). Players kept only in this browser use the
// browser's clock.
import type { Counters } from './achievements';
import type { Profile } from './profile';
import { noteChips } from './profile';

const DAY = 86_400_000;

/** Chips for the easy, medium and hard goal. supabase/challenges.sql repeats these. */
export const CHALLENGE_REWARDS = [2_500, 5_000, 10_000] as const;
export const CHALLENGE_LEVELS = ['Easy', 'Medium', 'Hard'] as const;
export type ChallengeSlot = 0 | 1 | 2;

/** Weeks since 1970, counting from Mondays (UTC). Day 0 was a Thursday. */
export const challengeWeek = (now = Date.now()): number => Math.floor((Math.floor(now / DAY) + 3) / 7);
/** When week `week` starts, in epoch ms. */
export const weekStart = (week: number): number => (week * 7 - 3) * DAY;
/** When week `week` ends and the next three goals arrive. */
export const weekEnd = (week: number): number => weekStart(week + 1);

interface ChallengeDef {
  id: string;
  /** What to do, in a sentence. */
  desc: string;
  goal: number;
  /** The counters this goal adds up. */
  keys: string[];
}

export interface Challenge extends ChallengeDef {
  slot: ChallengeSlot;
  reward: number;
}

const strongHands = (from: string) => {
  const all = ['made.straight', 'made.flush', 'made.fullHouse', 'made.quads', 'made.straightFlush'];
  return all.slice(all.indexOf(from));
};

const EASY: ChallengeDef[] = [
  { id: 'e-hands', desc: 'Play 60 hands of poker.', goal: 60, keys: ['hands'] },
  { id: 'e-wins', desc: 'Win 15 hands of poker.', goal: 15, keys: ['wins'] },
  { id: 'e-holdem', desc: "Play 40 hands of Texas Hold'em.", goal: 40, keys: ['play.holdem'] },
  { id: 'e-omaha', desc: 'Play 30 hands of Omaha or Omaha Hi-Lo.', goal: 30, keys: ['play.omaha', 'play.omaha8'] },
  { id: 'e-stud', desc: 'Play 30 hands of Seven Card Stud, Stud Hi-Lo or Razz.', goal: 30, keys: ['play.stud7', 'play.stud8', 'play.razz'] },
  { id: 'e-draw', desc: 'Play 25 hands of Five Card Draw.', goal: 25, keys: ['play.draw5'] },
  { id: 'e-bj', desc: 'Play 30 hands of blackjack.', goal: 30, keys: ['bj.hands'] },
  { id: 'e-roulette', desc: 'Spin the roulette wheel 30 times.', goal: 30, keys: ['rl.spins'] },
  { id: 'e-baccarat', desc: 'Play 25 hands of baccarat.', goal: 25, keys: ['bac.hands'] },
  { id: 'e-vp', desc: 'Play 40 hands of video poker.', goal: 40, keys: ['vp.hands'] },
  { id: 'e-slots', desc: 'Spin the slot machine 50 times.', goal: 50, keys: ['sl.spins'] },
];

const MEDIUM: ChallengeDef[] = [
  { id: 'm-showdowns', desc: 'Win 12 showdowns.', goal: 12, keys: ['showdownWins'] },
  { id: 'm-steals', desc: 'Bet or raise and win 15 pots without a showdown.', goal: 15, keys: ['steals'] },
  { id: 'm-allin', desc: 'Win 3 hands after going all in.', goal: 3, keys: ['allinWins'] },
  { id: 'm-straight', desc: 'Win 3 showdowns with a straight or better.', goal: 3, keys: strongHands('made.straight') },
  { id: 'm-cashes', desc: 'Finish in the money in 2 tournaments.', goal: 2, keys: ['cashes'] },
  { id: 'm-cashup', desc: 'Leave a cash game with more chips than you sat down with, 3 times.', goal: 3, keys: ['cashUp'] },
  { id: 'm-bj-wins', desc: 'Win 15 hands of blackjack.', goal: 15, keys: ['bj.wins'] },
  { id: 'm-bj-naturals', desc: 'Get dealt 3 blackjacks.', goal: 3, keys: ['bj.naturals'] },
  { id: 'm-bj-double', desc: 'Double down and win 3 times in blackjack.', goal: 3, keys: ['bj.doubleWins'] },
  { id: 'm-straight-up', desc: 'Hit a single-number roulette bet twice.', goal: 2, keys: ['rl.straightHits'] },
];

const HARD: ChallengeDef[] = [
  { id: 'h-sng', desc: 'Win a Sit & Go tournament.', goal: 1, keys: ['sngWins'] },
  { id: 'h-headsup', desc: 'Win a heads-up match.', goal: 1, keys: ['huWins'] },
  { id: 'h-wins', desc: 'Win 100 hands of poker.', goal: 100, keys: ['wins'] },
  { id: 'h-flush', desc: 'Win 5 showdowns with a flush or better.', goal: 5, keys: strongHands('made.flush') },
  { id: 'h-boat', desc: 'Win 2 showdowns with a full house or better.', goal: 2, keys: strongHands('made.fullHouse') },
  { id: 'h-allin', desc: 'Win 8 hands after going all in.', goal: 8, keys: ['allinWins'] },
  { id: 'h-air', desc: 'Win 3 showdowns with nothing better than high card.', goal: 3, keys: ['airWins'] },
  { id: 'h-lows', desc: 'Win the low half of 5 pots in Omaha Hi-Lo, Stud Hi-Lo or Razz.', goal: 5, keys: ['lowWins'] },
];

const POOLS = [EASY, MEDIUM, HARD] as const;

/** Every goal that can come up, for tests and the guide. */
export const ALL_CHALLENGES: readonly ChallengeDef[] = [...EASY, ...MEDIUM, ...HARD];

/** A well-mixed number from the week and slot, so neighbouring weeks don't look alike. */
function mix(week: number, slot: number): number {
  let h = Math.imul(week ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(slot + 1, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Pool order for one run through it: a shuffle seeded by the run and slot. */
function shuffled(n: number, run: number, slot: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = mix(run * 31 + i, slot) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * This week's three goals: easy, medium, hard. Each slot works through its whole pool in a
 * shuffled order before any goal comes round again, and never repeats from one week to the next.
 */
export function weeklyChallenges(week: number): Challenge[] {
  return POOLS.map((pool, slot) => {
    const n = pool.length;
    const run = Math.floor(week / n);
    const at = week - run * n;
    const order = shuffled(n, run, slot);
    // Where one run ends and the next begins, the same goal could land twice in a row.
    if (order[0] === shuffled(n, run - 1, slot)[n - 1]) [order[0], order[1]] = [order[1], order[0]];
    return { ...pool[order[at]], slot: slot as ChallengeSlot, reward: CHALLENGE_REWARDS[slot] };
  });
}

// ---------- progress ----------

/** Where a player's counters stood when this week's goals started for them. */
export interface ChallengeRecord {
  /** Which week this is (see challengeWeek); -1 before the first look. */
  week: number;
  /** The player's own counters at the start (games in this browser). */
  local: Counters;
  /** What the table server had credited at the start, or null until that was known. */
  server: Counters | null;
  /** Slots already paid this week. */
  claimed: ChallengeSlot[];
}

export const emptyChallenges = (): ChallengeRecord => ({ week: -1, local: {}, server: null, claimed: [] });

const sum = (c: Counters, keys: string[]) => keys.reduce((t, k) => t + (Number.isFinite(c[k]) ? c[k] : 0), 0);

function snapshot(c: Counters, week: number): Counters {
  const out: Counters = {};
  for (const ch of weeklyChallenges(week)) for (const k of ch.keys) out[k] = sum(c, [k]);
  return out;
}

/**
 * Starts a new week for the player if one began, and notes the server's counters once they're
 * known. `local` is the player's own counters (profileCounters), `server` what the table server
 * credited, and `serverKnown` whether that has been fetched (always true for players kept in
 * this browser). Returns true when the record changed and should be saved.
 */
export function startWeek(p: Profile, local: Counters, server: Counters, serverKnown: boolean, now = Date.now()): boolean {
  const week = challengeWeek(now);
  const r = p.challenges;
  if (r.week !== week) {
    p.challenges = { week, local: snapshot(local, week), server: serverKnown ? snapshot(server, week) : null, claimed: [] };
    return true;
  }
  if (!r.server && serverKnown) {
    r.server = snapshot(server, week);
    return true;
  }
  return false;
}

/** How far the player is toward `ch` this week, from 0 to its goal. */
export function challengeProgress(r: ChallengeRecord, ch: Challenge, local: Counters, server: Counters): number {
  let got = sum(local, ch.keys) - sum(r.local, ch.keys);
  if (r.server) got += sum(server, ch.keys) - sum(r.server, ch.keys);
  return Math.max(0, Math.min(ch.goal, got));
}

export type ChallengeState = 'open' | 'ready' | 'claimed';

export interface ChallengeStatus extends Challenge {
  progress: number;
  state: ChallengeState;
}

/** This week's goals with the player's progress, or an empty list if the week hasn't been started for them. */
export function challengeStatus(p: Profile, local: Counters, server: Counters, now = Date.now()): ChallengeStatus[] {
  const r = p.challenges;
  if (r.week !== challengeWeek(now)) return [];
  return weeklyChallenges(r.week).map((ch) => {
    const progress = challengeProgress(r, ch, local, server);
    const state: ChallengeState = r.claimed.includes(ch.slot) ? 'claimed' : progress >= ch.goal ? 'ready' : 'open';
    return { ...ch, progress, state };
  });
}

// ---------- claiming ----------

export interface ChallengeClaim {
  /** Chips added, or 0 if this goal was already paid. */
  amount: number;
  week: number;
  slot: ChallengeSlot;
}

/** Puts a claim's chips in the bank and marks the goal as paid. */
export function applyChallenge(p: Profile, c: ChallengeClaim): void {
  const r = p.challenges;
  if (r.week === c.week && !r.claimed.includes(c.slot)) r.claimed = [...r.claimed, c.slot].sort() as ChallengeSlot[];
  if (c.amount > 0) {
    p.bank += c.amount;
    p.stats.peakBank = Math.max(p.stats.peakBank, p.bank);
  }
  p.updatedAt = Date.now();
  noteChips(p, p.updatedAt);
}

/**
 * A claim checked in the browser, for players that aren't saved online. Throws if the goal
 * isn't finished; pays 0 if it was already paid.
 */
export function claimChallengeLocally(p: Profile, slot: ChallengeSlot, local: Counters, now = Date.now()): ChallengeClaim {
  const st = challengeStatus(p, local, {}, now)[slot];
  if (!st) throw new Error('This week\'s challenges are over. Have a look at the new ones.');
  if (st.state === 'open') throw new Error('That challenge isn\'t finished yet.');
  const claim: ChallengeClaim = { amount: st.state === 'ready' ? st.reward : 0, week: p.challenges.week, slot };
  applyChallenge(p, claim);
  return claim;
}

/** Tidies a saved record: anything odd becomes "not started yet". */
export function normalizeChallenges(raw: unknown): ChallengeRecord {
  const r = raw as Partial<ChallengeRecord> | null | undefined;
  if (!r || typeof r !== 'object' || typeof r.week !== 'number' || !Number.isInteger(r.week)) return emptyChallenges();
  const counters = (x: unknown): Counters => {
    const out: Counters = {};
    if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    return out;
  };
  const claimed = Array.isArray(r.claimed) ? [...new Set(r.claimed.filter((s): s is ChallengeSlot => s === 0 || s === 1 || s === 2))].sort() as ChallengeSlot[] : [];
  return { week: r.week, local: counters(r.local), server: r.server && typeof r.server === 'object' ? counters(r.server) : null, claimed };
}
