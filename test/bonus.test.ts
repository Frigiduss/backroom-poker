import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdminApi, MemoryStorage, NotSetUpError, OnlineAccountStore, OnlineAuth, OnlineError, STARTING_BANK, applyBonus, bonusAmount, bonusReady, claimLocally,
  claimOnlineBonus, createProfile, fetchLeaderboard, normalizeProfile, recordHand, safeColor,
} from '../src/accounts';
import { FakeSupabase } from './fake-supabase';

const HOUR = 3_600_000;
const config = { url: 'https://demo.supabase.co', anonKey: 'anon-key' };

test('the bonus grows each day in a row and tops out on day seven', () => {
  assert.deepEqual([1, 2, 3, 7, 8, 30].map(bonusAmount), [1000, 1500, 2000, 4000, 4000, 4000]);
});

test('local claims: once every 20 hours, the streak breaks after 48', () => {
  const p = createProfile('A');
  const t0 = Date.UTC(2026, 9, 20, 18);
  assert.equal(claimLocally(p, t0).amount, 1000);
  assert.equal(p.bank, STARTING_BANK + 1000);
  assert.equal(claimLocally(p, t0 + 5 * HOUR).amount, 0);
  assert.equal(p.bank, STARTING_BANK + 1000);
  assert.ok(!bonusReady(p.bonus, t0 + 19 * HOUR));
  const c2 = claimLocally(p, t0 + 21 * HOUR);
  assert.deepEqual([c2.amount, c2.streak], [1500, 2]);
  const c3 = claimLocally(p, t0 + 21 * HOUR + 60 * HOUR);
  assert.deepEqual([c3.amount, c3.streak], [1000, 1]);
  assert.equal(p.stats.peakBank, p.bank);
});

test('the bonus record survives saving and loading, and old saves start without one', () => {
  const p = createProfile('A');
  claimLocally(p, 1_000_000);
  assert.deepEqual(normalizeProfile(JSON.parse(JSON.stringify(p)))!.bonus, { last: 1_000_000, streak: 1 });
  const old = JSON.parse(JSON.stringify(p));
  delete old.bonus;
  assert.deepEqual(normalizeProfile(old)!.bonus, { last: null, streak: 0 });
});

const signedIn = async (server: FakeSupabase, email: string) => {
  const auth = new OnlineAuth(config, new MemoryStorage(), server.fetch);
  await auth.signUp(email, 'secret1');
  return { auth, store: new OnlineAccountStore(auth, null, server.fetch) };
};

test('online claims go by the server clock, whatever the saved profile says', async () => {
  const server = new FakeSupabase();
  server.now = Date.UTC(2026, 9, 20, 18);
  const { auth, store } = await signedIn(server, 'a@example.com');
  const p = createProfile('A');
  await store.put(p);

  const first = await claimOnlineBonus(auth, p.id, server.fetch);
  assert.deepEqual([first.amount, first.streak, first.last], [1000, 1, server.now]);
  applyBonus(p, first);
  assert.equal(p.bank, STARTING_BANK + 1000);

  // Wiping the saved claim (or winding the device clock on) doesn't let it pay twice.
  p.bonus = { last: null, streak: 0 };
  await store.put(p);
  assert.equal((await claimOnlineBonus(auth, p.id, server.fetch)).amount, 0);

  server.now += 22 * HOUR;
  const second = await claimOnlineBonus(auth, p.id, server.fetch);
  assert.deepEqual([second.amount, second.streak], [1500, 2]);
});

test('an account can only claim for its own players', async () => {
  const server = new FakeSupabase();
  const a = await signedIn(server, 'a@example.com');
  const b = await signedIn(server, 'b@example.com');
  const p = createProfile('A');
  await a.store.put(p);
  await assert.rejects(claimOnlineBonus(b.auth, p.id, server.fetch), OnlineError);
  await assert.rejects(claimOnlineBonus(a.auth, 'pr_missing', server.fetch), OnlineError);
});

