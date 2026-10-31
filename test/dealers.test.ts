import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEALERS, DealerMoment, WHISPER_CHANCE, WHISPER_DOWN_MINS, bjMoment, dealerByName, dealerLine, dealerSpeaks, pickDealer, rlMoment, shouldWhisper, whisperLine } from '../src/bots/dealers';
import { createRng } from '../src/engine/cards';

const BJ: DealerMoment[] = ['hello', 'shuffle', 'playerBj', 'dealerBj', 'dealerBust', 'bigWin', 'win', 'lose', 'push'];
const RL: DealerMoment[] = ['hello', 'noMore', 'zero', 'straight', 'repeat', 'bigWin', 'win', 'lose'];

test('every dealer has a unique name, a face, a story and a line for every moment of their game', () => {
  assert.equal(new Set(DEALERS.map((d) => d.name.toLowerCase())).size, DEALERS.length);
  const rng = createRng(5);
  for (const d of DEALERS) {
    assert.ok(d.face && d.bio && d.name.length <= 10, d.name);
    for (const m of d.game === 'blackjack' ? BJ : RL) {
      for (let i = 0; i < 20; i++) {
        const line = dealerLine(d, m, rng, '17');
        assert.ok(line.length > 0, `${d.name} ${m}`);
        assert.ok(!line.includes('{n}'), line);
      }
    }
  }
  assert.ok(DEALERS.filter((d) => d.game === 'blackjack').length >= 3);
  assert.ok(DEALERS.filter((d) => d.game === 'roulette').length >= 3);
});

test('a table gets a dealer for its own game', () => {
  const rng = createRng(1);
  for (let i = 0; i < 30; i++) {
    assert.equal(pickDealer('blackjack', rng).game, 'blackjack');
    assert.equal(pickDealer('roulette', rng).game, 'roulette');
  }
  assert.equal(dealerByName('étienne')?.game, 'roulette');
});

test('the croupier names the number', () => {
  const sal = dealerByName('Sal')!;
  const rng = createRng(2);
  const lines = new Set(Array.from({ length: 40 }, () => dealerLine(sal, 'straight', rng, '23')));
  assert.ok([...lines].some((l) => l.includes('23')));
});

test('blackjack: the most notable thing about a round', () => {
  const base = { outcomes: ['win'], net: 10, min: 10, dealerNatural: false, dealerBusted: false };
  assert.equal(bjMoment({ ...base, outcomes: ['blackjack'], net: 15 }), 'playerBj');
  assert.equal(bjMoment({ ...base, outcomes: ['lose'], net: -10, dealerNatural: true }), 'dealerBj');
  assert.equal(bjMoment({ ...base, outcomes: ['win', 'win'], net: 200 }), 'bigWin');
  assert.equal(bjMoment({ ...base, dealerBusted: true }), 'dealerBust');
  assert.equal(bjMoment(base), 'win');
  assert.equal(bjMoment({ ...base, outcomes: ['bust'], net: -10, dealerBusted: true }), 'lose');
  assert.equal(bjMoment({ ...base, outcomes: ['push'], net: 0 }), 'push');
});

test('roulette: the most notable thing about a spin', () => {
  const base = { pocket: 7, zero: false, straightHit: false, net: 5, staked: 5, min: 5 };
  assert.equal(rlMoment({ ...base, straightHit: true, net: 175 }), 'straight');
  assert.equal(rlMoment({ ...base, net: 100, staked: 20 }), 'bigWin');
  assert.equal(rlMoment({ ...base, pocket: 0, zero: true, net: -5 }), 'zero');
  assert.equal(rlMoment({ ...base, previous: 7, net: -5 }), 'repeat');
  assert.equal(rlMoment(base), 'win');
  assert.equal(rlMoment({ ...base, net: -5 }), 'lose');
});

test('small talk waits a few rounds; big moments do not', () => {
  assert.equal(dealerSpeaks('win', 1, 0), false);
  assert.equal(dealerSpeaks('win', 5, 0), true);
  assert.equal(dealerSpeaks('win', 5, 0.5), false);
  assert.equal(dealerSpeaks('playerBj', 0, 0.5), true);
  assert.equal(dealerSpeaks('hello', 99, 0.99), true);
});

test('the dealer whispers advice only when the player is well down, rarely, and once', () => {
  const min = 10;
  const down = min * WHISPER_DOWN_MINS;
  assert.equal(shouldWhisper(down - 1, min, false, 0), false);
  assert.equal(shouldWhisper(down, min, false, 0), true);
  assert.equal(shouldWhisper(down, min, true, 0), false);
  assert.equal(shouldWhisper(down, min, false, WHISPER_CHANCE), false);
  assert.equal(WHISPER_CHANCE, 0.001);
  const rng = createRng(4);
  for (const g of ['blackjack', 'roulette'] as const) assert.ok(whisperLine(g, rng).length > 0);
});
