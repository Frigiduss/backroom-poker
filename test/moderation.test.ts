import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdminApi, MemoryStorage, ModerationNotSetUpError, NOT_BANNED, OnlineAccountStore, OnlineAuth, OnlineError, applyAdminFields, banStatus,
  collectAdminChanges, createProfile, emptyProfileStats,
} from '../src/accounts';
import { AdminTableInfo } from '../src/online/protocol';
import { handle } from '../src/online/server';
import { FakeSupabase } from './fake-supabase';
import { MemoryDb } from './memory-db';

const config = { url: 'https://demo.supabase.co', anonKey: 'anon-key' };

async function account(server: FakeSupabase, email: string) {
  const auth = new OnlineAuth(config, new MemoryStorage(), server.fetch);
  await auth.signUp(email, 'secret12');
  return { auth, store: new OnlineAccountStore(auth, null, server.fetch), admin: new AdminApi(auth, server.fetch) };
}

async function setup() {
  const server = new FakeSupabase();
  const fridge = await account(server, 'fridge@example.com');
  const sam = await account(server, 'sam@example.com');
  server.admins.add(fridge.auth.current!.userId);
  const samP = createProfile('Sam');
  samP.bank = 10_000;
  await sam.store.put(samP);
  return { server, fridge, sam, samP };
}

test("an admin's change sticks while the player's game is open, until the game collects it", async () => {
  const { server, fridge, sam, samP } = await setup();
  // Sam's game holds its own copy of the player the whole time.
  const open = structuredClone(samP);
  const saved = await fridge.admin.editPlayer(samP.id, { bank: 2500, stats: { handsWon: 0 } });
  assert.equal(saved?.bank, 2500);

  open.bank = 10_400;
  open.stats.handsWon = 7;
  await sam.store.put(open);
  assert.equal((await sam.store.get(samP.id))?.bank, 2500, 'the old bank saved over it is refused');
  assert.equal((await sam.store.get(samP.id))?.stats.handsWon, 0);

  const got = await collectAdminChanges(sam.auth, open, server.fetch);
  assert.deepEqual(got, { deleted: false, changed: true, nameLocked: false });
  assert.equal(open.bank, 2500);
  assert.equal(open.stats.handsWon, 0);
  open.bank = 2600;
  await sam.store.put(open);
  assert.equal((await sam.store.get(samP.id))?.bank, 2600, 'after collecting, play saves as usual');
  assert.equal((await collectAdminChanges(sam.auth, open, server.fetch)).changed, false, 'collected once');
});

test('a name an admin sets stays until they unlock it', async () => {
  const { server, fridge, sam, samP } = await setup();
  await fridge.admin.editPlayer(samP.id, { name: 'Player 7' }, true);
  const open = structuredClone(samP);
  const got = await collectAdminChanges(sam.auth, open, server.fetch);
  assert.equal(open.name, 'Player 7');
  assert.equal(got.nameLocked, true);
  open.name = 'Sam again';
  await sam.store.put(open);
  assert.equal((await sam.store.get(samP.id))?.name, 'Player 7');
  await fridge.admin.editPlayer(samP.id, {}, false);
  assert.equal((await collectAdminChanges(sam.auth, open, server.fetch)).nameLocked, false);
  await sam.store.put(open);
  assert.equal((await sam.store.get(samP.id))?.name, 'Sam again');
});

test('a deleted player stays deleted, and the game learns it', async () => {
  const { server, fridge, sam, samP } = await setup();
  assert.equal(await fridge.admin.deletePlayerForGood(samP.id), true);
  await assert.rejects(sam.store.put(samP), /deleted this player/);
  assert.equal((await collectAdminChanges(sam.auth, samP, server.fetch)).deleted, true);
  await sam.store.put(createProfile('Sam 2'));
  assert.equal((await sam.store.list()).length, 1, 'the account can start again');
});

