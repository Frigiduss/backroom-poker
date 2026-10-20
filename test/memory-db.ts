// The in-memory table store the server tests share, with the same compare-and-save rule as the real database.
import { Counters } from '../src/accounts/achievements';
import { TableView } from '../src/online/protocol';
import { AwardCredit, StoredView, TableDb, TableRow, TableState } from '../src/online/server';

export class MemoryDb implements TableDb {
  rows = new Map<string, TableRow>();
  views = new Map<string, StoredView>();
  private n = 0;
  async byId(id: string) {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }
  async byCode(code: string) {
    const r = [...this.rows.values()].find((x) => x.code === code);
    return r ? structuredClone(r) : null;
  }
  async insert(code: string, state: TableState) {
    if ([...this.rows.values()].some((x) => x.code === code)) return null;
    const row = { id: `00000000-0000-0000-0000-${String(++this.n).padStart(12, '0')}`, code, version: 0, state: structuredClone(state) };
    this.rows.set(row.id, row);
    return structuredClone(row);
  }
  async update(id: string, version: number, state: TableState) {
    const r = this.rows.get(id);
    if (!r || r.version !== version) return false;
    this.rows.set(id, { ...r, version: version + 1, state: structuredClone(state) });
    return true;
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
  async putViews(tableId: string, views: StoredView[]) {
    for (const v of views) {
      const k = `${tableId}/${v.userId}`;
      const old = this.views.get(k);
      if (!old || old.version < v.version) this.views.set(k, structuredClone(v));
    }
  }
  async dropView(tableId: string, userId: string) {
    this.views.delete(`${tableId}/${userId}`);
  }
  async sweep() {}
  /** Online achievement counters by `${userId}/${playerId}`, kept like the credit_awards function does. */
  awarded = new Map<string, Counters>();
  /** Each player's own saved counters, as the players table would hold them. */
  profiles = new Map<string, Counters>();
  async awards(userId: string, playerId: string) {
    const k = `${userId}/${playerId}`;
    return { server: { ...(this.awarded.get(k) ?? {}) }, profile: { ...(this.profiles.get(k) ?? {}) } };
  }
  async creditAwards(credits: AwardCredit[]) {
    for (const c of credits) {
      const k = `${c.userId}/${c.playerId}`;
      const cur = this.awarded.get(k) ?? {};
      for (const [key, v] of Object.entries(c.tally.sum)) cur[key] = (cur[key] ?? 0) + v;
      for (const [key, v] of Object.entries(c.tally.max)) cur[key] = Math.max(cur[key] ?? 0, v);
      this.awarded.set(k, cur);
    }
  }
  admins = new Set<string>();
  adminLog: { userId: string; action: string }[] = [];
  async isAdmin(userId: string) {
    return this.admins.has(userId);
  }
  async recent(limit: number) {
    return [...this.rows.values()].slice(0, limit).map((r) => ({ ...structuredClone(r), updatedAt: '2026-10-20T00:00:00Z' }));
  }
  async logAdmin(userId: string, action: string) {
    this.adminLog.push({ userId, action });
  }
  view(tableId: string, userId: string): TableView {
    return this.views.get(`${tableId}/${userId}`)!.view;
  }
}
