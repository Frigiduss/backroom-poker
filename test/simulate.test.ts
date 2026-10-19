import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bots/bot';
import { buildView } from '../src/bots/view';
import { Difficulty, DIFFICULTIES, Format, Table } from '../src/engine/table';
import { Structure, VARIANTS, VARIANT_ORDER } from '../src/engine/variants';

/** Plays bot-only hands and checks chips are conserved and every hand finishes. */
function run(variant: (typeof VARIANT_ORDER)[number], structure: Structure, format: Format, players: number, hands: number, seed: number, diff?: Difficulty) {
  const seats = Array.from({ length: players }, (_, i) => ({ name: `Bot${i}`, isHuman: false, difficulty: diff ?? DIFFICULTIES[i % DIFFICULTIES.length] }));
  const t = new Table({ variant, structure, format, startingStack: 1000, bigBlind: 20, handsPerLevel: 6, seats, seed });
  const bots = t.seats.map((s, i) => new Bot(s.difficulty!, 'balanced', seed * 31 + i));
  let played = 0;
  const startTotal = 1000 * players;
  while (played < hands && !t.isOver) {
    const h = t.nextHand();
    let guard = 0;
    while (!h.isComplete) {
      const seat = t.seatOf(h.toAct);
      const bot = bots[t.seats.indexOf(seat)];
      const view = buildView(h, h.toAct, t.stats);
      h.act(h.normalize(bot.decide(view)));
      if (++guard > 500) throw new Error('hand did not finish');
    }
    const handTotal = h.players.reduce((s, p) => s + p.stack, 0);
    const startHand = h.players.reduce((s, p) => s + p.startStack, 0);
    assert.equal(handTotal, startHand, `chips conserved in hand ${t.handNumber}`);
    t.finishHand();
    const rebuys = t.seats.reduce((s, x) => s + x.rebuys, 0);
    assert.equal(t.seats.reduce((s, x) => s + x.stack, 0), startTotal + rebuys * 1000);
    played++;
  }
  return { t, played };
}

const quick = process.env.SIM_HANDS ? Number(process.env.SIM_HANDS) : 60;

for (const id of VARIANT_ORDER) {
  for (const st of VARIANTS[id].structures) {
    test(`${id} ${st}: bots play ${quick} cash hands`, () => {
      run(id, st, 'cash', Math.min(6, VARIANTS[id].maxPlayers), quick, 11);
    });
  }
  test(`${id}: sit and go runs to a winner`, () => {
    const { t } = run(id, VARIANTS[id].defaultStructure, 'sng', Math.min(5, VARIANTS[id].maxPlayers), 2000, 5, 'medium');
    assert.ok(t.isOver, 'tournament finished');
    const places = t.seats.map((s) => s.place).sort();
    assert.deepEqual(places, [1, 2, 3, 4, 5].slice(0, t.seats.length));
  });
}

test('full ring: nine-handed hold\'em and eight-handed stud', () => {
  run('holdem', 'NL', 'cash', 9, 40, 3);
  run('stud7', 'FL', 'cash', 8, 40, 4);
  run('razz', 'FL', 'cash', 8, 40, 9);
});
