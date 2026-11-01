// Crash reports (supabase/crashes.sql). Any player's game sends the errors it hits with
// report_crash(), which trims, groups and rate-limits them on the server. Only admins can read
// them, in the admin dashboard.
import { OnlineAuth, restRequest } from './online';

type Fetch = typeof fetch;

/** What the game sends about one error. */
export interface CrashInfo {
  message: string;
  stack: string;
  /** What the player was doing: "Texas Hold'em vs bots", "Blackjack", "Lobby"… */
  game: string;
  /** "Chrome 130 · Windows" */
  browser: string;
  /** Which deploy of the game. */
  build: string;
}

/** One kind of error, as the admin dashboard sees it. */
export interface CrashReport {
  id: number;
  message: string;
  stack: string;
  firstAt: string;
  lastAt: string;
  count: number;
  people: number;
  games: string[];
  browsers: string[];
  builds: string[];
  /** The latest signed-in account that hit it, or null. */
  account: string | null;
  /** When an admin marked it fixed, or null while it's open. */
  fixedAt: string | null;
}

/** Sends one crash report: as the signed-in account if possible, else as a visitor. Never throws. */
export async function sendCrash(auth: OnlineAuth, info: CrashInfo, fetchFn: Fetch = (...a) => fetch(...a)): Promise<boolean> {
  const body = { p_message: info.message, p_stack: info.stack, p_game: info.game, p_browser: info.browser, p_build: info.build };
  for (const anonymous of auth.current ? [false, true] : [true]) {
    try {
      await restRequest(auth, 'rpc/report_crash', { method: 'POST', body, anonymous }, fetchFn);
      return true;
    } catch {
      /* try as a visitor, or give up */
    }
  }
  return false;
}

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);

/** Admin-only reads and changes; the database refuses them for everyone else. */
export class CrashApi {
  constructor(private readonly auth: OnlineAuth, private readonly fetchFn: Fetch = (...a) => fetch(...a)) {}

  private call(path: string, init?: Parameters<typeof restRequest>[2]) {
    return restRequest(this.auth, path, init, this.fetchFn);
  }

  /** Every report, the most recent first. */
  async list(): Promise<CrashReport[]> {
    const rows = (await this.call('crash_reports?select=id,message,stack,first_at,last_at,count,people,games,browsers,builds,account,fixed_at&order=last_at.desc&limit=500')) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      message: String(r.message ?? ''),
      stack: String(r.stack ?? ''),
      firstAt: String(r.first_at ?? ''),
      lastAt: String(r.last_at ?? ''),
      count: Number(r.count ?? 1),
      people: Number(r.people ?? 1),
      games: strings(r.games),
      browsers: strings(r.browsers),
      builds: strings(r.builds),
      account: r.account ? String(r.account) : null,
      fixedAt: r.fixed_at ? String(r.fixed_at) : null,
    }));
  }

  /** Marks a report fixed (it opens again if the error comes back), or open again. */
  async setFixed(id: number, fixed: boolean): Promise<void> {
    await this.call(`crash_reports?id=eq.${id}`, { method: 'PATCH', prefer: 'return=minimal', body: { fixed_at: fixed ? new Date().toISOString() : null } });
  }

  async remove(id: number): Promise<void> {
    await this.call(`crash_reports?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
  }

  /** Deletes every report marked fixed. */
  async removeFixed(): Promise<void> {
    await this.call('crash_reports?fixed_at=not.is.null', { method: 'DELETE', prefer: 'return=minimal' });
  }
}
