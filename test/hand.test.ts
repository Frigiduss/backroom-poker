import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/engine/cards';
import { Hand, Stakes } from '../src/engine/hand';
import { VARIANTS } from '../src/engine/variants';

const stakes: Stakes = { sb: 10, bb: 20, ante: 0, bringIn: 0, smallBet: 20, bigBet: 40 };
const mk = (stacks: number[], structure: 'NL' | 'PL' | 'FL' = 'NL', button = 0) =>
  new Hand({ variant: VARIANTS.holdem, structure, stakes, players: stacks.map((s, i) => ({ id: `p${i}`, name: `P${i}`, stack: s })), button, rng: createRng(7) });

test('blinds and first to act, three handed', () => {
  const h = mk([1000, 1000, 1000]);
  assert.equal(h.sbIndex, 1);
  assert.equal(h.bbIndex, 2);
  assert.equal(h.toAct, 0);
  assert.equal(h.pot, 30);
});

test('heads up: button posts small blind and acts first preflop, last after', () => {
  const h = mk([1000, 1000]);
  assert.equal(h.sbIndex, 0);
  assert.equal(h.toAct, 0);
  h.act({ type: 'call' });
  assert.equal(h.toAct, 1); // big blind option
  h.act({ type: 'check' });
  assert.equal(h.street, 1);
  assert.equal(h.toAct, 1);
});

test('no-limit min raise and re-raise sizes', () => {
  const h = mk([1000, 1000, 1000]);
  let L = h.legal();
  assert.ok(L.kind === 'bet' && L.minRaiseTo === 40 && L.maxRaiseTo === 1000);
  h.act({ type: 'raise', to: 100 });
  L = h.legal();
  assert.ok(L.kind === 'bet' && L.minRaiseTo === 180);
});

test('pot-limit maximum', () => {
  const h = mk([1000, 1000, 1000], 'PL');
  const L = h.legal();
  // pot 30 + call 20 = 50, raise to 20 + 50 = 70
  assert.ok(L.kind === 'bet' && L.maxRaiseTo === 70);
});

test('fixed-limit raise cap', () => {
  const h = mk([1000, 1000, 1000], 'FL');
  h.act({ type: 'raise', to: 40 });
  h.act({ type: 'raise', to: 60 });
  h.act({ type: 'raise', to: 80 });
  const L = h.legal();
  assert.ok(L.kind === 'bet' && !L.raise && L.call);
});

test('side pots with three all-ins', () => {
  const h = mk([100, 300, 600]);
  h.act({ type: 'raise', to: 100 }); // P0 all in
  h.act({ type: 'raise', to: 300 }); // P1 all in
  h.act({ type: 'call' }); // P2 calls 300
  assert.ok(h.isComplete);
  const pots = h.result!.pots;
  assert.deepEqual(pots.map((p) => p.amount), [300, 400]);
  const total = h.players.reduce((t, p) => t + p.stack, 0);
  assert.equal(total, 1000);
});

test('incomplete all-in raise does not reopen betting', () => {
  const h = mk([150, 1000, 1000, 1000], 'NL', 0); // sb P1, bb P2, P3 first
  assert.equal(h.toAct, 3);
  h.act({ type: 'raise', to: 100 });
  h.act({ type: 'raise', to: 150 }); // P0 all in for less than a full raise
  h.act({ type: 'fold' });
  h.act({ type: 'fold' });
  assert.equal(h.toAct, 3);
  const L = h.legal();
  assert.ok(L.kind === 'bet' && L.call && !L.raise && L.callAmount === 50);
});

test('everyone folds to the big blind', () => {
  const h = mk([1000, 1000, 1000]);
  h.act({ type: 'fold' });
  h.act({ type: 'fold' });
  assert.ok(h.isComplete);
  assert.equal(h.players[2].stack, 1010);
});

test('stud bring-in and completion', () => {
  const st: Stakes = { sb: 0, bb: 20, ante: 2, bringIn: 5, smallBet: 20, bigBet: 40 };
  const h = new Hand({ variant: VARIANTS.stud7, structure: 'FL', stakes: st, players: [0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `P${i}`, stack: 500 })), button: 0, rng: createRng(3) });
  const L = h.legal();
  assert.ok(L.kind === 'bet' && L.bringIn && L.bringInAmount === 5 && L.minRaiseTo === 20);
  h.act({ type: 'bringin' });
  const L2 = h.legal();
  assert.ok(L2.kind === 'bet' && L2.callAmount === 5 && L2.minRaiseTo === 20);
  h.act({ type: 'raise', to: 20 });
  const L3 = h.legal();
  assert.ok(L3.kind === 'bet' && L3.minRaiseTo === 40);
});
