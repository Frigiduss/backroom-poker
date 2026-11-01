// This device's notification sign-up, kept by database functions in supabase/push.sql. The
// table server (src/online/push.ts) reads it to send "your turn" and invite notifications.
import { OnlineAuth, OnlineError, restRequest } from './online';

type Fetch = typeof fetch;

/** Which notifications a device gets. */
export interface PushPrefs {
  turns: boolean;
  invites: boolean;
}

/** What the browser's PushSubscription.toJSON() gives. */
export interface PushSubscriptionData {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

/** Thrown when supabase/push.sql hasn't been run on the project yet. */
export class PushNotSetUpError extends OnlineError {}

async function rpc(auth: OnlineAuth, name: string, body: Record<string, unknown>, fetchFn?: Fetch): Promise<unknown> {
  try {
    return await restRequest(auth, `rpc/${name}`, { method: 'POST', body }, fetchFn);
  } catch (err) {
    if (err instanceof OnlineError && err.status === 404) throw new PushNotSetUpError("Notifications aren't switched on yet.", 404);
    throw err;
  }
}

export async function savePush(auth: OnlineAuth, sub: PushSubscriptionData, prefs: PushPrefs, fetchFn?: Fetch): Promise<void> {
  await rpc(auth, 'push_save', {
    p_endpoint: sub.endpoint ?? '', p_p256dh: sub.keys?.p256dh ?? '', p_auth: sub.keys?.auth ?? '', p_turns: prefs.turns, p_invites: prefs.invites,
  }, fetchFn);
}

export async function removePush(auth: OnlineAuth, endpoint: string, fetchFn?: Fetch): Promise<void> {
  await rpc(auth, 'push_remove', { p_endpoint: endpoint }, fetchFn);
}

/** What this device gets, or null if the server doesn't have it signed up for this account. */
export async function pushStatus(auth: OnlineAuth, endpoint: string, fetchFn?: Fetch): Promise<PushPrefs | null> {
  const r = (await rpc(auth, 'push_status', { p_endpoint: endpoint }, fetchFn)) as Record<string, unknown> | null;
  return r && typeof r === 'object' ? { turns: r.turns !== false, invites: r.invites !== false } : null;
}

/** "This device has the game in front of me" (true) or "put away" (false). Nothing is sent while any device is awake. */
export async function setAwake(auth: OnlineAuth, device: string, awake: boolean, fetchFn?: Fetch): Promise<void> {
  await rpc(auth, 'push_awake', { p_device: device, p_awake: awake }, fetchFn);
}
