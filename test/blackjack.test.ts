import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, parseCards } from '../src/engine/cards';
import { BjAction, Round, Shoe, basicStrategy, bookPlay, describeTotal, handTotal } from '../src/engine/blackjack';
import { ACHIEVEMENT_BY_ID, blackjackTally, unlockedIn } from '../src/accounts/achievements';

/**
 * A round with the cards dealt in order: one card to each seat, then the dealer's upcard,
 * then the second round, then whatever is drawn after that.
 */
function rigged(cards: string, bets: number[] = [100], stack = 1000) {
  const shoe = new Shoe(6, createRng(1));
  shoe.rig(parseCards(cards));
  return new Round(shoe, bets.map((bet, i) => ({ id: `s${i}`, name: `P${i}`, stack, bet })));
}

const c = parseCards;

test('totals count aces as 11 until that would bust', () => {
  assert.deepEqual(handTotal(c('As 6d')), { total: 17, soft: true });
  assert.deepEqual(handTotal(c('As 6d Kc')), { total: 17, soft: false });
  assert.deepEqual(handTotal(c('As Ad')), { total: 12, soft: true });
  assert.deepEqual(handTotal(c('As Ad 9c')), { total: 21, soft: true });
  assert.equal(describeTotal(c('Ah Kd')), 'Blackjack');
  assert.equal(describeTotal(c('Ah 5d')), 'Soft 16');
  assert.equal(describeTotal(c('Th 5d 9c')), 'Bust 24');
});

test('blackjack pays 3 to 2', () => {
  // Player A K, dealer 9 7.
  const r = rigged('Ah 9c Kd 7s');
  assert.equal(r.phase, 'dealer');
  r.finish();
  assert.equal(r.seats[0].hands[0].outcome, 'blackjack');
  assert.equal(r.net(0), 150);
  assert.equal(r.seats[0].stack, 1150);
});

test('dealer stands on soft 17 and the higher total wins', () => {
  // Player T 8 = 18, dealer A 6 = soft 17. Insurance is offered under the ace.
  const r = rigged('Th Ac 8d 6s');
  assert.equal(r.phase, 'insurance');
  r.insure(0, false);
  assert.equal(r.phase, 'play');
  r.act('stand');
  r.finish();
  assert.equal(r.dealer.length, 2, 'no card drawn on soft 17');
  assert.equal(r.seats[0].hands[0].outcome, 'win');
  assert.equal(r.net(0), 100);
});

test('dealer draws to 17 and can bust', () => {
  // Player T 7, dealer 6 T, then dealer draws 9.
  const r = rigged('Th 6c 7d Ts 9h');
  r.act('stand');
  r.finish();
  assert.deepEqual(r.dealer, c('6c Ts 9h'));
  assert.equal(r.seats[0].hands[0].outcome, 'win');
});

test('a bust loses even when the dealer busts too', () => {
  const r = rigged('Th 6c 6d Ts 9h 9d');
  r.act('hit');
  assert.equal(r.seats[0].hands[0].outcome, null);
  assert.equal(r.phase, 'dealer');
  r.finish();
  assert.equal(r.seats[0].hands[0].outcome, 'bust');
  assert.equal(r.dealer.length, 2, 'the dealer has nothing to play against');
  assert.equal(r.net(0), -100);
});

test('a push returns the bet', () => {
  const r = rigged('Th 9c 9d Ts');
  r.act('stand');
  r.finish();
  assert.equal(r.seats[0].hands[0].outcome, 'push');
  assert.equal(r.net(0), 0);
  assert.equal(r.seats[0].stack, 1000);
});

test('doubling takes one card for twice the bet', () => {
  // Player 6 5, dealer 6 T; double draws T for 21; dealer draws 8 and busts.
  const r = rigged('6h 6c 5d Ts Th 8c');
  assert.ok(r.legal().double);
  r.act('double');
  const h = r.seats[0].hands[0];
  assert.equal(h.bet, 200);
  assert.equal(handTotal(h.cards).total, 21);
  r.finish();
  assert.equal(r.net(0), 200);
  const t = blackjackTally(r, 0, 1);
  assert.equal(t.sum['bj.doubleWins'], 1);
  assert.equal(t.sum['bj.hands'], 1);
  assert.equal(t.max['bj.bigWin'], 200);
});

test("can't double or split without the chips", () => {
  const r = rigged('8h 6c 8d Ts', [600], 1000);
  assert.deepEqual(r.legal(), { hit: true, stand: true, double: false, split: false });
  assert.throws(() => r.act('double'));
});

test('splitting a pair plays two hands, each dealt its second card in turn', () => {
  // Player 8 8 vs dealer 6 T. First hand gets 3 (11) and doubles onto 9 (20); second gets T (18).
  const r = rigged('8h 6c 8d Ts 3c 9d Tc 7h');
  assert.ok(r.legal().split);
  r.act('split');
  const s = r.seats[0];
  assert.equal(s.hands.length, 2);
  assert.deepEqual(s.hands[0].cards, c('8h 3c'));
  assert.deepEqual(s.hands[1].cards, c('8d'), 'the second hand waits for its card');
  assert.equal(s.stack, 800);
  r.act('double');
  assert.equal(r.handTurn, 1);
  assert.deepEqual(s.hands[1].cards, c('8d Tc'));
  r.act('stand');
  r.finish();
  // Dealer 6 T draws 7 = 23, bust.
  assert.equal(s.hands[0].outcome, 'win');
  assert.equal(s.hands[1].outcome, 'win');
  assert.equal(r.net(0), 300);
  const t = blackjackTally(r, 0);
  assert.equal(t.sum['bj.splitSweeps'], 1);
  assert.equal(t.sum['bj.doubleWins'], 1);
});

