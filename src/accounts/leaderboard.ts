// The leaderboard and the online daily bonus, both answered by database functions in
// supabase/leaderboard.sql. The leaderboard is readable without signing in and only ever
// returns a player's name, colour, title and score, never who owns them.
import { BonusClaim } from './bonus';
import { ChallengeClaim, ChallengeSlot } from './challenges';
import { OnlineAuth, OnlineError, restRequest } from './online';
import { safeColor } from './profile';
import { cleanAvatar } from './avatars';

type Fetch = typeof fetch;

export type Board = 'bank' | 'pot' | 'achievements';

export const BOARD_NAMES: Record<Board, string> = { bank: 'Chip bank', pot: 'Biggest pot', achievements: 'Achievements' };

/** Players need this many hands (poker or blackjack) before they show on the leaderboard. */
export const LEADERBOARD_MIN_HANDS = 10;

export interface LeaderRow {
  rank: number;
  name: string;
  color: string;
  /** The player's face (see avatars.ts), or null for their first letter. */
  avatar: string | null;
  /** Achievement id of the player's title, if they've unlocked it. */
  title: string | null;
  value: number;
  /** One of the signed-in account's own players. */
  mine: boolean;
}

/** Thrown when supabase/leaderboard.sql hasn't been run on the project yet. */
export class NotSetUpError extends OnlineError {}

const notSetUp = (err: unknown) => err instanceof OnlineError && err.status === 404;

/**
 * The top players on a board, plus the signed-in account's own players wherever they rank.
 * Signed out (or with `anonymous`), it reads as a visitor.
 */
export async function fetchLeaderboard(auth: OnlineAuth, board: Board, limit = 25, fetchFn: Fetch = (...a) => fetch(...a)): Promise<LeaderRow[]> {
  let rows: Record<string, unknown>[];
  try {
    rows = (await restRequest(auth, 'rpc/leaderboard', { method: 'POST', body: { p_board: board, p_limit: limit }, anonymous: !auth.current }, fetchFn)) as Record<string, unknown>[];
  } catch (err) {
    if (notSetUp(err)) throw new NotSetUpError('The leaderboard isn\'t switched on yet.', 404);
    throw err;
  }
  return (rows ?? []).map((r) => ({
    rank: Number(r.rank ?? 0),
    name: String(r.name ?? 'Player'),
    color: safeColor(r.color),
    avatar: cleanAvatar(r.avatar),
    title: typeof r.title === 'string' ? r.title : null,
    value: Number(r.value ?? 0),
    mine: r.mine === true,
  }));
}

/**
 * Collects the daily bonus for one of the signed-in account's players. The server decides
 * whether it's due and how much it pays; a claim made too soon comes back with amount 0.
 */
export async function claimOnlineBonus(auth: OnlineAuth, playerId: string, fetchFn: Fetch = (...a) => fetch(...a)): Promise<BonusClaim> {
  let r: Record<string, unknown>;
  try {
    r = (await restRequest(auth, 'rpc/claim_daily_bonus', { method: 'POST', body: { p_player: playerId } }, fetchFn)) as Record<string, unknown>;
  } catch (err) {
    if (notSetUp(err)) throw new NotSetUpError('The daily bonus isn\'t switched on yet.', 404);
    throw err;
  }
  return { amount: Number(r?.amount ?? 0), streak: Number(r?.streak ?? 0), last: Number(r?.last ?? Date.now()) };
}

/**
 * Claims a finished weekly challenge for one of the signed-in account's players. The server
 * checks the week on its own clock, pays each goal once per account and sets the amount;
 * a goal already paid comes back with amount 0.
 */
export async function claimOnlineChallenge(auth: OnlineAuth, playerId: string, week: number, slot: ChallengeSlot, fetchFn: Fetch = (...a) => fetch(...a)): Promise<ChallengeClaim> {
  let r: Record<string, unknown>;
  try {
    r = (await restRequest(auth, 'rpc/claim_challenge', { method: 'POST', body: { p_player: playerId, p_week: week, p_slot: slot } }, fetchFn)) as Record<string, unknown>;
  } catch (err) {
    if (notSetUp(err)) throw new NotSetUpError('Weekly challenge rewards aren\'t switched on yet.', 404);
    throw err;
  }
  return { amount: Number(r?.amount ?? 0), week, slot };
}
