import { Card, Rng, fullDeck } from '../engine/cards';
import { VariantDef, showdownValue } from '../engine/variants';
import { startingPercentile } from './strength';
import { PlayerView } from './view';

export interface OpponentSpec {
  /** Cards of theirs we can see. */
  known: Card[];
  /** Cards they hold that we cannot see. */
  unknown: number;
  /** Cards they will still receive. */
  future: number;
  /** Only sample hidden hole cards from their top `range` fraction (flop games). */
  range?: number;
}

export interface EquitySpec {
  variant: VariantDef;
  mine: Card[];
  myFuture: number;
  opponents: OpponentSpec[];
  board: Card[];
  boardFuture: number;
  dead: Card[];
}

export interface EquityOptions {
  iterations: number;
  rng: Rng;
  /** Stop early after this many milliseconds. */
  timeBudgetMs?: number;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Monte Carlo share of the pot this hand expects to win against the given opponents,
 * counting split pots and hi-lo halves. Works the same way for every variant.
 */
export function simulateEquity(spec: EquitySpec, opts: EquityOptions): number {
  const { variant: v } = spec;
  if (!spec.opponents.length) return 1;
  const used = new Set<Card>([...spec.mine, ...spec.board, ...spec.dead, ...spec.opponents.flatMap((o) => o.known)]);
  const pool = fullDeck(v.shortDeck).filter((c) => !used.has(c));
  const need = spec.myFuture + spec.boardFuture + spec.opponents.reduce((t, o) => t + o.unknown + o.future, 0);
  if (need > pool.length) return 1 / (spec.opponents.length + 1);

  const start = now();
  let total = 0;
  let it = 0;
  const rng = opts.rng;
  const oppHands: Card[][] = spec.opponents.map(() => []);
  const len = pool.length;

  for (; it < opts.iterations; it++) {
    if (opts.timeBudgetMs && (it & 31) === 31 && now() - start > opts.timeBudgetMs) break;
    let top = 0;
    const take = (k: number, out: Card[]) => {
      for (let j = 0; j < k; j++) {
        const r = top + Math.floor(rng.next() * (len - top));
        const t = pool[top];
        pool[top] = pool[r];
        pool[r] = t;
        out.push(pool[top++]);
      }
    };

    for (let o = 0; o < spec.opponents.length; o++) {
      const opp = spec.opponents[o];
      const hand = oppHands[o];
      hand.length = 0;
      for (const c of opp.known) hand.push(c);
      if (opp.range !== undefined && opp.range < 1 && opp.unknown > 0) {
        const mark = top;
        for (let tries = 0; tries < 12; tries++) {
          top = mark;
          hand.length = opp.known.length;
          take(opp.unknown, hand);
          if (startingPercentile(v, hand) >= 1 - opp.range) break;
        }
      } else {
        take(opp.unknown, hand);
      }
      take(opp.future, hand);
    }
    const mine = spec.mine.slice();
    take(spec.myFuture, mine);
    const board = spec.board.slice();
    take(spec.boardFuture, board);

    const me = showdownValue(v, mine, board);
    const vals = oppHands.map((h) => showdownValue(v, h, board));
    total += shareOf(v, me, vals);
  }
  return it ? total / it : 1 / (spec.opponents.length + 1);
}

function shareOf(v: VariantDef, me: { hi: number | null; lo: number | null }, opps: { hi: number | null; lo: number | null }[]): number {
  let hiShare = 0;
  if (!v.lowOnly) {
    let best = me.hi!;
    let ties = 1;
    let mineBest = true;
    for (const o of opps) {
      if (o.hi! > best) {
        best = o.hi!;
        mineBest = false;
        ties = 1;
      } else if (o.hi === best) ties++;
    }
    hiShare = mineBest ? 1 / ties : 0;
  }
  if (!v.hiLo && !v.lowOnly) return hiShare;
  let bestLo = Infinity;
  for (const x of [me, ...opps]) if (x.lo !== null && x.lo < bestLo) bestLo = x.lo;
  if (bestLo === Infinity) return v.lowOnly ? 0 : hiShare;
  let loTies = 0;
  for (const x of [me, ...opps]) if (x.lo === bestLo) loTies++;
  const loShare = me.lo === bestLo ? 1 / loTies : 0;
  return v.lowOnly ? loShare : (hiShare + loShare) / 2;
}

/** Build the simulation for one seat from what it can see. `keep` overrides held cards for draw planning. */
export function specFromView(view: PlayerView, opts: { keep?: Card[]; ranges?: (number | undefined)[] } = {}): EquitySpec {
  const v = view.variant;
  const fam = v.family;
  const dead: Card[] = [];
  const opponents: OpponentSpec[] = [];
  view.players.forEach((p, i) => {
    if (i === view.me) return;
    if (p.status === 'folded') {
      dead.push(...p.upCards);
      return;
    }
    if (fam === 'stud') {
      opponents.push({ known: [...p.upCards], unknown: p.hiddenCount, future: Math.max(0, 7 - p.totalCards - view.board.length) });
    } else if (fam === 'draw') {
      opponents.push({ known: [], unknown: 5, future: 0 });
    } else {
      opponents.push({ known: [], unknown: v.holeCards, future: 0, range: opts.ranges?.[i] });
    }
  });
  let mine = view.myCards;
  let myFuture = 0;
  if (opts.keep) {
    mine = opts.keep;
    myFuture = view.myCards.length - opts.keep.length;
    // Discarded cards are gone for good.
    dead.push(...view.myCards.filter((c) => !opts.keep!.includes(c)));
  }
  if (fam === 'stud') myFuture = Math.max(0, 7 - mine.length - view.board.length);
  const boardFuture = fam === 'flop' ? 5 - view.board.length : 0;
  return { variant: v, mine, myFuture, opponents, board: view.board, boardFuture, dead };
}
