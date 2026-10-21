// Video poker: five cards from a fresh 52-card deck, hold any of them, draw once, and the
// final hand is paid from the machine's pay table. Pure rules and no DOM; hands are scored by
// the same evaluator the poker tables use.
//
// Three machines, each the full-pay version found in casinos:
//   Jacks or Better 9/6, Bonus Poker 8/5 and Double Double Bonus 9/6.
// Bets are 1 to 5 coins. Every line pays per coin, except the royal flush, which jumps from
// 250 to 800 a coin on the fifth coin, so max coin is always the right way to play.
import { Card, Rng, fullDeck, rankOf, shuffle } from './cards';
import { Cat, categoryOf, evalHigh } from './evaluator';

export type Machine = 'jacks' | 'bonus' | 'ddb';
export const MACHINES: Machine[] = ['jacks', 'bonus', 'ddb'];
export const MACHINE_NAMES: Record<Machine, string> = { jacks: 'Jacks or Better', bonus: 'Bonus Poker', ddb: 'Double Double Bonus' };

export const MAX_COINS = 5;
/** What a royal flush pays per coin on max coin; on fewer coins it pays like any other line. */
export const ROYAL_MAX_COIN = 800;

export type PayLine =
  | 'royal' | 'straightFlush'
  | 'acesKicker' | 'lowKicker' | 'aces' | 'low' | 'quads'
  | 'fullHouse' | 'flush' | 'straight' | 'trips' | 'twoPair' | 'jacks';

export const LINE_NAMES: Record<PayLine, string> = {
  royal: 'Royal Flush',
  straightFlush: 'Straight Flush',
  acesKicker: 'Four Aces + 2, 3 or 4',
  lowKicker: 'Four 2s, 3s or 4s + A–4',
  aces: 'Four Aces',
  low: 'Four 2s, 3s or 4s',
  quads: 'Four of a Kind',
  fullHouse: 'Full House',
  flush: 'Flush',
  straight: 'Straight',
  trips: 'Three of a Kind',
  twoPair: 'Two Pair',
  jacks: 'Jacks or Better',
};

/** Each machine's pay table, best hand first, in coins paid per coin bet. */
export const PAY_TABLES: Record<Machine, [PayLine, number][]> = {
  jacks: [
    ['royal', 250], ['straightFlush', 50], ['quads', 25], ['fullHouse', 9], ['flush', 6],
    ['straight', 4], ['trips', 3], ['twoPair', 2], ['jacks', 1],
  ],
  bonus: [
    ['royal', 250], ['straightFlush', 50], ['aces', 80], ['low', 40], ['quads', 25], ['fullHouse', 8],
    ['flush', 5], ['straight', 4], ['trips', 3], ['twoPair', 2], ['jacks', 1],
  ],
  ddb: [
    ['royal', 250], ['straightFlush', 50], ['acesKicker', 400], ['lowKicker', 160], ['aces', 160], ['low', 80],
    ['quads', 50], ['fullHouse', 9], ['flush', 6], ['straight', 4], ['trips', 3], ['twoPair', 1], ['jacks', 1],
  ],
};

/** The pay table's line for a final hand on this machine, or null when it pays nothing. */
export function payLine(hand: readonly Card[], machine: Machine): PayLine | null {
  const score = evalHigh(hand);
  const cat = categoryOf(score);
  const top = (score >> 16) & 15;
  switch (cat) {
    case Cat.STRAIGHT_FLUSH: return top === 14 ? 'royal' : 'straightFlush';
    case Cat.QUADS: {
      if (machine === 'jacks') return 'quads';
      const kicker = (score >> 12) & 15;
      const lowQuad = top >= 2 && top <= 4;
      if (machine === 'ddb') {
        if (top === 14) return kicker >= 2 && kicker <= 4 ? 'acesKicker' : 'aces';
        if (lowQuad) return kicker === 14 || (kicker >= 2 && kicker <= 4) ? 'lowKicker' : 'low';
        return 'quads';
      }
      return top === 14 ? 'aces' : lowQuad ? 'low' : 'quads';
    }
    case Cat.FULL_HOUSE: return 'fullHouse';
    case Cat.FLUSH: return 'flush';
    case Cat.STRAIGHT: return 'straight';
    case Cat.TRIPS: return 'trips';
    case Cat.TWO_PAIR: return 'twoPair';
    case Cat.PAIR: return top >= 11 ? 'jacks' : null;
    default: return null;
  }
}

/** What a line pays per coin with this many coins bet. */
export function linePays(machine: Machine, line: PayLine, coins: number): number {
  if (line === 'royal' && coins >= MAX_COINS) return ROYAL_MAX_COIN;
  return PAY_TABLES[machine].find(([l]) => l === line)?.[1] ?? 0;
}

/** One hand at the machine: the deck it came from, the cards showing and which are held. */
export interface VpHand {
  machine: Machine;
  coins: number;
  /** Chips per coin. */
  denom: number;
  deck: Card[];
  /** The next card in the deck to draw. */
  next: number;
  cards: Card[];
  held: boolean[];
  /** The cards as first dealt, before the draw. */
  dealt: Card[];
  drawn: boolean;
}

export interface VpResult {
  line: PayLine | null;
  staked: number;
  paid: number;
  net: number;
  /** How many cards were thrown away on the draw. */
  replaced: number;
}

/** Shuffles a fresh deck and deals five. */
export function dealVp(machine: Machine, coins: number, denom: number, rng: Rng): VpHand {
  const deck = shuffle(fullDeck(), rng);
  const cards = deck.slice(0, 5);
  return { machine, coins, denom, deck, next: 5, cards, held: [false, false, false, false, false], dealt: [...cards], drawn: false };
}

/** Replaces every card not held with the next ones off the deck. */
export function drawVp(hand: VpHand): VpHand {
  if (hand.drawn) return hand;
  let next = hand.next;
  const cards = hand.cards.map((c, i) => (hand.held[i] ? c : hand.deck[next++]));
  return { ...hand, cards, next, drawn: true };
}

/** Pays the final hand. */
export function settleVp(hand: VpHand): VpResult {
  const line = payLine(hand.cards, hand.machine);
  const staked = hand.coins * hand.denom;
  const paid = line ? linePays(hand.machine, line, hand.coins) * hand.coins * hand.denom : 0;
  return { line, staked, paid, net: paid - staked, replaced: hand.held.filter((h) => !h).length };
}

/** True when the hand is four of a kind of any kind, whichever line the machine pays it on. */
export const isQuadsLine = (l: PayLine | null): boolean => l === 'quads' || l === 'aces' || l === 'low' || l === 'acesKicker' || l === 'lowKicker';

/** Four aces, with or without a kicker. */
export const isAcesLine = (l: PayLine | null, hand: readonly Card[]): boolean =>
  isQuadsLine(l) && hand.filter((c) => rankOf(c) === 14).length === 4;
