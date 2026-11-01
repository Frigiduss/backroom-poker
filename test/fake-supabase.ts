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
  /** supabase/crashes.sql, much simplified: one row per report_crash() call, and who sent it. */
  crashes: { id: number; message: string; stack: string; games: string[]; browsers: string[]; builds: string[]; account: string | null; fixed_at: string | null; last_at: string; sender: string }[] = [];
  /** daily_bonus rows by `owner/player`, as supabase/leaderboard.sql keeps them. Null until set up. */
  bonus: Map<string, { last: number; streak: number }> | null = new Map();
  /** weekly_challenges rows as `owner/week/slot`, as supabase/challenges.sql keeps them. Null until set up. */
  weekly: Set<string> | null = new Set();
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

  /** supabase/friends.sql: friend codes and last-seen times by user id, links "from>to", invites by "from>to". Null until set up. */
  friendAccounts: Map<string, { code: string; seen: number }> | null = new Map();
  friendLinks = new Map<string, { declined: boolean; hidden: boolean; at: number }>();
  invites = new Map<string, { code: string; game: string; variant?: string; structure?: string; at: number }>();
  /** Table codes each user is at, standing in for poker_views (code → user ids). */
  seated = new Map<string, { users: string[]; game: string; variant?: string; structure?: string }>();

  /** supabase/gifts.sql: every gift sent. Null until set up. */
  gifts: { from: string; to: string; amount: number; at: number; collected: boolean }[] | null = [];
  /** supabase/avatars.sql: uploaded pictures by name, and accounts blocked from uploading. Null until set up. */
  pictures: Map<string, { owner: string; bytes: number; type: string }> | null = new Map();
  pictureBlocked = new Set<string>();

  /** Authenticator apps by user id. The right code is always 246810. */
  factors = new Map<string, { id: string; status: 'verified' | 'unverified' }[]>();
  /** Access tokens that finished two-step sign-in. */
  aal2 = new Set<string>();
  private challenges = new Map<string, string>();

  /** Access tokens look like JWTs, with the `aal` claim the game reads. */
  private session(userId: string, email: string, aal = 'aal1') {
    const access = `h.${Buffer.from(JSON.stringify({ aal })).toString('base64url')}.at-${++this.n}`;
    const refresh = `rt-${this.n}`;
    this.tokens.set(access, userId);
    if (aal === 'aal2') this.aal2.add(access);
    this.refreshTokens.set(refresh, `${userId}|${aal}`);
    return { access_token: access, refresh_token: refresh, expires_in: this.expiresIn, token_type: 'bearer', user: { id: userId, email } };
  }

  /** What the real server's mfa_ok() says for this token. */
  private mfaOk(token: string, uid: string) {
    return this.aal2.has(token) || !(this.factors.get(uid) ?? []).some((f) => f.status === 'verified');
  }

  private emailOf(id: string) {
    return [...this.users].find(([, u]) => u.id === id)?.[0] ?? '';
  }

  handle(method: string, url: string, headers: Record<string, string>, bodyText: string | null, blob?: Blob): FakeReply {
    const u = new URL(url);
    this.calls.push(`${method} ${u.pathname}${u.search}`);
    if (u.pathname.startsWith('/storage/v1/object/') && !this.pictures) return { status: 400, body: { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' } };
    if (u.pathname.startsWith('/storage/v1/object/') && this.pictures && u.pathname !== '/storage/v1/object/list/avatars') {
      const uidS = this.tokens.get((headers.authorization ?? headers.Authorization ?? '').replace(/^Bearer /, ''));
      const isAdmin = !!uidS && this.admins.has(uidS);
      return this.storage(method, u.pathname, uidS, isAdmin, headers, blob ?? bodyText);
    }
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
      const [id, aal] = owner.split('|');
      return { status: 200, body: this.session(id, this.emailOf(id), aal) };
    }
    if (p === '/auth/v1/user') {
      if (!uid) return { status: 401, body: { msg: 'invalid JWT' } };
      if (method === 'PUT') {
        if (!this.mfaOk(bearer, uid)) return { status: 401, body: { error_code: 'insufficient_aal', msg: 'AAL2 required' } };
        this.users.get(this.emailOf(uid))!.password = body.password;
      }
      const factors = (this.factors.get(uid) ?? []).map((f) => ({ id: f.id, factor_type: 'totp', status: f.status, friendly_name: 'app' }));
      return { status: 200, body: { id: uid, email: this.emailOf(uid), ...(factors.length ? { factors } : {}) } };
    }
    if (p === '/auth/v1/logout') {
      if (u.searchParams.get('scope') === 'global' && uid) {
        for (const [t, id] of [...this.tokens]) if (id === uid) this.tokens.delete(t);
        for (const [t, id] of [...this.refreshTokens]) if (id.startsWith(`${uid}|`)) this.refreshTokens.delete(t);
      } else this.tokens.delete(bearer);
      return { status: 204 };
    }
    const factorPath = /^\/auth\/v1\/factors(?:\/([^/]+))?(?:\/(challenge|verify))?$/.exec(p);
    if (factorPath) {
      if (!uid) return { status: 401, body: { msg: 'invalid JWT' } };
      const list = this.factors.get(uid) ?? [];
      this.factors.set(uid, list);
      const [, fid, step] = factorPath;
      const f = list.find((x) => x.id === fid);
      if (!fid && method === 'POST') {
        const id = `factor-${++this.n}`;
        list.push({ id, status: 'unverified' });
        return { status: 200, body: { id, type: 'totp', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg xmlns="http://www.w3.org/2000/svg"><path fill="#000" d="M0 0h1v1z"/></svg>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' } } };
      }
      if (!f) return { status: 404, body: { error_code: 'mfa_factor_not_found', msg: 'Factor not found' } };
      if (step === 'challenge') {
        const id = `ch-${++this.n}`;
        this.challenges.set(id, f.id);
        return { status: 200, body: { id, expires_at: 0 } };
      }
      if (step === 'verify') {
        if (this.challenges.get(body.challenge_id) !== f.id) return { status: 422, body: { error_code: 'mfa_challenge_expired', msg: 'Challenge expired' } };
        if (body.code !== '246810') return { status: 422, body: { error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' } };
        f.status = 'verified';
        return { status: 200, body: this.session(uid, this.emailOf(uid), 'aal2') };
      }
      if (method === 'DELETE') {
        if (f.status === 'verified' && !this.aal2.has(bearer)) return { status: 401, body: { error_code: 'insufficient_aal', msg: 'AAL2 required' } };
        list.splice(list.indexOf(f), 1);
        return { status: 200, body: { id: f.id } };
      }
    }
    if (p === '/auth/v1/recover') return { status: 200, body: {} };

    const prefer = headers.Prefer ?? headers.prefer ?? '';
    const admin = !!uid && this.admins.has(uid) && this.mfaOk(bearer, uid);
    const denied = { status: 403, body: { code: '42501', message: 'permission denied' } };

    if (p === '/rest/v1/players') {
      if (!uid) return { status: 401, body: { code: 'PGRST301', message: 'JWT expired' } };
      // The restrictive "two-step sign-in finished" policy: no rows, and no writes.
      if (!this.mfaOk(bearer, uid)) return method === 'GET' ? { status: 200, body: [] } : { status: 403, body: { code: '42501', message: 'new row violates row-level security policy for table "players"' } };
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
    if (p === '/rest/v1/rpc/claim_challenge' && this.weekly) {
      if (!uid) return denied;
      if (!this.rows.some((r) => r.id === body.p_player && r.owner === uid)) return { status: 403, body: { code: '42501', message: "That player isn't in your account." } };
      const slot = Number(body.p_slot);
      if (![0, 1, 2].includes(slot)) return { status: 400, body: { code: 'P0001', message: "There's no such challenge." } };
      const week = Math.floor((Math.floor((this.now ?? Date.now()) / 86_400_000) + 3) / 7);
      if (body.p_week !== week) return { status: 400, body: { code: 'P0001', message: "That week's challenges are over. Have a look at the new ones." } };
      const key = `${uid}/${week}/${slot}`;
      if (this.weekly.has(key)) return { status: 200, body: { amount: 0, week, slot } };
      this.weekly.add(key);
      return { status: 200, body: { amount: [2500, 5000, 10000][slot], week, slot } };
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
            rank: x.rank, name: x.d.name, color: x.d.color, avatar: (x.d as { avatar?: string }).avatar ?? null, value: x.value, mine: !!uid && x.r.owner === uid,
            title: x.d.title && x.d.achievements?.unlocked && x.d.title in x.d.achievements.unlocked ? x.d.title : null,
          })),
      };
    }
    if (p.startsWith('/rest/v1/rpc/friends_') && this.friendAccounts) return this.friends(p.slice('/rest/v1/rpc/'.length), uid, bearer, body);
    if (['/rest/v1/rpc/send_chips', '/rest/v1/rpc/gifts_sync', '/rest/v1/rpc/collect_gifts'].includes(p) && this.gifts && this.friendAccounts) {
      return this.chipGifts(p.slice('/rest/v1/rpc/'.length), uid, bearer, body);
    }
    if (p.startsWith('/storage/v1/object/') && this.pictures) return this.storage(method, p, uid, admin, headers, bodyText);
    if (p === '/rest/v1/avatar_blocked') {
      if (!admin) return denied;
      if (method === 'POST') this.pictureBlocked.add(body.owner);
      if (method === 'DELETE') this.pictureBlocked.delete(u.searchParams.get('owner')?.replace(/^eq\./, '') ?? '');
      return { status: 201 };
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
    if (p === '/rest/v1/rpc/report_crash') {
      this.crashes.push({
        id: this.crashes.length + 1, message: String(body.p_message).slice(0, 300), stack: String(body.p_stack ?? ''),
        games: [body.p_game], browsers: [body.p_browser], builds: [body.p_build], account: uid || null, fixed_at: null,
        last_at: new Date().toISOString(), sender: uid ? 'account' : bearer === 'anon-key' ? 'visitor' : 'bad token',
      });
      return { status: 204 };
    }
    if (p === '/rest/v1/crash_reports') {
      if (!admin) return method === 'GET' ? { status: 200, body: [] } : { status: 204 };
      const idEq = Number(u.searchParams.get('id')?.replace(/^eq\./, '') ?? NaN);
      const fixedOnly = u.searchParams.get('fixed_at') === 'not.is.null';
      const hit = this.crashes.filter((c) => (Number.isNaN(idEq) || c.id === idEq) && (!fixedOnly || c.fixed_at));
      if (method === 'GET') return { status: 200, body: hit.map(({ sender: _s, ...c }) => ({ ...c, count: 1, people: 1, first_at: c.last_at })) };
      if (method === 'PATCH') for (const c of hit) c.fixed_at = body.fixed_at;
      if (method === 'DELETE') this.crashes = this.crashes.filter((c) => !hit.includes(c));
      return { status: 204 };
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

  /** The friend code of a user, made on first use like friend_code_of(). */
  friendCode(uid: string): string {
    const fa = this.friendAccounts!;
    let a = fa.get(uid);
    if (!a) {
      const n = fa.size + 1;
      const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      a = { code: `K${A[n % 32]}${A[(n * 7 + 3) % 32]}7M${A[(n * 13 + 5) % 32]}`, seen: 0 };
      fa.set(uid, a);
    }
    return a.code;
  }

  private friends(fn: string, uid: string | undefined, bearer: string, body: Record<string, unknown>): FakeReply {
    if (!uid) return { status: 401, body: { code: '42501', message: 'Sign in to an online account to use friends.' } };
    if (!this.mfaOk(bearer, uid)) return { status: 403, body: { code: '42501', message: 'Finish two-step sign-in first.' } };
    const fa = this.friendAccounts!;
    const now = this.now ?? Date.now();
    const bad = (message: string, status = 400) => ({ status, body: { code: 'P0001', message } });
    const byCode = (c: unknown) => [...fa].find(([, a]) => a.code === String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''))?.[0];
    const link = (a: string, b: string) => this.friendLinks.get(`${a}>${b}`);
    const friends = (a: string, b: string) => !!link(a, b) && !!link(b, a);
    const card = (u: string) => {
      const row = this.rows.filter((r) => r.owner === u).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
      const d = (row?.data ?? {}) as { name?: string; color?: string; avatar?: string; title?: string; achievements?: { unlocked?: Record<string, unknown> } };
      return { name: (d.name || 'Player').slice(0, 14), color: d.color ?? null, avatar: d.avatar ?? null, title: d.title && d.achievements?.unlocked && d.title in d.achievements.unlocked ? d.title : null };
    };
    const mine = this.friendCode(uid);
    if (fn === 'friends_sync') {
      fa.get(uid)!.seen = now;
      for (const [k, i] of [...this.invites]) if (i.at < now - 15 * 60_000) this.invites.delete(k);
      const users = [...fa.keys()].filter((u) => u !== uid);
      return {
        status: 200,
        body: {
          code: mine,
          friends: users.filter((u) => friends(uid, u)).sort((a, b) => fa.get(b)!.seen - fa.get(a)!.seen)
            .map((u) => ({ ...card(u), code: fa.get(u)!.code, online: fa.get(u)!.seen > now - 75_000, seen: fa.get(u)!.seen })),
          incoming: users.filter((u) => link(u, uid) && !link(u, uid)!.declined && !link(uid, u)).map((u) => ({ ...card(u), code: fa.get(u)!.code })),
          outgoing: users.filter((u) => link(uid, u) && !link(uid, u)!.hidden && !link(u, uid)).map((u) => ({ ...card(u), code: fa.get(u)!.code })),
          invites: users.filter((u) => this.invites.has(`${u}>${uid}`) && friends(uid, u)).map((u) => {
            const i = this.invites.get(`${u}>${uid}`)!;
            return { from: fa.get(u)!.code, name: card(u).name, color: card(u).color, table: i.code, game: i.game, variant: i.variant ?? null, structure: i.structure ?? null, at: i.at };
          }),
        },
      };
    }
    const them = byCode(body.p_code);
    if (!them) return bad(`No player has the friend code ${String(body.p_code ?? '') || '(blank)'}. Check it with your friend.`);
    if (fn === 'friends_add') {
      if (them === uid) return bad("That's your own friend code. Send it to a friend so they can add you.");
      if (!link(uid, them)) this.friendLinks.set(`${uid}>${them}`, { declined: false, hidden: false, at: now });
      link(uid, them)!.hidden = false;
      if (link(them, uid)) {
        link(them, uid)!.declined = false;
        return { status: 200, body: { status: 'friends', name: card(them).name } };
      }
      return { status: 200, body: { status: 'requested', name: card(them).name } };
    }
    if (fn === 'friends_answer') {
      if (!link(them, uid)) return bad("That friend request isn't there any more.");
      if (body.p_accept) {
        if (!link(uid, them)) this.friendLinks.set(`${uid}>${them}`, { declined: false, hidden: false, at: now });
        link(them, uid)!.declined = false;
      } else link(them, uid)!.declined = true;
      return { status: 204 };
    }
    if (fn === 'friends_remove') {
      if (link(uid, them)?.declined) link(uid, them)!.hidden = true;
      else {
        this.friendLinks.delete(`${uid}>${them}`);
        this.friendLinks.delete(`${them}>${uid}`);
      }
      this.invites.delete(`${uid}>${them}`);
      this.invites.delete(`${them}>${uid}`);
      return { status: 204 };
    }
    if (fn === 'friends_invite') {
      if (!friends(uid, them)) return { status: 403, body: { code: '42501', message: 'You can only invite friends to a table.' } };
      const code = String(body.p_table ?? '').toUpperCase();
      const t = this.seated.get(code);
      if (!t || !t.users.includes(uid)) return { status: 403, body: { code: '42501', message: "You can only invite friends to a table you're at." } };
      this.invites.set(`${uid}>${them}`, { code, game: t.game, variant: t.variant, structure: t.structure, at: now });
      return { status: 204 };
    }
    if (fn === 'friends_dismiss') {
      this.invites.delete(`${them}>${uid}`);
      return { status: 204 };
    }
    return { status: 404, body: { code: 'PGRST202', message: `no function ${fn}` } };
  }

  /** send_chips, gifts_sync and collect_gifts from supabase/gifts.sql. */
  private chipGifts(fn: string, uid: string | undefined, bearer: string, body: Record<string, unknown>): FakeReply {
    if (!uid) return { status: 401, body: { code: '42501', message: 'Sign in to an online account to use friends.' } };
    if (!this.mfaOk(bearer, uid)) return { status: 403, body: { code: '42501', message: 'Finish two-step sign-in first.' } };
    const gifts = this.gifts!;
    const fa = this.friendAccounts!;
    const now = this.now ?? Date.now();
    const bad = (message: string, status = 400) => ({ status, body: { code: 'P0001', message } });
    const day = (pick: (g: (typeof gifts)[number]) => boolean) => gifts.filter((g) => pick(g) && g.at > now - 86_400_000).reduce((t, g) => t + g.amount, 0);
    const nameOf = (u: string) => {
      const row = this.rows.filter((r) => r.owner === u).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
      return ((row?.data as { name?: string })?.name || 'Player').slice(0, 14);
    };
    this.friendCode(uid);
    if (fn === 'gifts_sync') {
      return {
        status: 200,
        body: {
          waiting: gifts.filter((g) => g.to === uid && !g.collected).sort((a, b) => b.at - a.at).map((g) => {
            const d = (this.rows.find((r) => r.owner === g.from)?.data ?? {}) as { color?: string; avatar?: string };
            return { from: fa.get(g.from)?.code, name: nameOf(g.from), color: d.color ?? null, avatar: d.avatar ?? null, amount: g.amount, at: g.at };
          }),
          left: Math.max(0, 10000 - day((g) => g.from === uid)),
        },
      };
    }
    const row = this.rows.find((r) => r.id === body.p_player && r.owner === uid);
    if (!row) return { status: 403, body: { code: '42501', message: "That player isn't in your account." } };
    const d = row.data as { bank?: number; table?: unknown; stats?: { hands?: number } };
    if (fn === 'collect_gifts') {
      const taken = gifts.filter((g) => g.to === uid && !g.collected);
      for (const g of taken) g.collected = true;
      return { status: 200, body: { amount: taken.reduce((t, g) => t + g.amount, 0), gifts: taken.map((g) => ({ name: nameOf(g.from), amount: g.amount })) } };
    }
    const them = [...fa].find(([, a]) => a.code === String(body.p_code ?? ''))?.[0];
    if (!them) return bad(`No player has the friend code ${String(body.p_code ?? '')}. Check it with your friend.`);
    if (them === uid) return bad("You can't send chips to yourself.");
    if (!(this.friendLinks.has(`${uid}>${them}`) && this.friendLinks.has(`${them}>${uid}`))) return { status: 403, body: { code: '42501', message: 'You can only send chips to a friend.' } };
    const amount = Number(body.p_amount);
    if (!(amount >= 100)) return bad('Send at least 100 chips.');
    if (amount > 10000) return bad('A gift can be at most 10,000 chips.');
    const sent = day((g) => g.from === uid);
    if (sent + amount > 10000) return bad(`You can send ${(10000 - sent).toLocaleString('en-US')} more chips today (10,000 a day).`);
    const got = day((g) => g.to === them);
    if (got + amount > 20000) return bad(`${nameOf(them)} can only be sent ${(20000 - got).toLocaleString('en-US')} more chips today (20,000 a day).`);
    if (d.table) return bad('Leave your table first. Gifts come out of your bank.');
    if ((d.stats?.hands ?? 0) < 10) return bad('Play 10 hands before sending chips.');
    const bank = Math.floor(d.bank ?? 0);
    if (bank < amount) return bad(`Your bank only has ${bank.toLocaleString('en-US')} chips.`);
    row.data = { ...d, bank: bank - amount };
    gifts.push({ from: uid, to: them, amount, at: now, collected: false });
    return { status: 200, body: { amount, bank: bank - amount, left: 10000 - sent - amount, name: nameOf(them) } };
  }

  /** The `avatars` bucket with the rules from supabase/avatars.sql. */
  private storage(method: string, p: string, uid: string | undefined, admin: boolean, headers: Record<string, string>, body: unknown): FakeReply {
    const pics = this.pictures!;
    if (p === '/storage/v1/object/list/avatars') {
      return { status: 200, body: [...pics].filter(([, x]) => x.owner === uid || admin).map(([name]) => ({ name })) };
    }
    const m = /^\/storage\/v1\/object\/(public\/)?avatars\/(.+)$/.exec(p);
    if (!m) return { status: 400, body: { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' } };
    const name = m[2];
    if (method === 'GET') return pics.has(name) ? { status: 200, body: 'jpeg' } : { status: 400, body: { statusCode: '404', message: 'Object not found' } };
    if (!uid) return { status: 400, body: { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' } };
    if (method === 'DELETE') {
      const x = pics.get(name);
      if (!x || (x.owner !== uid && !admin)) return { status: 400, body: { statusCode: '404', message: 'Object not found' } };
      pics.delete(name);
      return { status: 200, body: [{ name }] };
    }
    const type = headers['Content-Type'] ?? headers['content-type'] ?? '';
    const bytes = typeof body === 'string' ? body.length : (body as { size?: number })?.size ?? 0;
    if (type !== 'image/jpeg') return { status: 400, body: { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${type} is not supported` } };
    if (bytes > 65536) return { status: 400, body: { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' } };
    const count = [...pics.values()].filter((x) => x.owner === uid).length;
    if (!/^[0-9a-f]{32}\.jpg$/.test(name) || this.pictureBlocked.has(uid) || count >= 3) {
      return { status: 400, body: { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' } };
    }
    if (pics.has(name)) return { status: 400, body: { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' } };
    pics.set(name, { owner: uid, bytes, type });
    return { status: 200, body: { Key: `avatars/${name}` } };
  }

  /** A fetch function that answers from this fake. */
  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    if (this.offline) throw new TypeError('Failed to fetch');
    // Uploads send a Blob; the fake only needs its size.
    const raw = init.body as unknown;
    const bodyText = raw instanceof Blob ? 'x'.repeat(raw.size) : (raw as string) ?? null;
    const r = String(input).includes('/storage/v1/object/') && raw instanceof Blob
      ? this.handle(init.method ?? 'GET', String(input), (init.headers ?? {}) as Record<string, string>, null, raw)
      : this.handle(init.method ?? 'GET', String(input), (init.headers ?? {}) as Record<string, string>, bodyText);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  };
}
