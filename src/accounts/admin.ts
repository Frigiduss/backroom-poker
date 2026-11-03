// Admin calls for the developer console. Every one of them is checked by the database
// (supabase/admin.sql): an account that isn't in the `admins` table gets "not allowed",
// whatever the browser sends. The console only shows itself to accounts that pass is_admin().
import { Profile, normalizeProfile } from './profile';
import { OnlineAuth, OnlineError, RestInit, restRequest } from './online';
import { deletePicture } from './pictures';

type Fetch = typeof fetch;

export interface AdminAccount {
  id: string;
  email: string;
  createdAt: string;
  lastSignInAt: string | null;
  players: number;
  admin: boolean;
}

/** A player row from any account, with who owns it. */
export interface AdminPlayer {
  owner: string;
  updatedAt: string;
  profile: Profile;
}

export interface AdminLogEntry {
  at: string;
  action: string;
  detail: Record<string, unknown>;
}

/** A suspended account, from supabase/moderation.sql. */
export interface AdminBan {
  owner: string;
  email: string;
  /** Epoch ms, or null for until lifted. */
  until: number | null;
  reason: string;
  at: number;
}

/** An account's chip bank limits (supabase/banks.sql): a sign of edited banks when saves keep getting capped. */
export interface BankGuard {
  owner: string;
  /** Chips of winning the account can still save right now. */
  allowance: number;
  /** Saves cut back for winning faster than play allows. */
  capped: number;
  lastRefill: number | null;
}

/** What admin_edit_player can set. Stats are merged key by key. */
export interface AdminFields {
  bank?: number;
  name?: string;
  stats?: Record<string, unknown>;
  history?: [number, number][];
}

/** Thrown when supabase/moderation.sql hasn't been run, so the old way of changing players is all there is. */
export class ModerationNotSetUpError extends OnlineError {}

const ms = (x: unknown): number | null => {
  const t = typeof x === 'string' ? Date.parse(x) : NaN;
  return Number.isFinite(t) ? t : null;
};

export const ANNOUNCEMENT_KEY = 'announcement';

export class AdminApi {
  constructor(private readonly auth: OnlineAuth, private readonly fetchFn: Fetch = (...a) => fetch(...a)) {}

  private call(path: string, init?: RestInit): Promise<unknown> {
    return restRequest(this.auth, path, init, this.fetchFn);
  }

  /** True for admin accounts. False when signed out, not an admin, or admin.sql hasn't been run. */
  async isAdmin(): Promise<boolean> {
    if (!this.auth.current) return false;
    try {
      return (await this.call('rpc/is_admin', { method: 'POST', body: {} })) === true;
    } catch {
      return false;
    }
  }

