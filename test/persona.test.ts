import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSONAS, TalkEvent, lineFor, personaFor, remarkAfter } from '../src/bots/persona';
import { createRng } from '../src/engine/cards';

const EVENTS: TalkEvent[] = ['hello', 'win', 'bigwin', 'lose', 'allin', 'steal', 'bust'];

test('every regular has a unique short name, a face and something to say for every moment', () => {
  const names = new Set(PERSONAS.map((p) => p.name.toLowerCase()));
  assert.equal(names.size, PERSONAS.length);
  // Enough regulars to fill the biggest table (9 seats) and the blackjack spots.
  assert.ok(PERSONAS.length >= 9);
  const rng = createRng(3);
  for (const p of PERSONAS) {
    assert.ok(p.name.length <= 8, p.name);
    assert.ok(p.face.length > 0 && p.bio.length > 0, p.name);
    for (const e of EVENTS) assert.ok(lineFor(p, e, rng).length > 0, `${p.name} ${e}`);
  }
});

test('personas are found by name, ignoring case', () => {
  assert.equal(personaFor('big lou')?.face, '😎');
  assert.equal(personaFor('Somebody'), undefined);
});

test('remarks after a hand', () => {
  const base = { bots: ['p1', 'p2', null], showdown: true, pot: 400, busted: [] as number[], bigBlind: 10 };
  // A bot that won a big showdown speaks up; the roll decides whether they bother.
  assert.deepEqual(remarkAfter({ ...base, net: [200, -200, 0] }, 0), { seat: 'p1', event: 'bigwin' });
  assert.equal(remarkAfter({ ...base, net: [200, -200, 0] }, 0.99), null);
  // Busting out beats everything else.
  assert.deepEqual(remarkAfter({ ...base, net: [200, -200, 0], busted: [1] }, 0), { seat: 'p2', event: 'bust' });
  // People never get lines put in their mouths.
  assert.equal(remarkAfter({ ...base, net: [0, 0, 400] }, 0), null);
  // A small pot won without a showdown is a steal.
  assert.deepEqual(remarkAfter({ ...base, showdown: false, pot: 60, net: [-15, 45, -30] }, 0), { seat: 'p2', event: 'steal' });
});
