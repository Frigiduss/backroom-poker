import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, parseCards } from '../src/engine/cards';
import { Shoe } from '../src/engine/blackjack';
import { DOUBLE_ZERO, WHEEL_ORDER, layoutProblem, pocketColor, settle, spin, spotFor } from '../src/engine/roulette';
import { bankerDraws, betsProblem, dealCoup, handValue, settleCoup } from '../src/engine/baccarat';
import { ACHIEVEMENT_BY_ID, baccaratTally, rouletteTally, unlockedIn } from '../src/accounts/achievements';

// ---------- roulette ----------

test('both wheels hold every pocket exactly once', () => {
  assert.deepEqual([...WHEEL_ORDER.european].sort((a, b) => a - b), Array.from({ length: 37 }, (_, i) => i));
  assert.deepEqual([...WHEEL_ORDER.american].sort((a, b) => a - b), Array.from({ length: 38 }, (_, i) => i));
  const reds = Array.from({ length: 36 }, (_, i) => i + 1).filter((n) => pocketColor(n) === 'red');
  assert.equal(reds.length, 18);
  assert.equal(pocketColor(0), 'green');
  assert.equal(pocketColor(DOUBLE_ZERO), 'green');
});

test('layout spots cover the right numbers', () => {
  assert.deepEqual(spotFor('split:8-11', 'european')?.numbers, [8, 11]);
  assert.deepEqual(spotFor('split:2-3', 'european')?.numbers, [2, 3]);
  assert.equal(spotFor('split:3-4', 'european'), null, '3 and 4 are not next to each other');
  assert.deepEqual(spotFor('street:13', 'european')?.numbers, [13, 14, 15]);
  assert.equal(spotFor('street:14', 'european'), null);
  assert.deepEqual(spotFor('corner:5', 'european')?.numbers, [5, 6, 8, 9]);
  assert.equal(spotFor('corner:6', 'european'), null);
  assert.equal(spotFor('corner:34', 'european'), null);
  assert.deepEqual(spotFor('line:31', 'european')?.numbers, [31, 32, 33, 34, 35, 36]);
  assert.deepEqual(spotFor('column:2', 'european')?.numbers.slice(0, 3), [2, 5, 8]);
  assert.deepEqual(spotFor('dozen:3', 'european')?.numbers.length, 12);
  assert.equal(spotFor('straight:00', 'european'), null, 'no double zero on a European wheel');
  assert.deepEqual(spotFor('straight:00', 'american')?.numbers, [DOUBLE_ZERO]);
});

test('a spin pays each bet at its odds', () => {
  const r = settle({ 'straight:17': 10, 'split:17-20': 10, 'corner:13': 10, red: 10, 'dozen:2': 10, 'column:3': 10, low: 10 }, 17, 'european');
  const paid = Object.fromEntries(r.spots.map((s) => [s.key, s.paid]));
  assert.equal(paid['straight:17'], 360);
  assert.equal(paid['split:17-20'], 180);
  assert.equal(paid['corner:13'], 90, '13 14 16 17');
  assert.equal(paid.red, 0, '17 is black');
  assert.equal(paid['dozen:2'], 30);
  assert.equal(paid['column:3'], 0);
  assert.equal(paid.low, 20);
  assert.equal(r.staked, 70);
  assert.equal(r.net, r.paid - 70);
});

test('even-money bets lose on zero', () => {
  const r = settle({ red: 10, black: 10, odd: 10, even: 10, low: 10, high: 10, 'straight:0': 5 }, 0, 'european');
  assert.equal(r.paid, 180);
  assert.equal(r.net, 180 - 65);
});

test('a layout is checked against limits and bank', () => {
  const lim = { min: 5, max: 100 };
  assert.equal(layoutProblem({}, 'european', lim, 1000), 'Place a bet first.');
  assert.match(layoutProblem({ red: 2 }, 'european', lim, 1000)!, /at least 5/);
  assert.match(layoutProblem({ red: 60, black: 60 }, 'european', lim, 1000)!, /at most 100/);
  assert.match(layoutProblem({ red: 60 }, 'european', lim, 50)!, /bank/);
  assert.equal(layoutProblem({ red: 60 }, 'european', lim, 100), null);
});

test('the wheel lands everywhere and about evenly', () => {
  const rng = createRng(7);
  const hits = new Map<number, number>();
  for (let i = 0; i < 38_000; i++) {
    const p = spin('american', rng);
    hits.set(p, (hits.get(p) ?? 0) + 1);
  }
  assert.equal(hits.size, 38);
  for (const n of hits.values()) assert.ok(n > 800 && n < 1200, `pocket count ${n}`);
});

