import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PENTHOUSE, PENTHOUSE_BANK, PENTHOUSE_RIVAL_CHIPS, bigRivals, cashTally, createProfile, penthouseAccess, penthouseDoorLine, penthouseSeating } from '../src/accounts';
import { Rivalry, emptyRivalry, moodOf, normalizeRivals } from '../src/bots/rivals';
import { PERSONA_NAMES } from '../src/bots/persona';
import { Table } from '../src/engine/table';
import { Bot } from '../src/bots/bot';
import { buildView } from '../src/bots/view';

/** A regular who has lost `bb` big blinds and `chips` chips to the player over 40 hands. */
const rival = (bb: number, chips: number): Rivalry => ({ ...emptyRivalry(), hands: 40, net: bb, chips });

test('the stakes are 250/500 with a 100 big blind buy-in', () => {
  assert.equal(PENTHOUSE.buyIn, PENTHOUSE.bigBlind * PENTHOUSE.stackBB);
  assert.equal(PENTHOUSE.buyIn, 50_000);
});

test('a new player is kept downstairs and told how to get up', () => {
  const p = createProfile('Fridge');
  const a = penthouseAccess(p);
  assert.equal(a.open, false);
  assert.equal(a.via, null);
  const line = penthouseDoorLine(a, (n) => n.toLocaleString('en-US'));
  assert.match(line, /100,000/);
  assert.match(line, /20,000/);
});

test('a bank that once reached 100,000 opens the door for good', () => {
  const p = createProfile('Fridge');
  p.stats.peakBank = PENTHOUSE_BANK;
  p.bank = 3_000;
  assert.deepEqual([penthouseAccess(p).open, penthouseAccess(p).via], [true, 'bank']);
  const q = createProfile('Fridge');
  q.bank = PENTHOUSE_BANK - 1;
  q.stats.peakBank = PENTHOUSE_BANK - 1;
  assert.equal(penthouseAccess(q).open, false);
});

test('a big rivalry opens it: a grudge and 20,000 chips between you', () => {
  const p = createProfile('Fridge');
  p.rivals = { Rocco: rival(120, PENTHOUSE_RIVAL_CHIPS) };
  assert.ok(moodOf(p.rivals.Rocco).level >= 2);
  const a = penthouseAccess(p);
  assert.deepEqual([a.open, a.via, a.rival], [true, 'rival', 'Rocco']);
  assert.match(penthouseDoorLine(a, String), /^Rocco /);
});

test('a small rivalry or a cold one is not enough', () => {
  const p = createProfile('Fridge');
  // A grudge, but cheap chips.
  p.rivals = { Rocco: rival(120, PENTHOUSE_RIVAL_CHIPS - 1) };
  assert.equal(penthouseAccess(p).open, false);
  assert.equal(penthouseAccess(p).rivalChips, PENTHOUSE_RIVAL_CHIPS - 1);
  // Lots of chips, but they're only wary.
  p.rivals = { Rocco: rival(25, 90_000) };
  assert.equal(moodOf(p.rivals.Rocco).level, 1);
  assert.equal(penthouseAccess(p).open, false);
  // They beat the player up: smug, not a grudge.
  p.rivals = { Rocco: rival(-200, 90_000) };
  assert.equal(penthouseAccess(p).open, false);
});

test('the biggest grudge gets named, most chips first', () => {
  const rivals = { Mae: rival(130, 25_000), Tex: rival(130, 40_000), Doc: rival(130, 5_000) };
  assert.deepEqual(bigRivals(rivals), ['Tex', 'Mae']);
});

test('regulars with a score to settle are seated first upstairs', () => {
  const regulars = ['Ada', 'Mae', 'Tex', 'Doc', 'Gus'].map((name) => ({ name }));
  const rivals = { Doc: rival(130, 5_000), Tex: rival(25, 9_000), Gus: rival(130, 30_000) };
  assert.deepEqual(penthouseSeating(regulars, rivals).map((r) => r.name), ['Gus', 'Doc', 'Tex', 'Ada', 'Mae']);
});

test('old saves without a chip count get one from their big blinds', () => {
  const back = normalizeRivals({ Rosa: { hands: 40, net: -300 } }, PERSONA_NAMES);
  assert.equal(back.Rosa.chips, 6_000);
  const kept = normalizeRivals({ Rosa: { hands: 40, net: 10, chips: 45_000 } }, PERSONA_NAMES);
  assert.equal(kept.Rosa.chips, 45_000);
});

test('leaving the Penthouse ahead counts toward its achievement', () => {
  assert.equal(cashTally(60_000, 500, true).sum['ph.cashUp'], 1);
  assert.equal(cashTally(60_000, 500, true).max.cashBestBB, 120);
  assert.equal(cashTally(60_000, 20).sum['ph.cashUp'], undefined);
  assert.equal(cashTally(-5_000, 500, true).sum['ph.cashUp'], undefined);
});

test('upstairs the blinds climb and the bots buy in deeper with them', () => {
  const t = new Table({
    variant: 'holdem', structure: 'NL', format: 'cash', startingStack: PENTHOUSE.buyIn, bigBlind: PENTHOUSE.bigBlind,
    handsPerLevel: PENTHOUSE.handsPerLevel, climb: PENTHOUSE.climb, seed: 7,
    seats: [{ name: 'You', isHuman: true }, ...['A', 'B', 'C'].map((name) => ({ name, isHuman: false, difficulty: 'easy' as const }))],
  });
  const seen: number[] = [];
  const auto = new Bot('easy');
  for (let n = 0; n < PENTHOUSE.handsPerLevel * (PENTHOUSE.climb.length + 1); n++) {
    if (t.liveSeats.length < 2 || t.seats[0].busted) t.rebuy(t.seats[0].id);
    const level = t.level;
    const h = t.nextHand();
    if (!seen.includes(h.stakes.bb)) seen.push(h.stakes.bb);
    // When the stakes go up, every bot sits behind at least 100 big blinds of them.
    if (t.level > level) for (const s of t.seats.slice(1)) assert.ok(s.stack >= t.rebuyStack || s.busted, `${s.name} ${s.stack}`);
    while (!h.isComplete) h.act(h.normalize(auto.decide(buildView(h, h.toAct, t.stats))));
    t.finishHand();
  }
  assert.deepEqual(seen, [...PENTHOUSE.climb]);
  assert.equal(t.atTopLevel, true);
  assert.equal(t.handsUntilNextLevel(), Infinity);
  assert.equal(t.rebuyStack, 100 * 25_000);
});

test('ordinary cash games keep one blind level', () => {
  const t = new Table({ variant: 'holdem', structure: 'NL', format: 'cash', startingStack: 2000, bigBlind: 20, handsPerLevel: 10, seats: [{ name: 'You', isHuman: true }, { name: 'A', isHuman: false, difficulty: 'easy' }] });
  assert.equal(t.levelsRise, false);
  assert.equal(t.rebuyStack, 2000);
  assert.equal(t.handsUntilNextLevel(), Infinity);
});
