import { Card, Rng, rankOf, suitOf } from '../engine/cards';
import { Cat, categoryOf, evalHigh } from '../engine/evaluator';
import { Difficulty } from '../engine/table';

const idxWhere = (cards: Card[], keep: (c: Card, i: number) => boolean) =>
  cards.map((c, i) => (keep(c, i) ? -1 : i)).filter((i) => i >= 0);

/** Indices of the four cards making an open-ended (or, if allowed, inside) straight draw. */
function straightDraw(cards: Card[], allowGutshot: boolean): number[] | null {
  const ranks = cards.map(rankOf);
  for (let low = 10; low >= 1; low--) {
    for (const span of allowGutshot ? [4, 5] : [4]) {
      const want: number[] = [];
      for (let r = low; r < low + span; r++) want.push(r === 1 ? 14 : r);
      const hits = want.filter((r) => ranks.includes(r));
      const needed = span === 4 ? 4 : 4;
      if (hits.length < needed) continue;
      if (span === 4 && (low === 1 || low + 3 === 14)) continue; // one-ended, treat as a gutshot
      const keep: number[] = [];
      const seen = new Set<number>();
      ranks.forEach((r, i) => {
        if (want.includes(r) && !seen.has(r)) {
          seen.add(r);
          keep.push(i);
        }
      });
      if (keep.length >= 4) return keep.slice(0, 4);
    }
  }
  return null;
}

/** Which cards to throw away in Five Card Draw. Weaker bots make classic mistakes. */
export function chooseDiscards(cards: Card[], skill: Difficulty, rng: Rng): number[] {
  const score = evalHigh(cards);
  const cat = categoryOf(score);
  const ranks = cards.map(rankOf);
  const count = (r: number) => ranks.filter((x) => x === r).length;
  const sloppy = skill === 'beginner' || skill === 'easy';

  if (cat >= Cat.STRAIGHT) return [];
  if (cat === Cat.QUADS) return [];
  if (cat === Cat.TRIPS) return idxWhere(cards, (c) => count(rankOf(c)) === 3);
  if (cat === Cat.TWO_PAIR) return idxWhere(cards, (c) => count(rankOf(c)) === 2);

  const suits = [0, 1, 2, 3].map((s) => cards.filter((c) => suitOf(c) === s).length);
  const flushSuit = suits.findIndex((k) => k === 4);
  const pairRank = cat === Cat.PAIR ? ranks.find((r) => count(r) === 2)! : 0;

  // A four-flush beats a small pair; strong players keep a big pair instead.
  if (flushSuit >= 0 && (pairRank === 0 || (pairRank < 11 && !sloppy) || (sloppy && rng.next() < 0.7))) {
    return idxWhere(cards, (c) => suitOf(c) === flushSuit);
  }

  if (cat === Cat.PAIR) {
    // Keeping an ace kicker with a small pair is a common (weak) habit.
    const aceKick = ranks.includes(14) && pairRank !== 14;
    if (aceKick && (sloppy ? rng.next() < 0.6 : rng.next() < 0.1)) {
      return idxWhere(cards, (c) => rankOf(c) === pairRank || rankOf(c) === 14);
    }
    return idxWhere(cards, (c) => rankOf(c) === pairRank);
  }

  const sd = straightDraw(cards, sloppy && rng.next() < 0.5);
  if (sd) return cards.map((_, i) => i).filter((i) => !sd.includes(i));

  // Nothing: keep the high cards.
  const order = cards.map((c, i) => ({ r: rankOf(c), i })).sort((a, b) => b.r - a.r);
  if (sloppy && rng.next() < 0.3) return order.slice(2).map((o) => o.i); // keeps two of anything
  if (order[0].r === 14 && order[1].r >= 13) return order.slice(2).map((o) => o.i);
  if (order[0].r >= 13) return order.slice(1).map((o) => o.i);
  return order.slice(skill === 'expert' ? 0 : 1).map((o) => o.i);
}
