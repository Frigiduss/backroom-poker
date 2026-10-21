// Roulette against the house: the wheel, every standard bet on the layout, and how a spin
// settles them. Pure rules and no DOM, like the other engines.
//
// Two wheels: European (one zero, 37 pockets) and American (zero and double zero, 38).
// Payouts are the same on both, so the double zero is all extra house edge. Even-money bets
// simply lose when the ball lands on a zero.
import { Rng, randInt } from './cards';

export type Wheel = 'european' | 'american';
/** Pocket numbers: 0 to 36, and 37 stands for the double zero. */
export type Pocket = number;
export const DOUBLE_ZERO: Pocket = 37;

/** The pockets in the order they sit around each wheel, starting from zero. */
export const WHEEL_ORDER: Record<Wheel, Pocket[]> = {
  european: [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26],
  american: [0, 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1, 37, 27, 10, 25, 29, 12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2],
};

const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export const isRed = (p: Pocket): boolean => REDS.has(p);
export const isZero = (p: Pocket): boolean => p === 0 || p === DOUBLE_ZERO;
export const pocketColor = (p: Pocket): 'red' | 'black' | 'green' => (isZero(p) ? 'green' : isRed(p) ? 'red' : 'black');
export const pocketLabel = (p: Pocket): string => (p === DOUBLE_ZERO ? '00' : String(p));

export type RlLimits = 'low' | 'mid' | 'high';
/** Table limits: the smallest chip on one spot, and the most riding on one spin. */
export const RL_LIMITS: Record<RlLimits, { min: number; max: number }> = {
  low: { min: 5, max: 500 },
  mid: { min: 25, max: 2500 },
  high: { min: 100, max: 10_000 },
};

export type BetKind =
  | 'straight' | 'split' | 'street' | 'corner' | 'line'
  | 'column' | 'dozen' | 'red' | 'black' | 'odd' | 'even' | 'low' | 'high';

/** What each kind pays, to 1. */
export const PAYOUT: Record<BetKind, number> = {
  straight: 35, split: 17, street: 11, corner: 8, line: 5,
  column: 2, dozen: 2, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1,
};

/** A spot on the layout: what kind of bet it is and the pockets it covers. */
export interface Spot {
  kind: BetKind;
  numbers: Pocket[];
}

