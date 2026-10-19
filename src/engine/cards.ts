/**
 * Cards are small integers: card = (rank - 2) * 4 + suit.
 * rank: 2..14 (14 = Ace), suit: 0 clubs, 1 diamonds, 2 hearts, 3 spades.
 * This ordering also gives the stud bring-in tiebreak (clubs lowest, spades highest).
 */
export type Card = number;

export const RANK_CHARS = '23456789TJQKA';
export const SUIT_CHARS = 'cdhs';
export const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠'];

export const rankOf = (c: Card): number => (c >> 2) + 2;
export const suitOf = (c: Card): number => c & 3;
export const makeCard = (rank: number, suit: number): Card => ((rank - 2) << 2) | suit;

export function parseCard(s: string): Card {
  const r = RANK_CHARS.indexOf(s[0].toUpperCase());
  const su = SUIT_CHARS.indexOf(s[1].toLowerCase());
  if (r < 0 || su < 0) throw new Error(`Bad card: ${s}`);
  return makeCard(r + 2, su);
}

export const parseCards = (s: string): Card[] => s.trim().split(/\s+/).filter(Boolean).map(parseCard);

export const cardToString = (c: Card): string => RANK_CHARS[rankOf(c) - 2] + SUIT_CHARS[suitOf(c)];

export const cardsToString = (cs: readonly Card[]): string => cs.map(cardToString).join(' ');

/** Pretty form for logs: "A♠". */
export const cardLabel = (c: Card): string => {
  const r = RANK_CHARS[rankOf(c) - 2];
  return (r === 'T' ? '10' : r) + SUIT_SYMBOLS[suitOf(c)];
};

const RANK_NAMES = ['', '', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const RANK_PLURALS = ['', '', 'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
export const rankName = (r: number): string => RANK_NAMES[r === 1 ? 14 : r];
export const rankPlural = (r: number): string => RANK_PLURALS[r === 1 ? 14 : r];

/** A full 52-card deck, or the 36-card short deck (Sixes through Aces). */
export function fullDeck(short = false): Card[] {
  const deck: Card[] = [];
  for (let r = short ? 6 : 2; r <= 14; r++) for (let s = 0; s < 4; s++) deck.push(makeCard(r, s));
  return deck;
}

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
}

/** Small, fast, seedable PRNG (mulberry32). */
export function createRng(seed: number = (Math.random() * 2 ** 32) >>> 0): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export const randInt = (rng: Rng, n: number): number => Math.floor(rng.next() * n);

export function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}
