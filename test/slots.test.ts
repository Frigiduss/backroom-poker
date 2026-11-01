import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/engine/cards';
import { LINES, MAX_LINES, PAYS, REELS, linePay, returnToPlayer, settleSpin, spinSlots, windowAt } from '../src/engine/slots';
import { ACHIEVEMENT_BY_ID, slotsTally, unlockedIn } from '../src/accounts/achievements';

test('lines pay the right line of the pay table', () => {
  assert.equal(linePay(['seven', 'seven', 'seven']), 'sevens');
  assert.equal(linePay(['crown', 'crown', 'crown']), 'crowns');
  assert.equal(linePay(['chip', 'chip', 'chip']), 'chips');
  assert.equal(linePay(['club', 'club', 'club']), 'clubs');
  assert.equal(linePay(['heart', 'diamond', 'heart']), 'anyRed');
  assert.equal(linePay(['spade', 'club', 'club']), 'anyBlack');
  assert.equal(linePay(['spade', 'heart', 'club']), null, 'mixed colours pay nothing');
  assert.equal(linePay(['seven', 'chip', 'chip']), 'twoChips');
  assert.equal(linePay(['chip', 'seven', 'chip']), 'twoChips');
  assert.equal(linePay(['chip', 'seven', 'crown']), 'oneChip');
  assert.equal(linePay(['seven', 'chip', 'crown']), null, 'one chip only pays on the first reel');
  assert.equal(linePay(['seven', 'seven', 'crown']), null);
});

test('the window shows each reel stop with its neighbours, wrapping round the strip', () => {
  const grid = windowAt([0, 5, REELS[2].length - 1]);
  assert.deepEqual(grid[0], [REELS[0][REELS[0].length - 1], REELS[0][0], REELS[0][1]]);
  assert.deepEqual(grid[1], REELS[1].slice(4, 7));
  assert.deepEqual(grid[2], [REELS[2][REELS[2].length - 2], REELS[2][REELS[2].length - 1], REELS[2][0]]);
});

test('only the lines bought are paid, a coin each', () => {
  // Find stops with three sevens across the top row, then check which lines pay.
  const top = REELS.map((strip) => (strip.indexOf('seven') + 1) % strip.length);
  const all = settleSpin(top, MAX_LINES, 25);
  const sevens = all.wins.find((w) => w.pay === 'sevens');
  assert.ok(sevens, 'top row pays three sevens');
  assert.equal(sevens!.line, 1);
  assert.equal(sevens!.amount, 500 * 25);
  assert.equal(all.staked, 125);
  assert.equal(all.paid, all.wins.reduce((s, w) => s + w.amount, 0));
  const one = settleSpin(top, 1, 25);
  assert.ok(!one.wins.some((w) => w.line > 0), 'a one-line bet only plays the middle row');
  assert.equal(one.staked, 25);
});

test('the machine pays back about 95% and pays often enough to be fun', () => {
  const { rtp, hitRate, odds } = returnToPlayer();
  assert.ok(rtp > 0.93 && rtp < 0.97, `return ${rtp}`);
  assert.ok(hitRate > 0.2, `hit rate ${hitRate}`);
  assert.ok(odds.sevens > 0 && odds.sevens < odds.crowns && odds.crowns < odds.chips, 'the bigger prizes are rarer');
  assert.equal(PAYS.length, Object.keys(odds).length);
  assert.ok(LINES.every((l) => l.length === REELS.length));
});

test('a long run of spins comes out near the counted return', () => {
  const rng = createRng(7);
  let staked = 0;
  let paid = 0;
  for (let i = 0; i < 60000; i++) {
    const s = spinSlots(1, 1, rng);
    staked += s.staked;
    paid += s.paid;
  }
  assert.ok(Math.abs(paid / staked - returnToPlayer().rtp) < 0.06, `simulated ${paid / staked}`);
});

test('slot spins count toward the slot achievements', () => {
  const top = REELS.map((strip) => (strip.indexOf('seven') + 1) % strip.length);
  const t = slotsTally(settleSpin(top, MAX_LINES, 25));
  assert.equal(t.sum['sl.spins'], 1);
  assert.equal(t.sum['sl.sevens'], 1);
  assert.ok(t.max['sl.bigWin']! > 2500);
  assert.ok(unlockedIn({ 'sl.sevens': 1 }).map((a) => a.id).includes('sl-sevens'));
  assert.equal(ACHIEVEMENT_BY_ID.get('sl-sevens')?.group, 'slots');
  assert.deepEqual(slotsTally({ ...settleSpin(top, 1, 5), staked: 0 }).sum, {});
});
