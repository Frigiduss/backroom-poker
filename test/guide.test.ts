import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Card } from '../src/engine/cards';
import { VARIANTS, VariantId, showdownValue } from '../src/engine/variants';
import { evalHigh, evalLow } from '../src/engine/evaluator';
import { handTotal } from '../src/engine/blackjack';
import { payLine } from '../src/engine/videopoker';
import { GUIDE_GAMES, guideFor } from '../src/ui/guides/guide-data';
import { CATEGORIES } from '../src/ui/games';

const showdown = (id: VariantId) => {
  const step = guideFor(id).steps.find((s) => s.title === 'Showdown')!;
  const row = (label: string) => step.rows!.find((r) => r.label === label)?.cards as Card[];
  return { you: row('You'), them: row('Them'), board: row('Board') ?? [] };
};

test('every game in the lobby has a guide with rules and a first hand', () => {
  const lobby = CATEGORIES.flatMap((c) => c.games).sort();
  assert.deepEqual([...GUIDE_GAMES].sort(), lobby);
  for (const id of GUIDE_GAMES) {
    const g = guideFor(id);
    assert.ok(g.goal && g.rules.length >= 3, `${id} rules`);
    assert.ok(g.steps.length >= 4, `${id} walkthrough`);
  }
});

test('no card shows up twice in one step, and marks point at real cards', () => {
  for (const id of GUIDE_GAMES) {
    for (const s of guideFor(id).steps) {
      const seen = new Set<Card>();
      for (const r of s.rows ?? []) {
        for (const c of r.cards) {
          if (c === null) continue;
          assert.ok(!seen.has(c), `${id} "${s.title}" repeats a card`);
          seen.add(c);
        }
        for (const m of r.mark ?? []) assert.ok(m >= 0 && m < r.cards.length && r.cards[m] !== null, `${id} "${s.title}" mark ${m}`);
      }
    }
  }
});

test('the showdowns end the way the guides say', () => {
  // Hold'em, Short Deck, Omaha, Draw: you win.
  for (const id of ['holdem', 'shortdeck', 'omaha', 'draw5'] as VariantId[]) {
    const { you, them, board } = showdown(id);
    const v = VARIANTS[id];
    assert.ok(showdownValue(v, you, board).hi! > showdownValue(v, them, board).hi!, `${id}: you should win`);
  }
  // Short Deck: their full house would win with a full deck.
  const sd = showdown('shortdeck');
  assert.ok(evalHigh([...sd.them, ...sd.board], false) > evalHigh([...sd.you, ...sd.board], false));
  // Omaha Hi-Lo: they take high, you take low.
  const o8 = showdown('omaha8');
  const you = showdownValue(VARIANTS.omaha8, o8.you, o8.board);
  const them = showdownValue(VARIANTS.omaha8, o8.them, o8.board);
  assert.ok(them.hi! > you.hi!);
  assert.ok(you.lo !== null && them.lo !== null && you.lo < them.lo);
});

test('stud and razz final hands are what the guides call them', () => {
  const final = (id: VariantId) => guideFor(id).steps.at(-1)!.rows!.find((r) => r.label === 'You')!.cards as Card[];
  const fullHouse = evalHigh(final('stud7'), false);
  assert.ok(fullHouse > evalHigh(final('stud7').slice(0, 6), false));
  assert.equal(evalLow(final('razz'), false), evalLow(final('razz').filter((_, i) => [0, 1, 2, 4, 5].includes(i)), false));
  assert.notEqual(evalLow(final('stud8'), true), null);
});

test('blackjack and video poker steps add up', () => {
  const bj = guideFor('blackjack').steps;
  assert.equal(handTotal(bj[1].rows![1].cards as Card[]).total, 16);
  assert.equal(handTotal(bj[2].rows![1].cards as Card[]).total, 20);
  assert.equal(handTotal(bj[3].rows![0].cards as Card[]).total, 17);
  assert.equal(handTotal(bj[4].rows![1].cards as Card[]).total, 20);
  assert.equal(payLine(guideFor('videopoker').steps[2].rows![0].cards as Card[], 'jacks'), 'trips');
});

test('the slots walkthrough pays what it says', async () => {
  const { linePay, paysFor } = await import('../src/engine/slots');
  const step = guideFor('slots').steps[1];
  const rows = step.reels!;
  const pays = rows.map((r) => linePay(r));
  assert.deepEqual(pays, ['anyBlack', 'anyRed', null]);
  const diag = (rs: number[]) => linePay(rs.map((row, reel) => rows[row][reel]));
  assert.equal(diag([0, 1, 2]), null);
  assert.equal(diag([2, 1, 0]), null);
  assert.equal(paysFor('anyBlack') + paysFor('anyRed'), 6);
});
