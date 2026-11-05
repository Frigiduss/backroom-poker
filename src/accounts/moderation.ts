// What an admin's moderation means for a player's own game, answered by supabase/moderation.sql:
// whether the account is suspended, and changes an admin made to the player (a new bank,
// name or stats) for the game to take on. Until the game takes them, the database keeps
// them in force on every save, so an open game can't save over them.
import { OnlineAuth, OnlineError, restRequest } from './online';
import { NAME_MAX, Profile, noteChips } from './profile';

type Fetch = typeof fetch;

export interface BanStatus {
  banned: boolean;
  /** When it ends (epoch ms), or null for until an admin lifts it. */
  until: number | null;
  reason: string;
}

export const NOT_BANNED: BanStatus = { banned: false, until: null, reason: '' };

/** What collecting found. */
export interface AdminChanges {
  /** An admin deleted the player. */
  deleted: boolean;
  /** Something about the player changed. */
  changed: boolean;
  /** An admin set the player's name and keeps it. */
  nameLocked: boolean;
}

const NOTHING: AdminChanges = { deleted: false, changed: false, nameLocked: false };

/** True when supabase/moderation.sql isn't on the project (its functions are missing). */
export const notSetUp = (err: unknown): boolean => err instanceof OnlineError && err.status === 404;

const time = (x: unknown): number | null => {
  const t = typeof x === 'string' ? Date.parse(x) : NaN;
  return Number.isFinite(t) ? t : null;
};

export function parseBan(r: unknown): BanStatus {
  const o = (r ?? {}) as Record<string, unknown>;
  if (o.banned !== true) return NOT_BANNED;
  return { banned: true, until: time(o.until), reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '' };
}

/** Whether the signed-in account is suspended. Not suspended when moderation isn't set up. */
export async function banStatus(auth: OnlineAuth, fetchFn?: Fetch): Promise<BanStatus> {
  try {
    return parseBan(await restRequest(auth, 'rpc/ban_status', { method: 'POST', body: {} }, fetchFn));
  } catch (err) {
    if (notSetUp(err)) return NOT_BANNED;
    throw err;
  }
}

/**
 * Puts admin changes into `p` (which the caller then saves). Only the fields the console
 * sets are taken, each in the shape the profile needs.
 */
export function applyAdminFields(p: Profile, fields: Record<string, unknown>): boolean {
  let changed = false;
  const bank = fields.bank;
  if (typeof bank === 'number' && Number.isFinite(bank) && bank >= 0) {
    p.bank = Math.floor(bank);
    p.stats.peakBank = Math.max(p.stats.peakBank, p.bank);
    changed = true;
  }
  if (typeof fields.name === 'string' && fields.name.trim()) {
    p.name = fields.name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    changed = true;
  }
  const stats = fields.stats;
  if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
    for (const [k, v] of Object.entries(stats as Record<string, unknown>)) {
      if (!(k in p.stats)) continue;
      const now = (p.stats as unknown as Record<string, unknown>)[k];
      if (typeof now === 'number' && typeof v === 'number' && Number.isFinite(v)) (p.stats as unknown as Record<string, unknown>)[k] = Math.round(v);
      else if (now && typeof now === 'object' && v && typeof v === 'object') (p.stats as unknown as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(v));
      else if (now === null || v === null) (p.stats as unknown as Record<string, unknown>)[k] = v;
    }
    changed = true;
  }
  const history = fields.history;
  if (Array.isArray(history) && history.every((h) => Array.isArray(h) && h.length === 2 && h.every((x) => typeof x === 'number'))) {
    p.history = history.map((h) => [h[0], h[1]] as [number, number]);
    changed = true;
  }
  if (changed) {
    p.updatedAt = Date.now();
    if (typeof bank === 'number' && !Array.isArray(history)) noteChips(p, p.updatedAt);
  }
  return changed;
}

/** Takes on whatever an admin changed about player `p`. The caller saves `p` when `changed`. */
export async function collectAdminChanges(auth: OnlineAuth, p: Profile, fetchFn?: Fetch): Promise<AdminChanges> {
  let r: Record<string, unknown>;
  try {
    r = ((await restRequest(auth, 'rpc/collect_overrides', { method: 'POST', body: { p_player: p.id } }, fetchFn)) ?? {}) as Record<string, unknown>;
  } catch (err) {
    if (notSetUp(err)) return NOTHING;
    throw err;
  }
  if (r.deleted === true) return { deleted: true, changed: false, nameLocked: false };
  const fields = r.fields && typeof r.fields === 'object' ? (r.fields as Record<string, unknown>) : {};
  return { deleted: false, changed: applyAdminFields(p, fields), nameLocked: r.nameLocked === true };
}
