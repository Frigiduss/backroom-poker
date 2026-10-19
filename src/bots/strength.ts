import { Card, createRng, fullDeck, rankOf, shuffle, suitOf } from '../engine/cards';
import { VariantDef } from '../engine/variants';

/** Chen formula for two hole cards: a quick, well-known Hold'em starting hand score. */
export function chenScore(a: Card, b: Card): number {
  let hi = rankOf(a);
  let lo = rankOf(b);
  if (lo > hi) [hi, lo] = [lo, hi];
  const base = (r: number) => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  let s = base(hi);
  if (hi === lo) return Math.max(5, s * 2);
  if (suitOf(a) === suitOf(b)) s += 2;
  const gap = hi - lo - 1;
  s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 12) s += 1;
  return s;
}

/** Rough Omaha starting hand score: pairs, suits and connectedness all help. */
export function omahaScore(cards: readonly Card[]): number {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  let s = 0;
  const rc = new Map<number, number>();
  for (const r of ranks) rc.set(r, (rc.get(r) ?? 0) + 1);
  for (const [r, k] of rc) {
    if (k === 2) s += 2 + (r - 2) * 0.6;
    if (k >= 3) s -= 3;
  }
  const sc = new Map<number, Card[]>();
  for (const c of cards) {
    const su = suitOf(c);
    if (!sc.has(su)) sc.set(su, []);
    sc.get(su)!.push(c);
  }
  for (const [, cs] of sc) {
    if (cs.length === 2 || cs.length === 3) s += 1 + Math.max(...cs.map(rankOf)) / 5 - (cs.length === 3 ? 1 : 0);
  }
  const uniq = [...new Set(ranks)];
  for (let i = 0; i < uniq.length; i++)
    for (let j = i + 1; j < uniq.length; j++) {
      const d = uniq[i] - uniq[j];
      if (d === 1) s += 1.5;
      else if (d === 2) s += 1;
      else if (d === 3) s += 0.5;
    }
  for (const r of ranks) if (r >= 10) s += (r - 9) * 0.3;
  return s;
}

/** Low-hand starting strength for hi-lo Omaha: A-2, A-3 and wheel cards. */
function omaha8Score(cards: readonly Card[]): number {
  const lows = [...new Set(cards.map(rankOf).map((r) => (r === 14 ? 1 : r)).filter((r) => r <= 8))].sort((a, b) => a - b);
  let s = omahaScore(cards) * 0.6;
  if (lows.includes(1) && lows.includes(2)) s += 5;
  else if (lows.includes(1) && lows.includes(3)) s += 3;
  s += lows.length * 0.8;
  return s;
}

export function startingScore(v: VariantDef, cards: readonly Card[]): number {
  if (v.omaha) return v.hiLo ? omaha8Score(cards) : omahaScore(cards);
  if (cards.length >= 2) return chenScore(cards[0], cards[1]);
  return 0;
}

const distributions = new Map<string, number[]>();

/** Sorted sample of starting scores, used to turn a score into a percentile. */
function distribution(v: VariantDef): number[] {
  const key = v.id;
  let d = distributions.get(key);
  if (d) return d;
  const rng = createRng(12345);
  d = [];
  const deck = fullDeck(v.shortDeck);
  for (let k = 0; k < 3000; k++) {
    shuffle(deck, rng);
    d.push(startingScore(v, deck.slice(0, v.holeCards)));
  }
  d.sort((a, b) => a - b);
  distributions.set(key, d);
  return d;
}

/** Fraction of starting hands this hand beats (0 worst .. 1 best). Flop games only. */
export function startingPercentile(v: VariantDef, cards: readonly Card[]): number {
  const d = distribution(v);
  const s = startingScore(v, cards);
  let lo = 0;
  let hi = d.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  return lo / d.length;
}
