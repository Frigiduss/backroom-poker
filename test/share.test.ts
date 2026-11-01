import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bots/bot';
import { buildView } from '../src/bots/view';
import { HandHistory, recordHistory, replayFrames, sourceOfHand } from '../src/engine/history';
import { cleanSharedHand, decodeSharedHand, encodeSharedHand, shareableHand, sharedCodeIn } from '../src/engine/share';
import { Table } from '../src/engine/table';
import { VARIANTS, VARIANT_ORDER } from '../src/engine/variants';

/** A finished bot hand of each game, saved from seat 0. */
function playedHand(id: (typeof VARIANT_ORDER)[number], seed = 5): HandHistory {
  const players = Math.min(6, VARIANTS[id].maxPlayers);
  const seats = Array.from({ length: players }, (_, i) => ({ name: `Bot ${i}`, isHuman: false, difficulty: 'medium' as const }));
  const t = new Table({ variant: id, structure: VARIANTS[id].defaultStructure, format: 'cash', startingStack: 800, bigBlind: 20, handsPerLevel: 6, seats, seed });
  const bots = t.seats.map((_, i) => new Bot('medium', i % 2 ? 'aggressive' : 'loose', 10 + i));
  // Skip ahead a few hands so some go to showdown with real action.
  let rec: HandHistory | null = null;
  for (let n = 0; n < 6; n++) {
    const h = t.nextHand();
    while (!h.isComplete) h.act(h.normalize(bots[t.seats.indexOf(t.seatOf(h.toAct))].decide(buildView(h, h.toAct, t.stats))));
    rec = recordHistory(sourceOfHand(h, 0), 0, { where: 'Online · K7QD', number: t.handNumber, at: 1_700_000_000_000 + n });
  }
  return rec!;
}

for (const id of VARIANT_ORDER) {
  test(`${id}: a shared link replays the same hand`, async () => {
    const h = playedHand(id);
    const code = await encodeSharedHand(h);
    assert.match(code, /^z[A-Za-z0-9_-]+$/);
    assert.ok(code.length < 4000, `link too long: ${code.length}`);
    const back = await decodeSharedHand(code);
    assert.ok(back);
    assert.deepEqual(back, shareableHand(h));
    assert.deepEqual(replayFrames(back), replayFrames(h));
  });
}

test('a shared hand leaves out the private table code', () => {
  const h = playedHand('holdem');
  const s = shareableHand(h);
  assert.equal(s.where, 'Online');
  assert.equal(s.id, 'shared');
  assert.equal(shareableHand({ ...h, where: 'Cash game' }).where, 'Cash game');
});

test('the plain fallback reads back too', async () => {
  const h = playedHand('omaha');
  const json = Buffer.from(JSON.stringify(shareableHand(h))).toString('base64url');
  assert.deepEqual(await decodeSharedHand(`j${json}`), shareableHand(h));
});

test('the hand is found after #hand= only', () => {
  assert.equal(sharedCodeIn('#hand=zAbc'), 'zAbc');
  assert.equal(sharedCodeIn('hand=jX'), 'jX');
  assert.equal(sharedCodeIn('#access_token=abc'), null);
  assert.equal(sharedCodeIn(''), null);
});

test('damaged or made-up links are turned away', async () => {
  const h = shareableHand(playedHand('holdem'));
  const code = await encodeSharedHand(h);
  assert.equal(await decodeSharedHand(code.slice(0, code.length / 2)), null);
  assert.equal(await decodeSharedHand('z!!!'), null);
  assert.equal(await decodeSharedHand('x' + code.slice(1)), null);
  assert.equal(await decodeSharedHand(''), null);
  assert.equal(await decodeSharedHand('j' + Buffer.from('not json').toString('base64url')), null);

  const bad = (change: (x: any) => void) => {
    const x = JSON.parse(JSON.stringify(h));
    change(x);
    return cleanSharedHand(x);
  };
  assert.ok(bad(() => {}));
  assert.equal(bad((x) => (x.variant = '__proto__')), null);
  assert.equal(bad((x) => (x.variant = 'toString')), null);
  assert.equal(bad((x) => (x.structure = 'XX')), null);
  assert.equal(bad((x) => (x.me = 9)), null);
  assert.equal(bad((x) => (x.button = -1)), null);
  assert.equal(bad((x) => (x.players[0].cards[0] = 52)), null);
  assert.equal(bad((x) => (x.players[0].cards[0] = 1.5)), null);
  assert.equal(bad((x) => (x.players[1].name = { toString: 1 })), null);
  assert.equal(bad((x) => (x.players[1].name = 'x'.repeat(500))), null);
  assert.equal(bad((x) => (x.players[1].start = -5)), null);
  assert.equal(bad((x) => (x.players[1].start = 1e300)), null);
  assert.equal(bad((x) => (x.players[1].handName = 7)), null);
  assert.equal(bad((x) => (x.players = x.players.slice(0, 1))), null);
  assert.equal(bad((x) => (x.board = [null, null, null])), null);
  assert.equal(bad((x) => x.actions.push([0, 1, 'explode', 0, 0, 0])), null);
  assert.equal(bad((x) => x.actions.push([42, 1, 'fold', 0, 0, 0])), null);
  assert.equal(bad((x) => (x.summary = ['<img src=x onerror=alert(1)>'.repeat(50)])), null);
  assert.equal(bad((x) => (x.stakes.bb = 'big')), null);
  assert.equal(bad((x) => (x.v = 2)), null);
});

test('extra fields in a link are dropped', () => {
  const h = shareableHand(playedHand('holdem'));
  const x = JSON.parse(JSON.stringify(h));
  x.evil = 'yes';
  x.players[0].extra = 1;
  const clean = cleanSharedHand(x)!;
  assert.deepEqual(clean, h);
  assert.equal('evil' in clean, false);
});

test('a short or odd but well-formed hand still replays', () => {
  const h = shareableHand(playedHand('holdem'));
  const odd = cleanSharedHand({ ...h, actions: h.actions.slice(0, 3), summary: [] })!;
  assert.ok(odd);
  assert.ok(replayFrames(odd).length > 1);
});
