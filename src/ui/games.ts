import type { VariantId } from '../engine/variants';

// The games in the lobby and their tabs. No DOM here, so the tests can read it.

/** Every game in the lobby: a poker variant, or one of the house games. */
export type GameId = VariantId | HouseGame;
export type HouseGame = 'blackjack' | 'roulette' | 'baccarat' | 'videopoker' | 'slots';
export const HOUSE_GAMES: HouseGame[] = ['blackjack', 'roulette', 'baccarat', 'videopoker', 'slots'];
export const isHouseGame = (id: string): id is HouseGame => (HOUSE_GAMES as string[]).includes(id);

export interface Category { id: string; name: string; games: GameId[] }

/** The lobby's game tabs, grouped by how the games are dealt. */
export const CATEGORIES: Category[] = [
  { id: 'community', name: "Hold'em & Omaha", games: ['holdem', 'shortdeck', 'omaha', 'omaha8'] },
  { id: 'stud', name: 'Stud', games: ['stud7', 'stud8', 'razz'] },
  { id: 'draw', name: 'Draw', games: ['draw5'] },
  { id: 'casino', name: 'Casino', games: HOUSE_GAMES },
];
