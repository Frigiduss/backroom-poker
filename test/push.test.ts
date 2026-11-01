import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from './memory-db';
import { TableSettings, TableView } from '../src/online/protocol';
import { PING_GAP_MS, handle } from '../src/online/server';
import { PUSH_ENDPOINT, Pusher, TurnNotice, handlePush, inviteMessage, turnMessage } from '../src/online/push';
import { b64url, contentKeys, encryptPush, fromB64url, makeVapidKeys, vapidAuth } from '../src/online/webpush';

const subtle = globalThis.crypto.subtle;

/** A browser's side of a push subscription, to read what the server sent. */
async function browser() {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    p256dh: b64url(pub),
    auth: b64url(auth),
    async read(body: Uint8Array): Promise<string> {
      const salt = body.slice(0, 16);
      assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16), 4096, 'record size');
      const idlen = body[20];
      const asPublic = body.slice(21, 21 + idlen);
      const server = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const secret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: server }, pair.privateKey, 256));
      const { cek, nonce } = await contentKeys(secret, auth, pub, asPublic, salt);
      const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idlen)));
      assert.equal(plain[plain.length - 1], 2, 'last-record marker');
      return new TextDecoder().decode(plain.slice(0, -1));
    },
  };
}

test('push messages are encrypted so only the subscribed browser can read them', async () => {
  const b = await browser();
  const sealed = await encryptPush(new TextEncoder().encode('{"kind":"turn"}'), b.p256dh, b.auth);
  assert.equal(await b.read(sealed), '{"kind":"turn"}');
  const other = await browser();
  await assert.rejects(other.read(sealed), 'another browser cannot read it');
  await assert.rejects(encryptPush(new Uint8Array(1), 'AAAA', b.auth), /Bad subscription keys/);
});

test('the VAPID header is signed with the server key and names the push service', async () => {
  const keys = await makeVapidKeys();
  assert.equal(fromB64url(keys.publicKey).length, 65);
  const header = await vapidAuth('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://frigiduss.github.io/backroom-poker/', 1_700_000_000_000);
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
  assert.equal(k, keys.publicKey);
  const [h, p, s] = jwt.split('.');
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(p)));
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 12 * 3600, sub: 'https://frigiduss.github.io/backroom-poker/' });
  const pub = await subtle.importKey('raw', fromB64url(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(s), new TextEncoder().encode(`${h}.${p}`)));
});

test('only the big push services are ever posted to', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/x:y', 'https://updates.push.services.mozilla.com/wpush/v2/gAAA', 'https://web.push.apple.com/QM9b', 'https://wns2-par02p.notify.windows.com/w/?token=BQYA']) {
    assert.ok(PUSH_ENDPOINT.test(ok), ok);
  }
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.com/fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://localhost/x', 'https://push.apple.com.evil/x', 'https://notify.windows.com@evil.com/x']) {
    assert.ok(!PUSH_ENDPOINT.test(bad), bad);
  }
});

test('notification text', () => {
  const s = { variant: 'holdem', structure: 'NL', game: 'poker' } as TableSettings;
  assert.deepEqual(turnMessage({ userId: 'u', code: 'abc12', settings: s }), { kind: 'turn', title: "It's your turn", body: "Your move at table ABC12 (No-Limit Texas Hold'em). Tap to play.", code: 'ABC12' });
  assert.equal(turnMessage({ userId: 'u', code: 'Q', settings: { ...s, game: 'blackjack' } }).body, 'Your move at table Q (blackjack). Tap to play.');
  const inv = inviteMessage({ name: '  Sam  the   man ', table: 'xy-9', game: 'poker', variant: 'omaha', structure: 'PL' });
  assert.equal(inv.title, 'Sam the man opened a table');
  assert.equal(inv.body, 'Come and play Pot-Limit Omaha at table XY9.');
});

/** Supabase's REST API and the push services, as far as the Pusher uses them. */
function fakeServer(opts: { devices?: { endpoint: string; p256dh: string; auth: string }[]; invite?: Record<string, unknown> | null; status?: number } = {}) {
  const saved: { keys: { public_key: string; private_jwk: JsonWebKey } | null } = { keys: null };
  const log: string[] = [];
  const pushes: { url: string; headers: Headers; body: Uint8Array }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    if (url.hostname !== 'demo.supabase.co') {
      pushes.push({ url: url.href, headers, body: init.body as Uint8Array });
      return new Response(null, { status: opts.status ?? 201 });
    }
    assert.equal(headers.get('apikey'), 'service-key');
    log.push(`${method} ${url.pathname}${url.search}`);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname === '/rest/v1/push_keys') {
      if (method === 'GET') return Response.json(saved.keys ? [saved.keys] : []);
      saved.keys ??= { public_key: body.public_key, private_jwk: body.private_jwk };
      return new Response(null, { status: 201 });
    }
    if (url.pathname === '/rest/v1/rpc/push_targets') return Response.json(opts.devices ?? []);
    if (url.pathname === '/rest/v1/rpc/push_invite') return Response.json(opts.invite ?? null);
    if (url.pathname === '/rest/v1/push_devices' && method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, log, pushes, saved };
}

