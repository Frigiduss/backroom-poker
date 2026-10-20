import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, parseCards } from '../src/engine/cards';
import { Hand, Stakes } from '../src/engine/hand';
import { VARIANTS } from '../src/engine/variants';
import {
  ACHIEVEMENTS, ACHIEVEMENT_BY_ID, addTally, cashTally, combine, handTally, runAfter, titleFor, tournamentTally,
} from '../src/accounts/achievements';
import { allCounters, createProfile, credit, normalizeProfile, takeUnlocks } from '../src/accounts/profile';

const stakes: Stakes = { sb: 10, bb: 20, ante: 0, bringIn: 0, smallBet: 20, bigBet: 40 };
const studStakes: Stakes = { sb: 0, bb: 20, ante: 2, bringIn: 5, smallBet: 20, bigBet: 40 };

/** A two-player hand with fixed cards, both checking or calling down to a showdown. */
function showdown(variant: keyof typeof VARIANTS, hole0: string, hole1: string, board = '') {
  const h = new Hand({
    variant: VARIANTS[variant], structure: VARIANTS[variant].defaultStructure, stakes: VARIANTS[variant].family === 'stud' ? studStakes : stakes,
    players: [{ id: 'p0', name: 'A', stack: 1000 }, { id: 'p1', name: 'B', stack: 1000 }],
    button: 0, rng: createRng(3), rig: { hole: { 0: parseCards(hole0), 1: parseCards(hole1) }, board: parseCards(board) },
  });
  for (let i = 0; i < 40 && !h.isComplete; i++) {
    const L = h.legal();
    if (L.kind === 'draw') h.act({ type: 'draw', discard: [] });
    else if (L.kind === 'bet') h.act(L.check ? { type: 'check' } : L.bringIn ? { type: 'bringin' } : { type: 'call' });
  }
  assert.ok(h.isComplete && h.result?.showdown);
  return h;
}

test('the list is big, every id is unique, and titles are unique', () => {
  assert.ok(ACHIEVEMENTS.length >= 90, `${ACHIEVEMENTS.length} achievements`);
  assert.equal(new Set(ACHIEVEMENTS.map((a) => a.id)).size, ACHIEVEMENTS.length);
  const titles = ACHIEVEMENTS.filter((a) => a.title).map((a) => a.title);
  assert.ok(titles.length >= 50);
  assert.equal(new Set(titles).size, titles.length);
  for (const a of ACHIEVEMENTS) assert.equal(a.measure({}), 0, `${a.id} starts at zero`);
});

test('a royal flush at showdown counts as a royal, a straight flush, a win and a showdown win', () => {
  const h = showdown('holdem', 'As Ks', '2c 2d', 'Qs Js Ts 3h 4c');
  const t = handTally(h, 0);
  assert.equal(t.sum.hands, 1);
  assert.equal(t.sum.wins, 1);
  assert.equal(t.sum.showdownWins, 1);
  assert.equal(t.sum['made.straightFlush'], 1);
  assert.equal(t.sum['made.royal'], 1);
  assert.equal(t.sum['win.holdem'], 1);
  const loser = handTally(h, 1);
  assert.equal(loser.sum.wins, undefined);
  assert.equal(loser.sum.hands, 1);
});

test('losing with a full house is a bad beat; winning with Seven-Two is the Hammer', () => {
  const h = showdown('holdem', '7c 2d', 'Ks Kd', 'Kh 7h 7s 2s Qc');
  // Sevens full of twos loses to kings full of sevens.
  const a = handTally(h, 0);
  const b = handTally(h, 1);
  assert.equal(b.sum['made.fullHouse'], 1);
  assert.equal(a.sum.badBeats, 1);
  const hammer = showdown('holdem', '7c 2d', 'Ks Qd', '7h 7s 2s 3c 4d');
  assert.equal(handTally(hammer, 0).sum.hammer, 1);
});

test('a wheel wins the low in razz', () => {
  const h = showdown('razz', 'Ac 2d 3h 4s 5c 9d 9h', 'Kc Qd Jh Ts 8c 8d 8h');
  const t = handTally(h, 0);
  assert.equal(t.sum.lowWins, 1);
  assert.equal(t.sum.wheels, 1);
});

test('online counters only come from the server', () => {
  const local = { hands: 10, 'online.games': 500 };
  const server = { hands: 5, 'online.games': 2, bigPotBB: 30 };
  const c = combine({ ...local, bigPotBB: 60 }, server);
  assert.equal(c.hands, 15, 'totals add up');
  assert.equal(c['online.games'], 2, "the browser's own online count is ignored");
  assert.equal(c.bigPotBB, 60, 'best values keep the best');
  const rec = {};
  addTally(rec, { sum: { 'online.hands': 9, hands: 1 }, max: {} });
  assert.deepEqual(rec, { hands: 1 });
  assert.equal(titleFor('online-250', { 'online.games': 300 }), 'Card Room Regular');
  assert.equal(titleFor('online-250', combine({ 'online.games': 300 }, {})), null);
});

test('tournament wins count toward bot hunting only when every bot was the same level', () => {
  const t = tournamentTally({ format: 'sng', place: 1, cashed: true, bots: ['expert', 'expert', 'expert', 'expert', 'expert'] });
  assert.equal(t.sum.sngWins, 1);
  assert.equal(t.sum['beat.expert'], 1);
  assert.equal(t.sum['beat.expertFull'], 1);
  assert.equal(t.sum.cashes, 1);
  const mixed = tournamentTally({ format: 'headsup', place: 1, cashed: true, bots: ['easy', 'hard'] });
  assert.equal(mixed.sum.huWins, 1);
  assert.equal(Object.keys(mixed.sum).filter((k) => k.startsWith('beat.')).length, 0);
  assert.deepEqual(tournamentTally({ format: 'sng', place: 3, cashed: false, bots: ['easy'] }).sum, {});
  assert.equal(cashTally(2000, 20).max.cashBestBB, 100);
  assert.deepEqual(cashTally(-50, 20), { sum: {}, max: {} });
});

test('players saved before achievements keep credit for their history, without a flood of pop-ups', () => {
  const old = createProfile('Old Timer') as unknown as Record<string, unknown>;
  delete old.achievements;
  delete old.title;
  (old.stats as Record<string, unknown>).hands = 1500;
  (old.stats as Record<string, unknown>).handsWon = 120;
  const p = normalizeProfile(old)!;
  assert.equal(p.achievements.counters.hands, 1500);
  assert.ok('hands-1000' in p.achievements.unlocked, 'already marked as unlocked');
  assert.deepEqual(takeUnlocks(p), [], 'no pop-ups for old progress');
  credit(p, { sum: { 'made.flush': 1 }, max: {} });
  assert.deepEqual(takeUnlocks(p).map((a) => a.id), ['flush-1']);
  assert.deepEqual(takeUnlocks(p), [], 'each unlock is announced once');
  assert.deepEqual(takeUnlocks(p, { 'online.hands': 100 }).map((a) => a.id), ['online-hands-100']);
  assert.equal(allCounters(p).peakBank, p.stats.peakBank);
});

test('a winning run resets on any hand not won', () => {
  const h = showdown('holdem', 'As Ah', '2c 7d', 'Kh Qh 3s 4c 9d');
  assert.equal(runAfter(2, h, 0), 3);
  assert.equal(runAfter(2, h, 1), 0);
  assert.ok(ACHIEVEMENT_BY_ID.get('run-3'));
});
