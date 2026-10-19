import { Card, rankName, rankPlural } from './cards';

/**
 * High hands score as integers where bigger is better:
 *   category * 0x100000 + five 4-bit rank slots (most significant first).
 * Low hands (ace-to-five) use the same packing but smaller is better.
 */
export const Cat = {
  HIGH: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
} as const;

// Short deck ranks flushes above full houses and trips above straights.
// The mapping swaps 3<->4 and 5<->6, so it is its own inverse.
const SHORT_MAP = [0, 1, 2, 4, 3, 6, 5, 7, 8];

const CAT_UNIT = 0x100000;

function pack(cat: number, a = 0, b = 0, c = 0, d = 0, e = 0): number {
  return cat * CAT_UNIT + (a << 16) + (b << 12) + (c << 8) + (d << 4) + e;
}

const scoreOf = (cat: number, short: boolean, a = 0, b = 0, c = 0, d = 0, e = 0) =>
  pack(short ? SHORT_MAP[cat] : cat, a, b, c, d, e);

const WHEEL = (1 << 14) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5);
const SHORT_WHEEL = (1 << 14) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9);

/** Highest card of the best straight in a rank bitmask, or 0. */
function straightHigh(mask: number, short: boolean): number {
  const lowest = short ? 10 : 6;
  for (let h = 14; h >= lowest; h--) if (((mask >> (h - 4)) & 31) === 31) return h;
  if (short) return (mask & SHORT_WHEEL) === SHORT_WHEEL ? 9 : 0;
  return (mask & WHEEL) === WHEEL ? 5 : 0;
}

const counts = new Int32Array(15);
const suitMask = new Int32Array(4);
const suitCount = new Int32Array(4);

/**
 * Best high hand from any number of cards (1..7+). With fewer than five cards
 * only pairs/trips/quads and kickers count, which is what stud uses to decide
 * who acts first from the up cards.
 */
export function evalHigh(cards: readonly Card[], short = false): number {
  counts.fill(0);
  suitMask.fill(0);
  suitCount.fill(0);
  let mask = 0;
  const n = cards.length;
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    const r = (c >> 2) + 2;
    const s = c & 3;
    counts[r]++;
    suitCount[s]++;
    suitMask[s] |= 1 << r;
    mask |= 1 << r;
  }

  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (suitCount[s] >= 5) flushSuit = s;
  if (flushSuit >= 0) {
    const sf = straightHigh(suitMask[flushSuit], short);
    if (sf) return scoreOf(Cat.STRAIGHT_FLUSH, short, sf);
  }

  const quads: number[] = [];
  const trips: number[] = [];
  const pairs: number[] = [];
  const singles: number[] = [];
  for (let r = 14; r >= 2; r--) {
    switch (counts[r]) {
      case 4: quads.push(r); break;
      case 3: trips.push(r); break;
      case 2: pairs.push(r); break;
      case 1: singles.push(r); break;
    }
  }

  if (quads.length) {
    const q = quads[0];
    let kick = 0;
    for (let r = 14; r >= 2; r--) if (r !== q && counts[r] > 0) { kick = r; break; }
    return scoreOf(Cat.QUADS, short, q, kick);
  }

  let full = -1;
  if (trips.length) {
    const p = Math.max(trips[1] ?? 0, pairs[0] ?? 0);
    if (p) full = scoreOf(Cat.FULL_HOUSE, short, trips[0], p);
  }

  let flush = -1;
  if (flushSuit >= 0) {
    const top: number[] = [];
    const m = suitMask[flushSuit];
    for (let r = 14; r >= 2 && top.length < 5; r--) if (m & (1 << r)) top.push(r);
    flush = scoreOf(Cat.FLUSH, short, top[0], top[1], top[2], top[3], top[4]);
  }

  const st = n >= 5 ? straightHigh(mask, short) : 0;
  const straight = st ? scoreOf(Cat.STRAIGHT, short, st) : -1;

  const tripsScore = trips.length ? scoreOf(Cat.TRIPS, short, trips[0], singles[0] ?? 0, singles[1] ?? 0) : -1;

  if (short) {
    if (flush >= 0) return flush;
    if (full >= 0) return full;
    if (tripsScore >= 0) return tripsScore;
    if (straight >= 0) return straight;
  } else {
    if (full >= 0) return full;
    if (flush >= 0) return flush;
    if (straight >= 0) return straight;
    if (tripsScore >= 0) return tripsScore;
  }

  if (pairs.length >= 2) {
    const kick = Math.max(pairs[2] ?? 0, singles[0] ?? 0);
    return scoreOf(Cat.TWO_PAIR, short, pairs[0], pairs[1], kick);
  }
  if (pairs.length === 1) return scoreOf(Cat.PAIR, short, pairs[0], singles[0] ?? 0, singles[1] ?? 0, singles[2] ?? 0);
  return scoreOf(Cat.HIGH, short, singles[0] ?? 0, singles[1] ?? 0, singles[2] ?? 0, singles[3] ?? 0, singles[4] ?? 0);
}

const OMAHA_HOLE_PAIRS: [number, number][] = [];
const OMAHA_BOARD_TRIPLES: [number, number, number][] = [];
for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) OMAHA_HOLE_PAIRS.push([i, j]);
for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) for (let k = j + 1; k < 5; k++) OMAHA_BOARD_TRIPLES.push([i, j, k]);

const five: Card[] = [0, 0, 0, 0, 0];

