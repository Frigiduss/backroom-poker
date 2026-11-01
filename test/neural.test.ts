import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bots/bot';
import { NET_ACTIONS, NET_FEATURES, forward, unpack } from '../src/bots/neural';
import { NEURAL_WEIGHTS } from '../src/bots/neural-weights';
import { buildView } from '../src/bots/view';
import { CLASSIC_DIFFICULTIES, DIFFICULTIES, Table, difficultiesFor, hasMaster } from '../src/engine/table';
import { Structure, VariantId } from '../src/engine/variants';

test('the packed net unpacks to the expected shape and gives finite scores', () => {
  const net = unpack(NEURAL_WEIGHTS);
  assert.equal(net.sizes.at(-1), NET_ACTIONS);
  assert.ok(net.sizes[0] >= NET_FEATURES);
  net.W.forEach((w, l) => assert.equal(w.length, net.sizes[l] * net.sizes[l + 1]));
  const out = forward(net, new Float32Array(net.sizes[0]).fill(0.3));
  assert.equal(out.length, NET_ACTIONS);
  assert.ok([...out].every(Number.isFinite));
});

test('Master is offered only for No-Limit Hold\'em', () => {
  assert.ok(hasMaster('holdem', 'NL'));
  assert.ok(!hasMaster('holdem', 'FL'));
  assert.ok(!hasMaster('omaha', 'PL'));
  assert.deepEqual(difficultiesFor('holdem', 'NL'), DIFFICULTIES);
  assert.deepEqual(difficultiesFor('stud7', 'FL'), CLASSIC_DIFFICULTIES);
  assert.ok(!CLASSIC_DIFFICULTIES.includes('master'));
});

/** Plays bot-only hands where seat 0 is `hero` and the rest are Expert, returning seat 0's decisions. */
function play(variant: VariantId, structure: Structure, hero: 'master' | 'expert', hands: number, seed: number) {
  const seats = Array.from({ length: 6 }, (_, i) => ({ name: `B${i}`, isHuman: false, difficulty: i === 0 ? hero : 'expert' as const }));
  const t = new Table({ variant, structure, format: 'cash', startingStack: 2000, bigBlind: 20, handsPerLevel: 10, seats, seed });
  const bots = t.seats.map((s, i) => new Bot(s.difficulty!, 'balanced', seed * 17 + i));
  const log: string[] = [];
  for (let k = 0; k < hands; k++) {
    const h = t.nextHand();
    while (!h.isComplete) {
      const seat = t.seatOf(h.toAct);
      const i = t.seats.indexOf(seat);
      const d = bots[i].think(buildView(h, h.toAct, t.stats));
      if (i === 0) log.push(`${JSON.stringify(d.action)} ${d.reason ?? ''}`);
      h.act(h.normalize(d.action));
    }
    t.finishHand();
  }
  return log;
}

test('Master never uses the net outside No-Limit Hold\'em', () => {
  for (const [v, st] of [['omaha', 'PL'], ['holdem', 'FL'], ['draw5', 'FL']] as [VariantId, Structure][]) {
    const log = play(v, st, 'master', 6, 4);
    assert.ok(log.length > 0);
    assert.ok(!log.some((l) => l.includes('neural net')), `${v} ${st} plays as Expert`);
  }
});

test('Master\'s net overrules Expert some of the time in No-Limit Hold\'em', () => {
  const log = play('holdem', 'NL', 'master', 25, 7);
  const net = log.filter((l) => l.includes('neural net'));
  assert.ok(net.length > 0, 'the net made at least one call');
  assert.ok(net.length < log.length / 2, 'Expert\'s move stands most of the time');
});
