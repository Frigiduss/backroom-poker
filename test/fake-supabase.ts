// A tiny in-memory stand-in for the parts of Supabase the game uses (email sign-in and
// the `players` table with owner-only access), for testing without a real project.

interface Row { id: string; owner: string; data: unknown; updated_at: string }

export interface FakeReply { status: number; body?: unknown }

export class FakeSupabase {
  users = new Map<string, { id: string; password: string; confirmed: boolean }>();
  tokens = new Map<string, string>();
  refreshTokens = new Map<string, string>();
  rows: Row[] = [];
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

    if (p === '/rest/v1/players') {
      if (!uid) return { status: 401, body: { code: 'PGRST301', message: 'JWT expired' } };
      const idEq = u.searchParams.get('id')?.replace(/^eq\./, '');
      const mine = this.rows.filter((r) => r.owner === uid && (!idEq || r.id === idEq));
      if (method === 'GET') {
        return { status: 200, body: [...mine].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((r) => ({ id: r.id, data: r.data })) };
      }
      if (method === 'POST') {
        const existing = this.rows.find((r) => r.id === body.id);
        if (existing && existing.owner !== uid) return { status: 403, body: { code: '42501', message: 'new row violates row-level security policy for table "players"' } };
        if (existing) Object.assign(existing, { data: body.data, updated_at: body.updated_at });
        else this.rows.push({ id: body.id, owner: uid, data: body.data, updated_at: body.updated_at });
        return { status: 201 };
      }
      if (method === 'DELETE') {
        this.rows = this.rows.filter((r) => !mine.includes(r));
        return { status: 204 };
      }
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
