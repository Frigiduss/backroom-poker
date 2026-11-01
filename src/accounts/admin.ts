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