test('a suspension stops saves, shows its reason, hides the player and can be lifted', async () => {
  const { server, fridge, sam, samP } = await setup();
  const samId = sam.auth.current!.userId;
  assert.deepEqual(await banStatus(sam.auth, server.fetch), NOT_BANNED);
  const r = await fridge.admin.ban(samId, 3, 'chip farming');
  assert.equal(r.hidden, 1);
  assert.ok(r.until && r.until > Date.now());
  const status = await banStatus(sam.auth, server.fetch);
  assert.equal(status.banned, true);
  assert.equal(status.reason, 'chip farming');
  await assert.rejects(sam.store.put({ ...samP, bank: 1 }), /suspended/);
  assert.ok(server.hidden.has(samP.id));
  assert.deepEqual((await fridge.admin.bans()).map((b) => [b.email, b.reason]), [['sam@example.com', 'chip farming']]);
  await assert.rejects(fridge.admin.ban(fridge.auth.current!.userId, null, ''), /Admins can't be suspended/);
  // Players can't use any of it.
  await assert.rejects(sam.admin.ban(fridge.auth.current!.userId, 1, 'x'), OnlineError);
  await assert.rejects(sam.admin.editPlayer(samP.id, { bank: 1 }), OnlineError);

  assert.equal(await fridge.admin.unban(samId), true);
  assert.equal((await banStatus(sam.auth, server.fetch)).banned, false);
  assert.ok(!server.hidden.has(samP.id));
  await sam.store.put({ ...samP, bank: 9000 });
  assert.equal((await sam.store.get(samP.id))?.bank, 9000);
});

test('without moderation.sql nothing breaks, and the console is told why', async () => {
  const { server, fridge, sam, samP } = await setup();
  server.moderation = null;
  assert.deepEqual(await banStatus(sam.auth, server.fetch), NOT_BANNED);
  assert.deepEqual(await collectAdminChanges(sam.auth, samP, server.fetch), { deleted: false, changed: false, nameLocked: false });
  await assert.rejects(fridge.admin.editPlayer(samP.id, { bank: 5 }), ModerationNotSetUpError);
  await assert.rejects(fridge.admin.ban(sam.auth.current!.userId, 1, ''), ModerationNotSetUpError);
  assert.equal((await fridge.admin.bankGuards()).size, 0);
});

test('admin fields only take the shapes a profile needs', () => {
  const p = createProfile('Ann');
  p.stats.hands = 30;
  assert.equal(applyAdminFields(p, {}), false);
  assert.equal(applyAdminFields(p, { bank: -4, name: '   ', history: [[1, 'x']] }), false);
  assert.equal(applyAdminFields(p, { bank: 123_456.7, name: '  A   very long name indeed ', stats: { hands: 2, nope: 5 } }), true);
  assert.equal(p.bank, 123_456);
  assert.equal(p.stats.peakBank, 123_456);
  assert.equal(p.name, 'A very long na');
  assert.equal(p.stats.hands, 2);
  assert.equal('nope' in p.stats, false);
  applyAdminFields(p, { stats: emptyProfileStats(50), history: [[5, 50]] });
  assert.equal(p.stats.hands, 0);
  assert.deepEqual(p.history, [[5, 50]]);
});

// ---------- the table server ----------

function tables() {
  const db = new MemoryDb();
  db.admins.add('fridge');
  const opts = { now: () => 1_000_000, seed: () => 7 };
  const call = async (user: string, req: Record<string, unknown>) =>
    (await handle(db, user, req, opts)) as { status: number; body: { ok: boolean; error?: string; tableId: string; code: string; table: AdminTableInfo | null } };
  return { db, call };
}

test('a suspended account can’t open, join or watch a table, or chat', async () => {
  const { db, call } = tables();
  const made = await call('alice', { op: 'create', name: 'Alice', settings: { variant: 'holdem', format: 'cash', seats: 4 } });
  assert.equal(made.status, 200, made.body.error);
  db.bans.add('bob');
  for (const req of [
    { op: 'create', name: 'Bob', settings: { variant: 'holdem', format: 'cash', seats: 4 } },
    { op: 'join', code: made.body.code, name: 'Bob' },
    { op: 'watch', code: made.body.code, name: 'Bob' },
  ]) {
    const r = await call('bob', req);
    assert.equal(r.status, 403, req.op);
    assert.match(r.body.error ?? '', /suspended/);
  }
  db.bans.delete('bob');
  assert.equal((await call('bob', { op: 'join', code: made.body.code, name: 'Bob' })).status, 200);
  db.bans.add('bob');
  assert.equal((await call('bob', { op: 'chat', tableId: made.body.tableId, text: 'hi' })).status, 403);
  assert.equal((await call('bob', { op: 'leave', tableId: made.body.tableId })).status, 200, 'leaving still works');
});

test('Master bots only go to No-Limit Hold’em tables, and console edits stop a table counting', async () => {
  const { db, call } = tables();
  const omaha = await call('fridge', { op: 'create', name: 'Fridge', settings: { variant: 'omaha', structure: 'PL', format: 'cash', seats: 3 } });
  assert.equal((await call('fridge', { op: 'start', tableId: omaha.body.tableId })).status, 200);
  const seat = (await call('fridge', { op: 'admin', tableId: omaha.body.tableId, command: { do: 'inspect' } })).body.table!.seats.find((s) => !s.isHuman)!.id;
  const refused = await call('fridge', { op: 'admin', tableId: omaha.body.tableId, command: { do: 'bot', seat, difficulty: 'master' } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error ?? '', /No-Limit Hold'em/);
  assert.equal([...db.rows.values()].find((r) => r.id === omaha.body.tableId)!.state.tainted, undefined, 'a refused change taints nothing');

  const holdem = await call('fridge', { op: 'create', name: 'Fridge', settings: { variant: 'holdem', structure: 'NL', format: 'cash', seats: 3 } });
  assert.equal((await call('fridge', { op: 'start', tableId: holdem.body.tableId })).status, 200);
  const hSeat = (await call('fridge', { op: 'admin', tableId: holdem.body.tableId, command: { do: 'inspect' } })).body.table!.seats.find((s) => !s.isHuman)!.id;
  assert.equal((await call('fridge', { op: 'admin', tableId: holdem.body.tableId, command: { do: 'bot', seat: hSeat, difficulty: 'master' } })).status, 200);
  assert.equal([...db.rows.values()].find((r) => r.id === holdem.body.tableId)!.state.tainted, true);
});
