import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/engine/cards';
import { Hand, Stakes } from '../src/engine/hand';
import { VARIANTS } from '../src/engine/variants';
import { handTally } from '../src/accounts/achievements';
import { HISTORY_MAX, buyIn, cashOut, createProfile, normalizeProfile, noteChips, setTableStack } from '../src/accounts/profile';
import { chipsSince, playingStyle } from '../src/accounts/stats';

const stakes: Stakes = { sb: 10, bb: 20, ante: 0, bringIn: 0, smallBet: 20, bigBet: 40 };

function holdem(players = 3) {
  return new Hand({
    variant: VARIANTS.holdem, structure: 'NL', stakes,
    players: Array.from({ length: players }, (_, i) => ({ id: `p${i}`, name: `P${i}`, stack: 1000 })),
    button: 0, rng: createRng(7),
  });
}

test('style counters: a pre-flop raise counts toward VPIP, PFR and raise rate; the big blind checking does not', () => {
  // Three players: button (0) raises, small blind (1) folds, big blind (2) calls, then both check it down.
  const h = holdem();
  h.act({ type: 'raise', to: 60 });
  h.act({ type: 'fold' });
  h.act({ type: 'call' });
  for (let k = 0; k < 20 && !h.isComplete; k++) h.act({ type: 'check' });
  assert.ok(h.isComplete);
  const raiser = handTally(h, 0).sum;
  assert.equal(raiser['style.dealt'], 1);
  assert.equal(raiser['style.vpip'], 1);
  assert.equal(raiser['style.pfr'], 1);
  assert.equal(raiser['style.raises'], 1);
  assert.equal(raiser['style.showdowns'], 1);
  const folder = handTally(h, 1).sum;
  assert.equal(folder['style.dealt'], 1);
  assert.equal(folder['style.vpip'], undefined);
  assert.equal(folder['style.decisions'], 1);
  const caller = handTally(h, 2).sum;
  assert.equal(caller['style.vpip'], 1);
  assert.equal(caller['style.pfr'], undefined);
  assert.equal(caller['style.calls'], 1);

  // Everyone folds to the big blind: dealt in, but nothing voluntary.
  const walk = holdem();
  walk.act({ type: 'fold' });
  walk.act({ type: 'fold' });
  assert.ok(walk.isComplete);
  const bb = handTally(walk, 2).sum;
  assert.equal(bb['style.dealt'], 1);
  assert.equal(bb['style.vpip'], undefined);
  assert.equal(bb['style.decisions'], undefined);
});

test('playing style percentages and the read', () => {
  const s = playingStyle({ 'style.dealt': 40, 'style.vpip': 8, 'style.pfr': 6, 'style.decisions': 100, 'style.raises': 25, 'style.calls': 10, 'style.showdowns': 4 });
  assert.equal(s.vpip, 0.2);
  assert.equal(s.pfr, 0.15);
  assert.equal(s.raiseRate, 0.25);
  assert.equal(s.aggression, 2.5);
  assert.equal(s.showdowns, 0.1);
  assert.equal(s.label, 'Tight-aggressive');
  assert.equal(playingStyle({ 'style.dealt': 40, 'style.vpip': 20, 'style.pfr': 2 }).label, 'Loose-passive');
  assert.equal(playingStyle({ 'style.dealt': 10, 'style.vpip': 2 }).label, null, 'too few hands for a read');
  const none = playingStyle({});
  assert.equal(none.vpip, null);
  assert.equal(none.aggression, null);
});

test('chip history follows the bank and cash-game stack, skipping repeats', () => {
  const p = createProfile('Ann', { now: 1000 });
  assert.deepEqual(p.history, [[1000, 10_000]]);
  buyIn(p, 2000);
  assert.equal(p.history.length, 1, 'buying in moves chips but not their total');
  setTableStack(p, 2600);
  cashOut(p);
  assert.deepEqual(p.history.map((x) => x[1]), [10_000, 10_600]);
});

test('chip history thins out once it is full, keeping the first and latest points', () => {
  const p = createProfile('Ann', { now: 0 });
  for (let k = 1; k <= 1000; k++) {
    p.bank = 10_000 + k;
    noteChips(p, k);
  }
  assert.ok(p.history.length < HISTORY_MAX);
  assert.deepEqual(p.history[0], [0, 10_000]);
  assert.deepEqual(p.history[p.history.length - 1], [1000, 11_000]);
  for (let k = 1; k < p.history.length; k++) assert.ok(p.history[k][0] > p.history[k - 1][0]);
});

test('older saves get a chip history starting from their bank now', () => {
  const p = normalizeProfile({ id: 'pr_x', name: 'Old', bank: 4321, updatedAt: 5000 })!;
  assert.deepEqual(p.history, [[5000, 4321]]);
  const kept = normalizeProfile({ id: 'pr_y', name: 'New', history: [[2, 20], 'junk', [1, 10]] })!;
  assert.deepEqual(kept.history, [[1, 10], [2, 20]]);
});

test('a time range opens with the chips held when it starts', () => {
  const h: [number, number][] = [[0, 100], [10, 200], [20, 150]];
  assert.deepEqual(chipsSince(h, 15, 30), [[15, 200], [20, 150], [30, 150]]);
  assert.deepEqual(chipsSince(h, 0, 20), h);
  assert.deepEqual(chipsSince([], 0, 5), []);
});
