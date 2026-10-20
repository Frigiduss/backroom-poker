import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminApi, MemoryStorage, OnlineAccountStore, OnlineAuth, OnlineError, createProfile, readAnnouncement } from '../src/accounts';
import { FakeSupabase } from './fake-supabase';

const config = { url: 'https://demo.supabase.co', anonKey: 'anon-key' };

async function account(server: FakeSupabase, email: string) {
  const auth = new OnlineAuth(config, new MemoryStorage(), server.fetch);
  await auth.signUp(email, 'secret1');
  return { auth, store: new OnlineAccountStore(auth, null, server.fetch), admin: new AdminApi(auth, server.fetch) };
}

test('only accounts in the admins table pass the admin check', async () => {
  const server = new FakeSupabase();
  const fridge = await account(server, 'fridge@example.com');
  const sam = await account(server, 'sam@example.com');
  assert.equal(await fridge.admin.isAdmin(), false);
  server.admins.add(fridge.auth.current!.userId);
  assert.equal(await fridge.admin.isAdmin(), true);
  assert.equal(await sam.admin.isAdmin(), false);
  await assert.rejects(sam.admin.accounts(), OnlineError);
});

test('an admin can list and change every player; others cannot', async () => {
  const server = new FakeSupabase();
  const fridge = await account(server, 'fridge@example.com');
  const sam = await account(server, 'sam@example.com');
  server.admins.add(fridge.auth.current!.userId);
  const samP = createProfile('Sam');
  await sam.store.put(samP);
  await fridge.store.put(createProfile('Fridge'));

  const all = await fridge.admin.players();
  assert.equal(all.length, 2);
  const target = all.find((x) => x.profile.id === samP.id)!;
  assert.equal(target.owner, sam.auth.current!.userId);
  target.profile.bank = 999_999;
  await fridge.admin.savePlayer(target.profile);
  assert.equal((await sam.store.get(samP.id))?.bank, 999_999);

  const accounts = await fridge.admin.accounts();
  assert.deepEqual(accounts.map((a) => [a.email, a.players, a.admin]).sort(), [['fridge@example.com', 1, true], ['sam@example.com', 1, false]]);

  // Sam's own console calls are refused by the server.
  assert.equal((await sam.admin.players()).length, 1);
  await assert.rejects(sam.admin.savePlayer({ ...(await fridge.store.list())[0], bank: 1 }), OnlineError);
  await assert.rejects(sam.admin.deletePlayer((await fridge.store.list())[0].id), OnlineError);

  await fridge.admin.deletePlayer(samP.id);
  assert.equal((await sam.store.list()).length, 0);
});

test("an admin's own player list still only holds their own players", async () => {
  const server = new FakeSupabase();
  const fridge = await account(server, 'fridge@example.com');
  const sam = await account(server, 'sam@example.com');
  server.admins.add(fridge.auth.current!.userId);
  const samP = createProfile('Sam');
  await sam.store.put(samP);
  await fridge.store.put(createProfile('Fridge'));
  assert.deepEqual((await fridge.store.list()).map((p) => p.name), ['Fridge']);
  assert.equal(await fridge.store.get(samP.id), null);
  await fridge.store.remove(samP.id);
  assert.equal((await sam.store.list()).length, 1);
});

test('announcements: admins set them, everyone reads them, others cannot change them', async () => {
  const server = new FakeSupabase();
  const fridge = await account(server, 'fridge@example.com');
  const sam = await account(server, 'sam@example.com');
  server.admins.add(fridge.auth.current!.userId);
  const visitor = new OnlineAuth(config, new MemoryStorage(), server.fetch);
  assert.equal(await readAnnouncement(visitor, server.fetch), '');
  await fridge.admin.setAnnouncement('Double chips weekend!');
  assert.equal(await readAnnouncement(visitor, server.fetch), 'Double chips weekend!');
  await assert.rejects(sam.admin.setAnnouncement('hacked'), OnlineError);
  await fridge.admin.setAnnouncement('');
  assert.equal(await readAnnouncement(visitor, server.fetch), '');
});

test('console actions are logged for admins only', async () => {
  const server = new FakeSupabase();
  const fridge = await account(server, 'fridge@example.com');
  const sam = await account(server, 'sam@example.com');
  server.admins.add(fridge.auth.current!.userId);
  await fridge.admin.log('bank', { to: 5 });
  await sam.admin.log('bank', { to: 1 });
  const rows = await fridge.admin.recentLog();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'bank');
});
