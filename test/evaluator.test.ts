import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCards as P } from '../src/engine/cards';
import { describeHigh, describeLow, evalHigh, evalLow, evalOmahaHigh, evalOmahaLow } from '../src/engine/evaluator';

const hi = (s: string, short = false) => evalHigh(P(s), short);

test('ranks hand categories in order', () => {
  const ladder = [
    '2c 4d 7h 9s Jc', '2c 2d 7h 9s Jc', '2c 2d 7h 7s Jc', '2c 2d 2h 9s Jc', '5c 6d 7h 8s 9c',
    '2h 6h 8h Th Kh', '2c 2d 2h 9s 9c', '2c 2d 2h 2s Jc', '5h 6h 7h 8h 9h',
  ];
  for (let i = 1; i < ladder.length; i++) assert.ok(hi(ladder[i]) > hi(ladder[i - 1]), ladder[i]);
});

test('picks the best five of seven', () => {
  assert.equal(describeHigh(hi('Ah Kh 2c 3d 4s 5h 9c')), 'Straight, Five high');
  assert.equal(describeHigh(hi('Ah Kh Qh Jh Th 2c 2d')), 'Royal Flush');
  assert.equal(describeHigh(hi('Kc Kd Ks 7h 7d 7c 2s')), 'Full House, Kings full of Sevens');
  assert.equal(describeHigh(hi('9c 9d 4s 4h 2d 2c Ks')), 'Two Pair, Nines and Fours');
  // Third pair cannot play: kicker is the King.
  assert.ok(hi('9c 9d 4s 4h 2d 2c Ks') > hi('9c 9d 4s 4h 2d 2c Qs'));
});

test('kickers break ties', () => {
  assert.ok(hi('Ac Ad Kh 7s 3c') > hi('As Ah Qh 7d 3d'));
  assert.equal(hi('Ac Ad Kh 7s 3c'), hi('As Ah Kd 7c 3h'));
});

test('short deck: flush beats full house, trips beat straight, A-6-7-8-9 straight', () => {
  assert.ok(hi('6h 8h Th Qh Kh', true) > hi('Kc Kd Ks 7h 7d', true));
  assert.ok(hi('7c 7d 7h Ks Qc', true) > hi('6c 7d 8h 9s Tc', true));
  assert.equal(describeHigh(hi('Ac 6d 7h 8s 9c', true), true), 'Straight, Nine high');
});

test('omaha uses exactly two hole cards', () => {
  // Four hearts in hand and one on board is not a flush in Omaha.
  const v = evalOmahaHigh(P('Ah Kh Qh Jh'), P('2h 7c 8d 9s 3c'));
  assert.ok(v < hi('2c 2d 7h 9s Jc') + 0x100000 * 5);
  assert.equal(describeHigh(v), 'Ace high');
  const f = evalOmahaHigh(P('Ah Kh Qc Jd'), P('2h 7h 8h 9s 3c'));
  assert.equal(describeHigh(f), 'Flush, Ace high');
});

test('ace-to-five lows', () => {
  assert.equal(describeLow(evalLow(P('Ac 2d 3h 4s 5c Kd Kh'))!), '5-4-3-2-A low');
  assert.ok(evalLow(P('Ac 2d 3h 4s 6c'))! < evalLow(P('Ac 2d 3h 5s 6c'))!);
  assert.equal(evalLow(P('Ac 2d 3h 4s 9c Kd Kh'), true), null);
  // Razz with pairs: one pair beats two pair.
  const onePair = evalLow(P('Ac Ad 2h 3s Kc'))!;
  assert.ok(evalLow(P('Ac Ad 2h 2d 3h 3s Kc'))! <= onePair);
  assert.equal(evalOmahaLow(P('Ac 2d Kh Ks'), P('3c 4d 8h Qc Jd')) !== null, true);
  assert.equal(evalOmahaLow(P('Ac Kd Kh Ks'), P('3c 4d 8h 2c Jd')), null);
});
