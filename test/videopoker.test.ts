import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, parseCards } from '../src/engine/cards';
import { dealVp, drawVp, linePays, payLine, settleVp, VpHand } from '../src/engine/videopoker';
import { ACHIEVEMENT_BY_ID, unlockedIn, videoPokerTally } from '../src/accounts/achievements';

const line = (s: string, m: 'jacks' | 'bonus' | 'ddb' = 'jacks') => payLine(parseCards(s), m);

test('hands land on the right pay line', () => {
  assert.equal(line('As Ks Qs Js Ts'), 'royal');
  assert.equal(line('9h Kh Qh Jh Th'), 'straightFlush');
  assert.equal(line('Ah 2h 3h 4h 5h'), 'straightFlush');
  assert.equal(line('7c 7d 7h 7s 2c'), 'quads');
  assert.equal(line('7c 7d 7h Kh Kc'), 'fullHouse');
  assert.equal(line('2c 9c Jc Kc 4c'), 'flush');
  assert.equal(line('Ac 2d 3h 4s 5c'), 'straight');
  assert.equal(line('Tc Jd Qh Ks Ac'), 'straight');
  assert.equal(line('8c 8d 8h Ks 2c'), 'trips');
  assert.equal(line('8c 8d 3h 3s Ac'), 'twoPair');
  assert.equal(line('Jc Jd 3h 5s 9c'), 'jacks');
  assert.equal(line('Ac Ad 3h 5s 9c'), 'jacks');
  assert.equal(line('Tc Td 3h 5s 9c'), null, 'tens are too low');
  assert.equal(line('Ac Kd 3h 5s 9c'), null);
});

test('bonus machines pay four aces and low quads extra, and Double Double Bonus checks the kicker', () => {
  assert.equal(line('Ac Ad Ah As 9c', 'bonus'), 'aces');
  assert.equal(line('3c 3d 3h 3s 9c', 'bonus'), 'low');
  assert.equal(line('9c 9d 9h 9s 3c', 'bonus'), 'quads');
  assert.equal(line('Ac Ad Ah As 3c', 'ddb'), 'acesKicker');
  assert.equal(line('Ac Ad Ah As 9c', 'ddb'), 'aces');
  assert.equal(line('2c 2d 2h 2s Ac', 'ddb'), 'lowKicker');
  assert.equal(line('4c 4d 4h 4s 3c', 'ddb'), 'lowKicker');
  assert.equal(line('4c 4d 4h 4s Kc', 'ddb'), 'low');
  assert.equal(line('Kc Kd Kh Ks Ac', 'ddb'), 'quads');
  assert.equal(line('Ac Ad Ah As 3c', 'jacks'), 'quads');
});

test('pays per coin, with the royal jumping to 800 a coin on five', () => {
  assert.equal(linePays('jacks', 'fullHouse', 1), 9);
  assert.equal(linePays('jacks', 'flush', 5), 6);
  assert.equal(linePays('bonus', 'fullHouse', 5), 8);
  assert.equal(linePays('ddb', 'twoPair', 3), 1);
  assert.equal(linePays('ddb', 'acesKicker', 5), 400);
  assert.equal(linePays('jacks', 'royal', 4), 250);
  assert.equal(linePays('jacks', 'royal', 5), 800);
});

test('the draw replaces only the cards not held, from the same deck', () => {
  const hand = dealVp('jacks', 5, 25, createRng(3));
  hand.held = [true, false, true, false, false];
  const after = drawVp(hand);
  assert.equal(after.cards[0], hand.cards[0]);
  assert.equal(after.cards[2], hand.cards[2]);
  assert.deepEqual([after.cards[1], after.cards[3], after.cards[4]], hand.deck.slice(5, 8));
  assert.equal(new Set([...hand.dealt, ...after.cards]).size, 8, 'no card comes out twice');
  assert.equal(drawVp(after), after, 'only one draw');
});

const handOf = (cards: string, held: boolean[], coins = 5, denom = 5, machine: VpHand['machine'] = 'jacks'): VpHand => {
  const cs = parseCards(cards);
  return { machine, coins, denom, deck: cs, next: 5, cards: cs, dealt: cs, held, drawn: true };
};

test('a final hand settles into chips', () => {
  const royal = settleVp(handOf('As Ks Qs Js Ts', [true, true, true, true, true], 5, 25));
  assert.equal(royal.line, 'royal');
  assert.equal(royal.staked, 125);
  assert.equal(royal.paid, 800 * 5 * 25);
  const pair = settleVp(handOf('Jc Jd 3h 5s 9c', [true, true, false, false, false], 3, 5));
  assert.equal(pair.paid, 15);
  assert.equal(pair.net, 0, 'jacks or better gives the bet back');
  assert.equal(pair.replaced, 3);
  const nothing = settleVp(handOf('2c 7d 9h Js Kc', [false, false, false, false, false], 1, 100));
  assert.equal(nothing.paid, 0);
  assert.equal(nothing.net, -100);
});

test('video poker achievements count quads, aces, royals and clean slates', () => {
  const aces = handOf('Ac Ad Ah As 3c', [false, false, false, false, false], 5, 25, 'ddb');
  const t = videoPokerTally(aces, settleVp(aces));
  assert.equal(t.sum['vp.hands'], 1);
  assert.equal(t.sum['vp.quads'], 1);
  assert.equal(t.sum['vp.aces'], 1);
  assert.equal(t.sum['vp.cleanSlates'], 1);
  assert.equal(t.max['vp.bigWin'], 400 * 5 * 25 - 125);
  const royal = handOf('As Ks Qs Js Ts', [true, true, true, false, false]);
  const tr = videoPokerTally(royal, settleVp(royal));
  assert.equal(tr.sum['vp.royals'], 1);
  assert.equal(tr.sum['vp.cleanSlates'], undefined);
  assert.ok(unlockedIn({ 'vp.royals': 1 }).map((a) => a.id).includes('vp-royal'));
  assert.equal(ACHIEVEMENT_BY_ID.get('vp-royal')?.title, 'Jackpot');
});

test('max coin Jacks or Better returns about what it should over many random hands held by a simple rule', () => {
  // Hold any paying hand or any pair, otherwise draw five. Far from perfect play, so the
  // return sits well under the 99.5% that perfect strategy gets, but a broken pay table or
  // draw would push it far outside this range.
  const rng = createRng(11);
  let staked = 0;
  let paid = 0;
  for (let i = 0; i < 40_000; i++) {
    const h = dealVp('jacks', 5, 1, rng);
    const ranks = h.cards.map((c) => c >> 2);
    const made = payLine(h.cards, 'jacks');
    h.held = h.cards.map((_, k) => made !== null && made !== 'jacks' && made !== 'twoPair' && made !== 'trips' ? true : ranks.filter((r) => r === ranks[k]).length > 1);
    const r = settleVp(drawVp(h));
    staked += r.staked;
    paid += r.paid;
  }
  const rtp = paid / staked;
  assert.ok(rtp > 0.7 && rtp < 0.97, `return ${rtp}`);
});
