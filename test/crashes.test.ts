import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminApi, CrashApi, MemoryStorage, OnlineAuth, sendCrash } from '../src/accounts';
import { browserName, cleanStack, ignorable } from '../src/ui/crash';
import { FakeSupabase } from './fake-supabase';

const config = { url: 'https://demo.supabase.co', anonKey: 'anon-key' };
const info = { message: 'TypeError: x is undefined', stack: 'at deal (/:1:2)', game: 'Blackjack', browser: 'Chrome 130 · Windows', build: 'abc1234' };

test('browser names are short and readable', () => {
  assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'), 'Chrome 130 · Windows');
  assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68'), 'Edge 130 · Windows');
  assert.equal(browserName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 5, true), 'Safari 18 · iPhone · app');
  assert.equal(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 5), 'Safari 18 · iPad');
  assert.equal(browserName('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'), 'Firefox 131 · Linux');
  assert.equal(browserName('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36'), 'Samsung Internet 26 · Android');
});

test('stack traces lose page addresses\' query and #fragment', () => {
  const origin = 'https://frigiduss.github.io';
  const stack = 'TypeError: x\n    at deal (https://frigiduss.github.io/backroom-poker/#access_token=SECRET&type=recovery:1:200)\n    at go (https://frigiduss.github.io/backroom-poker/?watch=AB12:1:90)\n    at blob:https://frigiduss.github.io/1234-abcd:1:5\n    deal@https://frigiduss.github.io/backroom-poker/#x=1:1:7';
  const clean = cleanStack(stack, origin);
  assert.ok(!clean.includes('SECRET') && !clean.includes('AB12') && !clean.includes('x=1'), clean);
  assert.match(clean, /at deal \(\/backroom-poker\/:1:200\)/);
  assert.match(clean, /at go \(\/backroom-poker\/:1:90\)/);
  assert.match(clean, /at worker:1:5/);
  assert.match(clean, /deal@\/backroom-poker\/:1:7/);
  assert.equal(cleanStack('x'.repeat(5000)).length, 2000);
});

test('errors that are not the game\'s fault are skipped', () => {
  const origin = 'https://frigiduss.github.io';
  assert.ok(ignorable('Script error.'));
  assert.ok(ignorable('TypeError: Failed to fetch'));
  assert.ok(ignorable('ResizeObserver loop completed with undelivered notifications.'));
  assert.ok(ignorable('boom', 'chrome-extension://abc/content.js', origin));
  assert.ok(!ignorable('boom', 'https://frigiduss.github.io/backroom-poker/', origin));
  assert.ok(!ignorable('boom', 'blob:https://frigiduss.github.io/1234', origin));
  assert.ok(!ignorable('TypeError: x is undefined'));
});

test('crash reports go in signed in or not, and only admins read them', async () => {
  const server = new FakeSupabase();
  const visitor = new OnlineAuth(config, new MemoryStorage(), server.fetch);
  assert.equal(await sendCrash(visitor, info, server.fetch), true);
  const fridge = new OnlineAuth(config, new MemoryStorage(), server.fetch);
  await fridge.signUp('fridge@example.com', 'secret12');
  const sam = new OnlineAuth(config, new MemoryStorage(), server.fetch);
  await sam.signUp('sam@example.com', 'secret12');
  assert.equal(await sendCrash(sam, { ...info, message: 'RangeError: bad' }, server.fetch), true);
  assert.deepEqual(server.crashes.map((c) => c.sender), ['visitor', 'account']);

  assert.deepEqual(await new CrashApi(sam, server.fetch).list(), []);
  server.admins.add(fridge.current!.userId);
  const api = new CrashApi(fridge, server.fetch);
  const list = await api.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].games[0], 'Blackjack');
  assert.equal(list[1].account, sam.current!.userId);
  await api.setFixed(list[0].id, true);
  assert.ok((await api.list())[0].fixedAt);
  await api.removeFixed();
  assert.deepEqual((await api.list()).map((c) => c.message), ['RangeError: bad']);
  await api.remove(list[1].id);
  assert.equal((await api.list()).length, 0);
  assert.equal(await new AdminApi(fridge, server.fetch).isAdmin(), true);

  server.offline = true;
  assert.equal(await sendCrash(visitor, info, server.fetch), false);
});
