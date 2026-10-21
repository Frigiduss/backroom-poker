import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chachaBlock, createRng, fullDeck, secureSeed, shuffle, subSeed } from '../src/engine/cards';
import { Shoe } from '../src/engine/blackjack';

test('ChaCha20 block matches the RFC 8439 test vector (2.3.2)', () => {
  const key = Array.from({ length: 8 }, (_, i) => {
    const b = [4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 3];
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  });
  const out = new Uint32Array(16);
  chachaBlock(key, 1, [0x09000000, 0x4a000000, 0x00000000], out);
  assert.deepEqual(Array.from(out.slice(0, 4)), [0xe4e7f110, 0x15593bd1, 0x1fdd0f50, 0xc47120a3]);
  assert.deepEqual(Array.from(out.slice(12)), [0xd19c12b5, 0xb94e16de, 0xe883d0cb, 0x4e3c50a2]);
});

test('secure seeds are fresh 256-bit keys', () => {
  const a = secureSeed();
  assert.match(a, /^[0-9a-f]{64}\.0\.0$/);
  assert.notEqual(a, secureSeed());
});

test('a ChaCha20 rng saves and restores its place mid-block', () => {
  const rng = createRng(secureSeed());
  for (let i = 0; i < 37; i++) rng.next();
  const saved = rng.state;
  const ahead = Array.from({ length: 50 }, () => rng.next());
  const again = createRng(saved);
  assert.deepEqual(Array.from({ length: 50 }, () => again.next()), ahead);
  rng.state = saved;
  assert.equal(rng.next(), ahead[0]);
  for (const x of ahead) assert.ok(x >= 0 && x < 1);
});

test('sub-seeds give independent streams, and number seeds keep the old behaviour', () => {
  const seed = secureSeed();
  const a = shuffle(fullDeck(), createRng(seed));
  const b = shuffle(fullDeck(), createRng(subSeed(seed, 7)));
  assert.notDeepEqual(a, b);
  assert.deepEqual(shuffle(fullDeck(), createRng(subSeed(seed, 7))), b);
  assert.equal(subSeed(12345, 0x5bd1e995), (12345 ^ 0x5bd1e995) >>> 0);
  assert.equal(createRng(42).next(), createRng(42).next());
});

test('a blackjack shoe on a secure seed reshuffles the same way after a save', () => {
  const shoe = new Shoe(6, createRng(secureSeed()));
  const copy = Shoe.load(shoe.save());
  shoe.shuffle();
  copy.shuffle();
  assert.deepEqual(copy.save(), shoe.save());
});
