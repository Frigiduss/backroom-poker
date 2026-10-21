import { test } from 'node:test';
import assert from 'node:assert/strict';
import workerSource from 'virtual:bot-worker';
import { Bot } from '../src/bots/bot';
import { BrainReply, BrainRequest, createBrain } from '../src/bots/brain';
import { specFromView } from '../src/bots/equity';
import { buildView } from '../src/bots/view';
import { Table } from '../src/engine/table';
import { equity, think } from '../src/ui/thinker';

function table() {
  const seats = Array.from({ length: 4 }, (_, i) => ({ name: `Bot${i}`, isHuman: false, difficulty: 'hard' as const }));
  return new Table({ variant: 'holdem', structure: 'NL', format: 'cash', startingStack: 1000, bigBlind: 20, handsPerLevel: 6, seats, seed: 3 });
}

// Views cross into the worker by structured clone, so they must survive a JSON-style copy.
const cloned = <T>(x: T): T => structuredClone(x);

test('the brain plays whole hands from cloned views', () => {
  const answer = createBrain();
  const t = table();
  let id = 0;
  for (let n = 0; n < 6; n++) {
    const h = t.nextHand();
    while (!h.isComplete) {
      const view = cloned(buildView(h, h.toAct, t.stats));
      const r = answer({ id: ++id, kind: 'think', bot: h.toAct, difficulty: 'hard', style: 'balanced', view });
      assert.equal(r.id, id);
      assert.ok('decision' in r, JSON.stringify(r));
      h.act(h.normalize(r.decision.action));
    }
    t.finishHand();
  }
});

test('the brain works out pot share for the odds meter', () => {
  const t = table();
  const h = t.nextHand();
  const r = createBrain()({ id: 1, kind: 'equity', spec: cloned(specFromView(buildView(h, 0))), iterations: 300 });
  assert.ok('equity' in r && r.equity > 0 && r.equity < 1);
});

test('a bad request comes back as an error, not a crash', () => {
  const r = createBrain()({ id: 9, kind: 'think', bot: 1, difficulty: 'hard', style: 'balanced', view: {} as never });
  assert.ok('error' in r && r.id === 9);
});

test('the bundled worker answers messages', () => {
  const replies: BrainReply[] = [];
  const self = { onmessage: null as ((e: { data: BrainRequest }) => void) | null, postMessage: (m: BrainReply) => replies.push(m) };
  new Function('self', workerSource)(self);
  assert.ok(self.onmessage, 'worker sets onmessage');
  const t = table();
  const h = t.nextHand();
  self.onmessage({ data: cloned({ id: 5, kind: 'think', bot: 1, difficulty: 'expert', style: 'tight', view: buildView(h, h.toAct, t.stats) }) });
  assert.equal(replies.length, 1);
  assert.ok(replies[0].id === 5 && 'decision' in replies[0]);
});

test('without workers, bots think on the page as before', async () => {
  assert.equal(typeof Worker, 'undefined');
  const t = table();
  const h = t.nextHand();
  const view = buildView(h, h.toAct, t.stats);
  const d = await think(new Bot('medium'), view);
  assert.ok(['fold', 'check', 'call', 'raise'].includes(d.action.type));
  const x = await equity(specFromView(view), 200);
  assert.ok(x > 0 && x < 1);
});
