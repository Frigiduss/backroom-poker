// Online accounts on Supabase (hosted sign-in plus a Postgres database). This talks to
// Supabase's REST endpoints directly with fetch, which keeps the game a small single file.
// Each signed-in account plays as one player, stored as one row of the
// `players` table (see supabase/setup.sql), readable and writable only by its owner.
import { Counters } from './achievements';
import { Profile, normalizeProfile } from './profile';
import { AccountStore, KeyValueStorage } from './store';

export interface OnlineConfig {
  /** Project URL, like https://abcd1234.supabase.co */
  url: string;
  /** The project's public "anon" key. Safe to ship in the page; row security protects the data. */
  anonKey: string;
}

export const onlineEnabled = (c: OnlineConfig): boolean => !!(c.url && c.anonKey);

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  userId: string;
  email: string;
}

/** An authenticator app set up on the account for two-step sign-in. */
export interface Factor {
  id: string;
  verified: boolean;
  name: string;
}

/** A new authenticator being set up: scan `qr` (an SVG data URI) or type `secret`. */
export interface TotpSetup {
  id: string;
  qr: string;
  secret: string;
}

/** Fewest characters a new password may have. Supabase's own setting should match (supabase/README.md). */
export const PASSWORD_MIN = 8;

/**
 * How strongly this sign-in was checked, from the access token: 'aal2' once an authenticator
 * code was entered, 'aal1' after just a password. The server checks the token; this is only
 * for knowing when to ask for a code.
 */
export function assuranceOf(accessToken: string): string {
  try {
    const part = accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='))) as { aal?: unknown };
    return typeof claims.aal === 'string' ? claims.aal : 'aal1';
  } catch {
    return 'aal1';
  }
}

export class OnlineError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

type Fetch = typeof fetch;

const SESSION_KEY = 'backroom-poker-session';

/** Turns Supabase's error replies into sentences a player can act on. */
function friendly(status: number, body: Record<string, unknown>): string {
  const code = String(body.error_code ?? body.code ?? body.error ?? '');
  const msg = String(body.msg ?? body.message ?? body.error_description ?? '');
  if (code === 'invalid_credentials' || /invalid login/i.test(msg)) return "That email and password don't match an account.";
  if (code === 'email_not_confirmed' || /not confirmed/i.test(msg)) return 'Confirm your email first: open the link we sent you, then sign in.';
  if (code === 'user_already_exists' || /already registered/i.test(msg)) return 'There is already an account with that email. Sign in instead.';
  if (code === 'weak_password' || /password should be/i.test(msg)) return msg || 'Pick a longer password.';
  if (code === 'mfa_verification_failed' || /invalid totp/i.test(msg)) return "That code didn't match. Check the app and try the newest code.";
  if (code === 'mfa_challenge_expired') return 'That took too long. Try a fresh code.';
  if (code === 'insufficient_aal') return 'Enter a code from your authenticator app first.';
  if (code === 'over_email_send_rate_limit' || status === 429) return 'Too many tries. Wait a minute and try again.';
  if (/valid email|email address/i.test(msg)) return 'That email address doesn\'t look right.';
  return msg || `The server said no (${status}).`;
}

/** Supabase sends the QR code as raw SVG after a data: prefix; encode it so any '#' in it survives. Only SVG is kept. */
function qrUri(qr: string): string {
  const m = /^data:image\/svg\+xml;(?:utf-8|charset=utf-8),([\s\S]*)$/i.exec(qr);
  if (m) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(m[1].includes('<') ? m[1] : decodeURIComponent(m[1]))}`;
  return qr.trim().startsWith('<svg') ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}` : '';
}

/** Email and password sign-in, with the session kept in browser storage and refreshed as needed. */
export class OnlineAuth {
  private session: Session | null;
  private refreshing: Promise<Session | null> | null = null;

  constructor(readonly config: OnlineConfig, private readonly storage: KeyValueStorage | null, private readonly fetchFn: Fetch = (...a) => fetch(...a)) {
    this.session = this.load();
  }

