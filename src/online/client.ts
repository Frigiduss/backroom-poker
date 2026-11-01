// The browser's side of online tables: sends moves to the poker-table function and
// watches the signed-in account's own view row for changes.
import { OnlineAuth, OnlineError, restRequest } from '../accounts/online';
import { AdminReply, Reply, Request, TableView } from './protocol';

type Fetch = typeof fetch;

export const FUNCTION_NAME = 'poker-table';

export class TableClient {
  constructor(private readonly auth: OnlineAuth, private readonly fetchFn: Fetch = (...a) => fetch(...a)) {}

  get userId(): string {
    return this.auth.current?.userId ?? '';
  }

  async send(req: Request): Promise<Reply> {
    return (await this.post(req)) as unknown as Reply;
  }

  /** The key browsers sign up for notifications with (src/online/push.ts). */
  async pushKey(): Promise<string> {
    return String((await this.post({ op: 'push-key' })).key ?? '');
  }

  /** Lets the server send a notification about an invite just made to the friend with this code. Never throws. */
  async pushInvite(friendCode: string): Promise<void> {
    await this.post({ op: 'push-invite', code: friendCode }).catch(() => undefined);
  }

  private async post(req: unknown): Promise<Record<string, unknown>> {
    const token = await this.auth.token();
    let res: Response;
    try {
      res = await this.fetchFn(`${this.auth.config.url}/functions/v1/${FUNCTION_NAME}`, {
        method: 'POST',
        headers: { apikey: this.auth.config.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
    } catch {
      throw new OnlineError("Can't reach the table server. Check your connection.");
    }
    const body = (await res.json().catch(() => ({}))) as Partial<Reply> & { error?: string; message?: string };
    if (res.status === 404 && !('ok' in body)) throw new OnlineError("Online tables aren't switched on yet: the poker-table function isn't deployed on the server.", 404);
    if (!res.ok || !body.ok) throw new OnlineError(body.error ?? body.message ?? `The table server said no (${res.status}).`, res.status);
    return body as Record<string, unknown>;
  }

  /** Developer console requests ('admin' and 'tables'). The server refuses them unless the account is an admin. */
  async admin(req: Extract<Request, { op: 'admin' | 'tables' }>): Promise<AdminReply> {
    return (await this.send(req)) as unknown as AdminReply;
  }

  /** The newer view of a table, or null if nothing changed since `version`. */
  async poll(tableId: string, version: number): Promise<TableView | null> {
    const rows = (await restRequest(this.auth, `poker_views?select=view&table_id=eq.${encodeURIComponent(tableId)}&user_id=eq.${encodeURIComponent(this.userId)}&version=gt.${version}`, {}, this.fetchFn)) as { view: TableView }[];
    return rows[0]?.view ?? null;
  }

  /** The table this account was at most recently, if its game is still going. */
  async current(): Promise<TableView | null> {
    const rows = (await restRequest(this.auth, `poker_views?select=view&user_id=eq.${encodeURIComponent(this.userId)}&order=updated_at.desc&limit=1`, {}, this.fetchFn)) as { view: TableView }[];
    const v = rows[0]?.view;
    return v && v.phase !== 'over' ? v : null;
  }
}
