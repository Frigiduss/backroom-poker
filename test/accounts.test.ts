import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalAccountStore, MemoryStorage, STARTING_BANK, TOURNAMENT_FEE, buyIn, canRefill, cashOut, createProfile, enterTournament,
  exportProfile, finishTournament, importProfile, normalizeProfile, prizeFor, recordHand, refill, setTableStack, settleOpenTable,
} from '../src/accounts';

test('cash game: buy-in, rebuy and cash-out move chips through the bank', () => {
  const p = createProfile('Fridge');
  assert.equal(p.bank, STARTING_BANK);
  assert.ok(buyIn(p, 2000));
  assert.equal(p.bank, 8000);
  setTableStack(p, 0);
  assert.ok(buyIn(p, 2000)); // rebuy
  assert.equal(p.table?.paidIn, 4000);
  setTableStack(p, 5500);
  const net = cashOut(p);
  assert.equal(net, 1500);
  assert.equal(p.bank, 6000 + 5500);
  assert.equal(p.stats.cashNet, 1500);
  assert.equal(p.stats.cashSessions, 1);
  assert.equal(p.table, null);
  assert.equal(p.stats.peakBank, 11500);
});

test('cannot buy in for more than the bank holds', () => {
  const p = createProfile('A');
  p.bank = 1500;
  assert.equal(buyIn(p, 2000), false);
  assert.equal(p.bank, 1500);
  assert.equal(p.table, null);
});

test('a closed tab returns the last saved cash stack and forfeits tournaments', () => {
  const p = createProfile('A');
  buyIn(p, 2000);
  setTableStack(p, 2600);
  settleOpenTable(p);
  assert.equal(p.bank, 10600);
  enterTournament(p);
  settleOpenTable(p);
  assert.equal(p.bank, 10600 - TOURNAMENT_FEE);
  assert.equal(p.table, null);
});

test('tournament payouts', () => {
  assert.equal(prizeFor(1, 2), 2 * TOURNAMENT_FEE);
  assert.equal(prizeFor(2, 2), 0);
  assert.equal(prizeFor(1, 6) + prizeFor(2, 6), 6 * TOURNAMENT_FEE);
  assert.equal(prizeFor(1, 9) + prizeFor(2, 9) + prizeFor(3, 9), 9 * TOURNAMENT_FEE);
  assert.equal(prizeFor(4, 9), 0);
  const p = createProfile('A');
  enterTournament(p);
  const prize = finishTournament(p, 2, 6);
  assert.equal(prize, prizeFor(2, 6));
  assert.equal(p.bank, STARTING_BANK - TOURNAMENT_FEE + prize);
  assert.equal(p.stats.tournamentCashes, 1);
  assert.equal(p.stats.bestFinish, 2);
  assert.equal(finishTournament(p, 1, 6), 0, 'a tournament pays out once');
});

test('refill only when the bank is nearly empty and nothing is at a table', () => {
  const p = createProfile('A');
  assert.equal(refill(p), false);
  p.bank = 300;
  assert.ok(canRefill(p));
  assert.ok(refill(p));
  assert.equal(p.bank, STARTING_BANK);
  assert.equal(p.stats.refills, 1);
});

test('hand stats', () => {
  const p = createProfile('A');
  recordHand(p, { variant: 'holdem', net: 300, collected: 500, showdownWin: true });
  recordHand(p, { variant: 'holdem', net: -100, collected: 0, showdownWin: false });
  recordHand(p, { variant: 'razz', net: 0, collected: 40, showdownWin: false });
  assert.equal(p.stats.hands, 3);
  assert.equal(p.stats.handsWon, 1);
  assert.equal(p.stats.showdownsWon, 1);
  assert.equal(p.stats.biggestPot, 500);
  assert.deepEqual(p.stats.byVariant, { holdem: 2, razz: 1 });
});

test('local store saves, reloads and tracks the current player', async () => {
  const storage = new MemoryStorage();
  const a = new LocalAccountStore(storage);
  const p = createProfile('Fridge', { settings: { prefs: { speed: 'fast' } } });
  await a.put(p);
  await a.setCurrentId(p.id);
  p.bank = 1; // the store keeps its own copy
  const b = new LocalAccountStore(storage);
  assert.equal(await b.currentId(), p.id);
  const loaded = (await b.get(p.id))!;
  assert.equal(loaded.bank, STARTING_BANK);
  assert.deepEqual(loaded.settings, { prefs: { speed: 'fast' } });
  await b.remove(p.id);
  assert.equal(await b.currentId(), null);
  assert.equal((await new LocalAccountStore(storage).list()).length, 0);
});

test('damaged or partial saves still load', async () => {
  const storage = new MemoryStorage();
  storage.setItem('backroom-poker-accounts', '{not json');
  assert.equal((await new LocalAccountStore(storage).list()).length, 0);
  const p = normalizeProfile({ id: 'x', name: '  Old   save ', stats: { hands: 4 } })!;
  assert.equal(p.name, 'Old save');
  assert.equal(p.stats.hands, 4);
  assert.equal(p.bank, STARTING_BANK);
  assert.equal(normalizeProfile({ name: 'no id' }), null);
});

test('backup round trip gets a new id and settles any open table', () => {
  const p = createProfile('A');
  buyIn(p, 2000);
  const copy = importProfile(exportProfile(p));
  assert.notEqual(copy.id, p.id);
  assert.equal(copy.name, 'A');
  assert.equal(copy.table, null);
  assert.equal(copy.bank, STARTING_BANK);
  assert.throws(() => importProfile('{"hello":1}'));
});
