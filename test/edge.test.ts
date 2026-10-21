import { test } from 'node:test';
import assert from 'node:assert/strict';

// Runs the Edge Function entry point against a stand-in for Supabase's Auth and REST APIs,
// to check the requests it sends match what PostgREST expects.

type Handler = (req: Request) => Promise<Response>;

const tables = new Map<string, { id: string; code: string; version: number; state: unknown; updated_at: string }>();
const views = new Map<string, { version: number; view: unknown }>();
const calls: string[] = [];
const credited: { owner: string; player_id: string; sum: Record<string, number>; max: Record<string, number> }[] = [];
const ADMIN = '11111111-2222-4333-8444-555555555555';
const adminLog: { admin: string; action: string }[] = [];
let n = 0;

const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

async function fakeSupabase(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const headers = new Headers(init.headers);
  const method = init.method ?? 'GET';
  calls.push(`${method} ${url.pathname}`);
  assert.equal(headers.get('apikey'), 'service-key');
  if (url.pathname === '/auth/v1/user') {
    const token = headers.get('Authorization')?.replace('Bearer ', '');
    // user-2fa-<id>: an account with an authenticator app, signed in with just the password.
    if (token?.startsWith('user-2fa-')) return reply(200, { id: token.slice(9), factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] });
    return token?.startsWith('user-') ? reply(200, { id: token.slice(5) }) : reply(401, { msg: 'bad jwt' });
  }
  assert.equal(headers.get('Authorization'), 'Bearer service-key');
  const q = url.searchParams;
  const body = init.body ? JSON.parse(String(init.body)) : null;
  const eq = (k: string) => q.get(k)?.replace(/^eq\./, '');
  if (url.pathname === '/rest/v1/poker_tables') {
    if (method === 'GET') {
      const rows = [...tables.values()].filter((r) => (!eq('id') || r.id === eq('id')) && (!eq('code') || r.code === eq('code')));
      return reply(200, rows.map(({ id, code, version, state, updated_at }) => ({ id, code, version, state, ...(q.get('select')?.includes('updated_at') ? { updated_at } : {}) })));
    }
    if (method === 'POST') {
      if ([...tables.values()].some((r) => r.code === body.code)) return reply(409, { code: '23505' });
      const row = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, code: body.code, version: body.version, state: body.state, updated_at: new Date().toISOString() };
      tables.set(row.id, row);
      return reply(201, [row]);
    }
    if (method === 'PATCH') {
      const r = tables.get(eq('id')!);
      if (!r || r.version !== Number(eq('version'))) return reply(200, []);
      Object.assign(r, body);
      return reply(200, [{ id: r.id }]);
    }
    if (method === 'DELETE') {
      if (eq('id')) tables.delete(eq('id')!);
      return reply(204);
    }
  }
  if (url.pathname === '/rest/v1/admins' && method === 'GET') return reply(200, eq('user_id') === ADMIN ? [{ user_id: ADMIN }] : []);
  if (url.pathname === '/rest/v1/admin_log' && method === 'POST') {
    adminLog.push(body);
    return reply(201);
  }
  if (url.pathname === '/rest/v1/rpc/put_poker_views' && method === 'POST') {
    for (const v of body.p_views) {
      const k = `${body.p_table}/${v.user_id}`;
      if (!views.has(k) || views.get(k)!.version < v.version) views.set(k, { version: v.version, view: v.view });
    }
    return reply(204);
  }
  if (url.pathname === '/rest/v1/player_awards' && method === 'GET') return reply(200, []);
  if (url.pathname === '/rest/v1/players' && method === 'GET') {
    assert.equal(q.get('select'), 'counters:data->achievements->counters');
    return reply(200, eq('owner') === 'alice' && eq('id') === 'pr_a' ? [{ counters: { hands: 1500 } }] : []);
  }
  if (url.pathname === '/rest/v1/rpc/credit_awards' && method === 'POST') {
    credited.push(...body.p_credits);
    return reply(204);
  }
  if (url.pathname === '/rest/v1/poker_views' && method === 'DELETE') {
    views.delete(`${eq('table_id')}/${eq('user_id')}`);
    return reply(204);
  }
  return reply(404, { message: `unexpected ${method} ${url.pathname}` });
}

