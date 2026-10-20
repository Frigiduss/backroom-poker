import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage, OnlineAccountStore, OnlineAuth, OnlineError, createProfile } from '../src/accounts';
import { FakeSupabase } from './fake-supabase';

const config = { url: 'https://demo.supabase.co', anonKey: 'anon-key' };
const setup = () => {
  const server = new FakeSupabase();
  const storage = new MemoryStorage();
  const auth = new OnlineAuth(config, storage, server.fetch);
  return { server, storage, auth, store: new OnlineAccountStore(auth, storage, server.fetch) };
};

test('sign up, save players, and find them again from another device', async () => {
  const { server, auth, store } = setup();
  await auth.signUp('fridge@example.com', 'secret1');
  const p = createProfile('Fridge');
  await store.put(p);
  p.bank = 12345;
  await store.put(p);
  await store.put(createProfile('Sam'));

  const other = new OnlineAuth(config, new MemoryStorage(), server.fetch);
  await other.signIn('fridge@example.com', 'secret1');
  const players = await new OnlineAccountStore(other, null, server.fetch).list();
  assert.equal(players.length, 2);
  assert.equal(players.find((x) => x.id === p.id)?.bank, 12345);
});

test('accounts only see their own players', async () => {
  const { server, auth, store } = setup();
  await auth.signUp('a@example.com', 'secret1');
  const p = createProfile('A');
  await store.put(p);

  const authB = new OnlineAuth(config, new MemoryStorage(), server.fetch);
  await authB.signUp('b@example.com', 'secret1');
  const storeB = new OnlineAccountStore(authB, null, server.fetch);
  assert.equal((await storeB.list()).length, 0);
  assert.equal(await storeB.get(p.id), null);
  await assert.rejects(storeB.put({ ...p, name: 'Hijack' }), OnlineError);
  await storeB.remove(p.id);
  assert.equal((await store.list()).length, 1);
});

test('the session survives a reload and refreshes when it expires', async () => {
  const { server, storage, auth } = setup();
  server.expiresIn = 30; // already inside the refresh margin
  await auth.signUp('x@example.com', 'secret1');
  const first = auth.current!.accessToken;
  const reloaded = new OnlineAuth(config, storage, server.fetch);
  assert.equal(reloaded.current?.email, 'x@example.com');
  const store = new OnlineAccountStore(reloaded, storage, server.fetch);
  await store.put(createProfile('X'));
  assert.notEqual(reloaded.current!.accessToken, first);
  assert.ok(server.calls.some((c) => c.includes('grant_type=refresh_token')));
});

test('a rejected refresh signs out; a network failure does not', async () => {
  const { server, auth, store } = setup();
  server.expiresIn = 30;
  await auth.signUp('x@example.com', 'secret1');
  server.offline = true;
  await assert.rejects(store.list(), /Sign in again|reach/);
  assert.ok(auth.current, 'still signed in while offline');
  server.offline = false;
  server.refreshTokens.clear();
  await assert.rejects(store.list(), /Sign in again/);
  assert.equal(auth.current, null);
});

test('friendly errors and email confirmation', async () => {
  const { server, auth } = setup();
  await assert.rejects(auth.signIn('nobody@example.com', 'secret1'), /don't match/);
  server.requireConfirm = true;
  assert.equal(await auth.signUp('new@example.com', 'secret1'), null);
  await assert.rejects(auth.signIn('new@example.com', 'secret1'), /Confirm your email/);
  await assert.rejects(auth.signUp('new@example.com', 'secret1'), /already an account/);
});

test('session from an email link, then a new password', async () => {
  const { server, auth } = setup();
  await auth.signUp('r@example.com', 'oldpass');
  const access = auth.current!.accessToken;
  const refresh = auth.current!.refreshToken;
  await auth.signOut();
  assert.equal(auth.current, null);

  const linked = new OnlineAuth(config, new MemoryStorage(), server.fetch);
  // Logout revoked the old token, so mint a new one the way a reset link would.
  const s = server.handle('POST', `${config.url}/auth/v1/token?grant_type=refresh_token`, {}, JSON.stringify({ refresh_token: refresh })).body as { access_token: string; refresh_token: string };
  assert.notEqual(s.access_token, access);
  const r = await linked.fromRedirect(`#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&type=recovery`);
  assert.deepEqual(r, { type: 'recovery' });
  assert.equal(linked.current?.email, 'r@example.com');
  await linked.setPassword('newpass');
  await new OnlineAuth(config, null, server.fetch).signIn('r@example.com', 'newpass');
  assert.deepEqual(await linked.fromRedirect('#error=access_denied&error_description=Email+link+is+invalid+or+has+expired'), { error: 'Email link is invalid or has expired' });
  assert.equal(await linked.fromRedirect('#something=else'), null);
});
