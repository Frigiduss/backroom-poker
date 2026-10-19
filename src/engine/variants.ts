import { Card } from './cards';
import { evalHigh, evalLow, evalOmahaHigh, evalOmahaLow, describeHigh, describeLow } from './evaluator';

export type VariantId = 'holdem' | 'shortdeck' | 'omaha' | 'omaha8' | 'draw5' | 'stud7' | 'stud8' | 'razz';
export type Family = 'flop' | 'draw' | 'stud';
/** No-limit, pot-limit or fixed-limit betting. */
export type Structure = 'NL' | 'PL' | 'FL';

export interface VariantDef {
  id: VariantId;
  name: string;
  family: Family;
  /** Hole cards for flop games, cards held for draw, max cards per player for stud. */
  holeCards: number;
  structures: Structure[];
  defaultStructure: Structure;
  minPlayers: number;
  maxPlayers: number;
  hiLo: boolean;
  lowOnly: boolean;
  shortDeck: boolean;
  omaha: boolean;
  /** Betting rounds in a full hand. */
  streets: number;
  blurb: string;
}

export const VARIANTS: Record<VariantId, VariantDef> = {
  holdem: {
    id: 'holdem', name: "Texas Hold'em", family: 'flop', holeCards: 2,
    structures: ['NL', 'PL', 'FL'], defaultStructure: 'NL', minPlayers: 2, maxPlayers: 9,
    hiLo: false, lowOnly: false, shortDeck: false, omaha: false, streets: 4,
    blurb: 'Two hole cards, five on the board. Best five-card hand wins.',
  },
  shortdeck: {
    id: 'shortdeck', name: 'Short Deck', family: 'flop', holeCards: 2,
    structures: ['NL'], defaultStructure: 'NL', minPlayers: 2, maxPlayers: 8,
    hiLo: false, lowOnly: false, shortDeck: true, omaha: false, streets: 4,
    blurb: "Hold'em with the 2s to 5s removed. Flushes beat full houses, trips beat straights.",
  },
  omaha: {
    id: 'omaha', name: 'Omaha', family: 'flop', holeCards: 4,
    structures: ['PL', 'NL', 'FL'], defaultStructure: 'PL', minPlayers: 2, maxPlayers: 9,
    hiLo: false, lowOnly: false, shortDeck: false, omaha: true, streets: 4,
    blurb: 'Four hole cards. Use exactly two of them with three from the board.',
  },
  omaha8: {
    id: 'omaha8', name: 'Omaha Hi-Lo', family: 'flop', holeCards: 4,
    structures: ['PL', 'FL'], defaultStructure: 'PL', minPlayers: 2, maxPlayers: 9,
    hiLo: true, lowOnly: false, shortDeck: false, omaha: true, streets: 4,
    blurb: 'Omaha where the pot splits between the best high and the best eight-or-better low.',
  },
  draw5: {
    id: 'draw5', name: 'Five Card Draw', family: 'draw', holeCards: 5,
    structures: ['FL', 'PL', 'NL'], defaultStructure: 'FL', minPlayers: 2, maxPlayers: 6,
    hiLo: false, lowOnly: false, shortDeck: false, omaha: false, streets: 2,
    blurb: 'Five private cards, one chance to swap any of them, then a final round of betting.',
  },
  stud7: {
    id: 'stud7', name: 'Seven Card Stud', family: 'stud', holeCards: 7,
    structures: ['FL'], defaultStructure: 'FL', minPlayers: 2, maxPlayers: 8,
    hiLo: false, lowOnly: false, shortDeck: false, omaha: false, streets: 5,
    blurb: 'Seven cards each, four of them face up. No community cards and no blinds.',
  },
  stud8: {
    id: 'stud8', name: 'Stud Hi-Lo', family: 'stud', holeCards: 7,
    structures: ['FL'], defaultStructure: 'FL', minPlayers: 2, maxPlayers: 8,
    hiLo: true, lowOnly: false, shortDeck: false, omaha: false, streets: 5,
    blurb: 'Seven Card Stud with the pot split between high and an eight-or-better low.',
  },
  razz: {
    id: 'razz', name: 'Razz', family: 'stud', holeCards: 7,
    structures: ['FL'], defaultStructure: 'FL', minPlayers: 2, maxPlayers: 8,
    hiLo: false, lowOnly: true, shortDeck: false, omaha: false, streets: 5,
    blurb: 'Seven Card Stud for the lowest hand. Aces are low, straights and flushes do not count.',
  },
};

export const VARIANT_ORDER: VariantId[] = ['holdem', 'omaha', 'omaha8', 'shortdeck', 'draw5', 'stud7', 'stud8', 'razz'];

export const STRUCTURE_NAMES: Record<Structure, string> = { NL: 'No-Limit', PL: 'Pot-Limit', FL: 'Fixed-Limit' };

export interface ShowdownValue {
  /** Higher is better; null when the game has no high half. */
  hi: number | null;
  /** Lower is better; null when no qualifying low. */
  lo: number | null;
}

/** Value of a player's cards at showdown. `board` holds community cards (stud only uses it if the deck ran out). */
export function showdownValue(v: VariantDef, cards: readonly Card[], board: readonly Card[]): ShowdownValue {
  if (v.omaha) {
    return { hi: evalOmahaHigh(cards, board), lo: v.hiLo ? evalOmahaLow(cards, board) : null };
  }
  const all = board.length ? [...cards, ...board] : (cards as Card[]);
  if (v.lowOnly) return { hi: null, lo: evalLow(all, false) };
  return { hi: evalHigh(all, v.shortDeck), lo: v.hiLo ? evalLow(all, true) : null };
}

/** Human-readable name of what a player currently holds (works mid-hand too). */
export function describeHolding(v: VariantDef, cards: readonly Card[], board: readonly Card[]): string {
  if (!cards.length) return '';
  if (v.omaha) {
    if (board.length < 3) return '';
    const val = showdownValue(v, cards, board);
    const hi = describeHigh(val.hi!, false);
    return v.hiLo && val.lo !== null ? `${hi} · ${describeLow(val.lo)}` : hi;
  }
  const all = [...cards, ...board];
  if (v.lowOnly) {
    const lo = evalLow(all, false);
    return lo === null ? '' : describeLow(lo);
  }
  const hi = describeHigh(evalHigh(all, v.shortDeck), v.shortDeck);
  if (v.hiLo) {
    const lo = evalLow(all, true);
    if (lo !== null) return `${hi} · ${describeLow(lo)}`;
  }
  return hi;
}
