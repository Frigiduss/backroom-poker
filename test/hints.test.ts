import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bots/bot';
import { buildView } from '../src/bots/view';
import { Table } from '../src/engine/table';
import { VARIANTS, VARIANT_ORDER } from '../src/engine/variants';

// Practice tables show what a Hard bot would do and why, so every real decision needs a reason.
for (const id of VARIANT_ORDER) {
  test(`${id}: the practice coach explains every decision`, () => {
    const players = Math.min(5, VARIANTS[id].maxPlayers);
    const seats = Array.from({ length: players }, (_, i) => ({ name: `Bot${i}`, isHuman: false, difficulty: 'hard' as const }));
    const t = new Table({ variant: id, structure: VARIANTS[id].defaultStructure, format: 'cash', startingStack: 1000, bigBlind: 20, handsPerLevel: 6, seats, seed: 7 });
    const coach = new Bot('hard', 'balanced', 99);
    let decisions = 0;
    for (let n = 0; n < 12; n++) {
      const h = t.nextHand();
      while (!h.isComplete) {
        const view = buildView(h, h.toAct, t.stats);
        const d = coach.think(view);
        if (view.legal.kind !== 'none') {
          decisions++;
          assert.ok(d.reason && d.reason.length > 10, `reason for ${d.action.type} on street ${view.street}`);
          if (view.legal.kind === 'bet' && !view.legal.bringIn && d.equity !== undefined) assert.equal(d.potOdds !== undefined, view.legal.callAmount > 0);
        }
        h.act(h.normalize(d.action));
      }
      t.finishHand();
    }
    assert.ok(decisions > 20);
  });
}