  get current(): Session | null {
    return this.session;
  }

  private load(): Session | null {
    try {
      const raw = this.storage?.getItem(SESSION_KEY);
      const s = raw ? (JSON.parse(raw) as Session) : null;
      return s && s.accessToken && s.refreshToken ? s : null;
    } catch {
      return null;
    }
  }

  private keep(s: Session | null) {
    this.session = s;
    try {
      this.storage?.setItem(SESSION_KEY, s ? JSON.stringify(s) : '');
    } catch {
      /* the session lasts for this visit only */
    }
  }

  private async call(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.config.url}/auth/v1/${path}`, {
        method: init.method ?? 'POST',
        headers: {
          apikey: this.config.anonKey,
          'Content-Type': 'application/json',
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw new OnlineError("Can't reach the account server. Check your connection.");
    }
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    if (!res.ok) throw new OnlineError(friendly(res.status, body), res.status);
    return body;
  }

  private toSession(b: Record<string, unknown>): Session | null {
    const user = b.user as { id?: string; email?: string } | undefined;
    if (typeof b.access_token !== 'string' || typeof b.refresh_token !== 'string' || !user?.id) return null;
    const expiresIn = typeof b.expires_in === 'number' ? b.expires_in : 3600;
    return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt: Date.now() + expiresIn * 1000, userId: user.id, email: user.email ?? '' };
  }

  async signIn(email: string, password: string): Promise<Session> {
    const s = this.toSession(await this.call('token?grant_type=password', { body: { email, password } }));
    if (!s) throw new OnlineError('Sign-in failed. Try again.');
    this.keep(s);
    return s;
  }

  /** Creates an account. Returns null when the project wants the email confirmed first. */
  async signUp(email: string, password: string, redirectTo?: string): Promise<Session | null> {
    const q = redirectTo ? `signup?redirect_to=${encodeURIComponent(redirectTo)}` : 'signup';
    const s = this.toSession(await this.call(q, { body: { email, password } }));
    if (s) this.keep(s);
    return s;
  }

  async sendPasswordReset(email: string, redirectTo?: string): Promise<void> {
    const q = redirectTo ? `recover?redirect_to=${encodeURIComponent(redirectTo)}` : 'recover';
    await this.call(q, { body: { email } });
  }

  async setPassword(password: string): Promise<void> {
    await this.call('user', { method: 'PUT', body: { password }, token: await this.token() });
  }

  async signOut(): Promise<void> {
    const s = this.session;
    this.keep(null);
    if (s) await this.call('logout', { token: s.accessToken }).catch(() => undefined);
  }

  /** Signs this account out on every device, this one included. */
  async signOutEverywhere(): Promise<void> {
    await this.call('logout?scope=global', { token: await this.token() });
    this.keep(null);
  }

  // ---------- two-step sign-in (Supabase MFA with an authenticator app) ----------

  /** The authenticator apps on the account. */
  async factors(): Promise<Factor[]> {
    const user = await this.call('user', { method: 'GET', token: await this.token() });
    const list = Array.isArray(user.factors) ? (user.factors as Record<string, unknown>[]) : [];
    return list
      .filter((f) => f.factor_type === 'totp' && typeof f.id === 'string')
      .map((f) => ({ id: f.id as string, verified: f.status === 'verified', name: String(f.friendly_name ?? '') }));
  }

  /** The authenticator to ask for a code when this sign-in still needs its second step, else null. */
  async secondStepFactor(): Promise<Factor | null> {
    const s = this.session;
    if (!s || assuranceOf(s.accessToken) === 'aal2') return null;
    return (await this.factors()).find((f) => f.verified) ?? null;
  }

  /** Starts setting up an authenticator app. Any half-finished setup is cleared first. */
  async enrollTotp(): Promise<TotpSetup> {
    const token = await this.token();
    for (const f of await this.factors()) if (!f.verified) await this.call(`factors/${encodeURIComponent(f.id)}`, { method: 'DELETE', token });
    const r = await this.call('factors', { body: { factor_type: 'totp', friendly_name: `Back Room Poker ${new Date().toISOString().slice(0, 16)}` }, token });
    const totp = (r.totp ?? {}) as { qr_code?: unknown; secret?: unknown };
    if (typeof r.id !== 'string' || typeof totp.secret !== 'string') throw new OnlineError('Two-step sign-in could not be set up. Try again.');
    return { id: r.id, qr: typeof totp.qr_code === 'string' ? qrUri(totp.qr_code) : '', secret: totp.secret };
  }

  /**
   * Checks a code from the authenticator app. That finishes a sign-in's second step, or turns
   * on a new authenticator, and upgrades this sign-in to 'aal2'.
   */
  async verifyTotp(factorId: string, code: string): Promise<void> {
    const token = await this.token();
    const f = encodeURIComponent(factorId);
    const challenge = await this.call(`factors/${f}/challenge`, { body: {}, token });
    if (typeof challenge.id !== 'string') throw new OnlineError('The code could not be checked. Try again.');
    const s = this.toSession(await this.call(`factors/${f}/verify`, { body: { challenge_id: challenge.id, code: code.replace(/\s+/g, '') }, token }));
    if (!s) throw new OnlineError('The code could not be checked. Try again.');
    this.keep(s);
  }

  /** Removes an authenticator, after a fresh code from it, so a borrowed unlocked device can't turn it off. */
  async removeTotp(factorId: string, code: string): Promise<void> {
    await this.verifyTotp(factorId, code);
    await this.call(`factors/${encodeURIComponent(factorId)}`, { method: 'DELETE', token: await this.token() });
  }

  /**
   * Picks up a session from a link in an email (confirm signup, password reset), which
   * Supabase delivers in the URL hash. Returns what the link was for, or null.
   */
  async fromRedirect(hash: string): Promise<{ type: string } | { error: string } | null> {
    const p = new URLSearchParams(hash.replace(/^#/, ''));
    if (p.get('error_description') || p.get('error')) return { error: (p.get('error_description') ?? p.get('error') ?? '').replace(/\+/g, ' ') };
    const access = p.get('access_token');
    const refresh = p.get('refresh_token');
    if (!access || !refresh) return null;
    const user = (await this.call('user', { method: 'GET', token: access })) as { id?: string; email?: string };
    if (!user.id) return null;
    this.keep({ accessToken: access, refreshToken: refresh, expiresAt: Date.now() + Number(p.get('expires_in') ?? 3600) * 1000, userId: user.id, email: user.email ?? '' });
    return { type: p.get('type') ?? 'signup' };
  }

  /** A valid access token, refreshed when it is about to expire. Throws if signed out. */
  async token(): Promise<string> {
    let s = this.session;
    if (!s) throw new OnlineError('You are signed out.', 401);
    if (s.expiresAt - Date.now() > 60_000) return s.accessToken;
    // Another page on this site (the game, or the admin dashboard) may have refreshed this
    // sign-in already, which used up the refresh token this page holds.
    const stored = this.load();
    if (stored && stored.userId === s.userId && stored.refreshToken !== s.refreshToken) {
      this.session = s = stored;
      if (s.expiresAt - Date.now() > 60_000) return s.accessToken;
    }
    this.refreshing ??= this.refresh(s).finally(() => (this.refreshing = null));
    const next = await this.refreshing;
    if (!next) throw new OnlineError('Your sign-in expired. Sign in again.', 401);
    return next.accessToken;
  }

  private async refresh(s: Session): Promise<Session | null> {
    try {
      const next = this.toSession(await this.call('token?grant_type=refresh_token', { body: { refresh_token: s.refreshToken } }));
      this.keep(next);
      return next;
    } catch (err) {
      // A rejected refresh token means the sign-in is over; a network error keeps it for later.
      if (err instanceof OnlineError && err.status >= 400 && err.status < 500) this.keep(null);
      return null;
    }
  }
}

export interface RestInit {
  method?: string;
  body?: unknown;
  prefer?: string;
  /** Read as a visitor with only the public key, without a signed-in account. */
  anonymous?: boolean;
}

/** One call to the project's database API (`/rest/v1/<path>`), signed in unless `anonymous`. */
export async function restRequest(auth: OnlineAuth, path: string, init: RestInit = {}, fetchFn: Fetch = (...a) => fetch(...a)): Promise<unknown> {
  const token = init.anonymous ? auth.config.anonKey : await auth.token();
  let res: Response;
  try {
    res = await fetchFn(`${auth.config.url}/rest/v1/${path}`, {
      method: init.method ?? 'GET',
      headers: {
        apikey: auth.config.anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.prefer ? { Prefer: init.prefer } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new OnlineError("Can't reach the account server.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OnlineError(friendly(res.status, body as Record<string, unknown>), res.status);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

interface PlayerRow {
  id: string;
  data: unknown;
}

/** Players saved in the signed-in account's rows of the `players` table. */
export class OnlineAccountStore implements AccountStore {
  readonly kind = 'online' as const;

  constructor(private readonly auth: OnlineAuth, private readonly storage: KeyValueStorage | null, private readonly fetchFn: Fetch = (...a) => fetch(...a)) {}

  get email(): string {
    return this.auth.current?.email ?? '';
  }

  private rest(query: string, init: RestInit = {}): Promise<unknown> {
    return restRequest(this.auth, `players${query}`, init, this.fetchFn);
  }

  // Always filter by owner: an admin account can read every account's rows (supabase/admin.sql).
  private get mine(): string {
    return `owner=eq.${encodeURIComponent(this.auth.current?.userId ?? '')}`;
  }

  async list(): Promise<Profile[]> {
    const rows = (await this.rest(`?select=id,data&${this.mine}&order=updated_at.desc`)) as PlayerRow[];
    return rows.map((r) => normalizeProfile({ ...(r.data as object), id: r.id })).filter((p): p is Profile => !!p);
  }

  async get(id: string): Promise<Profile | null> {
    const rows = (await this.rest(`?select=id,data&${this.mine}&id=eq.${encodeURIComponent(id)}`)) as PlayerRow[];
    return rows[0] ? normalizeProfile({ ...(rows[0].data as object), id: rows[0].id }) : null;
  }

  async put(profile: Profile): Promise<void> {
    await this.rest('?on_conflict=id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: { id: profile.id, data: profile, updated_at: new Date(profile.updatedAt).toISOString() },
    });
  }

  async remove(id: string): Promise<void> {
    await this.rest(`?${this.mine}&id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
  }

  /**
   * Achievement progress the table server credited to a player for online play
   * (supabase/achievements.sql). Empty when there is none, or before that setup is done.
   */
  async awards(playerId: string): Promise<Counters> {
    let rows: { counters: Counters }[];
    try {
      rows = (await restRequest(this.auth, `player_awards?select=counters&${this.mine}&player_id=eq.${encodeURIComponent(playerId)}`, {}, this.fetchFn)) as { counters: Counters }[];
    } catch (err) {
      // 404: the table hasn't been made yet, which just means nothing was credited.
      if (err instanceof OnlineError && err.status === 404) return {};
      throw err;
    }
    const out: Counters = {};
    for (const [k, v] of Object.entries(rows[0]?.counters ?? {})) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    return out;
  }

  // The last player used is remembered per device and per account.
  private get currentKey() {
    return `backroom-poker-current-${this.auth.current?.userId ?? 'none'}`;
  }

  async currentId(): Promise<string | null> {
    try {
      return this.storage?.getItem(this.currentKey) || null;
    } catch {
      return null;
    }
  }

  async setCurrentId(id: string | null): Promise<void> {
    try {
      this.storage?.setItem(this.currentKey, id ?? '');
    } catch {
      /* fine: the most recent player opens instead */
    }
  }
}
