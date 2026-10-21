// Numbers for the stats page: how a player plays (from the style.* counters every poker hand
// adds) and their chips over a stretch of time (from the profile's chip history).
import type { Counters } from './achievements';
import type { ChipPoint } from './profile';

/** Hands before the page gives a playing-style read. */
export const STYLE_MIN_HANDS = 30;

export interface PlayingStyle {
  /** Poker hands dealt in since these counts began. */
  hands: number;
  /** Share of hands where the player put chips in by choice on the first betting round. */
  vpip: number | null;
  /** Share of hands where the player bet or raised on the first betting round. */
  pfr: number | null;
  /** Share of all decisions (fold, check, call, bet, raise) that were bets or raises. */
  raiseRate: number | null;
  /** Bets and raises for every call. */
  aggression: number | null;
  /** Share of hands that reached a showdown with the player still in. */
  showdowns: number | null;
  /** A one-word read such as "Tight-aggressive", once there are enough hands. */
  label: string | null;
}

const share = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export function playingStyle(c: Counters): PlayingStyle {
  const n = (k: string) => c[k] ?? 0;
  const hands = n('style.dealt');
  const vpip = share(n('style.vpip'), hands);
  const pfr = share(n('style.pfr'), hands);
  const raises = n('style.raises');
  const calls = n('style.calls');
  const style: PlayingStyle = {
    hands,
    vpip,
    pfr,
    raiseRate: share(raises, n('style.decisions')),
    aggression: calls > 0 ? raises / calls : raises > 0 ? raises : null,
    showdowns: share(n('style.showdowns'), hands),
    label: null,
  };
  if (hands >= STYLE_MIN_HANDS && vpip !== null && pfr !== null) {
    const loose = vpip > 0.3;
    // Raising for most of the hands played counts as aggressive.
    const aggressive = vpip > 0 && pfr / vpip >= 0.5;
    style.label = `${loose ? 'Loose' : 'Tight'}-${aggressive ? 'aggressive' : 'passive'}`;
  }
  return style;
}

/** What each read means, in a sentence. */
export const STYLE_NOTES: Record<string, string> = {
  'Tight-aggressive': 'Picky about starting hands and pushes the ones you play. The classic winning style.',
  'Loose-aggressive': 'Plays lots of hands and keeps the pressure on. Hard to read, easy to overdo.',
  'Tight-passive': 'Picky about hands but calls more than raises. Bet your strong ones harder.',
  'Loose-passive': 'Plays lots of hands and mostly calls. Folding more and raising the good ones will win more chips.',
};

/**
 * The chip history from `from` onward. A stretch that starts after the first point opens
 * with the chips held at that moment, so the line covers the whole range.
 */
export function chipsSince(history: readonly ChipPoint[], from: number, now = Date.now()): ChipPoint[] {
  const out: ChipPoint[] = [];
  let before: ChipPoint | null = null;
  for (const pt of history) {
    if (pt[0] < from) before = pt;
    else out.push(pt);
  }
  if (before) out.unshift([from, before[1]]);
  const last = out[out.length - 1];
  if (last && last[0] < now) out.push([now, last[1]]);
  return out;
}
