// Seasonal events. Each one runs for a few weeks of the year: while it is on, its felt and
// card back are free for everyone, and every game played counts toward its achievement.
// Earn the achievement before the event ends and the felt and back stay yours for good.
//
// Adding an event: add an entry to SEASONS, its felt and back to looks.ts (with `season` set),
// their colours to styles.css, and its achievement to achievements.ts on the counter
// seasonCounter(id). The browser uses the player's own calendar and the table server uses
// its clock, so the dates are read in local time on each side.
import type { Tally } from './achievements';

/** A month (1-12) and day. */
export type MonthDay = [month: number, day: number];

export interface Season {
  id: string;
  name: string;
  /** One line for the lobby banner. */
  blurb: string;
  /** First and last day, both included. An event may run over New Year (from after to). */
  from: MonthDay;
  to: MonthDay;
  /** Looks that are free while it is on. */
  felt: string;
  back: string;
  /** The achievement that keeps them. */
  achievement: string;
  /** Games to play while it is on. */
  goal: number;
}

export const SEASONS: Season[] = [
  {
    id: 'winter',
    name: 'Winter Nights',
    blurb: 'Snow on the window, cards on the felt.',
    from: [12, 1],
    to: [12, 31],
    felt: 'snowfall',
    back: 'snowflake',
    achievement: 'snowed-in',
    goal: 50,
  },
];

export const SEASON_BY_ID: ReadonlyMap<string, Season> = new Map(SEASONS.map((s) => [s.id, s]));

/** The counter of games played during an event. */
export const seasonCounter = (id: string): string => `ev.${id}.played`;

const md = (d: Date) => (d.getMonth() + 1) * 100 + d.getDate();
const num = ([m, d]: MonthDay) => m * 100 + d;

export function seasonIsOn(s: Season, now: Date = new Date()): boolean {
  const t = md(now);
  const a = num(s.from);
  const b = num(s.to);
  return a <= b ? t >= a && t <= b : t >= a || t <= b;
}

/** The event that is on right now, if any. */
export const seasonOn = (now: Date = new Date()): Season | null => SEASONS.find((s) => seasonIsOn(s, now)) ?? null;

/** The last day of an event that is on, as a date (local midnight at its start). */
export function seasonLastDay(s: Season, now: Date = new Date()): Date {
  const year = now.getFullYear() + (num(s.from) > num(s.to) && md(now) >= num(s.from) ? 1 : 0);
  return new Date(year, s.to[0] - 1, s.to[1]);
}

/** The next event to start after today (or today's, if one is on). */
export function nextSeason(now: Date = new Date()): { season: Season; starts: Date } | null {
  let best: { season: Season; starts: Date } | null = null;
  for (const s of SEASONS) {
    const start = new Date(now.getFullYear(), s.from[0] - 1, s.from[1]);
    if (md(now) > num(s.from)) start.setFullYear(now.getFullYear() + 1);
    if (!best || start < best.starts) best = { season: s, starts: start };
  }
  return best;
}

/** Counters that mean "one game played": a poker hand, a blackjack round, a spin and so on. */
const PLAY_COUNTERS = ['hands', 'bj.hands', 'rl.spins', 'bac.hands', 'vp.hands', 'sl.spins'];

/**
 * `t` plus what it adds to the event that is on, if any. Every game counts once, whatever it
 * is; finishing a tournament or leaving a cash game counts nothing extra.
 */
export function withSeason(t: Tally, now: Date = new Date()): Tally {
  const s = seasonOn(now);
  if (!s) return t;
  const games = PLAY_COUNTERS.reduce((sum, k) => sum + (t.sum[k] ?? 0), 0);
  if (games <= 0) return t;
  const key = seasonCounter(s.id);
  return { sum: { ...t.sum, [key]: (t.sum[key] ?? 0) + games }, max: t.max };
}