test('split aces get one card each, and 21 there is not a blackjack', () => {
  const r = rigged('Ah 9c Ad 8s Kc 5d');
  r.act('split');
  const s = r.seats[0];
  assert.ok(s.hands.every((h) => h.done && h.splitAces && h.cards.length === 2));
  assert.equal(r.phase, 'dealer');
  r.finish();
  assert.equal(s.hands[0].outcome, 'win', 'A K after a split pays even money');
  assert.equal(s.hands[1].outcome, 'lose', 'A 5 = 16 loses to 17');
  assert.equal(r.net(0), 0);
});

test('a hand can be split up to four ways', () => {
  const r = rigged('8h 6c 8d Ts 8c 8s 8h 2c 2d 2h 2s', [100], 10_000);
  r.act('split');
  r.act('split');
  r.act('split');
  assert.equal(r.seats[0].hands.length, 4);
  assert.equal(r.legal().split, false);
});

test('insurance pays 2 to 1 when the dealer has blackjack', () => {
  const r = rigged('Th Ac 9d Ks');
  r.insure(0, true);
  assert.equal(r.isComplete, true);
  assert.equal(r.seats[0].hands[0].outcome, 'lose');
  assert.equal(r.net(0), 0, 'the 50 insurance wins 100, covering the lost bet');
  assert.equal(blackjackTally(r, 0).sum['bj.insured'], 1);
});

test('even money on a blackjack against an ace', () => {
  const r = rigged('Ah Ac Kd Ks');
  r.insure(0, true);
  assert.equal(r.seats[0].hands[0].outcome, 'push');
  assert.equal(r.net(0), 100);
  const r2 = rigged('Ah Ac Kd 5s');
  r2.insure(0, true);
  r2.finish();
  assert.equal(r2.net(0), 100);
});

test('the dealer peeks under a ten and ends the round on blackjack', () => {
  const r = rigged('9h Kc 9d As');
  assert.equal(r.isComplete, true);
  assert.equal(r.net(0), -100);
});

test('seats act in order and every hand must finish before the dealer plays', () => {
  const r = rigged('Th 9h 6c 7d 8d Ts', [50, 50]);
  assert.equal(r.seatTurn, 0);
  r.act('stand');
  assert.equal(r.seatTurn, 1);
  r.act('stand');
  assert.equal(r.phase, 'dealer');
});

test('basic strategy makes the textbook plays', () => {
  const both = { double: true, split: true };
  const play = (cards: string, up: string, can = both): BjAction => basicStrategy(c(cards), c(up)[0], can);
  assert.equal(play('8h 8d', 'Ts'), 'split');
  assert.equal(play('Ah Ad', 'As'), 'split');
  assert.equal(play('Th Td', '6s'), 'stand');
  assert.equal(play('5h 6d', '9s'), 'double');
  assert.equal(play('5h 6d', 'As'), 'hit');
  assert.equal(play('Th 6d', '7s'), 'hit');
  assert.equal(play('Th 6d', '6s'), 'stand');
  assert.equal(play('Th 2d', '3s'), 'hit');
  assert.equal(play('Ah 7d', '9s'), 'hit');
  assert.equal(play('Ah 7d', '8s'), 'stand');
  assert.equal(play('Ah 7d', '5s'), 'double');
  assert.equal(play('Ah 7d', '5s', { double: false, split: false }), 'stand');
  assert.equal(play('9h 9d', '7s'), 'stand');
  assert.equal(play('5h 5d', '9s'), 'double');
});

test('the blackjack achievements exist and unlock from their counters', () => {
  for (const id of ['bj-hands-25', 'bj-natural-1', 'bj-double-1', 'bj-split-1', 'bj-charlie', 'bj-insured', 'bj-run-5', 'bj-win-1000']) {
    assert.ok(ACHIEVEMENT_BY_ID.get(id), id);
  }
  const ids = unlockedIn({ 'bj.naturals': 1, 'bj.bestRun': 6 }).map((a) => a.id);
  assert.deepEqual(ids.sort(), ['bj-natural-1', 'bj-run-5']);
});

test('a shoe deals six decks and shuffles at the cut card', () => {
  const shoe = new Shoe(6, createRng(9));
  assert.equal(shoe.remaining, 312);
  for (let i = 0; i < 233; i++) shoe.draw();
  assert.equal(shoe.needsShuffle, false);
  shoe.draw();
  assert.equal(shoe.needsShuffle, true);
});

test('basic strategy over many rounds loses about half a percent, and chips add up', () => {
  const shoe = new Shoe(6, createRng(2024));
  const rounds = Number(process.env.BJ_ROUNDS ?? 40_000);
  let wagered = 0;
  let net = 0;
  for (let i = 0; i < rounds; i++) {
    if (shoe.needsShuffle) shoe.shuffle();
    const r = new Round(shoe, [{ id: 'a', name: 'A', stack: 10_000, bet: 100 }, { id: 'b', name: 'B', stack: 10_000, bet: 100 }]);
    while (r.insuranceTurn() >= 0) r.insure(r.insuranceTurn(), false);
    let guard = 0;
    while (r.phase === 'play') {
      r.act(bookPlay(r)!);
      if (++guard > 50) throw new Error('round did not finish');
    }
    r.finish();
    for (let s = 0; s < 2; s++) {
      const seat = r.seats[s];
      assert.equal(seat.stack, 10_000 + r.net(s), 'stack moves by exactly the net');
      wagered += 100;
      net += r.net(s);
    }
  }
  const edge = net / wagered;
  if (process.env.BJ_ROUNDS) console.log(`player return ${(edge * 100).toFixed(2)}%`);
  assert.ok(edge > -0.03 && edge < 0.015, `player return ${(edge * 100).toFixed(2)}%`);
});
