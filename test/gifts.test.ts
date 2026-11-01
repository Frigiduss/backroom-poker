import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GiftsNotSetUpError, MemoryStorage, OnlineAuth, Profile, addFriend, collectGifts, createProfile, giftProblem, parseGifts, sendChips, syncFriends, syncGifts,
} from '../src/accounts';
import { FakeSupabase } from './fake-supabase';

const config = { url: 'https://demo.supabase.co', anonKey: 'anon-key' };

async function person(fake: FakeSupabase, name: string, hands = 20): Promise<{ auth: OnlineAuth; p: Profile; code: string }> {
  const auth = new OnlineAuth(config, new MemoryStorage(), fake.fetch);
  await auth.signUp(`${name.toLowerCase()}@x.test`, 'password1');
  const p = createProfile(name);
  p.stats.hands = hands;
  fake.rows.push({ id: p.id, owner: auth.current!.userId, data: p, updated_at: new Date().toISOString() });
  const code = (await syncFriends(auth, fake.fetch)).code;
  return { auth, p, code };
}

/** The player's row on the fake server, as the next save would leave it. */
const save = (fake: FakeSupabase, p: Profile) => {
  fake.rows.find((r) => r.id === p.id)!.data = JSON.parse(JSON.stringify(p));
};

test('gifts the browser can turn down before asking', () => {
  const p = createProfile('Ann');
  p.stats.hands = 30;
  assert.equal(giftProblem(p, 50, 10000), 'Send at least 100 chips.');
  assert.match(giftProblem(p, 20000, 10000), /at most 10,000/);
  assert.match(giftProblem(p, 6000, 5000), /5,000 more chips today/);
  p.bank = 300;
  assert.match(giftProblem(p, 500, 10000), /only has 300/);
  p.bank = 10000;
  assert.equal(giftProblem(p, 500, 10000), '');
  p.table = { kind: 'cash', paidIn: 100, stack: 100 };
  assert.match(giftProblem(p, 500, 10000), /Leave your table/);
  p.table = null;
  p.stats.hands = 3;
  assert.match(giftProblem(p, 500, 10000), /10 hands/);
});

test('sending, collecting and the daily limits', async () => {
  const fake = new FakeSupabase();
  const ann = await person(fake, 'Ann');
  const bo = await person(fake, 'Bo');
  const cy = await person(fake, 'Cy');
  await assert.rejects(sendChips(ann.auth, ann.p, bo.code, 500, fake.fetch), /only send chips to a friend/);
  await addFriend(ann.auth, bo.code, fake.fetch);
  await addFriend(bo.auth, ann.code, fake.fetch);

  const r = await sendChips(ann.auth, ann.p, bo.code, 4000, fake.fetch);
  assert.deepEqual(r, { amount: 4000, left: 6000, name: 'Bo' });
  assert.equal(ann.p.bank, 6000);
  assert.equal(ann.p.history.at(-1)![1], 6000);

  const waiting = await syncGifts(bo.auth, fake.fetch);
  assert.deepEqual(waiting.waiting.map((g) => [g.name, g.amount, g.from]), [['Ann', 4000, ann.code]]);
  assert.equal((await syncGifts(ann.auth, fake.fetch)).left, 6000);

  const got = await collectGifts(bo.auth, bo.p, fake.fetch);
  assert.deepEqual(got, { amount: 4000, gifts: [{ name: 'Ann', amount: 4000 }] });
  assert.equal(bo.p.bank, 14000);
  assert.equal(bo.p.stats.peakBank, 14000);
  assert.equal((await collectGifts(bo.auth, bo.p, fake.fetch)).amount, 0);
  assert.equal(bo.p.bank, 14000);

  save(fake, ann.p);
  await assert.rejects(sendChips(ann.auth, ann.p, bo.code, 6100, fake.fetch), /6,000 more chips today/);
  assert.equal(ann.p.bank, 6000, 'a refused gift leaves the bank alone');

  // Bo can be sent 20,000 a day, from anyone.
  await addFriend(cy.auth, bo.code, fake.fetch);
  await addFriend(bo.auth, cy.code, fake.fetch);
  cy.p.bank = 50000;
  save(fake, cy.p);
  await sendChips(cy.auth, cy.p, bo.code, 10000, fake.fetch);
  save(fake, cy.p);
  await assert.rejects(sendChips(ann.auth, ann.p, bo.code, 6100, fake.fetch), /6,000 more chips today/);
  await assert.rejects(sendChips(cy.auth, cy.p, bo.code, 100, fake.fetch), /0 more chips today/);
  fake.gifts!.push({ from: 'someone', to: bo.auth.current!.userId, amount: 2000, at: Date.now(), collected: true });
  await assert.rejects(sendChips(ann.auth, ann.p, bo.code, 5000, fake.fetch), /Bo can only be sent 4,000 more chips today/);
});

test('a project without gifts.sql says so', async () => {
  const fake = new FakeSupabase();
  fake.gifts = null;
  const ann = await person(fake, 'Ann');
  await assert.rejects(syncGifts(ann.auth, fake.fetch), GiftsNotSetUpError);
});

test('gift lists keep only well-formed values', () => {
  const g = parseGifts({ waiting: [{ from: 'kq3-7mz', name: 'A very long name indeed', color: 'red;background:url(x)', avatar: 'f:fox"', amount: '250.7', at: 5 }, { amount: 0 }, null], left: 99999 });
  assert.deepEqual(g, { waiting: [{ from: 'KQ37MZ', name: 'A very long na', color: '#e6b85c', avatar: null, amount: 250, at: 5 }], left: 10000 });
});