test('the server makes its key once, then sends each device an encrypted, signed push', async () => {
  const phone = await browser();
  const devices = [
    { endpoint: 'https://fcm.googleapis.com/fcm/send/phone', p256dh: phone.p256dh, auth: phone.auth },
    { endpoint: 'https://evil.example/steal', p256dh: phone.p256dh, auth: phone.auth },
  ];
  const s = fakeServer({ devices });
  const pusher = new Pusher('https://demo.supabase.co', 'service-key', s.fetchFn);
  const key = await pusher.publicKey();
  assert.equal(await new Pusher('https://demo.supabase.co', 'service-key', s.fetchFn).publicKey(), key, 'a second server reads the saved key');
  assert.equal(s.log.filter((l) => l.startsWith('POST /rest/v1/push_keys')).length, 1);

  const settings = { variant: 'holdem', structure: 'NL' } as TableSettings;
  assert.equal(await pusher.turn({ userId: 'bob', code: 'ABCDE', settings }), 1);
  assert.equal(s.pushes.length, 1, 'only the real push service is posted to');
  const p = s.pushes[0];
  assert.equal(p.headers.get('Content-Encoding'), 'aes128gcm');
  assert.equal(p.headers.get('TTL'), '60');
  assert.match(p.headers.get('Authorization')!, new RegExp(`^vapid t=.+, k=${key}$`));
  assert.deepEqual(JSON.parse(await phone.read(p.body)), turnMessage({ userId: 'bob', code: 'ABCDE', settings }));
  assert.ok(s.log.some((l) => l.startsWith('POST /rest/v1/rpc/push_targets')));
});

test('a device the push service says is gone is removed', async () => {
  const phone = await browser();
  const s = fakeServer({ devices: [{ endpoint: 'https://web.push.apple.com/old', p256dh: phone.p256dh, auth: phone.auth }], status: 410 });
  const pusher = new Pusher('https://demo.supabase.co', 'service-key', s.fetchFn);
  assert.equal(await pusher.turn({ userId: 'bob', code: 'ABCDE', settings: {} as TableSettings }), 0);
  assert.ok(s.log.includes(`DELETE /rest/v1/push_devices?endpoint=eq.${encodeURIComponent('https://web.push.apple.com/old')}`));
});

test('invites are sent only when the database says the invite is real and new', async () => {
  const phone = await browser();
  const devices = [{ endpoint: 'https://fcm.googleapis.com/fcm/send/p', p256dh: phone.p256dh, auth: phone.auth }];
  const none = fakeServer({ devices, invite: null });
  assert.deepEqual(await handlePush(new Pusher('https://demo.supabase.co', 'service-key', none.fetchFn), 'alice', { op: 'push-invite', code: 'FRND22' }), { status: 200, body: { ok: true } });
  assert.equal(none.pushes.length, 0);

  const yes = fakeServer({ devices, invite: { to: 'bob', name: 'Alice', table: 'ABCDE', game: 'blackjack' } });
  await handlePush(new Pusher('https://demo.supabase.co', 'service-key', yes.fetchFn), 'alice', { op: 'push-invite', code: 'FRND22' });
  assert.equal(yes.pushes.length, 1);
  assert.equal(yes.pushes[0].headers.get('TTL'), '900');
  assert.equal(JSON.parse(await phone.read(yes.pushes[0].body)).title, 'Alice opened a table');
  const key = await handlePush(new Pusher('https://demo.supabase.co', 'service-key', yes.fetchFn), 'alice', { op: 'push-key' });
  assert.equal((key.body as { key: string }).key, yes.saved.keys!.public_key);
});

test('the table server notices when the turn comes round to someone else, at most once a turn and every 45 seconds', async () => {
  const db = new MemoryDb();
  let clock = 1_000_000;
  const notices: TurnNotice[] = [];
  const opts = { now: () => clock, seed: () => 7, notify: (n: TurnNotice) => notices.push(n) };
  const call = async (user: string, body: Record<string, unknown>) => {
    const r = await handle(db, user, body, opts);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (r.body as { view: TableView; tableId: string; code: string });
  };
  const settings: TableSettings = { variant: 'holdem', structure: 'NL', format: 'headsup', difficulty: 'easy', stackBB: 100, blindSpeed: 'normal', seats: 2 };
  const made = await call('alice', { op: 'create', name: 'Alice', settings });
  await call('bob', { op: 'join', code: made.code, name: 'Bob' });
  const started = await call('alice', { op: 'start', tableId: made.tableId });
  const who = (v: TableView) => (v.legal ? 'me' : 'other');
  // Whoever acts first: if it's Bob, Alice starting the game is what tells him.
  const aliceFirst = who(started.view) === 'me';
  assert.deepEqual(notices.map((n) => n.userId), aliceFirst ? [] : ['bob']);
  if (notices.length) assert.equal(notices[0].code, made.code);

  // Moves in quick succession: each turn change is noticed, but one person hears at most once in 45 s.
  const act = async () => {
    const views = await Promise.all(['alice', 'bob'].map(async (u) => ({ u, v: (await handle(db, u, { op: 'tick', tableId: made.tableId, version: -1 }, opts)).body as { view: TableView } })));
    const turn = views.find((x) => x.v.view.legal)!;
    const legal = turn.v.view.legal!;
    const action = legal.kind === 'bet' && legal.check ? { type: 'check' } : { type: 'call' };
    await call(turn.u, { op: 'act', tableId: made.tableId, hand: turn.v.view.handNumber, action });
    return turn.u;
  };
  const before = notices.length;
  const first = await act();
  assert.equal(notices.length, before + 1, 'the other player is told it is their turn');
  assert.notEqual(notices.at(-1)!.userId, first, 'nobody is told about a turn they made happen');
  clock += 1000;
  await act();
  clock += 1000;
  await act();
  const counts = notices.reduce<Record<string, number>>((c, n) => ((c[n.userId] = (c[n.userId] ?? 0) + 1), c), {});
  assert.ok(Object.values(counts).every((n) => n <= 1), `at most one each within 45 s: ${JSON.stringify(counts)}`);
  clock += PING_GAP_MS;
  const n = notices.length;
  await act();
  assert.equal(notices.length, n + 1, 'after 45 seconds they can be told again');
});