test('roulette achievements count hits on single numbers and zero', () => {
  const t = rouletteTally(settle({ 'straight:0': 200 }, 0, 'european'));
  assert.equal(t.sum['rl.spins'], 1);
  assert.equal(t.sum['rl.straightHits'], 1);
  assert.equal(t.sum['rl.zeroHits'], 1);
  assert.equal(t.max['rl.bigWin'], 7000);
  const got = unlockedIn({ ...t.sum, ...t.max }).map((a) => a.id);
  for (const id of ['rl-straight-1', 'rl-zero', 'rl-win-5000']) assert.ok(got.includes(id), id);
  assert.ok(ACHIEVEMENT_BY_ID.get('rl-win-5000')?.title);
});

// ---------- baccarat ----------

/** Deals a coup with the cards in shoe order: P B P B, then any third cards. */
function coup(cards: string) {
  const shoe = new Shoe(8, createRng(1));
  shoe.rig(parseCards(cards));
  return dealCoup(shoe);
}

test('hand values drop the tens', () => {
  assert.equal(handValue(parseCards('9s 8d')), 7);
  assert.equal(handValue(parseCards('Kh Qd')), 0);
  assert.equal(handValue(parseCards('As 5d 4c')), 0);
  assert.equal(handValue(parseCards('As 7d')), 8);
});

test('a natural ends the coup with no draws', () => {
  const c = coup('9s 2d Kc 3h');
  assert.equal(c.natural, true);
  assert.equal(c.player.length, 2);
  assert.equal(c.banker.length, 2);
  assert.equal(c.winner, 'player');
});

test('player draws on 0 to 5 and stands on 6 or 7', () => {
  assert.equal(coup('3s 6d 2c Kh 4h').player.length, 3, 'player 5 draws');
  const stands = coup('3s 2d 4c 2h 8h');
  assert.equal(stands.player.length, 2, 'player 7 stands');
  assert.equal(stands.banker.length, 3, 'banker 4 draws when the player stood');
});

test('the banker follows the tableau', () => {
  const draws = (bankerTotal: number, third: string) => bankerDraws(bankerTotal, parseCards(third)[0]);
  assert.equal(draws(3, '8s'), false);
  assert.equal(draws(3, '9s'), true);
  assert.equal(draws(4, 'As'), false);
  assert.equal(draws(4, '2s'), true);
  assert.equal(draws(5, '3s'), false);
  assert.equal(draws(5, '4s'), true);
  assert.equal(draws(6, '6s'), true);
  assert.equal(draws(6, '5s'), false);
  assert.equal(draws(7, '7s'), false);
  assert.equal(bankerDraws(5, null), true);
  assert.equal(bankerDraws(6, null), false);
  // Player 2 draws a 4 (6); banker 5 draws against a 4 and gets a 3 (8).
  const c = coup('As 3d Ac 2h 4h 3c');
  assert.equal(c.player.length, 3);
  assert.equal(c.banker.length, 3);
  assert.equal(c.bankerTotal, 8);
  assert.equal(c.winner, 'banker');
});

test('banker pays less 5%, ties push the main bets and pay 8 to 1', () => {
  const banker = settleCoup({ banker: 100, player: 100 }, coup('2s 9d 3c Kh'));
  assert.deepEqual(banker.spots.map((s) => [s.spot, s.paid]), [['player', 0], ['banker', 195]]);
  const tie = settleCoup({ banker: 100, player: 50, tie: 10 }, coup('4s 4d 4c 4h'));
  assert.deepEqual(tie.spots.map((s) => [s.spot, s.outcome, s.paid]), [['player', 'push', 50], ['tie', 'win', 90], ['banker', 'push', 100]]);
  assert.equal(tie.net, 80);
});

test('pair bets pay 11 to 1 on the first two cards', () => {
  const c = coup('7s 2d 7c 3h');
  assert.equal(c.playerPair, true);
  assert.equal(c.bankerPair, false);
  const r = settleCoup({ playerPair: 10, bankerPair: 10 }, c);
  assert.equal(r.paid, 120);
  assert.equal(betsProblem({ player: 5 }, { min: 10, max: 500 }, 1000), 'Each bet needs at least 10 chips.');
});

test('baccarat achievements', () => {
  const c = coup('9s 2d Kc 3h');
  const t = baccaratTally(c, settleCoup({ player: 100 }, c), 6);
  assert.equal(t.sum['bac.hands'], 1);
  assert.equal(t.sum['bac.nines'], 1);
  assert.equal(t.max['bac.bestRun'], 6);
  const got = unlockedIn({ ...t.sum, ...t.max }).map((a) => a.id);
  assert.ok(got.includes('bac-nine') && got.includes('bac-run-6'));
});

test('a long run of coups stays near the house edge', () => {
  const shoe = new Shoe(8, createRng(3));
  let net = 0;
  const n = 40_000;
  for (let i = 0; i < n; i++) {
    if (shoe.needsShuffle) shoe.shuffle();
    net += settleCoup({ banker: 100 }, dealCoup(shoe)).net;
  }
  // Banker's edge is about 1.06%.
  const edge = -net / (n * 100);
  assert.ok(edge > 0 && edge < 0.03, `edge ${edge}`);
});
