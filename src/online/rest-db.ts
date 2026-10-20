// TableDb on Supabase's REST API, used by the Edge Function with the project's service key.
// The browser never uses this: it can't read poker_tables at all (supabase/multiplayer.sql).
import { Counters } from '../accounts/achievements';
import { AwardCounters, AwardCredit, StoredView, TableDb, TableRow, TableState } from './server';

type Fetch = typeof fetch;

export class RestTableDb implements TableDb {
  constructor(private readonly url: string, private readonly key: string, private readonly fetchFn: Fetch = (...a) => fetch(...a)) {}

  private async call(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<{ status: number; data: unknown }> {
    const res = await this.fetchFn(`${this.url}/rest/v1/${path}`, {
      method: init.method ?? 'GET',
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        ...(init.prefer ? { Prefer: init.prefer } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok && res.status !== 409) throw new Error(`Database error ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    return { status: res.status, data };
  }

  private async one(query: string): Promise<TableRow | null> {
    const { data } = await this.call(`poker_tables?select=id,code,version,state&${query}`);
    return (data as TableRow[])[0] ?? null;
  }

  byId(id: string) {
    return /^[0-9a-f-]{36}$/i.test(id) ? this.one(`id=eq.${id}`) : Promise.resolve(null);
  }

  byCode(code: string) {
    return /^[A-Z0-9]{1,12}$/.test(code) ? this.one(`code=eq.${code}`) : Promise.resolve(null);
  }

  async insert(code: string, state: TableState): Promise<TableRow | null> {
    const { status, data } = await this.call('poker_tables?select=id,code,version,state', {
      method: 'POST', body: { code, state, version: 0 }, prefer: 'return=representation',
    });
    if (status === 409) return null;
    return (data as TableRow[])[0] ?? null;
  }

  async update(id: string, version: number, state: TableState): Promise<boolean> {
    const { data } = await this.call(`poker_tables?id=eq.${id}&version=eq.${version}&select=id`, {
      method: 'PATCH', body: { state, version: version + 1, updated_at: new Date().toISOString() }, prefer: 'return=representation',
    });
    return Array.isArray(data) && data.length === 1;
  }

  async remove(id: string): Promise<void> {
    await this.call(`poker_tables?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
  }

  async putViews(tableId: string, views: StoredView[]): Promise<void> {
    if (!views.length) return;
    await this.call('rpc/put_poker_views', {
      method: 'POST', body: { p_table: tableId, p_views: views.map((v) => ({ user_id: v.userId, version: v.version, view: v.view })) },
    });
  }

  async dropView(tableId: string, userId: string): Promise<void> {
    await this.call(`poker_views?table_id=eq.${tableId}&user_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE', prefer: 'return=minimal' });
  }

  async sweep(before: Date): Promise<void> {
    await this.call(`poker_tables?updated_at=lt.${encodeURIComponent(before.toISOString())}`, { method: 'DELETE', prefer: 'return=minimal' });
  }

  async awards(userId: string, playerId: string): Promise<AwardCounters> {
    const q = `owner=eq.${encodeURIComponent(userId)}`;
    const id = encodeURIComponent(playerId);
    const [server, profile] = await Promise.all([
      // No player_awards table yet (supabase/achievements.sql not run) just means nothing credited.
      this.call(`player_awards?select=counters&${q}&player_id=eq.${id}`).catch(() => ({ data: [] })),
      this.call(`players?select=counters:data->achievements->counters&${q}&id=eq.${id}`),
    ]);
    const first = (d: unknown): Counters => {
      const c = Array.isArray(d) ? (d[0] as { counters?: unknown } | undefined)?.counters : null;
      return c && typeof c === 'object' ? (c as Counters) : {};
    };
    return { server: first(server.data), profile: first(profile.data) };
  }

  async creditAwards(credits: AwardCredit[]): Promise<void> {
    if (!credits.length) return;
    await this.call('rpc/credit_awards', {
      method: 'POST',
      body: { p_credits: credits.map((c) => ({ owner: c.userId, player_id: c.playerId, sum: c.tally.sum, max: c.tally.max })) },
    });
  }
}
