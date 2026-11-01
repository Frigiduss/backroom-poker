// Uploading and deleting profile pictures in the `avatars` storage bucket (supabase/avatars.sql).
// The face values and their checks are in avatars.ts, which the table server shares.
import { AVATAR_BUCKET, PICTURE_MAX_BYTES, newPictureKey } from './avatars';
import { OnlineAuth, OnlineError } from './online';

type Fetch = typeof fetch;

/** Thrown when supabase/avatars.sql hasn't been run on the project yet. */
export class AvatarsNotSetUpError extends OnlineError {}

function objectUrl(auth: OnlineAuth, key: string): string {
  return `${auth.config.url}/storage/v1/object/${AVATAR_BUCKET}/${key}.jpg`;
}

/** Uploads a picture (a JPEG already squared and shrunk) and returns the face value for it. */
export async function uploadPicture(auth: OnlineAuth, jpeg: Blob, fetchFn: Fetch = (...a) => fetch(...a)): Promise<string> {
  if (jpeg.type !== 'image/jpeg') throw new OnlineError('Pictures are sent as JPEG.');
  if (jpeg.size > PICTURE_MAX_BYTES) throw new OnlineError('That picture is too big.');
  const key = newPictureKey();
  const token = await auth.token();
  let res: Response;
  try {
    res = await fetchFn(objectUrl(auth, key), {
      method: 'POST',
      headers: { apikey: auth.config.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'false', 'cache-control': 'max-age=31536000' },
      body: jpeg,
    });
  } catch {
    throw new OnlineError("Can't reach the account server.");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const msg = String(body.message ?? body.error ?? '');
    if (/bucket not found/i.test(msg)) throw new AvatarsNotSetUpError('Pictures aren\'t switched on yet. Pick a face instead.', 404);
    if (res.status === 413 || /too large|exceeded the maximum/i.test(msg)) throw new OnlineError('That picture is too big.', res.status);
    if (/row-level security|unauthori[sz]ed|403/i.test(msg) || res.status === 403) {
      throw new OnlineError('You can\'t upload a picture right now. Remove an old one, or pick a face instead.', 403);
    }
    throw new OnlineError(msg || 'The picture didn\'t upload. Try again.', res.status);
  }
  return `u:${key}`;
}

/** Deletes one of this account's uploaded pictures. Never throws: an old file left behind does no harm. */
export async function deletePicture(auth: OnlineAuth, key: string, fetchFn: Fetch = (...a) => fetch(...a)): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/.test(key)) return false;
  try {
    const res = await fetchFn(objectUrl(auth, key), {
      method: 'DELETE',
      headers: { apikey: auth.config.anonKey, Authorization: `Bearer ${await auth.token()}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The names (keys) of this account's own uploaded pictures. Empty if they can't be listed. */
export async function listPictures(auth: OnlineAuth, fetchFn: Fetch = (...a) => fetch(...a)): Promise<string[]> {
  try {
    const res = await fetchFn(`${auth.config.url}/storage/v1/object/list/${AVATAR_BUCKET}`, {
      method: 'POST',
      headers: { apikey: auth.config.anonKey, Authorization: `Bearer ${await auth.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 100, offset: 0 }),
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as { name?: unknown }[];
    return (Array.isArray(rows) ? rows : []).map((r) => /^([0-9a-f]{32})\.jpg$/.exec(String(r?.name ?? ''))?.[1]).filter((k): k is string => !!k);
  } catch {
    return [];
  }
}

/** Deletes every uploaded picture of this account but `keep`, making room for a new one. */
export async function clearOldPictures(auth: OnlineAuth, keep: string | null, fetchFn?: Fetch): Promise<number> {
  const old = (await listPictures(auth, fetchFn)).filter((k) => k !== keep);
  const done = await Promise.all(old.map((k) => deletePicture(auth, k, fetchFn)));
  return done.filter(Boolean).length;
}