const range = (from: number, to: number, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
const ONE_TO_36 = range(1, 36);

// The layout is three rows of twelve: numbers go up by one across a street (1 2 3) and
// by three along a row (1 4 7 …). A street's first number is 1, 4, 7 … 34.
const streetOf = (n: number) => n - ((n - 1) % 3);

/** The spot a key like "split:8-11" names, or null if no such spot is on the layout. */
export function spotFor(key: string, wheel: Wheel): Spot | null {
  const [kind, arg = ''] = key.split(':') as [BetKind, string?];
  const nums = arg.split('-').filter(Boolean).map((s) => (s === '00' ? DOUBLE_ZERO : Number(s)));
  const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= 36;
  switch (kind) {
    case 'straight': {
      const [n] = nums;
      if (nums.length !== 1) return null;
      if (n === 0 || valid(n) || (n === DOUBLE_ZERO && wheel === 'american')) return { kind, numbers: [n] };
      return null;
    }
    case 'split': {
      const [a, b] = nums;
      if (nums.length !== 2 || !valid(a) || !valid(b) || a >= b) return null;
      // Side by side across a street, or one street apart along a row.
      if ((b === a + 1 && streetOf(a) === streetOf(b)) || b === a + 3) return { kind, numbers: [a, b] };
      return null;
    }
    case 'street': {
      const [n] = nums;
      if (nums.length !== 1 || !valid(n) || streetOf(n) !== n) return null;
      return { kind, numbers: [n, n + 1, n + 2] };
    }
    case 'corner': {
      // Named by its lowest number, which can't be in the top row (3, 6 …) or the last street.
      const [n] = nums;
      if (nums.length !== 1 || !valid(n) || n % 3 === 0 || n > 32) return null;
      return { kind, numbers: [n, n + 1, n + 3, n + 4] };
    }
    case 'line': {
      const [n] = nums;
      if (nums.length !== 1 || !valid(n) || streetOf(n) !== n || n > 31) return null;
      return { kind, numbers: range(n, n + 5) };
    }
    case 'column': {
      const [c] = nums;
      if (nums.length !== 1 || ![1, 2, 3].includes(c)) return null;
      return { kind, numbers: range(c, 36, 3) };
    }
    case 'dozen': {
      const [d] = nums;
      if (nums.length !== 1 || ![1, 2, 3].includes(d)) return null;
      return { kind, numbers: range(d * 12 - 11, d * 12) };
    }
    case 'red': return { kind, numbers: ONE_TO_36.filter(isRed) };
    case 'black': return { kind, numbers: ONE_TO_36.filter((n) => !isRed(n)) };
    case 'odd': return { kind, numbers: ONE_TO_36.filter((n) => n % 2) };
    case 'even': return { kind, numbers: ONE_TO_36.filter((n) => !(n % 2)) };
    case 'low': return { kind, numbers: range(1, 18) };
    case 'high': return { kind, numbers: range(19, 36) };
    default: return null;
  }
}

/** "Straight up 17", "Split 8 / 11", "Red". */
export function describeSpot(key: string): string {
  const [kind, arg = ''] = key.split(':');
  const nums = arg.split('-');
  switch (kind) {
    case 'straight': return `Straight up ${nums[0]}`;
    case 'split': return `Split ${nums.join(' / ')}`;
    case 'street': return `Street ${nums[0]}–${Number(nums[0]) + 2}`;
    case 'corner': return `Corner ${nums[0]}–${Number(nums[0]) + 4}`;
    case 'line': return `Six line ${nums[0]}–${Number(nums[0]) + 5}`;
    case 'column': return `Column ${nums[0]}`;
    case 'dozen': return ['', '1st 12', '2nd 12', '3rd 12'][Number(nums[0])];
    case 'low': return '1 to 18';
    case 'high': return '19 to 36';
    default: return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
}

/** Chips on the layout, by spot key. */
export type Layout = Record<string, number>;

export const layoutTotal = (bets: Layout): number => Object.values(bets).reduce((s, x) => s + x, 0);

export interface SpotResult {
  key: string;
  bet: number;
  /** Chips handed back for this spot: the bet plus winnings, or 0. */
  paid: number;
}

export interface SpinResult {
  pocket: Pocket;
  spots: SpotResult[];
  /** Everything on the layout. */
  staked: number;
  /** Everything paid back. */
  paid: number;
  /** paid − staked. */
  net: number;
}

/** Settles every bet on the layout against where the ball landed. */
export function settle(bets: Layout, pocket: Pocket, wheel: Wheel): SpinResult {
  const spots: SpotResult[] = [];
  for (const [key, bet] of Object.entries(bets)) {
    if (!(bet > 0)) continue;
    const spot = spotFor(key, wheel);
    if (!spot) continue;
    const paid = spot.numbers.includes(pocket) ? bet * (PAYOUT[spot.kind] + 1) : 0;
    spots.push({ key, bet, paid });
  }
  const staked = spots.reduce((s, r) => s + r.bet, 0);
  const paid = spots.reduce((s, r) => s + r.paid, 0);
  return { pocket, spots, staked, paid, net: paid - staked };
}

/** A fair spin of the wheel. */
export function spin(wheel: Wheel, rng: Rng): Pocket {
  return WHEEL_ORDER[wheel][randInt(rng, WHEEL_ORDER[wheel].length)];
}

/** Why a layout can't be spun as it stands, or null when it can. */
export function layoutProblem(bets: Layout, wheel: Wheel, limits: { min: number; max: number }, bank: number): string | null {
  const total = layoutTotal(bets);
  if (!total) return 'Place a bet first.';
  for (const [key, bet] of Object.entries(bets)) {
    if (!spotFor(key, wheel)) return `There's no ${key} on this wheel.`;
    if (bet < limits.min) return `Each bet needs at least ${limits.min} chips.`;
  }
  if (total > limits.max) return `The table takes at most ${limits.max} a spin.`;
  if (total > bank) return 'Your bank can’t cover these bets.';
  return null;
}

/** The house's edge on every bet, as a share of the stake. */
export const houseEdge = (wheel: Wheel): number => (wheel === 'european' ? 1 / 37 : 2 / 38);
