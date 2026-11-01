// The slot machine: three reels showing three rows each, and up to five pay lines across
// them (the three rows and the two diagonals). Pure rules and no DOM.
//
// The theme is the card room: the four suits are the small symbols, then a stack of chips,
// a crown, and the red seven on top. Each reel is a fixed strip of symbols and a spin picks
// a stop on each strip at random, so every outcome's odds can be counted exactly. The strips
// and pay table are set for a return of about 95% a line (see `returnToPlayer`).
import { Rng } from './cards';

export type Sym = 'seven' | 'crown' | 'chip' | 'spade' | 'heart' | 'diamond' | 'club';
export const SYMBOLS: Sym[] = ['seven', 'crown', 'chip', 'spade', 'heart', 'diamond', 'club'];
export const SYMBOL_NAMES: Record<Sym, string> = {
  seven: 'Seven', crown: 'Crown', chip: 'Chips', spade: 'Spade', heart: 'Heart', diamond: 'Diamond', club: 'Club',
};
const RED = new Set<Sym>(['heart', 'diamond']);
const BLACK = new Set<Sym>(['spade', 'club']);
export const isSuit = (s: Sym): boolean => RED.has(s) || BLACK.has(s);

export const REEL_COUNT = 3;
export const ROW_COUNT = 3;
export const MAX_LINES = 5;

/** Each pay line as the row it crosses on each reel (0 top, 1 middle, 2 bottom), in the order lines are bought. */
export const LINES: number[][] = [
  [1, 1, 1],
  [0, 0, 0],
  [2, 2, 2],
  [0, 1, 2],
  [2, 1, 0],
];
export const LINE_NAMES = ['Middle row', 'Top row', 'Bottom row', 'Diagonal down', 'Diagonal up'];

export type PayId = 'sevens' | 'crowns' | 'chips' | 'spades' | 'hearts' | 'diamonds' | 'clubs' | 'anyRed' | 'anyBlack' | 'twoChips' | 'oneChip';

/** The pay table, best first, in coins paid for each coin on the line. */
export const PAYS: { id: PayId; name: string; show: Sym[]; pays: number }[] = [
  { id: 'sevens', name: 'Three sevens', show: ['seven', 'seven', 'seven'], pays: 500 },
  { id: 'crowns', name: 'Three crowns', show: ['crown', 'crown', 'crown'], pays: 60 },
  { id: 'chips', name: 'Three chips', show: ['chip', 'chip', 'chip'], pays: 30 },
  { id: 'spades', name: 'Three spades', show: ['spade', 'spade', 'spade'], pays: 18 },
  { id: 'hearts', name: 'Three hearts', show: ['heart', 'heart', 'heart'], pays: 15 },
  { id: 'diamonds', name: 'Three diamonds', show: ['diamond', 'diamond', 'diamond'], pays: 12 },
  { id: 'clubs', name: 'Three clubs', show: ['club', 'club', 'club'], pays: 8 },
  { id: 'anyBlack', name: 'Any three black suits', show: ['spade', 'club', 'spade'], pays: 3 },
  { id: 'anyRed', name: 'Any three red suits', show: ['heart', 'diamond', 'heart'], pays: 3 },
  { id: 'twoChips', name: 'Any two chips', show: ['chip', 'chip'], pays: 3 },
  { id: 'oneChip', name: 'Chips on the first reel', show: ['chip'], pays: 1 },
];
const PAY_BY_ID = Object.fromEntries(PAYS.map((p) => [p.id, p])) as Record<PayId, (typeof PAYS)[number]>;
export const paysFor = (id: PayId): number => PAY_BY_ID[id].pays;

/** How many of each symbol is on each reel's strip. */
const STRIP_COUNTS: Record<Sym, number>[] = [
  { seven: 1, crown: 2, chip: 4, spade: 5, heart: 5, diamond: 5, club: 6 },
  { seven: 1, crown: 2, chip: 3, spade: 5, heart: 6, diamond: 5, club: 6 },
  { seven: 1, crown: 2, chip: 3, spade: 6, heart: 5, diamond: 6, club: 5 },
];

