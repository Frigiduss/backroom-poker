import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bots/bot';
import { buildView } from '../src/bots/view';
import { Card, createRng, parseCards } from '../src/engine/cards';
import { Hand, Stakes } from '../src/engine/hand';
import { HandHistory, chapters, historyNet, isHandHistory, recordHistory, replayFrames, sourceOfHand } from '../src/engine/history';
import { Table } from '../src/engine/table';
import { VARIANTS, VARIANT_ORDER } from '../src/engine/variants';

interface Seen {
  pot: number;
  board: Card[];
  mine: Card[];
  bets: number[];
  stacks: number[];
}

/** Plays bot hands, saving from seat 0 what the table looked like before each move, and checks the replay matches. */
for (const id of VARIANT_ORDER) {
  test(`${id}: replay frames match the hand as it was played`, () => {
    const players = Math.min(5, VARIANTS[id].maxPlayers);
    const seats = Array.from({ length: players }, (_, i) => ({ name: `Bot${i}`, isHuman: false, difficulty: 'medium' as const }));
    const t = new Table({ variant: id, structure: VARIANTS[id].defaultStructure, format: 'cash', startingStack: 600, bigBlind: 20, handsPerLevel: 6, seats, seed: 3 });
    const bots = t.seats.map((s, i) => new Bot('medium', i % 2 ? 'aggressive' : 'loose', 40 + i));
    for (let n = 0; n < 40; n++) {
      const h = t.nextHand();
      const me = 0;
      const seen: Seen[] = [];
      while (!h.isComplete) {
        seen.push({
          pot: h.pot, board: [...h.board], mine: [...h.players[me].cards],
          bets: h.players.map((p) => (h.phase === 'draw' ? 0 : p.streetBet)), stacks: h.players.map((p) => p.stack),
        });
        const seat = t.seatOf(h.toAct);
        h.act(h.normalize(bots[t.seats.indexOf(seat)].decide(buildView(h, h.toAct, t.stats))));
      }
      const rec = recordHistory(sourceOfHand(h, me), me, { where: 'Cash game', number: t.handNumber, at: 1000 + n })!;
      assert.ok(isHandHistory(JSON.parse(JSON.stringify(rec))));
      const frames = replayFrames(rec);
      const acted = frames.flatMap((f, k) => (f.actor >= 0 ? [k] : []));
      const moves = h.actions.filter((a) => a.type !== 'blind' && a.type !== 'ante');
      assert.equal(acted.length, moves.length, 'one frame per move');
      acted.forEach((k, m) => {
        const before = frames[k - 1];
        const s = seen[m];
        assert.equal(frames[k].actor, moves[m].player);
        assert.equal(before.pot, s.pot, `pot before move ${m}`);
        assert.deepEqual(before.board, s.board, `board before move ${m}`);
        assert.deepEqual(before.players[me].cards.map((c) => c.card), s.mine, `my cards before move ${m}`);
        assert.deepEqual(before.players.map((p) => p.stack), s.stacks, `stacks before move ${m}`);
        if (VARIANTS[id].family !== 'draw' || !before.chapter.includes('draw')) assert.deepEqual(before.players.map((p) => p.bet), s.bets, `bets before move ${m}`);
      });
      const last = frames[frames.length - 1];
      assert.ok(last.final);
      assert.deepEqual(last.board, h.board);
      assert.deepEqual(last.players.map((p) => p.stack), h.players.map((p) => p.stack));
      assert.equal(historyNet(rec), h.players[me].stack - h.players[me].startStack);
      // Nobody else's hidden cards leak, and shown hands appear at the end.
      h.players.forEach((p, i) => {
        if (i === me) return;
        last.players[i].cards.forEach((c, k) => {
          if (c.card !== null) assert.ok(c.up || p.shown, `${p.name} card ${k} was never shown`);
        });
        if (p.shown) assert.deepEqual(last.players[i].cards.map((c) => c.card), p.cards);
      });
      for (const f of frames.slice(0, -1)) {
        f.players.forEach((p, i) => i !== me && p.cards.forEach((c) => assert.ok(c.card === null || c.up, 'face-down cards stay hidden until the end')));
      }
      assert.equal(chapters(frames).at(-1)!.name, 'Result');
      t.finishHand();
    }
  });
}

