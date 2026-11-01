// Friends, who's online, and table invites, answered by database functions in
// supabase/friends.sql. Friends are known by their friend code; the server never hands out an
// email or account id, and only friends see each other's name and online status.
import { VARIANTS, VariantId, STRUCTURE_NAMES, Structure } from '../engine/variants';
import { OnlineAuth, OnlineError, restRequest } from './online';
import { safeColor } from './profile';
import { cleanAvatar } from './avatars';

type Fetch = typeof fetch;

/** Friend codes: six letters and digits, without 0/O or 1/I. */
export const FRIEND_CODE = /^[A-HJ-NP-Z2-9]{6}$/;

/** Tidies a friend code someone typed or pasted: capitals, no spaces or dashes. */
export const cleanFriendCode = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

export interface FriendCard {
  code: string;
  name: string;
  color: string;
  /** Their face (see avatars.ts), or null for their first letter. */
  avatar: string | null;
  /** Achievement id of the title they wear, only if they've earned it. */
  title: string | null;
}

export interface Friend extends FriendCard {
  online: boolean;
  /** When they last had the game open, epoch ms. */
  seen: number;
}

export interface TableInvite {
  /** The friend code of whoever sent it. */
  from: string;
  name: string;
  color: string;
  avatar: string | null;
  /** The table's code. */
  table: string;
  /** What's played there, for showing: "Pot Limit Omaha", "Blackjack". */
  game: string;
  at: number;
}

export interface FriendsState {
  /** This account's own friend code. */
  code: string;
  friends: Friend[];
  /** Requests waiting for this account to say yes or no. */
  incoming: FriendCard[];
  /** Requests this account sent that haven't been answered. */
  outgoing: FriendCard[];
  invites: TableInvite[];
}

/** Thrown when supabase/friends.sql hasn't been run on the project yet. */
export class FriendsNotSetUpError extends OnlineError {}

const str = (x: unknown, max = 40): string => (typeof x === 'string' ? x.slice(0, max) : '');

function card(r: Record<string, unknown>): FriendCard {
  return { code: cleanFriendCode(str(r.code)), name: str(r.name, 14) || 'Player', color: safeColor(r.color), avatar: cleanAvatar(r.avatar), title: typeof r.title === 'string' ? r.title : null };
}

function gameText(r: Record<string, unknown>): string {
  if (r.game === 'blackjack') return 'Blackjack';
  const v = VARIANTS[r.variant as VariantId];
  const st = STRUCTURE_NAMES[r.structure as Structure];
  return v ? `${st ? `${st} ` : ''}${v.name}` : 'Poker';
}

const list = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.filter((r) => r && typeof r === 'object') : []);

/** Reads the server's answer, keeping only well-formed values. */
export function parseFriends(r: Record<string, unknown>): FriendsState {
  return {
    code: cleanFriendCode(str(r.code)),
    friends: list(r.friends).map((f) => ({ ...card(f), online: f.online === true, seen: Number(f.seen) || 0 })),
    incoming: list(r.incoming).map(card),
    outgoing: list(r.outgoing).map(card),
    invites: list(r.invites).map((i) => ({
      from: cleanFriendCode(str(i.from)), name: str(i.name, 14) || 'A friend', color: safeColor(i.color), avatar: cleanAvatar(i.avatar),
      table: str(i.table, 8).toUpperCase().replace(/[^A-Z0-9]/g, ''), game: gameText(i), at: Number(i.at) || 0,
    })).filter((i) => i.table),
  };
}

async function rpc(auth: OnlineAuth, name: string, body: Record<string, unknown>, fetchFn?: Fetch): Promise<unknown> {
  try {
    return await restRequest(auth, `rpc/${name}`, { method: 'POST', body }, fetchFn);
  } catch (err) {
    if (err instanceof OnlineError && err.status === 404) throw new FriendsNotSetUpError('Friends aren\'t switched on yet.', 404);
    throw err;
  }
}

/** Marks this account as online and reads the friends list, requests and invites. */
export async function syncFriends(auth: OnlineAuth, fetchFn?: Fetch): Promise<FriendsState> {
  return parseFriends(((await rpc(auth, 'friends_sync', {}, fetchFn)) ?? {}) as Record<string, unknown>);
}

/** Sends a friend request. 'friends' when they had already asked this account. */
export async function addFriend(auth: OnlineAuth, code: string, fetchFn?: Fetch): Promise<{ status: 'requested' | 'friends'; name: string }> {
  const r = ((await rpc(auth, 'friends_add', { p_code: cleanFriendCode(code) }, fetchFn)) ?? {}) as Record<string, unknown>;
  return { status: r.status === 'friends' ? 'friends' : 'requested', name: str(r.name, 14) || 'Player' };
}

export async function answerFriend(auth: OnlineAuth, code: string, accept: boolean, fetchFn?: Fetch): Promise<void> {
  await rpc(auth, 'friends_answer', { p_code: code, p_accept: accept }, fetchFn);
}

/** Ends a friendship, or takes back a request. */
export async function removeFriend(auth: OnlineAuth, code: string, fetchFn?: Fetch): Promise<void> {
  await rpc(auth, 'friends_remove', { p_code: code }, fetchFn);
}

/** Invites a friend to the online table with this code. The server checks this account is at it. */
export async function inviteFriend(auth: OnlineAuth, code: string, table: string, fetchFn?: Fetch): Promise<void> {
  await rpc(auth, 'friends_invite', { p_code: code, p_table: table }, fetchFn);
}

/** Clears a friend's invite (after joining, or saying no thanks). */
export async function dismissInvite(auth: OnlineAuth, from: string, fetchFn?: Fetch): Promise<void> {
  await rpc(auth, 'friends_dismiss', { p_code: from }, fetchFn);
}

/** "Online", "Seen 5m ago", "Seen 3h ago", "Seen 2d ago". */
export function seenText(f: Pick<Friend, 'online' | 'seen'>, now = Date.now()): string {
  if (f.online) return 'Online';
  if (!f.seen) return 'Not seen yet';
  const mins = Math.max(1, Math.floor((now - f.seen) / 60_000));
  if (mins < 60) return `Seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `Seen ${hours}h ago`;
  return `Seen ${Math.floor(hours / 24)}d ago`;
}
