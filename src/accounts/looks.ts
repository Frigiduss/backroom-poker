// Table felts and card backs. One of each is free; the rest are unlocked by achievements, so
// a look is held exactly when its achievement is (online achievements included). The choice
// is kept in the player's settings, so it follows them to every device they sign in on.
import { ACHIEVEMENT_BY_ID, Counters, isUnlocked } from './achievements';
import { SEASON_BY_ID, seasonIsOn } from './seasons';

export type LookKind = 'felt' | 'back';

export interface Look {
  id: string;
  kind: LookKind;
  name: string;
  /** The achievement that unlocks it; free when absent. */
  unlock?: string;
  /** A seasonal event (seasons.ts) during which it is free for everyone. */
  season?: string;
}

export const FELTS: Look[] = [
  { id: 'emerald', kind: 'felt', name: 'Emerald' },
  { id: 'midnight', kind: 'felt', name: 'Midnight', unlock: 'hands-100' },
  { id: 'bordeaux', kind: 'felt', name: 'Bordeaux', unlock: 'wins-100' },
  { id: 'lagoon', kind: 'felt', name: 'Lagoon', unlock: 'bj-hands-25' },
  { id: 'smoke', kind: 'felt', name: 'Smoke', unlock: 'steal-25' },
  { id: 'sahara', kind: 'felt', name: 'Sahara', unlock: 'variety-3' },
  { id: 'velvet', kind: 'felt', name: 'Velvet', unlock: 'boat-1' },
  { id: 'onyx', kind: 'felt', name: 'Onyx', unlock: 'beat-expert' },
  { id: 'snowfall', kind: 'felt', name: 'Snowfall', unlock: 'snowed-in', season: 'winter' },
];

export const CARD_BACKS: Look[] = [
  { id: 'classic', kind: 'back', name: 'Classic' },
  { id: 'lattice', kind: 'back', name: 'Blue Lattice', unlock: 'hands-10' },
  { id: 'stripe', kind: 'back', name: 'Racing Stripe', unlock: 'allin-1' },
  { id: 'spade', kind: 'back', name: 'Ace of Spades', unlock: 'bj-natural-1' },
  { id: 'flame', kind: 'back', name: 'Flame', unlock: 'run-5' },
  { id: 'gilded', kind: 'back', name: 'Gilded', unlock: 'sflush-1' },
  { id: 'diamond', kind: 'back', name: 'Diamond', unlock: 'bank-1m' },
  { id: 'snowflake', kind: 'back', name: 'Snowflake', unlock: 'snowed-in', season: 'winter' },
];

export const LOOKS: Look[] = [...FELTS, ...CARD_BACKS];

export interface LookChoice {
  felt: string;
  back: string;
}

export const DEFAULT_LOOK: LookChoice = { felt: FELTS[0].id, back: CARD_BACKS[0].id };

/** Free for now only because its seasonal event is on. */
export const lookOnLoan = (l: Look, c: Counters, now: Date = new Date()): boolean => {
  const s = l.season ? SEASON_BY_ID.get(l.season) : undefined;
  return !!s && seasonIsOn(s, now) && !lookEarned(l, c);
};

const lookEarned = (l: Look, c: Counters): boolean => {
  const a = l.unlock ? ACHIEVEMENT_BY_ID.get(l.unlock) : undefined;
  return !l.unlock || (!!a && isUnlocked(a, c));
};

/** Held for good through its achievement, or free while its seasonal event is on. */
export const lookUnlocked = (l: Look, c: Counters, now: Date = new Date()): boolean => {
  const s = l.season ? SEASON_BY_ID.get(l.season) : undefined;
  return lookEarned(l, c) || (!!s && seasonIsOn(s, now));
};

/** Felts and backs that an achievement unlocks (for its card and its unlock pop-up). */
export const looksUnlockedBy = (achievementId: string): Look[] => LOOKS.filter((l) => l.unlock === achievementId);

/**
 * The felt and back to show for these settings. Anything unknown, or not (or no longer)
 * unlocked, falls back to the free one, the same way a title does.
 */
export function lookFor(settings: Record<string, unknown>, c: Counters, now: Date = new Date()): LookChoice {
  const saved = (settings.look && typeof settings.look === 'object' ? settings.look : {}) as Partial<LookChoice>;
  const pick = (list: Look[], id: unknown) => {
    const l = list.find((x) => x.id === id);
    return l && lookUnlocked(l, c, now) ? l.id : list[0].id;
  };
  return { felt: pick(FELTS, saved.felt), back: pick(CARD_BACKS, saved.back) };
}
