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

/**
 * Where a seeded rng starts. A number gives the small, fast mulberry32, fine for games on
 * this device. A string from secureSeed() gives a ChaCha20 stream with a 256-bit key, for
 * online tables: from the cards a player sees, nobody can work out the ones still to come.
 */
export type Seed = number | string;

/** An Rng whose position can be saved and restored, so a shuffle can be replayed exactly. */
export interface SeededRng extends Rng {
  state: Seed;
}

/** A fresh ChaCha20 seed from the platform's cryptographic random source. */
export function secureSeed(): string {
  const key = crypto.getRandomValues(new Uint32Array(8));
  return `${Array.from(key, (w) => w.toString(16).padStart(8, '0')).join('')}.0.0`;
}

/**
 * A second, independent stream from the same seed, for choices (bot names, seating) that
 * shouldn't use up the deck's stream. With a number seed it's the old `seed ^ salt`.
 */
export function subSeed(seed: Seed, salt: number): Seed {
  if (typeof seed === 'number') return (seed ^ salt) >>> 0;
  return `${seed.split('.')[0]}.${salt >>> 0}.0`;
}

/** A seeded rng: ChaCha20 for a string seed (secureSeed), mulberry32 for a number. */
export function createRng(seed: Seed = (Math.random() * 2 ** 32) >>> 0): SeededRng {
  return typeof seed === 'string' ? chachaRng(seed) : mulberry32(seed);
}

/** Small, fast, seedable PRNG (mulberry32). Its whole state is 32 bits, so never for online dealing. */
function mulberry32(seed: number): SeededRng {
  let a = seed >>> 0;
  return {
    get state() {
      return a;
    },
    set state(v: Seed) {
      a = Number(v) >>> 0;
    },
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

function quarter(s: Uint32Array, a: number, b: number, c: number, d: number) {
  s[a] += s[b]; s[d] = rotl(s[d] ^ s[a], 16);
  s[c] += s[d]; s[b] = rotl(s[b] ^ s[c], 12);
  s[a] += s[b]; s[d] = rotl(s[d] ^ s[a], 8);
  s[c] += s[d]; s[b] = rotl(s[b] ^ s[c], 7);
}

/** One ChaCha20 block (RFC 8439): 16 words of keystream for this key, counter and nonce. */
export function chachaBlock(key: ArrayLike<number>, counter: number, nonce: ArrayLike<number>, out: Uint32Array) {
  const init = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574, ...Array.from(key), counter, ...Array.from(nonce)]);
  out.set(init);
  for (let i = 0; i < 10; i++) {
    quarter(out, 0, 4, 8, 12); quarter(out, 1, 5, 9, 13); quarter(out, 2, 6, 10, 14); quarter(out, 3, 7, 11, 15);
    quarter(out, 0, 5, 10, 15); quarter(out, 1, 6, 11, 12); quarter(out, 2, 7, 8, 13); quarter(out, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) out[i] += init[i];
}

/** ChaCha20 as an rng. Its state is "key.stream.position": the key in hex, then which stream and how far along. */
function chachaRng(seed: string): SeededRng {
  let hex = '';
  let key = new Uint32Array(8);
  let nonce = 0;
  let pos = 0;
  const buf = new Uint32Array(16);
  let block = -1;
  const load = (v: string) => {
    const [k, n, p] = v.split('.');
    if (!/^[0-9a-f]{64}$/.test(k ?? '') || !/^\d+$/.test(n ?? '') || !/^\d+$/.test(p ?? '')) throw new Error('Bad rng state.');
    hex = k;
    key = new Uint32Array(Array.from({ length: 8 }, (_, i) => parseInt(k.slice(i * 8, i * 8 + 8), 16)));
    nonce = Number(n) >>> 0;
    pos = Number(p);
    block = -1;
  };
  load(seed);
  return {
    get state() {
      return `${hex}.${nonce}.${pos}`;
    },
    set state(v: Seed) {
      load(String(v));
    },
    next() {
      const b = Math.floor(pos / 16);
      if (b !== block) {
        chachaBlock(key, b >>> 0, [nonce, 0, 0], buf);
        block = b;
      }
      return buf[pos++ % 16] / 4294967296;
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