const stakes: Stakes = { sb: 10, bb: 20, ante: 0, bringIn: 0, smallBet: 20, bigBet: 40 };

test('an all-in before the flop runs out the board street by street', () => {
  const h = new Hand({
    variant: VARIANTS.holdem, structure: 'NL', stakes, button: 0, rng: createRng(1),
    players: [{ id: 'a', name: 'Ann', stack: 500 }, { id: 'b', name: 'Bo', stack: 500 }],
    rig: { hole: { 0: parseCards('As Ad'), 1: parseCards('Kc Kd') }, board: parseCards('2c 7d 9h Js 3s') },
  });
  h.act({ type: 'raise', to: 500 });
  h.act({ type: 'call' });
  assert.ok(h.isComplete);
  const rec = recordHistory(sourceOfHand(h, 0), 0, { where: 'Cash game', number: 1 })!;
  const frames = replayFrames(rec);
  assert.deepEqual(chapters(frames).map((c) => c.name), ['Pre-flop', 'Flop', 'Turn', 'River', 'Result']);
  assert.equal(frames[1].text, 'Ann raises to 500 and is all-in');
  // Bo's kings stay face down until the showdown.
  assert.equal(frames[3].players[1].cards[0].card, null);
  assert.deepEqual(frames.at(-1)!.players[1].cards.map((c) => c.card), parseCards('Kc Kd'));
  assert.equal(frames.at(-1)!.players[0].stack, 1000);
  assert.equal(historyNet(rec), 500);
});

test('a folded hand keeps the winner\'s cards hidden', () => {
  const h = new Hand({
    variant: VARIANTS.holdem, structure: 'NL', stakes, button: 0, rng: createRng(1),
    players: [{ id: 'a', name: 'Ann', stack: 500 }, { id: 'b', name: 'Bo', stack: 500 }],
  });
  h.act({ type: 'raise', to: 60 });
  h.act({ type: 'fold' });
  const fromBo = recordHistory(sourceOfHand(h, 1), 1, { where: 'Cash game', number: 1 })!;
  assert.deepEqual(fromBo.players[0].cards, [null, null]);
  assert.deepEqual(fromBo.players[1].cards, h.players[1].cards);
  assert.equal(historyNet(fromBo), -20);
});

test('draws keep track of which cards were swapped', () => {
  const h = new Hand({
    variant: VARIANTS.draw5, structure: 'FL', stakes, button: 0, rng: createRng(5),
    players: [{ id: 'a', name: 'Ann', stack: 500 }, { id: 'b', name: 'Bo', stack: 500 }],
    rig: { hole: { 0: parseCards('As Ad 7c 4h 2s Ac 9d'), 1: parseCards('Kc Kd Qh Qs 3c 8h') } },
  });
  h.act({ type: 'call' });
  h.act({ type: 'check' });
  h.act({ type: 'draw', discard: [4] });
  h.act({ type: 'draw', discard: [2, 4] });
  assert.equal(h.actions.filter((a) => a.type === 'draw')[1].discard?.join(), '2,4');
  h.act({ type: 'check' });
  h.act({ type: 'check' });
  const rec = recordHistory(sourceOfHand(h, 1), 1, { where: 'Cash game', number: 1 })!;
  const frames = replayFrames(rec);
  assert.deepEqual(chapters(frames).map((c) => c.name), ['Before the draw', 'The draw', 'After the draw', 'Result']);
  const afterDraw = frames.find((f) => f.chapter === 'After the draw')!;
  assert.deepEqual(afterDraw.players[1].cards.map((c) => c.card), h.players[1].cards);
  assert.deepEqual(frames.at(-1)!.players[0].cards.map((c) => c.card), h.players[0].cards);
});

test('old or broken saves are skipped', () => {
  assert.equal(isHandHistory(null), false);
  assert.equal(isHandHistory({ v: 2 }), false);
  const ok: HandHistory = {
    v: 1, id: 'x', at: 0, variant: 'holdem', structure: 'NL', stakes, button: 0, me: 0, where: '', number: 1,
    players: [{ name: 'a', start: 1, end: 1, cards: [], shown: false, won: 0, handName: null }, { name: 'b', start: 1, end: 1, cards: [], shown: false, won: 0, handName: null }],
    board: [], actions: [], showdown: false, summary: [],
  };
  assert.equal(isHandHistory(ok), true);
});
