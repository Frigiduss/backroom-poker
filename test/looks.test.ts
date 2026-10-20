import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACHIEVEMENT_BY_ID } from '../src/accounts/achievements';
import { CARD_BACKS, DEFAULT_LOOK, FELTS, LOOKS, lookFor, lookUnlocked, looksUnlockedBy } from '../src/accounts/looks';

test('every look has a unique id, a real achievement, and one free option per kind', () => {
  for (const list of [FELTS, CARD_BACKS]) {
    assert.equal(new Set(list.map((l) => l.id)).size, list.length);
    assert.ok(!list[0].unlock, 'the first one is the free default');
  }
  for (const l of LOOKS) if (l.unlock) assert.ok(ACHIEVEMENT_BY_ID.has(l.unlock), `${l.id} unlocks with ${l.unlock}`);
  assert.deepEqual(DEFAULT_LOOK, { felt: 'emerald', back: 'classic' });
});

test('a look is held exactly when its achievement is', () => {
  const midnight = FELTS.find((l) => l.id === 'midnight')!;
  assert.equal(lookUnlocked(midnight, { hands: 99 }), false);
  assert.equal(lookUnlocked(midnight, { hands: 100 }), true);
  assert.deepEqual(looksUnlockedBy('hands-100').map((l) => l.id), ['midnight']);
});

test('the chosen look falls back to the free one when unknown or locked', () => {
  const settings = { look: { felt: 'midnight', back: 'diamond' } };
  assert.deepEqual(lookFor(settings, { hands: 100 }), { felt: 'midnight', back: 'classic' });
  assert.deepEqual(lookFor(settings, { hands: 100, peakBank: 1_000_000 }), { felt: 'midnight', back: 'diamond' });
  assert.deepEqual(lookFor({ look: { felt: 'nope', back: 7 } }, { hands: 1e6 }), DEFAULT_LOOK);
  assert.deepEqual(lookFor({}, {}), DEFAULT_LOOK);
  assert.deepEqual(lookFor({ look: 'bad' }, {}), DEFAULT_LOOK);
});
