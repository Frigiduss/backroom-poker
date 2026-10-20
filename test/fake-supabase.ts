// A tiny in-memory stand-in for the parts of Supabase the game uses (email sign-in and
// the `players` table with owner-only access, plus the admin rules from admin.sql), for testing
// without a real project.

interface Row { id: string; owner: string; data: unknown; updated_at: string }

export interface FakeReply { status: number; body?: unknown }

export class FakeSupabase {
  users = new Map<string, { id: string; password: string; confirmed: boolean }>();
  tokens = new Map<string, string>();
  refreshTokens = new Map<string, string>();
  rows: Row[] = [];
  /** User ids in the admins table. */
  admins = new Set<string>();
  site = new Map<string, unknown>();
  log: { at: string; admin: string; action: string; detail: unknown }[] = [];
  /** daily_bonus rows by `owner/player`, as supabase/leaderboard.sql keeps them. Null until set up. */
  bonus: Map<string, { last: number; streak: number }> | null = new Map();
  /** Player ids an admin took off the leaderboard. */
  hidden = new Set<string>();
  /** The server's clock (epoch ms); defaults to the real time. */
  now: number | null = null;
  /** Seconds a new access token lasts. */
  expiresIn = 3600;
  requireConfirm = false;
  offline = false;
  calls: string[] = [];
  private n = 0;

  private session(userId: string, email: string) {
    const access = `at-${++this.n}`;
    const refresh = `rt-${this.n}`;
    this.tokens.set(access, userId);
    this.refreshTokens.set(refresh, userId);
    return { access_token: access, refresh_token: refresh, expires_in: this.expiresIn, token_type: 'bearer', user: { id: userId, email } };
  }

  private emailOf(id: string) {
    return [...this.users].find(([, u]) => u.id === id)?.[0] ?? '';
  }

