// Shared hands: one saved hand packed into a link a friend can open to watch the replay.
// The whole hand travels in the link itself (after the #, so it never reaches a server),
// and anything read back from a link is checked field by field before it is shown,
// because anyone can make one.
import { Card } from './cards';
import { HandHistory, HistoryAction, HistoryPlayer } from './history';
import { STRUCTURE_NAMES, Structure, VARIANTS, VariantId } from './variants';

/** The part of the address after # that carries a shared hand. */
export const SHARE_PREFIX = 'hand=';

const MAX_LINK = 12000;
const MAX_PLAYERS = 10;
const MAX_ACTIONS = 400;
const MAX_NAME = 40;
const MAX_LINE = 240;
const MAX_CHIPS = 1e12;
const ACTION_TYPES = new Set<HistoryAction[2]>(['fold', 'check', 'call', 'raise', 'bringin', 'draw', 'blind', 'ante']);

/** The hand as it goes out in a link: nothing that points back to a table or a device. */
export function shareableHand(h: HandHistory): HandHistory {
  return {
    ...h,
    id: 'shared',
    // "Online · K7QD" would hand out a private table's code.
    where: h.where.startsWith('Online') ? 'Online' : h.where,
  };
}

// ---------- packing ----------

const toB64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64 = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const canZip = (): boolean => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      void reader.cancel();
      throw new Error('too big');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

/**
 * Packs a hand for a link: "z" + deflated JSON in base64url, or "j" + plain JSON in
 * base64url where the browser can't compress.
 */
export async function encodeSharedHand(h: HandHistory): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(shareableHand(h)));
  if (canZip()) {
    try {
      return `z${toB64(await through(json, new CompressionStream('deflate-raw')))}`;
    } catch {
      /* fall through to plain */
    }
  }
  return `j${toB64(json)}`;
}

/** Reads a hand back from a link, or null when the link is damaged, too old or made up. */
export async function decodeSharedHand(code: string): Promise<HandHistory | null> {
  try {
    if (code.length > MAX_LINK || !/^[zj][A-Za-z0-9_-]+$/.test(code)) return null;
    const raw = fromB64(code.slice(1));
    let bytes: Uint8Array;
    if (code[0] === 'z') {
      if (!canZip()) return null;
      bytes = await through(raw, new DecompressionStream('deflate-raw'), 200_000);
    } else bytes = raw;
    return cleanSharedHand(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/** The hand from an address's # part ("#hand=…"), if it has one. */
export function sharedCodeIn(hash: string): string | null {
  const s = hash.replace(/^#/, '');
  return s.startsWith(SHARE_PREFIX) ? s.slice(SHARE_PREFIX.length) : null;
}

// ---------- checking ----------

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const chips = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_CHIPS ? x : null);
const index = (x: unknown, n: number): number | null => (Number.isInteger(x) && (x as number) >= 0 && (x as number) < n ? (x as number) : null);
const text = (x: unknown, max: number): string | null => (typeof x === 'string' && x.length <= max ? x : null);
const card = (x: unknown): Card | null | undefined => (x === null ? null : Number.isInteger(x) && (x as number) >= 0 && (x as number) < 52 ? (x as Card) : undefined);

/**
 * Rebuilds a hand from untrusted data, keeping only fields of the right shape and size,
 * or null if anything the replay relies on is missing or out of range.
 */
export function cleanSharedHand(x: unknown): HandHistory | null {
  if (!isObj(x) || x.v !== 1) return null;
  if (typeof x.variant !== 'string' || !Object.prototype.hasOwnProperty.call(VARIANTS, x.variant)) return null;
  const variant = x.variant as VariantId;
  const v = VARIANTS[variant];
  if (typeof x.structure !== 'string' || !Object.prototype.hasOwnProperty.call(STRUCTURE_NAMES, x.structure)) return null;
  if (!isObj(x.stakes) || !Array.isArray(x.players) || !Array.isArray(x.actions) || !Array.isArray(x.board) || !Array.isArray(x.summary)) return null;

  const n = x.players.length;
  if (n < 2 || n > Math.min(MAX_PLAYERS, v.maxPlayers)) return null;
  const maxCards = v.family === 'stud' ? 7 : v.family === 'draw' ? v.holeCards * 4 : v.holeCards;
  const players: HistoryPlayer[] = [];
  for (const p of x.players) {
    if (!isObj(p) || !Array.isArray(p.cards) || p.cards.length > maxCards) return null;
    const name = text(p.name, MAX_NAME);
    const start = chips(p.start);
    const end = chips(p.end);
    const won = chips(p.won);
    const cards = p.cards.map(card);
    const handName = p.handName === null || p.handName === undefined ? null : text(p.handName, MAX_LINE);
    if (name === null || start === null || end === null || won === null || cards.some((c) => c === undefined)) return null;
    if (handName === null && p.handName != null) return null;
    players.push({ name, start, end, won, cards: cards as (Card | null)[], shown: p.shown === true, handName });
  }

  const s = x.stakes;
  const stakes = { sb: chips(s.sb), bb: chips(s.bb), ante: chips(s.ante), bringIn: chips(s.bringIn), smallBet: chips(s.smallBet), bigBet: chips(s.bigBet) };
  if (Object.values(stakes).some((c) => c === null)) return null;

  if (x.board.length > 5) return null;
  const board = x.board.map(card);
  if (board.some((c) => c === null || c === undefined)) return null;

  if (x.actions.length > MAX_ACTIONS) return null;
  const actions: HistoryAction[] = [];
  for (const a of x.actions) {
    if (!Array.isArray(a) || a.length < 6 || a.length > 7) return null;
    const player = index(a[0], n);
    const street = index(a[1], 7);
    const type = a[2] as HistoryAction[2];
    const amount = chips(a[3]);
    const to = chips(a[4]);
    if (player === null || street === null || !ACTION_TYPES.has(type) || amount === null || to === null || (a[5] !== 0 && a[5] !== 1)) return null;
    const row: HistoryAction = [player, street, type, amount, to, a[5]];
    if (a.length === 7) {
      const d = a[6];
      if (!Array.isArray(d) || d.length > v.holeCards || d.some((k) => index(k, v.holeCards) === null)) return null;
      row.push([...(d as number[])]);
    }
    actions.push(row);
  }

  if (x.summary.length > 20) return null;
  const summary = x.summary.map((l) => text(l, MAX_LINE));
  if (summary.some((l) => l === null)) return null;

  const me = index(x.me, n);
  const button = index(x.button, n);
  const at = typeof x.at === 'number' && Number.isFinite(x.at) && x.at >= 0 && x.at <= 8.64e15 ? x.at : null;
  const number = chips(x.number);
  const where = text(x.where, MAX_NAME);
  if (me === null || button === null || at === null || number === null || where === null) return null;

  return {
    v: 1,
    id: 'shared',
    at,
    variant,
    structure: x.structure as Structure,
    stakes: stakes as HandHistory['stakes'],
    button,
    me,
    where,
    number: Math.floor(number),
    players,
    board: board as Card[],
    actions,
    showdown: x.showdown === true,
    summary: summary as string[],
  };
}
