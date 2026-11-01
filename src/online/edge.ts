// The poker-table Supabase Edge Function. scripts/build.mjs bundles this file (with the
// engine and bots) into supabase/functions/poker-table/index.ts, which is what gets deployed.
// Supabase provides SUPABASE_URL and the service key to every function on its own.
import { assuranceOf } from '../accounts/online';
import { RestTableDb } from './rest-db';
import { handle } from './server';
import { Pusher, TurnNotice, handlePush } from './push';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const URL_BASE = Deno.env.get('SUPABASE_URL') ?? '';

/** The project's secret key: the newer sb_secret_ kind when present, else the legacy service_role JWT. */
function serviceKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>;
    const key = keys.default ?? Object.values(keys)[0];
    if (key) return key;
  } catch {
    /* not set */
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

const KEY = serviceKey();
const db = new RestTableDb(URL_BASE, KEY);
const pusher = new Pusher(URL_BASE, KEY);

/** Work that carries on after the answer has gone back, so a notification never slows a move down. */
const pending = new Set<Promise<unknown>>();
function later(p: Promise<unknown>) {
  const done = p.catch((err) => console.error(err)).finally(() => pending.delete(done));
  pending.add(done);
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(done);
}

const notify = (n: TurnNotice) => later(pusher.turn(n));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/**
 * Checks the caller's sign-in with Supabase Auth and returns their account id, or 'code' when
 * the account has an authenticator app and this sign-in skipped its code.
 */
async function userFor(req: Request): Promise<string | null> {
  const auth = req.headers.get('Authorization') ?? '';
  if (!/^Bearer \S+/.test(auth)) return null;
  const res = await fetch(`${URL_BASE}/auth/v1/user`, { headers: { apikey: KEY, Authorization: auth } });
  if (!res.ok) return null;
  const user = (await res.json()) as { id?: string; factors?: { status?: string }[] };
  if (!user.id) return null;
  // Auth has just vouched for this token, so its aal claim can be read as is.
  if (user.factors?.some((f) => f.status === 'verified') && assuranceOf(auth.slice(7)) !== 'aal2') return 'code';
  return user.id;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'Use POST.' });
  if (!URL_BASE || !KEY) return json(500, { ok: false, error: 'The table server is missing its Supabase settings.' });
  try {
    const userId = await userFor(req);
    if (!userId) return json(401, { ok: false, error: 'Sign in to play online.' });
    if (userId === 'code') return json(401, { ok: false, error: 'Finish two-step sign-in to play online.' });
    const body = await req.json().catch(() => null);
    const out = body?.op === 'push-key' || body?.op === 'push-invite' ? await handlePush(pusher, userId, body) : await handle(db, userId, body, { notify });
    return json(out.status, out.body);
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: 'The table server hit a problem. Try again.' });
  }
});
