import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSONA_NAMES } from '../src/bots/persona';
import { RIVAL_MIN_HANDS, RivalHand, Rivals, emptyRivalry, grudgeStyle, moodOf, noteHand, normalizeRivals, rememberedStats, rivalLine, rivalrySummary, transferBetween } from '../src/bots/rivals';
import { createRng } from '../src/engine/cards';
import { emptyStats } from '../src/engine/table';
import { createProfile, normalizeProfile } from '../src/accounts/profile';

const hand = (o: Partial<RivalHand> = {}): RivalHand => ({
  bigBlind: 10, showdown: false, sameShowdown: false, playerNet: 0, moved: 0, winner: null,
  playerBusted: false, botBusted: false, botFoldedToPlayer: false, playerStats: emptyStats(), now: 1, ...o,
});

test('chips the player wins are split across the seats that lost them', () => {
  // Player (0) wins 300; seat 1 lost 200 and seat 2 lost 100.
  assert.equal(transferBetween([300, -200, -100], 0, 1), 200);
  assert.equal(transferBetween([300, -200, -100], 0, 2), 100);
  // Player loses 100 to two winners who took 150 and 50 between them (one also beat seat 3).
  assert.equal(transferBetween([-100, 150, 50, -100], 0, 1), -75);
  assert.equal(transferBetween([-100, 150, 50, -100], 0, 3), 0);
  assert.equal(transferBetween([0, 50, -50], 0, 1), 0);
});

test('a regular has no opinion until they have played enough hands with the player', () => {
  const rivals: Rivals = {};
  for (let i = 0; i < RIVAL_MIN_HANDS - 1; i++) noteHand(rivals, 'Big Lou', hand({ moved: 200, playerNet: 200 }));
  assert.equal(moodOf(rivals['Big Lou']).level, 0);
  assert.equal(moodOf(undefined).label, null);
});

test('taking chips and knocking a regular out builds a grudge, announced once on the way up', () => {
  const rivals: Rivals = {};
  const rises: number[] = [];
  for (let i = 0; i < 40; i++) {
    const { mood, rose } = noteHand(rivals, 'Tex', hand({ moved: 25, playerNet: 25, botBusted: i % 10 === 9 }));
    if (rose) rises.push(mood.level);
  }
  const m = moodOf(rivals.Tex);
  assert.equal(m.level, 3);
  assert.equal(m.label, 'Nemesis');
  assert.deepEqual(rises, [2, 3]);
  assert.equal(rivals.Tex.busted, 4);
  assert.match(rivalrySummary(rivals.Tex), /You're up 100 big blinds on them over 40 hands; you've knocked them out 4 times\./);
});

test('winning chips back cools a grudge, and a regular who keeps winning gets smug', () => {
  const rivals: Rivals = {};
  for (let i = 0; i < 20; i++) noteHand(rivals, 'Mae', hand({ moved: 50, playerNet: 50 }));
  assert.ok(moodOf(rivals.Mae).level >= 2);
  for (let i = 0; i < 20; i++) noteHand(rivals, 'Mae', hand({ moved: -50, playerNet: -50 }));
  assert.equal(moodOf(rivals.Mae).level, 0);
  for (let i = 0; i < 12; i++) noteHand(rivals, 'Mae', hand({ moved: -50, playerNet: -50 }));
  assert.equal(moodOf(rivals.Mae).level, -1);
  assert.equal(moodOf(rivals.Mae).label, 'Has your number');
});

test('showdowns, knockouts and pushed pots are counted from the right side', () => {
  const rivals: Rivals = {};
  noteHand(rivals, 'Doc', hand({ showdown: true, sameShowdown: true, winner: 'player', moved: 80, playerNet: 80 }));
  noteHand(rivals, 'Doc', hand({ showdown: true, sameShowdown: true, winner: 'bot', moved: -300, playerNet: -300, playerBusted: true }));
  noteHand(rivals, 'Doc', hand({ botFoldedToPlayer: true, moved: 15, playerNet: 15 }));
  noteHand(rivals, 'Doc', hand({ botFoldedToPlayer: true, playerNet: -5 }));
  const r = rivals.Doc;
  assert.deepEqual([r.beatThem, r.lostTo, r.bustedBy, r.busted, r.pushed, r.hands], [1, 1, 1, 0, 1, 4]);
  assert.equal(r.net, -20.5);
});

test('a grudge heats up a regular\'s style only once it is a real grudge', () => {
  const wary = { level: 1, heat: 0.2, label: 'Wary of you' } as const;
  const grudge = { level: 2, heat: 0.5, label: 'Holds a grudge' } as const;
  const nemesis = { level: 3, heat: 0.9, label: 'Nemesis' } as const;
  assert.equal(grudgeStyle('tight', wary), 'tight');
  assert.equal(grudgeStyle('tight', grudge), 'balanced');
  assert.equal(grudgeStyle('tight', nemesis), 'loose');
  assert.equal(grudgeStyle('passive', grudge), 'loose');
  assert.equal(grudgeStyle('loose', grudge), 'aggressive');
});

test('a regular remembers the player\'s habits on top of tonight\'s', () => {
  const r = emptyRivalry();
  const rivals: Rivals = { Wren: r };
  noteHand(rivals, 'Wren', hand({ playerStats: { ...emptyStats(), hands: 1, vpip: 1, bets: 2 } }));
  const tonight = { ...emptyStats(), hands: 3, vpip: 1, calls: 1 };
  assert.deepEqual(rememberedStats(tonight, r), { ...emptyStats(), hands: 4, vpip: 2, bets: 2, calls: 1 });
  assert.deepEqual(rememberedStats(undefined, undefined), emptyStats());
});

test('rival lines name the player and read right for "You"', () => {
  const rng = createRng(3);
  for (let i = 0; i < 30; i++) {
    const l = rivalLine('Big Lou', 'greetGrudge', 'Fridge', rng);
    assert.ok(!l.includes('{name}'));
    assert.match(l, /^[A-Z]/);
  }
  for (let i = 0; i < 30; i++) {
    const l = rivalLine('Gus', 'greetGrudge', 'You', rng);
    assert.ok(!l.includes('{name}') && !/.\bYou\b/.test(l), l);
  }
});

test('rivals save with the profile and junk is dropped on load', () => {
  const p = createProfile('Fridge');
  assert.deepEqual(p.rivals, {});
  noteHand(p.rivals, 'Rosa', hand({ moved: 20, playerNet: 20 }));
  const back = normalizeProfile(JSON.parse(JSON.stringify(p)))!;
  assert.equal(back.rivals.Rosa.net, 2);
  assert.equal(back.rivals.Rosa.hands, 1);
  const odd = normalizeRivals({ Rosa: { hands: 'lots', net: 5, reads: { vpip: -3 } }, Stranger: { hands: 9 }, Mae: null }, PERSONA_NAMES);
  assert.deepEqual(Object.keys(odd), ['Rosa']);
  assert.equal(odd.Rosa.hands, 0);
  assert.equal(odd.Rosa.reads.vpip, 0);
  // Saves from before rivals existed still load.
  const old = JSON.parse(JSON.stringify(p));
  delete old.rivals;
  assert.deepEqual(normalizeProfile(old)!.rivals, {});
});
