import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, parseCards } from '../src/engine/cards';
import { Hand, Stakes, rigProblem } from '../src/engine/hand';
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

test('a rig deals chosen hole cards and board, and the rest of the deck stays whole', () => {
  const rng = createRng(7);
  const hand = new Hand({
    variant: VARIANTS.holdem, structure: 'NL', stakes: { sb: 1, bb: 2, ante: 0, bringIn: 0, smallBet: 2, bigBet: 4 },
    players: [{ id: 'a', name: 'A', stack: 100 }, { id: 'b', name: 'B', stack: 100 }, { id: 'c', name: 'C', stack: 100 }],
    button: 0, rng, rig: { hole: { 1: parseCards('As Ad') }, board: parseCards('Ah Ac 2d 7s 9h') },
  });
  assert.deepEqual(hand.players[1].cards, parseCards('As Ad'));
  while (!hand.isComplete) hand.act(hand.normalize({ type: 'call' }));
  assert.deepEqual(hand.board, parseCards('Ah Ac 2d 7s 9h'));
  const seen = [...hand.board, ...hand.players.flatMap((p) => p.cards)];
  assert.equal(new Set(seen).size, seen.length);
});

test('setBoard fixes the cards still to come and refuses ones already out', () => {
  const hand = new Hand({
    variant: VARIANTS.holdem, structure: 'NL', stakes: { sb: 1, bb: 2, ante: 0, bringIn: 0, smallBet: 2, bigBet: 4 },
    players: [{ id: 'a', name: 'A', stack: 100 }, { id: 'b', name: 'B', stack: 100 }],
    button: 0, rng: createRng(3),
  });
  assert.throws(() => hand.setBoard([hand.players[0].cards[0]]), /already been dealt/);
  hand.setBoard(parseCards('Kh Qh Jh'));
  assert.deepEqual(hand.upcoming(52).filter((c) => parseCards('Kh Qh Jh').includes(c)), []);
  while (hand.board.length < 3) hand.act(hand.normalize({ type: 'call' }));
  assert.deepEqual(hand.board, parseCards('Kh Qh Jh'));
});

test('rigProblem catches repeated cards and short-deck gaps', () => {
  assert.match(rigProblem({ hole: { 0: parseCards('As Ad') }, board: parseCards('As') }, false)!, /twice/);
  assert.match(rigProblem({ hole: { 0: parseCards('2s 3d') } }, true)!, /short deck/);
  assert.equal(rigProblem({ hole: { 0: parseCards('As Ad') } }, false), null);
});

test('coming() names the flop, turn and river before they are dealt', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const hand = new Hand({
      variant: VARIANTS.holdem, structure: 'NL', stakes: { sb: 1, bb: 2, ante: 0, bringIn: 0, smallBet: 2, bigBet: 4 },
      players: [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}`, stack: 100 })), button: 0, rng: createRng(seed),
    });
    const told = hand.coming();
    assert.deepEqual(told.map((s) => s.name), ['Flop', 'Turn', 'River']);
    while (!hand.isComplete) hand.act(hand.normalize({ type: 'call' }));
    assert.deepEqual(hand.board, told.flatMap((s) => s.board), `seed ${seed}`);
  }
});

test('coming() follows a fixed board, and stud and draw cards', () => {
  const stakes = { sb: 1, bb: 2, ante: 1, bringIn: 1, smallBet: 2, bigBet: 4 };
  const players = [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}`, stack: 500 }));
  const flop = new Hand({ variant: VARIANTS.holdem, structure: 'NL', stakes, players, button: 0, rng: createRng(5) });
  const spare = flop.upcoming(52).slice(-2);
  flop.setBoard(spare);
  assert.deepEqual(flop.coming()[0].board.slice(0, 2), spare);

  const stud = new Hand({ variant: VARIANTS.stud7, structure: 'FL', stakes, players, button: 0, rng: createRng(9) });
  const fourth = stud.coming()[0];
  assert.equal(fourth.name, 'Fourth street');
  while (stud.street === 0 && !stud.isComplete) stud.act(stud.normalize({ type: 'call' }));
  for (const { player, card } of fourth.players) assert.equal(stud.players[player].cards[3], card);

  const draw = new Hand({ variant: VARIANTS.draw5, structure: 'FL', stakes, players, button: 0, rng: createRng(4) });
  const next = draw.coming()[0].draws;
  while (draw.phase !== 'draw' && !draw.isComplete) draw.act(draw.normalize({ type: 'call' }));
  const who = draw.toAct;
  draw.act({ type: 'draw', discard: [0, 1] });
  assert.deepEqual(draw.players[who].cards.slice(-2), next.slice(0, 2));
});
