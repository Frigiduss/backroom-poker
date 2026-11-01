// Web Push from the table server, with nothing but WebCrypto (Deno and Node both have it):
// VAPID sign-in to the browser's push service (RFC 8292) and the encrypted message body
// (RFC 8291, aes128gcm). The private key never leaves the server; see src/online/push.ts.

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export interface VapidKeys {
  /** The uncompressed P-256 point, base64url: what browsers subscribe with. */
  publicKey: string;
  /** The whole key as a JWK, kept only in the database (push_keys, unreadable by browsers). */
  privateJwk: JsonWebKey;
}

export async function makeVapidKeys(): Promise<VapidKeys> {
  const pair = (await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const jwk = await subtle().exportKey('jwk', pair.privateKey);
  return { publicKey: b64url(raw), privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
}

/** The Authorization header that tells a push service the message is from this server. */
export async function vapidAuth(endpoint: string, keys: VapidKeys, subject: string, nowMs: number): Promise<string> {
  const key = await subtle().importKey('jwk', { ...keys.privateJwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })}`;
  const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${keys.publicKey}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** The keys both ends work out from the shared secret (RFC 8291 section 3.4). */
export async function contentKeys(ecdhSecret: Uint8Array, authSecret: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array, salt: Uint8Array) {
  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  return { cek, nonce };
}

/** Encrypts a message for one browser subscription (its p256dh and auth keys), as a single aes128gcm record. */
export async function encryptPush(message: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Bad subscription keys.');
  const ua = await subtle().importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const mine = (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await subtle().exportKey('raw', mine.publicKey));
  const secret = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: ua }, mine.privateKey, 256));
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const { cek, nonce } = await contentKeys(secret, authSecret, uaPublic, asPublic, salt);
  const key = await subtle().importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 marks the last (only) record; no padding.
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(message, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed);
}