  async accounts(): Promise<AdminAccount[]> {
    const rows = (await this.call('rpc/admin_accounts', { method: 'POST', body: {} })) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      email: String(r.email ?? ''),
      createdAt: String(r.created_at ?? ''),
      lastSignInAt: r.last_sign_in_at ? String(r.last_sign_in_at) : null,
      players: Number(r.players ?? 0),
      admin: r.admin === true,
    }));
  }

  /** Every player in every account, most recently saved first. */
  async players(): Promise<AdminPlayer[]> {
    const rows = (await this.call('players?select=id,owner,data,updated_at&order=updated_at.desc')) as { id: string; owner: string; data: unknown; updated_at: string }[];
    const out: AdminPlayer[] = [];
    for (const r of rows) {
      const profile = normalizeProfile({ ...(r.data as object), id: r.id });
      if (profile) out.push({ owner: r.owner, updatedAt: r.updated_at, profile });
    }
    return out;
  }

  /** Saves a change to any account's player. The row must already exist. */
  async savePlayer(p: Profile): Promise<void> {
    const rows = (await this.call(`players?id=eq.${encodeURIComponent(p.id)}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { data: p, updated_at: new Date(p.updatedAt).toISOString() },
    })) as unknown[];
    if (!rows?.length) throw new OnlineError('That player is gone, or this account is not an admin.', 404);
  }

  async deletePlayer(id: string): Promise<void> {
    const rows = (await this.call(`players?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=representation' })) as unknown[];
    if (!rows?.length) throw new OnlineError('That player is gone, or this account is not an admin.', 404);
  }

  /** Calls a supabase/moderation.sql function, saying so when that file hasn't been run. */
  private async moderation(name: string, body: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.call(`rpc/${name}`, { method: 'POST', body });
    } catch (err) {
      if (err instanceof OnlineError && err.status === 404) throw new ModerationNotSetUpError('Run supabase/moderation.sql in the Supabase SQL Editor first.', 404);
      throw err;
    }
  }

  /**
   * Changes any player through the database, which keeps the change in force until that
   * player's game collects it, so a game that's open can't save over it. `lockName` keeps
   * a new name on the player (true) or lets them rename again (false). Returns the saved player.
   */
  async editPlayer(playerId: string, fields: AdminFields, lockName: boolean | null = null): Promise<Profile | null> {
    const data = await this.moderation('admin_edit_player', { p_player: playerId, p_fields: fields, p_lock_name: lockName });
    return data && typeof data === 'object' ? normalizeProfile({ ...(data as object), id: playerId }) : null;
  }

  /** Deletes a player for good: a game that's open can't save it back. */
  async deletePlayerForGood(playerId: string): Promise<boolean> {
    return (await this.moderation('admin_delete_player', { p_player: playerId })) === true;
  }

  /** Suspends an account for `days` days (null: until lifted). Its players come off the leaderboard meanwhile. */
  async ban(owner: string, days: number | null, reason: string): Promise<{ until: number | null; hidden: number }> {
    const r = ((await this.moderation('admin_ban', { p_owner: owner, p_days: days, p_reason: reason })) ?? {}) as Record<string, unknown>;
    return { until: ms(r.until), hidden: Number(r.hidden ?? 0) };
  }

  /** Lifts a suspension. False when the account wasn't suspended. */
  async unban(owner: string): Promise<boolean> {
    return (await this.moderation('admin_unban', { p_owner: owner })) === true;
  }

  /** Every suspension in force, newest first. */
  async bans(): Promise<AdminBan[]> {
    const rows = ((await this.moderation('admin_bans', {})) ?? []) as Record<string, unknown>[];
    return rows.map((r) => ({ owner: String(r.owner), email: String(r.email ?? ''), until: ms(r.until), reason: String(r.reason ?? ''), at: ms(r.at) ?? 0 }));
  }

  /** Every account's bank limits, by account id. Empty when banks.sql or moderation.sql isn't set up. */
  async bankGuards(): Promise<Map<string, BankGuard>> {
    let rows: Record<string, unknown>[];
    try {
      rows = ((await this.moderation('admin_bank_guard', {})) ?? []) as Record<string, unknown>[];
    } catch (err) {
      if (err instanceof ModerationNotSetUpError) return new Map();
      throw err;
    }
    return new Map(rows.map((r) => [String(r.owner), { owner: String(r.owner), allowance: Number(r.allowance ?? 0), capped: Number(r.capped ?? 0), lastRefill: ms(r.last_refill) }]));
  }

  /** Takes a player off the leaderboard (or puts them back). Their own setting can't undo it. */
  async setLeaderboardHidden(playerId: string, hidden: boolean): Promise<void> {
    if (hidden) {
      await this.call('leaderboard_hidden?on_conflict=player_id', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: { player_id: playerId } });
    } else {
      await this.call(`leaderboard_hidden?player_id=eq.${encodeURIComponent(playerId)}`, { method: 'DELETE', prefer: 'return=minimal' });
    }
  }

  /**
   * Stops an account uploading profile pictures (or lets it again), and deletes the picture
   * given. Faces from the game's own set still work.
   */
  async setPictureBlocked(owner: string, blocked: boolean, pictureKey: string | null = null): Promise<boolean> {
    if (blocked) {
      await this.call('avatar_blocked?on_conflict=owner', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: { owner } });
    } else {
      await this.call(`avatar_blocked?owner=eq.${encodeURIComponent(owner)}`, { method: 'DELETE', prefer: 'return=minimal' });
    }
    return pictureKey ? deletePicture(this.auth, pictureKey, this.fetchFn) : false;
  }

  /** The lobby announcement everyone sees. Readable without signing in. */
  async announcement(): Promise<string> {
    return readAnnouncement(this.auth, this.fetchFn);
  }

  async setAnnouncement(text: string): Promise<void> {
    if (!text) {
      await this.call(`site?key=eq.${ANNOUNCEMENT_KEY}`, { method: 'DELETE', prefer: 'return=minimal' });
      return;
    }
    await this.call('site?on_conflict=key', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: { key: ANNOUNCEMENT_KEY, value: text, updated_at: new Date().toISOString() },
    });
  }

  /** Records a console action. Never throws: a missing log entry shouldn't undo the action. */
  async log(action: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.call('admin_log', { method: 'POST', prefer: 'return=minimal', body: { action, detail } }).catch(() => undefined);
  }

  async recentLog(limit = 20): Promise<AdminLogEntry[]> {
    const rows = (await this.call(`admin_log?select=at,action,detail&order=at.desc&limit=${limit}`)) as AdminLogEntry[];
    return rows;
  }
}

/** The current lobby announcement, or '' when there is none (or the site table isn't set up). */
export async function readAnnouncement(auth: OnlineAuth, fetchFn: Fetch = (...a) => fetch(...a)): Promise<string> {
  try {
    const rows = (await restRequest(auth, `site?select=value&key=eq.${ANNOUNCEMENT_KEY}`, { anonymous: true }, fetchFn)) as { value: unknown }[];
    const v = rows?.[0]?.value;
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}
