// Sending chips to a friend, answered by database functions in supabase/gifts.sql. The server
// takes the chips out of the sender's saved bank and keeps the gift until the friend collects
// it, with daily limits so chips can't be farmed with spare accounts.
import { FriendsNotSetUpError, cleanFriendCode } from './friends';
import { OnlineAuth, OnlineError, restRequest } from './online';
import { Profile, noteChips, safeColor } from './profile';
import { cleanAvatar } from './avatars';

type Fetch = typeof fetch;

/** The smallest and largest single gift. */
export const GIFT_MIN = 100;
export const GIFT_MAX = 10_000;
/** Chips an account can send, and be sent, in any 24 hours. */
export const GIFT_SEND_DAY = 10_000;
export const GIFT_RECEIVE_DAY = 20_000;
/** Hands a player needs before they can send chips. */
export const GIFT_MIN_HANDS = 10;

export interface ChipGift {
  /** Friend code of the sender. */
  from: string;
  name: string;
  color: string;
  avatar: string | null;
  amount: number;
  at: number;
}

export interface GiftsState {
  waiting: ChipGift[];
  /** Chips this account can still send today. */
  left: number;
}

/** Thrown when supabase/gifts.sql hasn't been run on the project yet. */
export class GiftsNotSetUpError extends FriendsNotSetUpError {}

const str = (x: unknown, max = 40): string => (typeof x === 'string' ? x.slice(0, max) : '');
const whole = (x: unknown): number => Math.max(0, Math.floor(Number(x) || 0));

export function parseGifts(r: Record<string, unknown>): GiftsState {
  const waiting = Array.isArray(r.waiting) ? r.waiting.filter((g) => g && typeof g === 'object') as Record<string, unknown>[] : [];
  return {
    waiting: waiting.map((g) => ({
      from: cleanFriendCode(str(g.from)), name: str(g.name, 14) || 'A friend', color: safeColor(g.color), avatar: cleanAvatar(g.avatar),
      amount: whole(g.amount), at: Number(g.at) || 0,
    })).filter((g) => g.amount > 0),
    left: Math.min(GIFT_SEND_DAY, whole(r.left)),
  };
}

async function rpc(auth: OnlineAuth, name: string, body: Record<string, unknown>, fetchFn?: Fetch): Promise<Record<string, unknown>> {
  try {
    return ((await restRequest(auth, `rpc/${name}`, { method: 'POST', body }, fetchFn)) ?? {}) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof OnlineError && err.status === 404) throw new GiftsNotSetUpError('Sending chips isn\'t switched on yet.', 404);
    throw err;
  }
}

/** Gifts waiting for this account, and how much it can still send today. */
export async function syncGifts(auth: OnlineAuth, fetchFn?: Fetch): Promise<GiftsState> {
  return parseGifts(await rpc(auth, 'gifts_sync', {}, fetchFn));
}

/** Problems the browser can spot before asking the server, or '' when a gift looks fine. */
export function giftProblem(p: Profile, amount: number, left: number): string {
  if (!Number.isFinite(amount) || amount < GIFT_MIN) return `Send at least ${GIFT_MIN} chips.`;
  if (amount > GIFT_MAX) return `A gift can be at most ${GIFT_MAX.toLocaleString('en-US')} chips.`;
  if (p.table) return 'Leave your table first. Gifts come out of your bank.';
  if (p.stats.hands + (p.achievements.counters['bj.hands'] ?? 0) < GIFT_MIN_HANDS) return `Play ${GIFT_MIN_HANDS} hands before sending chips.`;
  if (amount > left) return `You can send ${left.toLocaleString('en-US')} more chips today.`;
  if (amount > p.bank) return `Your bank only has ${p.bank.toLocaleString('en-US')} chips.`;
  return '';
}

/**
 * Sends chips from player `p` to the friend with this code. The server takes them out of the
 * saved bank; this takes the same amount out of `p`, which the caller then saves. Save `p`
 * before calling, so the server's bank is up to date.
 */
export async function sendChips(auth: OnlineAuth, p: Profile, code: string, amount: number, fetchFn?: Fetch): Promise<{ amount: number; left: number; name: string }> {
  const r = await rpc(auth, 'send_chips', { p_player: p.id, p_code: cleanFriendCode(code), p_amount: Math.floor(amount) }, fetchFn);
  const sent = whole(r.amount);
  p.bank = Math.max(0, p.bank - sent);
  p.updatedAt = Date.now();
  noteChips(p, p.updatedAt);
  return { amount: sent, left: whole(r.left), name: str(r.name, 14) || 'your friend' };
}

/** Collects every gift waiting, into player `p`'s bank. The caller saves `p`. */
export async function collectGifts(auth: OnlineAuth, p: Profile, fetchFn?: Fetch): Promise<{ amount: number; gifts: { name: string; amount: number }[] }> {
  const r = await rpc(auth, 'collect_gifts', { p_player: p.id }, fetchFn);
  const amount = whole(r.amount);
  if (amount > 0) {
    p.bank += amount;
    p.stats.peakBank = Math.max(p.stats.peakBank, p.bank);
    p.updatedAt = Date.now();
    noteChips(p, p.updatedAt);
  }
  const gifts = Array.isArray(r.gifts) ? (r.gifts as Record<string, unknown>[]).map((g) => ({ name: str(g?.name, 14) || 'A friend', amount: whole(g?.amount) })) : [];
  return { amount, gifts };
}