let handler: Handler | null = null;
async function load(): Promise<Handler> {
  if (handler) return handler;
  (globalThis as Record<string, unknown>).Deno = {
    env: { get: (k: string) => ({ SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key' })[k] },
    serve: (h: Handler) => (handler = h),
  };
  globalThis.fetch = fakeSupabase as typeof fetch;
  await import('../src/online/edge');
  return handler!;
}

const post = (h: Handler, user: string | null, body: unknown) =>
  h(new Request('https://demo.supabase.co/functions/v1/poker-table', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer user-${user}` } : {}) }, body: JSON.stringify(body),
  }));

test('the deployed function signs people in, makes a table and plays a hand over REST', async () => {
  const h = await load();
  const pre = await h(new Request('https://demo.supabase.co/functions/v1/poker-table', { method: 'OPTIONS' }));
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await post(h, null, { op: 'create' })).status, 401);

  const settings = { variant: 'holdem', structure: 'NL', format: 'cash', difficulty: 'easy', stackBB: 100, blindSpeed: 'normal', seats: 3 };
  const made = await (await post(h, 'alice', { op: 'create', name: 'Alice', settings, playerId: 'pr_a', title: 'hands-1000' })).json();
  assert.ok(made.ok, made.error);
  assert.equal(made.view.members[0].title, 'Grinder', "Alice's title is checked against her saved player");
  const joined = await (await post(h, 'bob', { op: 'join', code: made.code, name: 'Bob', playerId: 'pr_b', title: 'hands-1000' })).json();
  assert.equal(joined.view.members[1].title, null, "Bob hasn't earned it");
  assert.ok(joined.ok, joined.error);
  const started = await (await post(h, 'alice', { op: 'start', tableId: made.tableId })).json();
  assert.ok(started.ok, started.error);
  assert.equal(started.view.phase, 'playing');
  assert.deepEqual(credited.map((c) => [c.owner, c.player_id, c.sum['online.games']]), [['alice', 'pr_a', 1], ['bob', 'pr_b', 1]], 'starting a game with a friend is credited');
  assert.equal(views.size, 2, 'a view row for each person');
  const bobView = views.get(`${made.tableId}/bob`)!.view as { hand: { players: { id: string; cards: (number | null)[] }[] }; mySeat: string };
  for (const p of bobView.hand.players) assert.equal(p.cards.every((c) => c !== null), p.id === bobView.mySeat);

  const left = await (await post(h, 'bob', { op: 'leave', tableId: made.tableId })).json();
  assert.ok(left.ok);
  assert.ok(!views.has(`${made.tableId}/bob`), "Bob's view is removed when he leaves");
  assert.ok(calls.includes('POST /rest/v1/rpc/put_poker_views'));
});

test('an account with two-step sign-in needs the code before it can play online', async () => {
  const h = await load();
  const settings = { variant: 'holdem', structure: 'NL', format: 'cash', difficulty: 'easy', stackBB: 100, blindSpeed: 'normal', seats: 3 };
  const skipped = await post(h, '2fa-carol', { op: 'create', name: 'Carol', settings });
  assert.equal(skipped.status, 401);
  assert.match((await skipped.json()).error, /two-step/);
  const aal2 = Buffer.from(JSON.stringify({ aal: 'aal2' })).toString('base64url');
  const done = await (await post(h, `2fa-carol.${aal2}.sig`, { op: 'create', name: 'Carol', settings })).json();
  assert.ok(done.ok, done.error);
});

test('console commands over REST: admins only, checked on the server', async () => {
  const h = await load();
  const settings = { variant: 'holdem', structure: 'NL', format: 'cash', difficulty: 'easy', stackBB: 100, blindSpeed: 'normal', seats: 3 };
  const made = await (await post(h, 'carol', { op: 'create', name: 'Carol', settings })).json();
  await post(h, 'carol', { op: 'start', tableId: made.tableId });
  const refused = await post(h, 'carol', { op: 'admin', code: made.code, command: { do: 'inspect' } });
  assert.equal(refused.status, 403);
  const seen = await (await post(h, ADMIN, { op: 'admin', code: made.code, command: { do: 'inspect' } })).json();
  assert.ok(seen.ok, seen.error);
  assert.equal(seen.table.code, made.code);
  const paused = await (await post(h, ADMIN, { op: 'admin', tableId: made.tableId, command: { do: 'pause' } })).json();
  assert.ok(paused.ok, paused.error);
  assert.equal(adminLog.at(-1)?.admin, ADMIN);
  const list = await (await post(h, ADMIN, { op: 'tables' })).json();
  assert.ok(list.ok, list.error);
  assert.ok(list.tables.some((t: { code: string; paused: boolean }) => t.code === made.code && t.paused));
});
