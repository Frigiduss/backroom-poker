import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_CHALLENGES, CHALLENGE_REWARDS, MemoryStorage, NotSetUpError, OnlineAccountStore, OnlineAuth, OnlineError, STARTING_BANK,
  applyChallenge, challengeStatus, challengeWeek, claimChallengeLocally, claimOnlineChallenge, createProfile, normalizeProfile,
  profileCounters, startWeek, weekEnd, weekStart, weeklyChallenges,
} from '../src/accounts';
import { FakeSupabase } from './fake-supabase';

const HOUR = 3_600_000;
const config = { url: 'https://demo.supabase.co', anonKey: 'anon-key' };
// Monday 2 November 2026, 09:00 UTC.
const MON = Date.UTC(2026, 10, 2, 9);

test('weeks turn over at midnight UTC on Mondays', () => {
  const w = challengeWeek(MON);
  assert.equal(challengeWeek(Date.UTC(2026, 10, 2, 0, 0, 0)), w);
  assert.equal(challengeWeek(Date.UTC(2026, 10, 1, 23, 59, 59)), w - 1);
  assert.equal(challengeWeek(Date.UTC(2026, 10, 8, 23, 59)), w);
  assert.equal(challengeWeek(Date.UTC(2026, 10, 9)), w + 1);
  assert.equal(weekStart(w), Date.UTC(2026, 10, 2));
  assert.equal(weekEnd(w), Date.UTC(2026, 10, 9));
  assert.equal(new Date(weekStart(w)).getUTCDay(), 1);
});

test('three goals a week: easy, medium, hard, the same for everyone, never repeated the next week', () => {
  const w = challengeWeek(MON);
  const seen = new Set<string>();
  for (let week = w - 200; week <= w + 200; week++) {
    const list = weeklyChallenges(week);
    assert.deepEqual(list.map((c) => c.slot), [0, 1, 2]);
    assert.deepEqual(list.map((c) => c.reward), [...CHALLENGE_REWARDS]);
    assert.deepEqual(list.map((c) => c.id[0]), ['e', 'm', 'h']);
    assert.deepEqual(weeklyChallenges(week), list);
    const prev = weeklyChallenges(week - 1);
    for (const s of [0, 1, 2]) assert.notEqual(list[s].id, prev[s].id);
    list.forEach((c) => seen.add(c.id));
  }
  // Over a few years every goal comes up.
  assert.equal(seen.size, ALL_CHALLENGES.length);
  assert.equal(new Set(ALL_CHALLENGES.map((c) => c.id)).size, ALL_CHALLENGES.length);
});

/** Pushes every counter one of this week's goals watches up to its goal (local play). */
function finish(p: ReturnType<typeof createProfile>, slot: number, now: number) {
  const ch = weeklyChallenges(challengeWeek(now))[slot];
  p.achievements.counters[ch.keys[0]] = (p.achievements.counters[ch.keys[0]] ?? 0) + ch.goal;
}

test('progress counts from the start of the week, and resets the next', () => {
  const p = createProfile('A');
  const ch = weeklyChallenges(challengeWeek(MON));
  // Play before the week started for this player doesn't count.
  p.achievements.counters[ch[0].keys[0]] = 500;
  assert.deepEqual(challengeStatus(p, profileCounters(p), {}, MON), []);
  assert.ok(startWeek(p, profileCounters(p), {}, true, MON));
  assert.ok(!startWeek(p, profileCounters(p), {}, true, MON + HOUR));
  let st = challengeStatus(p, profileCounters(p), {}, MON);
  assert.deepEqual(st.map((s) => [s.progress, s.state]), [[0, 'open'], [0, 'open'], [0, 'open']]);

  p.achievements.counters[ch[0].keys[0]] += 1;
  st = challengeStatus(p, profileCounters(p), {}, MON);
  assert.equal(st[0].progress, 1);
  finish(p, 0, MON);
  st = challengeStatus(p, profileCounters(p), {}, MON);
  assert.equal(st[0].progress, ch[0].goal);
  assert.equal(st[0].state, 'ready');

  // Next Monday: new goals from zero.
  const next = MON + 7 * 24 * HOUR;
  assert.deepEqual(challengeStatus(p, profileCounters(p), {}, next), []);
  assert.ok(startWeek(p, profileCounters(p), {}, true, next));
  assert.ok(challengeStatus(p, profileCounters(p), {}, next).every((s) => s.progress === 0 && s.state === 'open'));
});