test('before leaderboard.sql is run, the bonus and leaderboard say so', async () => {
  const server = new FakeSupabase();
  server.bonus = null;
  const { auth, store } = await signedIn(server, 'a@example.com');
  const p = createProfile('A');
  await store.put(p);
  await assert.rejects(claimOnlineBonus(auth, p.id, server.fetch), NotSetUpError);
  await assert.rejects(fetchLeaderboard(auth, 'bank', 25, server.fetch), NotSetUpError);
});

const played = (name: string, bank: number, hands = 10) => {
  const p = createProfile(name);
  p.bank = bank;
  for (let i = 0; i < hands; i++) recordHand(p, { variant: 'holdem', net: 10, collected: 100 * (i + 1), showdownWin: false });
  return p;
};

test('leaderboard: ranks players across accounts, hides newcomers and opt-outs, and shows your own', async () => {
  const server = new FakeSupabase();
  const a = await signedIn(server, 'a@example.com');
  const b = await signedIn(server, 'b@example.com');
  await a.store.put(played('Rich', 90_000));
  await a.store.put(played('Middle', 40_000));
  await a.store.put(played('Newbie', 99_000, 3));
  const shy = played('Shy', 80_000);
  shy.settings.leaderboard = false;
  await a.store.put(shy);
  for (let i = 0; i < 4; i++) await a.store.put(played(`Filler${i}`, 50_000 + i));
  const mine = played('Mine', 1_500);
  mine.title = 'hands-10';
  await b.store.put(mine);

  const top = await fetchLeaderboard(b.auth, 'bank', 3, server.fetch);
  assert.deepEqual(top.map((r) => r.name), ['Rich', 'Filler3', 'Filler2', 'Mine']);
  assert.deepEqual(top.map((r) => r.rank), [1, 2, 3, 7]);
  assert.deepEqual(top.map((r) => r.mine), [false, false, false, true]);
  assert.equal(top[3].title, null); // not unlocked, so not shown

  // Visitors can read it too, with nobody marked as theirs.
  await b.auth.signOut();
  const visitor = await fetchLeaderboard(b.auth, 'pot', 25, server.fetch);
  assert.equal(visitor.length, 7);
  assert.ok(visitor.every((r) => !r.mine && r.value === 1000));
  assert.ok(visitor.every((r) => r.rank === 1));
});

test('an admin can take a player off the leaderboard, and only an admin', async () => {
  const server = new FakeSupabase();
  const a = await signedIn(server, 'a@example.com');
  const cheat = played('Cheat', 9_999_999);
  await a.store.put(cheat);
  await a.store.put(played('Honest', 20_000));
  const boss = await signedIn(server, 'boss@example.com');
  server.admins.add(boss.auth.current!.userId);

  await assert.rejects(new AdminApi(a.auth, server.fetch).setLeaderboardHidden(cheat.id, true), OnlineError);
  await new AdminApi(boss.auth, server.fetch).setLeaderboardHidden(cheat.id, true);
  assert.deepEqual((await fetchLeaderboard(a.auth, 'bank', 25, server.fetch)).map((r) => r.name), ['Honest']);
  await new AdminApi(boss.auth, server.fetch).setLeaderboardHidden(cheat.id, false);
  assert.equal((await fetchLeaderboard(a.auth, 'bank', 25, server.fetch))[0].name, 'Cheat');
});

test("a player's colour can't carry CSS onto someone else's screen", () => {
  assert.equal(safeColor('#6fb7ea'), '#6fb7ea');
  assert.equal(safeColor('red;background:url(https://evil.example/x.png)'), '#e6b85c');
  assert.equal(safeColor('#fff" onmouseover="x'), '#e6b85c');
  assert.equal(safeColor(7), '#e6b85c');
  assert.equal(normalizeProfile({ ...createProfile('A'), color: 'red;position:fixed' })!.color, '#e6b85c');
});
