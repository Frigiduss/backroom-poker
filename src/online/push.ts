// Phone and desktop notifications, sent by the table server (src/online/edge.ts): "your turn"
// at an online table, and a friend inviting you to theirs. supabase/push.sql keeps each
// device's subscription and whether its owner has the game in front of them right now; this
// file asks it who to tell, then sends through the browser makers' push services.
//
// The signing key is made by the server the first time it's needed and kept in push_keys,
// which browsers can't read. Nothing secret is in the code or the repository.
import { STRUCTURE_NAMES, VARIANTS } from '../engine/variants';
import { TableSettings } from './protocol';
import { VapidKeys, encryptPush, makeVapidKeys, vapidAuth } from './webpush';

type Fetch = typeof fetch;

/** Who a push service may call this server: the game's own address. */
export const PUSH_SUBJECT = 'https://frigiduss.github.io/backroom-poker/';

/**
 * The push services of Chrome/Android, Firefox, Safari/iPhone and Edge. Subscriptions anywhere
 * else are refused here and in supabase/push.sql, so the server never posts to an address a
 * player made up.
 */
export const PUSH_ENDPOINT = /^https:\/\/(fcm\.googleapis\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)*notify\.windows\.com)\/[\w\-.~:/?#[\]@!$&'()*+,;=%]{1,900}$/;

/** What the service worker (src/ui/app/sw.js) gets. */
export interface PushMessage {
  kind: 'turn' | 'invite';
  title: string;
  body: string;
  /** The table's code. */
  code: string;
}

export interface PushDevice {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** A person whose turn just came round at an online table (from server.ts). */
export interface TurnNotice {
  userId: string;
  code: string;
  settings: TableSettings;
}

export function gameName(s: Pick<TableSettings, 'game' | 'variant' | 'structure'>): string {
  if (s.game === 'blackjack') return 'blackjack';
  const v = VARIANTS[s.variant];
  return v ? `${STRUCTURE_NAMES[s.structure] ?? ''} ${v.name}`.trim() : 'poker';
}

const cleanCode = (s: unknown): string => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const cleanName = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'A friend';

export function turnMessage(n: TurnNotice): PushMessage {
  const code = cleanCode(n.code);
  return { kind: 'turn', title: "It's your turn", body: `Your move at table ${code} (${gameName(n.settings)}). Tap to play.`, code };
}

export function inviteMessage(r: { name?: unknown; table?: unknown; game?: unknown; variant?: unknown; structure?: unknown }): PushMessage {
  const code = cleanCode(r.table);
  const game = r.game === 'blackjack' ? 'blackjack' : gameName({ variant: r.variant as TableSettings['variant'], structure: r.structure as TableSettings['structure'] });
  return { kind: 'invite', title: `${cleanName(r.name)} opened a table`, body: `Come and play ${game} at table ${code}.`, code };
}

/** How long a push service keeps trying: a turn is over in 30 seconds, an invite lasts 15 minutes. */
const TTL: Record<PushMessage['kind'], number> = { turn: 60, invite: 900 };

export class Pusher {
  private keys: Promise<VapidKeys> | null = null;

  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly fetchFn: Fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
  ) {}

  private async rest(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<unknown> {
    const res = await this.fetchFn(`${this.url}/rest/v1/${path}`, {
      method: init.method ?? 'GET',
      headers: {
        apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json',
        ...(init.prefer ? { Prefer: init.prefer } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Push database error ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  /** The server's signing keys, made and saved the first time (two servers racing keep whichever was saved first). */
  vapid(): Promise<VapidKeys> {
    this.keys ??= (async () => {
      const read = async () => {
        const rows = (await this.rest('push_keys?select=public_key,private_jwk&id=eq.1')) as { public_key: string; private_jwk: JsonWebKey }[];
        return rows[0] ? { publicKey: rows[0].public_key, privateJwk: rows[0].private_jwk } : null;
      };
      const have = await read();
      if (have) return have;
      const made = await makeVapidKeys();
      await this.rest('push_keys', { method: 'POST', body: { id: 1, public_key: made.publicKey, private_jwk: made.privateJwk }, prefer: 'resolution=ignore-duplicates,return=minimal' });
      const saved = await read();
      if (!saved) throw new Error('Could not save the notification keys.');
      return saved;
    })();
    this.keys.catch(() => (this.keys = null));
    return this.keys;
  }

  async publicKey(): Promise<string> {
    return (await this.vapid()).publicKey;
  }

  /** Tells a person it's their turn, on each device they turned it on for, unless they have the game in front of them. */
  async turn(n: TurnNotice): Promise<number> {
    return this.sendTo(n.userId, turnMessage(n));
  }

  /**
   * After `fromUser` invited the friend with this friend code (supabase/friends.sql), tells the
   * friend. The database checks the invite is real and recent, and sends each one only once.
   */
  async invite(fromUser: string, friendCode: string): Promise<number> {
    const r = (await this.rest('rpc/push_invite', { method: 'POST', body: { p_from: fromUser, p_code: String(friendCode ?? '').slice(0, 12) } })) as Record<string, unknown> | null;
    if (!r || typeof r.to !== 'string') return 0;
    return this.sendTo(r.to, inviteMessage(r));
  }

  private async sendTo(userId: string, msg: PushMessage): Promise<number> {
    const devices = (await this.rest('rpc/push_targets', { method: 'POST', body: { p_user: userId, p_kind: msg.kind } })) as PushDevice[] | null;
    if (!Array.isArray(devices) || !devices.length) return 0;
    const keys = await this.vapid();
    const body = new TextEncoder().encode(JSON.stringify(msg));
    const sent = await Promise.all(devices.slice(0, 10).map((d) => this.sendOne(d, body, msg.kind, keys).catch(() => false)));
    return sent.filter(Boolean).length;
  }

  private async sendOne(d: PushDevice, body: Uint8Array, kind: PushMessage['kind'], keys: VapidKeys): Promise<boolean> {
    if (!PUSH_ENDPOINT.test(d.endpoint)) return false;
    const res = await this.fetchFn(d.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuth(d.endpoint, keys, PUSH_SUBJECT, this.now()),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL[kind]),
        Urgency: 'high',
        Topic: kind,
      },
      body: await encryptPush(body, d.p256dh, d.auth),
    });
    // Gone: the browser dropped the subscription (notifications turned off, app removed).
    if (res.status === 404 || res.status === 410) {
      await this.rest(`push_devices?endpoint=eq.${encodeURIComponent(d.endpoint)}`, { method: 'DELETE', prefer: 'return=minimal' }).catch(() => undefined);
    }
    return res.ok;
  }
}

/** The table server's notification requests: the key browsers subscribe with, and "I just invited a friend". */
export async function handlePush(pusher: Pusher, userId: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (body.op === 'push-key') {
    try {
      return { status: 200, body: { ok: true, key: await pusher.publicKey() } };
    } catch {
      return { status: 503, body: { ok: false, error: "Notifications aren't switched on yet." } };
    }
  }
  // An invite still counts if the push can't go: the friend sees it in the game either way.
  await pusher.invite(userId, String(body.code ?? '')).catch(() => 0);
  return { status: 200, body: { ok: true } };
}
