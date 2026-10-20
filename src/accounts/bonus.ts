// The daily chip bonus: once a day a player collects free chips, more for each day in a row.
// For online players the server keeps the claim time (supabase/leaderboard.sql, which repeats
// these numbers), so changing the device clock or editing saved data can't collect it twice.
// Players kept only in this browser use the same rules with the browser's clock.
import { Profile } from './profile';

/** Hours to wait between claims. A little under a day, so the time of day can drift. */
export const BONUS_COOLDOWN_HOURS = 20;
/** Claiming within this many hours of the last claim keeps the streak going. */
export const BONUS_STREAK_HOURS = 48;
export const BONUS_BASE = 1_000;
export const BONUS_STEP = 500;
/** The streak stops adding chips after this many days. */
export const BONUS_MAX_DAY = 7;

const HOUR = 3_600_000;

export interface BonusRecord {
  /** When the bonus was last collected (epoch ms), or null if never. */
  last: number | null;
  /** Days in a row collected, counting the last claim. */
  streak: number;
}

/** Chips for the `day`th day in a row: 1,000 on day one, up 500 a day to 4,000 from day seven. */
export const bonusAmount = (day: number): number => BONUS_BASE + BONUS_STEP * (Math.min(Math.max(day, 1), BONUS_MAX_DAY) - 1);

/** When the bonus can next be collected (epoch ms); 0 means now. */
export const nextBonusAt = (b: BonusRecord): number => (b.last === null ? 0 : b.last + BONUS_COOLDOWN_HOURS * HOUR);

export const bonusReady = (b: BonusRecord, now = Date.now()): boolean => now >= nextBonusAt(b);

/** Which day of the streak a claim made `now` would be. */
export function streakDay(b: BonusRecord, now = Date.now()): number {
  return b.last !== null && now - b.last <= BONUS_STREAK_HOURS * HOUR ? b.streak + 1 : 1;
}

export interface BonusClaim {
  /** Chips added to the bank, or 0 when it was too soon. */
  amount: number;
  streak: number;
  /** When the claim landed (or the last one, if too soon). */
  last: number;
}

/** Applies a claim to the profile: chips into the bank and the claim remembered. */
export function applyBonus(p: Profile, c: BonusClaim): void {
  p.bonus = { last: c.last, streak: c.streak };
  if (c.amount > 0) {
    p.bank += c.amount;
    p.stats.peakBank = Math.max(p.stats.peakBank, p.bank);
  }
  p.updatedAt = Date.now();
}

/** A claim checked against the browser's clock, for players that aren't saved online. */
export function claimLocally(p: Profile, now = Date.now()): BonusClaim {
  if (!bonusReady(p.bonus, now)) return { amount: 0, streak: p.bonus.streak, last: p.bonus.last ?? now };
  const day = streakDay(p.bonus, now);
  const claim = { amount: bonusAmount(day), streak: day, last: now };
  applyBonus(p, claim);
  return claim;
}
