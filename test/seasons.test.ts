import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACHIEVEMENT_BY_ID, emptyTally, isUnlocked } from '../src/accounts/achievements';
import { LOOKS, lookFor, lookOnLoan, lookUnlocked } from '../src/accounts/looks';
import { SEASONS, Season, nextSeason, seasonCounter, seasonIsOn, seasonLastDay, seasonOn, withSeason } from '../src/accounts/seasons';
import { createProfile, credit } from '../src/accounts/profile';

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12);
const winter = SEASONS.find((s) => s.id === 'winter')!;
const snowfall = LOOKS.find((l) => l.id === 'snowfall')!;
const snowflake = LOOKS.find((l) => l.id === 'snowflake')!;

test('every season has its felt, card back and achievement wired up', () => {
  assert.equal(new Set(SEASONS.map((s) => s.id)).size, SEASONS.length);
  for (const s of SEASONS) {
    const a = ACHIEVEMENT_BY_ID.get(s.achievement);
    assert.ok(a, `${s.id} has achievement ${s.achievement}`);
    assert.equal(a!.group, 'events');
    assert.equal(a!.goal, s.goal);
    assert.equal(a!.measure({ [seasonCounter(s.id)]: s.goal }), s.goal, 'the achievement watches the season counter');
    for (const id of [s.felt, s.back]) {
      const l = LOOKS.find((x) => x.id === id);
      assert.ok(l, `${s.id} look ${id} exists`);
      assert.equal(l!.season, s.id);
      assert.equal(l!.unlock, s.achievement);
    }
  }
});

test('Winter Nights runs through December only', () => {
  assert.equal(seasonOn(day(2026, 11, 30)), null);
  assert.equal(seasonOn(day(2026, 12, 1))?.id, 'winter');
  assert.equal(seasonOn(day(2026, 12, 31))?.id, 'winter');
  assert.equal(seasonOn(day(2027, 1, 1)), null);
  assert.equal(seasonLastDay(winter, day(2026, 12, 10)).toDateString(), day(2026, 12, 31).toDateString());
  assert.equal(nextSeason(day(2026, 11, 1))?.starts.toDateString(), day(2026, 12, 1).toDateString());
  assert.equal(nextSeason(day(2026, 12, 2))?.starts.getFullYear(), 2027);
});

test('an event can run over New Year', () => {
  const s: Season = { ...winter, from: [12, 20], to: [1, 5] };
  assert.ok(seasonIsOn(s, day(2026, 12, 25)));
  assert.ok(seasonIsOn(s, day(2027, 1, 3)));
  assert.ok(!seasonIsOn(s, day(2027, 1, 6)));
  assert.ok(!seasonIsOn(s, day(2026, 12, 19)));
  assert.equal(seasonLastDay(s, day(2026, 12, 25)).toDateString(), day(2027, 1, 5).toDateString());
  assert.equal(seasonLastDay(s, day(2027, 1, 2)).toDateString(), day(2027, 1, 5).toDateString());
});

test('every game counts once toward the event that is on, and nothing counts out of season', () => {
  const key = seasonCounter('winter');
  for (const k of ['hands', 'bj.hands', 'rl.spins', 'bac.hands', 'vp.hands', 'sl.spins']) {
    assert.equal(withSeason({ sum: { [k]: 1 }, max: {} }, day(2026, 12, 5)).sum[key], 1, k);
  }
  assert.equal(withSeason({ sum: { hands: 1 }, max: {} }, day(2026, 11, 5)).sum[key], undefined);
  assert.equal(withSeason({ sum: { sngWins: 1, cashUp: 1 }, max: {} }, day(2026, 12, 5)).sum[key], undefined, 'tournament finishes are not games');
  assert.deepEqual(withSeason(emptyTally(), day(2026, 12, 5)), emptyTally());
});

test('credit() counts toward the event, and 50 December games earn the looks for good', () => {
  const p = createProfile('Snow');
  for (let i = 0; i < 49; i++) credit(p, { sum: { hands: 1 }, max: {} }, day(2026, 12, 3));
  credit(p, { sum: { hands: 1 }, max: {} }, day(2026, 11, 30));
  const a = ACHIEVEMENT_BY_ID.get('snowed-in')!;
  assert.equal(p.achievements.counters[seasonCounter('winter')], 49);
  assert.ok(!isUnlocked(a, p.achievements.counters));
  credit(p, { sum: { 'sl.spins': 1 }, max: {} }, day(2026, 12, 31));
  assert.ok(isUnlocked(a, p.achievements.counters));
  assert.ok(lookUnlocked(snowfall, p.achievements.counters, day(2027, 6, 1)), 'kept after the event');
});

test('seasonal looks are free while the event is on and locked after unless earned', () => {
  const settings = { look: { felt: 'snowfall', back: 'snowflake' } };
  const dec = day(2026, 12, 15);
  const jan = day(2027, 1, 2);
  assert.ok(lookUnlocked(snowfall, {}, dec));
  assert.ok(lookOnLoan(snowflake, {}, dec));
  assert.deepEqual(lookFor(settings, {}, dec), { felt: 'snowfall', back: 'snowflake' });
  assert.ok(!lookUnlocked(snowfall, {}, jan));
  assert.deepEqual(lookFor(settings, {}, jan), { felt: 'emerald', back: 'classic' }, 'falls back once the loan ends');
  const kept = { [seasonCounter('winter')]: 50 };
  assert.ok(!lookOnLoan(snowfall, kept, dec), 'earned, not on loan');
  assert.deepEqual(lookFor(settings, kept, jan), { felt: 'snowfall', back: 'snowflake' });
});
