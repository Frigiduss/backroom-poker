// The Penthouse: the high-stakes game upstairs. No-Limit Hold'em at 25 times the usual
// blinds against the sharpest bots, open to players who have built a big bank or made an
// expensive enemy of one of the regulars.
//
// The door is only a door: what really protects the chip economy is the 50,000 buy-in, which
// comes out of a bank the server already limits (supabase/banks.sql). Everything here is plain
// data and pure functions, so it can be tested without a page.
import { Rivals, moodOf } from '../bots/rivals';
import type { Profile } from './profile';

export const PENTHOUSE = {
  name: 'The Penthouse',
  bigBlind: 500,
  stackBB: 100,
  /** 100 big blinds at 250/500. */
  buyIn: 50_000,
  opponents: 5,
  /**
   * The big blind climbs every few hands and the bots buy in deeper each time, so the money
   * gets bigger the longer the night goes: 250/500 up to 12,500/25,000 with 2.5 million stacks.
   */
  climb: [500, 1_000, 2_000, 5_000, 10_000, 25_000],
  handsPerLevel: 8,
} as const;

/** A bank that has once reached this opens the door for good. */
export const PENTHOUSE_BANK = 100_000;
/** Or a regular holding a grudge (or worse) after this many chips have changed hands between you. */
export const PENTHOUSE_RIVAL_CHIPS = 20_000;
export const PENTHOUSE_RIVAL_LEVEL = 2;

export type PenthouseBots = 'expert' | 'master';

export interface PenthouseAccess {
  open: boolean;
  /** How the player got in: their bank, or a rival. */
  via: 'bank' | 'rival' | null;
  /** The rival whose grudge opened the door (the one with the most chips between you). */
  rival: string | null;
  /** The best of each road so far, for the lobby's progress line. */
  peak: number;
  rivalChips: number;
}

/** Regulars whose grudge is big enough, most chips first. */
export function bigRivals(rivals: Rivals): string[] {
  return Object.entries(rivals)
    .filter(([, r]) => moodOf(r).level >= PENTHOUSE_RIVAL_LEVEL && r.chips >= PENTHOUSE_RIVAL_CHIPS)
    .sort((a, b) => b[1].chips - a[1].chips)
    .map(([name]) => name);
}

export function penthouseAccess(p: Pick<Profile, 'bank' | 'stats' | 'rivals'>): PenthouseAccess {
  const peak = Math.max(p.stats.peakBank, p.bank);
  const rivals = p.rivals ?? {};
  const big = bigRivals(rivals);
  const rivalChips = Object.values(rivals).reduce((m, r) => (moodOf(r).level >= PENTHOUSE_RIVAL_LEVEL ? Math.max(m, r.chips) : m), 0);
  const viaBank = peak >= PENTHOUSE_BANK;
  return {
    open: viaBank || big.length > 0,
    via: viaBank ? 'bank' : big.length ? 'rival' : null,
    rival: big[0] ?? null,
    peak,
    rivalChips,
  };
}

/**
 * Who sits upstairs: regulars with a score to settle with the player come first (the
 * hottest grudge first), then the rest in the order given.
 */
export function penthouseSeating<T extends { name: string }>(regulars: readonly T[], rivals: Rivals): T[] {
  const heat = (name: string) => {
    const r = rivals[name];
    const m = moodOf(r);
    return m.level > 0 ? m.level * 1e9 + (r?.chips ?? 0) : m.level < 0 ? 1 : 0;
  };
  return regulars
    .map((x, i) => ({ x, i, h: heat(x.name) }))
    .sort((a, b) => b.h - a.h || a.i - b.i)
    .map((e) => e.x);
}

/** One line for the lobby on where the player stands with the door. */
export function penthouseDoorLine(a: PenthouseAccess, fmt: (n: number) => string): string {
  if (a.via === 'bank') return `Your bank has reached ${fmt(PENTHOUSE_BANK)}. You're on the list.`;
  if (a.via === 'rival') return `${a.rival} has a score to settle with you. They'll be waiting upstairs.`;
  return `Reach a bank of ${fmt(PENTHOUSE_BANK)} (best so far ${fmt(a.peak)}), or make a regular hold a grudge after ${fmt(PENTHOUSE_RIVAL_CHIPS)} chips change hands between you${a.rivalChips ? ` (closest ${fmt(a.rivalChips)})` : ''}.`;
}
