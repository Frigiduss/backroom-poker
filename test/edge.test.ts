import { test } from 'node:test';
import assert from 'node:assert/strict';

// Runs the Edge Function entry point against a stand-in for Supabase's Auth and REST APIs,
// to check the requests it sends match what PostgREST expects.

type Handler = (req: Request) => Promise<Response>;

const tables = new Map<string, { id: string; code: string; version: number; state: unknown; updated_at: string }>();
const views = new Map<string, { version: number; view: unknown }>();
const calls: string[] = [];
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
    return token?.startsWith('user-') ? reply(200, { id: token.slice(5) }) : reply(401, { msg: 'bad jwt' });
  }
  assert.equal(headers.get('Authorization'), 'Bearer service-key');
  const q = url.searchParams;
  const body = init.body ? JSON.parse(String(init.body)) : null;
  const eq = (k: string) => q.get(k)?.replace(/^eq\./, '');
  if (url.pathname === '/rest/v1/poker_tables') {
    if (method === 'GET') {
      const rows = [...tables.values()].filter((r) => (!eq('id') || r.id === eq('id')) && (!eq('code') || r.code === eq('code')));
      return reply(200, rows.map(({ id, code, version, state }) => ({ id, code, version, state })));
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
  if (url.pathname === '/rest/v1/rpc/put_poker_views' && method === 'POST') {
    for (const v of body.p_views) {
      const k = `${body.p_table}/${v.user_id}`;
      if (!views.has(k) || views.get(k)!.version < v.version) views.set(k, { version: v.version, view: v.view });
    }
    return reply(204);
  }
  if (url.pathname === '/rest/v1/poker_views' && method === 'DELETE') {
    views.delete(`${eq('table_id')}/${eq('user_id')}`);
    return reply(204);
  }
  return reply(404, { message: `unexpected ${method} ${url.pathname}` });
}

async function load(): Promise<Handler> {
  let handler: Handler | null = null;
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
  const made = await (await post(h, 'alice', { op: 'create', name: 'Alice', settings })).json();
  assert.ok(made.ok, made.error);
  const joined = await (await post(h, 'bob', { op: 'join', code: made.code, name: 'Bob' })).json();
  assert.ok(joined.ok, joined.error);
  const started = await (await post(h, 'alice', { op: 'start', tableId: made.tableId })).json();
  assert.ok(started.ok, started.error);
  assert.equal(started.view.phase, 'playing');
  assert.equal(views.size, 2, 'a view row for each person');
  const bobView = views.get(`${made.tableId}/bob`)!.view as { hand: { players: { id: string; cards: (number | null)[] }[] }; mySeat: string };
  for (const p of bobView.hand.players) assert.equal(p.cards.every((c) => c !== null), p.id === bobView.mySeat);

  const left = await (await post(h, 'bob', { op: 'leave', tableId: made.tableId })).json();
  assert.ok(left.ok);
  assert.ok(!views.has(`${made.tableId}/bob`), "Bob's view is removed when he leaves");
  assert.ok(calls.includes('POST /rest/v1/rpc/put_poker_views'));
});
