// Baccarat (punto banco) against the house: an eight-deck shoe, the fixed drawing rules for
// Player and Banker, and how a coup settles the bets on it. Pure rules and no DOM.
//
// Nobody makes decisions in punto banco. Both hands follow the tableau below, so the only
// choice is the bet: Player pays 1 to 1, Banker 1 to 1 less a 5% commission, Tie 8 to 1
// (Player and Banker bets push on a tie), and either pair side bet 11 to 1.
import { Card, rankOf } from './cards';
import { Shoe } from './blackjack';

export const BAC_DECKS = 8;

export type BacLimits = 'low' | 'mid' | 'high';
/** Table limits: the smallest bet on one spot, and the most riding on one coup. */
export const BAC_LIMITS: Record<BacLimits, { min: number; max: number }> = {
  low: { min: 10, max: 500 },
  mid: { min: 50, max: 2500 },
  high: { min: 250, max: 10_000 },
};

export type BacSpot = 'player' | 'banker' | 'tie' | 'playerPair' | 'bankerPair';
export const BAC_SPOTS: BacSpot[] = ['playerPair', 'player', 'tie', 'banker', 'bankerPair'];
export const BAC_SPOT_NAMES: Record<BacSpot, string> = { player: 'Player', banker: 'Banker', tie: 'Tie', playerPair: 'Player pair', bankerPair: 'Banker pair' };
/** What each spot pays, to 1, before the Banker commission. */
export const BAC_PAYOUT: Record<BacSpot, number> = { player: 1, banker: 1, tie: 8, playerPair: 11, bankerPair: 11 };
export const BANKER_COMMISSION = 0.05;

/** Baccarat value of one card: aces 1, tens and faces 0. */
export function cardValue(c: Card): number {
  const r = rankOf(c);
  return r === 14 ? 1 : r >= 10 ? 0 : r;
}

/** A hand's point total: the last digit of the sum. */
export const handValue = (cards: readonly Card[]): number => cards.reduce((s, c) => s + cardValue(c), 0) % 10;

/** Whether the Banker draws a third card, given its total and the Player's third card (null if the Player stood). */
export function bankerDraws(banker: number, playerThird: Card | null): boolean {
  if (playerThird === null) return banker <= 5;
  const t = cardValue(playerThird);
  switch (banker) {
    case 0: case 1: case 2: return true;
    case 3: return t !== 8;
    case 4: return t >= 2 && t <= 7;
    case 5: return t >= 4 && t <= 7;
    case 6: return t === 6 || t === 7;
    default: return false;
  }
}

export type Winner = 'player' | 'banker' | 'tie';

export interface Coup {
  player: Card[];
  banker: Card[];
  /** Who each card went to, in the order they came out of the shoe. */
  order: ('player' | 'banker')[];
  playerTotal: number;
  bankerTotal: number;
  winner: Winner;
  /** One side had 8 or 9 on its first two cards, so nobody drew. */
  natural: boolean;
  playerPair: boolean;
  bankerPair: boolean;
}

/** Deals one coup from the shoe by the drawing rules. */
export function dealCoup(shoe: Shoe): Coup {
  const player: Card[] = [];
  const banker: Card[] = [];
  const order: Coup['order'] = [];
  const give = (who: 'player' | 'banker') => {
    (who === 'player' ? player : banker).push(shoe.draw());
    order.push(who);
  };
  give('player');
  give('banker');
  give('player');
  give('banker');
  const natural = handValue(player) >= 8 || handValue(banker) >= 8;
  if (!natural) {
    let third: Card | null = null;
    if (handValue(player) <= 5) {
      give('player');
      third = player[2];
    }
    if (bankerDraws(handValue(banker), third)) give('banker');
  }
  const playerTotal = handValue(player);
  const bankerTotal = handValue(banker);
  const pair = (cs: Card[]) => rankOf(cs[0]) === rankOf(cs[1]);
  return {
    player, banker, order, playerTotal, bankerTotal, natural,
    winner: playerTotal > bankerTotal ? 'player' : bankerTotal > playerTotal ? 'banker' : 'tie',
    playerPair: pair(player), bankerPair: pair(banker),
  };
}

export type BacBets = Partial<Record<BacSpot, number>>;

export const betsTotal = (bets: BacBets): number => Object.values(bets).reduce((s, x) => s + (x ?? 0), 0);

export interface BacSpotResult {
  spot: BacSpot;
  bet: number;
  /** Chips handed back: the bet plus winnings, the bet alone on a push, or 0. */
  paid: number;
  outcome: 'win' | 'push' | 'lose';
}

export interface BacResult {
  spots: BacSpotResult[];
  staked: number;
  paid: number;
  net: number;
}

/** Settles the bets against a dealt coup. */
export function settleCoup(bets: BacBets, coup: Coup): BacResult {
  const spots: BacSpotResult[] = [];
  for (const spot of BAC_SPOTS) {
    const bet = bets[spot] ?? 0;
    if (!(bet > 0)) continue;
    let outcome: BacSpotResult['outcome'];
    if (spot === 'playerPair') outcome = coup.playerPair ? 'win' : 'lose';
    else if (spot === 'bankerPair') outcome = coup.bankerPair ? 'win' : 'lose';
    else if (spot === 'tie') outcome = coup.winner === 'tie' ? 'win' : 'lose';
    else outcome = coup.winner === 'tie' ? 'push' : coup.winner === spot ? 'win' : 'lose';
    let paid = 0;
    if (outcome === 'push') paid = bet;
    else if (outcome === 'win') {
      const winnings = bet * BAC_PAYOUT[spot];
      paid = bet + (spot === 'banker' ? Math.floor(winnings * (1 - BANKER_COMMISSION)) : winnings);
    }
    spots.push({ spot, bet, paid, outcome });
  }
  const staked = spots.reduce((s, r) => s + r.bet, 0);
  const paid = spots.reduce((s, r) => s + r.paid, 0);
  return { spots, staked, paid, net: paid - staked };
}

/** Why these bets can't be dealt as they stand, or null when they can. */
export function betsProblem(bets: BacBets, limits: { min: number; max: number }, bank: number): string | null {
  const total = betsTotal(bets);
  if (!total) return 'Place a bet first.';
  if (Object.values(bets).some((b) => b && b < limits.min)) return `Each bet needs at least ${limits.min} chips.`;
  if (total > limits.max) return `The table takes at most ${limits.max} a hand.`;
  if (total > bank) return 'Your bank can’t cover these bets.';
  return null;
}