  handle(method: string, url: string, headers: Record<string, string>, bodyText: string | null): FakeReply {
    const u = new URL(url);
    this.calls.push(`${method} ${u.pathname}${u.search}`);
    const body = bodyText ? JSON.parse(bodyText) : {};
    const bearer = (headers.authorization ?? headers.Authorization ?? '').replace(/^Bearer /, '');
    const uid = this.tokens.get(bearer);
    const p = u.pathname;

    if (p === '/auth/v1/signup') {
      if (this.users.has(body.email)) return { status: 422, body: { error_code: 'user_already_exists', msg: 'User already registered' } };
      const id = `user-${++this.n}`;
      this.users.set(body.email, { id, password: body.password, confirmed: !this.requireConfirm });
      return { status: 200, body: this.requireConfirm ? { id, email: body.email } : this.session(id, body.email) };
    }
    if (p === '/auth/v1/token') {
      const grant = u.searchParams.get('grant_type');
      if (grant === 'password') {
        const user = this.users.get(body.email);
        if (!user || user.password !== body.password) return { status: 400, body: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' } };
        if (!user.confirmed) return { status: 400, body: { error_code: 'email_not_confirmed', msg: 'Email not confirmed' } };
        return { status: 200, body: this.session(user.id, body.email) };
      }
      const owner = this.refreshTokens.get(body.refresh_token);
      if (!owner) return { status: 400, body: { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' } };
      this.refreshTokens.delete(body.refresh_token);
      return { status: 200, body: this.session(owner, this.emailOf(owner)) };
    }
    if (p === '/auth/v1/user') {
      if (!uid) return { status: 401, body: { msg: 'invalid JWT' } };
      if (method === 'PUT') this.users.get(this.emailOf(uid))!.password = body.password;
      return { status: 200, body: { id: uid, email: this.emailOf(uid) } };
    }
    if (p === '/auth/v1/logout') {
      this.tokens.delete(bearer);
      return { status: 204 };
    }
    if (p === '/auth/v1/recover') return { status: 200, body: {} };

    const prefer = headers.Prefer ?? headers.prefer ?? '';
    const admin = !!uid && this.admins.has(uid);
    const denied = { status: 403, body: { code: '42501', message: 'permission denied' } };

    if (p === '/rest/v1/players') {
      if (!uid) return { status: 401, body: { code: 'PGRST301', message: 'JWT expired' } };
      const idEq = u.searchParams.get('id')?.replace(/^eq\./, '');
      const ownerEq = u.searchParams.get('owner')?.replace(/^eq\./, '');
      // Row security: your own rows, or every row for an admin (supabase/admin.sql).
      const visible = this.rows.filter((r) => (r.owner === uid || admin) && (!idEq || r.id === idEq) && (!ownerEq || r.owner === ownerEq));
      if (method === 'GET') {
        const withOwner = (u.searchParams.get('select') ?? '').includes('owner');
        return { status: 200, body: [...visible].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((r) => (withOwner ? { ...r } : { id: r.id, data: r.data })) };
      }
      if (method === 'POST') {
        const existing = this.rows.find((r) => r.id === body.id);
        if (existing && existing.owner !== uid && !admin) return { status: 403, body: { code: '42501', message: 'new row violates row-level security policy for table "players"' } };
        if (existing) Object.assign(existing, { data: body.data, updated_at: body.updated_at });
        else this.rows.push({ id: body.id, owner: uid, data: body.data, updated_at: body.updated_at });
        return { status: 201 };
      }
      if (method === 'PATCH') {
        for (const r of visible) Object.assign(r, body);
        return prefer.includes('return=representation') ? { status: 200, body: visible } : { status: 204 };
      }
      if (method === 'DELETE') {
        this.rows = this.rows.filter((r) => !visible.includes(r));
        return prefer.includes('return=representation') ? { status: 200, body: visible } : { status: 204 };
      }
    }
    if (p === '/rest/v1/rpc/is_admin') return uid ? { status: 200, body: admin } : denied;
    if (p === '/rest/v1/rpc/admin_accounts') {
      if (!admin) return { status: 403, body: { code: '42501', message: 'Only admins can list accounts.' } };
      return {
        status: 200,
        body: [...this.users].map(([email, x]) => ({
          id: x.id, email, created_at: '2026-10-20T00:00:00Z', last_sign_in_at: null,
          players: this.rows.filter((r) => r.owner === x.id).length, admin: this.admins.has(x.id),
        })),
      };
    }
    if (p === '/rest/v1/rpc/claim_daily_bonus' && this.bonus) {
      if (!uid) return denied;
      if (!this.rows.some((r) => r.id === body.p_player && r.owner === uid)) return { status: 403, body: { code: '42501', message: "That player isn't in your account." } };
      const now = this.now ?? Date.now();
      const key = `${uid}/${body.p_player}`;
      const b = this.bonus.get(key);
      if (b && b.last > now - 20 * 3_600_000) return { status: 200, body: { amount: 0, streak: b.streak, last: b.last } };
      const day = b && b.last >= now - 48 * 3_600_000 ? b.streak + 1 : 1;
      this.bonus.set(key, { last: now, streak: day });
      return { status: 200, body: { amount: 1000 + 500 * (Math.min(day, 7) - 1), streak: day, last: now } };
    }
    if (p === '/rest/v1/rpc/leaderboard' && this.bonus) {
      const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
      type D = { name?: string; color?: string; title?: string; bank?: unknown; stats?: { hands?: unknown; biggestPot?: unknown }; settings?: { leaderboard?: unknown }; achievements?: { unlocked?: Record<string, unknown>; counters?: Record<string, unknown> } };
      const scored = this.rows.map((r) => {
        const d = r.data as D;
        const value = body.p_board === 'bank' ? num(d.bank) : body.p_board === 'pot' ? num(d.stats?.biggestPot) : Object.keys(d.achievements?.unlocked ?? {}).length;
        return { r, d, value };
      }).filter(({ r, d, value }) => !this.hidden.has(r.id) && d.settings?.leaderboard !== false && num(d.stats?.hands) + num(d.achievements?.counters?.['bj.hands']) >= 10 && value > 0)
        .sort((a, b) => b.value - a.value || a.r.id.localeCompare(b.r.id));
      const limit = Math.min(Math.max(Number(body.p_limit ?? 25), 1), 100);
      return {
        status: 200,
        body: scored.map((x, i) => ({ ...x, rank: scored.findIndex((y) => y.value === x.value) + 1, rn: i + 1 }))
          .filter((x) => x.rn <= limit || x.r.owner === uid)
          .map((x) => ({
            rank: x.rank, name: x.d.name, color: x.d.color, value: x.value, mine: !!uid && x.r.owner === uid,
            title: x.d.title && x.d.achievements?.unlocked && x.d.title in x.d.achievements.unlocked ? x.d.title : null,
          })),
      };
    }
    if (p === '/rest/v1/leaderboard_hidden') {
      if (!admin) return denied;
      if (method === 'POST') this.hidden.add(body.player_id);
      if (method === 'DELETE') this.hidden.delete(u.searchParams.get('player_id')?.replace(/^eq\./, '') ?? '');
      return { status: 201 };
    }
    if (p === '/rest/v1/site') {
      const keyEq = u.searchParams.get('key')?.replace(/^eq\./, '');
      if (method === 'GET') return { status: 200, body: [...this.site].filter(([k]) => !keyEq || k === keyEq).map(([key, value]) => ({ key, value })) };
      if (!admin) return { status: 403, body: { code: '42501', message: 'new row violates row-level security policy for table "site"' } };
      if (method === 'POST') this.site.set(body.key, body.value);
      if (method === 'DELETE' && keyEq) this.site.delete(keyEq);
      return { status: 201 };
    }
    if (p === '/rest/v1/admin_log') {
      if (!admin) return method === 'GET' ? { status: 200, body: [] } : denied;
      if (method === 'POST') {
        this.log.unshift({ at: new Date().toISOString(), admin: uid, action: body.action, detail: body.detail });
        return { status: 201 };
      }
      return { status: 200, body: this.log.slice(0, Number(u.searchParams.get('limit') ?? 20)) };
    }
    return { status: 404, body: { message: `no route ${method} ${p}` } };
  }

  /** A fetch function that answers from this fake. */
  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    if (this.offline) throw new TypeError('Failed to fetch');
    const r = this.handle(init.method ?? 'GET', String(input), (init.headers ?? {}) as Record<string, string>, (init.body as string) ?? null);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  };
}