/** Lays the symbols out round a strip, each kind spread as evenly as it will go. */
function spread(counts: Record<Sym, number>): Sym[] {
  const slots: { at: number; sym: Sym }[] = [];
  SYMBOLS.forEach((sym, k) => {
    for (let i = 0; i < counts[sym]; i++) slots.push({ at: (i + (k + 1) / (SYMBOLS.length + 1)) / counts[sym], sym });
  });
  slots.sort((a, b) => a.at - b.at);
  return slots.map((s) => s.sym);
}

/** The reel strips, top to bottom as they scroll past. */
export const REELS: Sym[][] = STRIP_COUNTS.map(spread);

/** What one line of three symbols pays, or null. */
export function linePay(syms: readonly Sym[]): PayId | null {
  const [a, b, c] = syms;
  if (a === b && b === c) {
    const three: Partial<Record<Sym, PayId>> = { seven: 'sevens', crown: 'crowns', chip: 'chips', spade: 'spades', heart: 'hearts', diamond: 'diamonds', club: 'clubs' };
    return three[a]!;
  }
  if (syms.every((s) => RED.has(s))) return 'anyRed';
  if (syms.every((s) => BLACK.has(s))) return 'anyBlack';
  const chips = syms.filter((s) => s === 'chip').length;
  if (chips === 2) return 'twoChips';
  if (a === 'chip') return 'oneChip';
  return null;
}

/** The symbols showing: grid[reel][row]. */
export function windowAt(stops: readonly number[]): Sym[][] {
  return stops.map((stop, r) => {
    const strip = REELS[r];
    return [-1, 0, 1].map((d) => strip[(stop + d + strip.length) % strip.length]);
  });
}

export interface LineWin {
  /** Index into LINES. */
  line: number;
  pay: PayId;
  /** Chips this line pays. */
  amount: number;
}

export interface SlotSpin {
  stops: number[];
  grid: Sym[][];
  lines: number;
  /** Chips a line. */
  coin: number;
  wins: LineWin[];
  staked: number;
  paid: number;
  net: number;
}

/** Pays the lines bet for a given set of reel stops. */
export function settleSpin(stops: readonly number[], lines: number, coin: number): SlotSpin {
  const n = Math.max(1, Math.min(MAX_LINES, Math.floor(lines)));
  const grid = windowAt(stops);
  const wins: LineWin[] = [];
  for (let line = 0; line < n; line++) {
    const syms = LINES[line].map((row, reel) => grid[reel][row]);
    const pay = linePay(syms);
    if (pay) wins.push({ line, pay, amount: paysFor(pay) * coin });
  }
  const staked = n * coin;
  const paid = wins.reduce((s, w) => s + w.amount, 0);
  return { stops: [...stops], grid, lines: n, coin, wins, staked, paid, net: paid - staked };
}

/** Stops that put a seven on the middle row of every reel: the top prize on line 1, which every bet plays. For the console. */
export function highRollStops(): number[] {
  return REELS.map((strip) => strip.indexOf('seven'));
}

/** One pull of the handle. */
export function spinSlots(lines: number, coin: number, rng: Rng): SlotSpin {
  const stops = REELS.map((strip) => Math.floor(rng.next() * strip.length));
  return settleSpin(stops, lines, coin);
}

/**
 * The exact return for one coin on one line, and how often a line pays, counted over every
 * combination of stops. Every line sees the same odds, since each reel's rows are just
 * neighbouring stops on the strip.
 */
export function returnToPlayer(): { rtp: number; hitRate: number; odds: Record<PayId, number> } {
  const [r0, r1, r2] = REELS;
  const odds = Object.fromEntries(PAYS.map((p) => [p.id, 0])) as Record<PayId, number>;
  let back = 0;
  let hits = 0;
  const all = r0.length * r1.length * r2.length;
  for (const a of r0) for (const b of r1) for (const c of r2) {
    const pay = linePay([a, b, c]);
    if (!pay) continue;
    hits++;
    odds[pay]++;
    back += paysFor(pay);
  }
  for (const id of Object.keys(odds) as PayId[]) odds[id] /= all;
  return { rtp: back / all, hitRate: hits / all, odds };
}