test('online progress counts once the server has answered, from that point on', () => {
  const p = createProfile('A');
  const ch = weeklyChallenges(challengeWeek(MON))[2];
  const server = { [ch.keys[0]]: 40 };
  // The lobby opened before the server's numbers arrived: they aren't a jump in progress.
  startWeek(p, profileCounters(p), {}, false, MON);
  assert.equal(p.challenges.server, null);
  assert.equal(challengeStatus(p, profileCounters(p), server, MON)[2].progress, 0);
  assert.ok(startWeek(p, profileCounters(p), server, true, MON));
  assert.equal(challengeStatus(p, profileCounters(p), server, MON)[2].progress, 0);
  server[ch.keys[0]] += 1;
  p.achievements.counters[ch.keys[0]] = 0;
  assert.equal(challengeStatus(p, profileCounters(p), server, MON)[2].progress, Math.min(1, ch.goal));
});

test('local claims pay each finished goal once', () => {
  const p = createProfile('A');
  startWeek(p, profileCounters(p), {}, true, MON);
  assert.throws(() => claimChallengeLocally(p, 1, profileCounters(p), MON), /isn't finished/);
  finish(p, 1, MON);
  const c = claimChallengeLocally(p, 1, profileCounters(p), MON);
  assert.equal(c.amount, 5000);
  assert.equal(p.bank, STARTING_BANK + 5000);
  assert.equal(p.stats.peakBank, p.bank);
  assert.equal(claimChallengeLocally(p, 1, profileCounters(p), MON).amount, 0);
  assert.equal(p.bank, STARTING_BANK + 5000);
  assert.equal(challengeStatus(p, profileCounters(p), {}, MON)[1].state, 'claimed');
  // Once the week is over, last week's goals can't be collected.
  finish(p, 2, MON);
  assert.throws(() => claimChallengeLocally(p, 2, profileCounters(p), MON + 7 * 24 * HOUR), /over/);
});

test('the challenge record survives saving, and odd or old saves start fresh', () => {
  const p = createProfile('A');
  startWeek(p, profileCounters(p), { hands: 3 }, true, MON);
  finish(p, 0, MON);
  claimChallengeLocally(p, 0, profileCounters(p), MON);
  const back = normalizeProfile(JSON.parse(JSON.stringify(p)))!;
  assert.deepEqual(back.challenges, p.challenges);
  const old = JSON.parse(JSON.stringify(p));
  delete old.challenges;
  assert.equal(normalizeProfile(old)!.challenges.week, -1);
  old.challenges = { week: 'x', claimed: [0] };
  assert.equal(normalizeProfile(old)!.challenges.week, -1);
  old.challenges = { week: 5, local: { hands: 'many', wins: 2 }, server: 7, claimed: [0, 0, 2, 9, '1'] };
  assert.deepEqual(normalizeProfile(old)!.challenges, { week: 5, local: { wins: 2 }, server: null, claimed: [0, 2] });
});

const signedIn = async (server: FakeSupabase, email: string) => {
  const auth = new OnlineAuth(config, new MemoryStorage(), server.fetch);
  await auth.signUp(email, 'secret1');
  return { auth, store: new OnlineAccountStore(auth, null, server.fetch) };
};

test('online claims: the server pays each goal once per account, this week only', async () => {
  const server = new FakeSupabase();
  server.now = MON;
  const { auth, store } = await signedIn(server, 'a@example.com');
  const p = createProfile('A');
  await store.put(p);
  const week = challengeWeek(MON);

  const c = await claimOnlineChallenge(auth, p.id, week, 2, server.fetch);
  assert.deepEqual(c, { amount: 10000, week, slot: 2 });
  startWeek(p, profileCounters(p), {}, true, MON);
  applyChallenge(p, c);
  assert.equal(p.bank, STARTING_BANK + 10000);
  assert.deepEqual(p.challenges.claimed, [2]);

  // Forgetting the claim in the saved profile doesn't pay it twice.
  p.challenges.claimed = [];
  assert.equal((await claimOnlineChallenge(auth, p.id, week, 2, server.fetch)).amount, 0);
  await assert.rejects(claimOnlineChallenge(auth, p.id, week - 1, 0, server.fetch), OnlineError);
  await assert.rejects(claimOnlineChallenge(auth, p.id, week + 1, 0, server.fetch), OnlineError);

  const b = await signedIn(server, 'b@example.com');
  await assert.rejects(claimOnlineChallenge(b.auth, p.id, week, 0, server.fetch), OnlineError);

  server.weekly = null;
  await assert.rejects(claimOnlineChallenge(auth, p.id, week, 0, server.fetch), NotSetUpError);
});