/** Omaha high: exactly two hole cards plus exactly three board cards. */
export function evalOmahaHigh(hole: readonly Card[], board: readonly Card[]): number {
  let best = -1;
  for (const [a, b] of OMAHA_HOLE_PAIRS) {
    if (a >= hole.length || b >= hole.length) continue;
    for (const [x, y, z] of OMAHA_BOARD_TRIPLES) {
      if (z >= board.length) continue;
      five[0] = hole[a]; five[1] = hole[b]; five[2] = board[x]; five[3] = board[y]; five[4] = board[z];
      const v = evalHigh(five);
      if (v > best) best = v;
    }
  }
  return best;
}

// ---- Low hands (ace-to-five: aces low, straights and flushes ignored) ----

const lowRank = (c: Card): number => {
  const r = (c >> 2) + 2;
  return r === 14 ? 1 : r;
};

/** Score up to five low ranks (ace = 1). Pairs make a hand worse. Lower is better. */
function scoreLowRanks(ranks: number[]): number {
  const cnt = new Map<number, number>();
  for (const r of ranks) cnt.set(r, (cnt.get(r) ?? 0) + 1);
  const groups = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]);
  let cat = 0;
  if (shape[0] === 4) cat = 5;
  else if (shape[0] === 3 && shape[1] === 2) cat = 4;
  else if (shape[0] === 3) cat = 3;
  else if (shape[0] === 2 && shape[1] === 2) cat = 2;
  else if (shape[0] === 2) cat = 1;
  const order: number[] = [];
  for (const [r, k] of groups) for (let i = 0; i < k; i++) order.push(r);
  return pack(cat, order[0] ?? 0, order[1] ?? 0, order[2] ?? 0, order[3] ?? 0, order[4] ?? 0);
}

/**
 * Best ace-to-five low from any number of cards.
 * With `eightOrBetter`, returns null unless five different ranks of eight or lower exist.
 * With fewer than five cards it scores what is there (used for razz up cards).
 */
export function evalLow(cards: readonly Card[], eightOrBetter = false): number | null {
  const distinct = [...new Set(cards.map(lowRank))].sort((a, b) => a - b);
  if (distinct.length >= 5) {
    const best = distinct.slice(0, 5);
    if (eightOrBetter && best[4] > 8) return null;
    return pack(0, best[4], best[3], best[2], best[1], best[0]);
  }
  if (eightOrBetter) return null;
  if (cards.length <= 5) return scoreLowRanks(cards.map(lowRank));
  // Fewer than five ranks among 6+ cards: keep the lowest ranks and the fewest duplicates.
  const all = cards.map(lowRank).sort((a, b) => a - b);
  const chosen: number[] = [...distinct];
  const extras = all.slice();
  for (const r of distinct) extras.splice(extras.indexOf(r), 1);
  while (chosen.length < 5 && extras.length) chosen.push(extras.shift()!);
  return scoreLowRanks(chosen);
}

/** Omaha eight-or-better low: two hole cards plus three board cards, or null. */
export function evalOmahaLow(hole: readonly Card[], board: readonly Card[]): number | null {
  let best: number | null = null;
  for (const [a, b] of OMAHA_HOLE_PAIRS) {
    if (b >= hole.length) continue;
    const h1 = lowRank(hole[a]);
    const h2 = lowRank(hole[b]);
    if (h1 > 8 || h2 > 8 || h1 === h2) continue;
    for (const [x, y, z] of OMAHA_BOARD_TRIPLES) {
      if (z >= board.length) continue;
      const rs = [h1, h2, lowRank(board[x]), lowRank(board[y]), lowRank(board[z])];
      if (new Set(rs).size !== 5 || rs.some((r) => r > 8)) continue;
      rs.sort((p, q) => q - p);
      const v = pack(0, rs[0], rs[1], rs[2], rs[3], rs[4]);
      if (best === null || v < best) best = v;
    }
  }
  return best;
}

// ---- Descriptions ----

export function categoryOf(score: number, short = false): number {
  const c = Math.floor(score / CAT_UNIT);
  return short ? SHORT_MAP[c] : c;
}

const slot = (score: number, i: number) => (score >> (16 - 4 * i)) & 15;

export function describeHigh(score: number, short = false): string {
  const cat = categoryOf(score, short);
  const a = slot(score, 0);
  const b = slot(score, 1);
  switch (cat) {
    case Cat.STRAIGHT_FLUSH:
      return a === 14 ? 'Royal Flush' : `Straight Flush, ${rankName(a)} high`;
    case Cat.QUADS: return `Four ${rankPlural(a)}`;
    case Cat.FULL_HOUSE: return `Full House, ${rankPlural(a)} full of ${rankPlural(b)}`;
    case Cat.FLUSH: return `Flush, ${rankName(a)} high`;
    case Cat.STRAIGHT: return `Straight, ${rankName(a)} high`;
    case Cat.TRIPS: return `Three ${rankPlural(a)}`;
    case Cat.TWO_PAIR: return `Two Pair, ${rankPlural(a)} and ${rankPlural(b)}`;
    case Cat.PAIR: return `Pair of ${rankPlural(a)}`;
    default: return a ? `${rankName(a)} high` : 'Nothing';
  }
}

const LOW_CHARS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];

export function describeLow(score: number): string {
  const cat = Math.floor(score / CAT_UNIT);
  const ranks: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = slot(score, i);
    if (r) ranks.push(LOW_CHARS[r]);
  }
  return `${ranks.join('-')} low${cat > 0 ? ' (paired)' : ''}`;
}
