// Notifications on this device: the Notifications panel on the profile page, telling the server
// whether the game is in front of the player (so their phone stays quiet while they're playing),
// and what happens when a notification is tapped. The server side is supabase/push.sql and
// src/online/push.ts; src/ui/app/sw.js shows them.
import { OnlineAuth, OnlineError, PushNotSetUpError, PushPrefs, pushStatus, removePush, savePush, setAwake } from '../../accounts';
import { TableClient } from '../../online/client';
import { fromB64url } from '../../online/webpush';

interface Hooks {
  auth: OnlineAuth | null;
  /** Goes to the online table with this code (a "your turn" notification was tapped). */
  openTable: (code: string) => void;
}

const DEVICE_KEY = 'backroom-poker-device';
const PREFS_KEY = 'backroom-poker-push';
/** How often the server hears "still here" while the game is in front of the player (the server forgets after two minutes). */
const AWAKE_MS = 80_000;

let hooks: Hooks | null = null;
let notSetUp = false;
let lastAwake: boolean | null = null;
let lastAwakeAt = 0;
let awakeFor = '';

function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,40}$/.test(id)) {
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'nostorage';
  }
}

const awakeNow = () => document.visibilityState === 'visible' && document.hasFocus();

/** Lets the server know whether this device has the game in front of the player, when that changes and every so often while it does. */
function tellServer() {
  const auth = hooks?.auth;
  const who = auth?.current?.userId ?? '';
  if (!auth || !who || notSetUp) return;
  const awake = awakeNow();
  const now = Date.now();
  if (who === awakeFor && awake === lastAwake && (!awake || now - lastAwakeAt < AWAKE_MS)) return;
  lastAwake = awake;
  lastAwakeAt = now;
  awakeFor = who;
  // Going away can be the last thing the page does, so that call is allowed to outlive it.
  const fetchFn: typeof fetch = (input, init) => fetch(input, { ...init, keepalive: !awake });
  setAwake(auth, deviceId(), awake, fetchFn).catch((err) => {
    if (err instanceof PushNotSetUpError) notSetUp = true;
    lastAwake = null; // try again next time
  });
}

export function initNotify(h: Hooks) {
  hooks = h;
  if (!h.auth) return;
  for (const ev of ['visibilitychange', 'focus', 'blur', 'pagehide', 'pageshow']) {
    (ev === 'visibilitychange' ? document : window).addEventListener(ev, () => tellServer());
  }
  window.setInterval(tellServer, 20_000);
  tellServer();
  navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; kind?: string; code?: string } | null;
    if (d?.type !== 'brp-open' || d.kind !== 'turn') return;
    const code = String(d.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (code) hooks?.openTable(code);
  });
}

// ---------- this device's sign-up ----------

function loadPrefs(): PushPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<PushPrefs>;
    return { turns: p.turns !== false, invites: p.invites !== false };
  } catch {
    return { turns: true, invites: true };
  }
}

function keepPrefs(p: PushPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* only kept on the server then */
  }
}

/** Why this browser can't get notifications, or '' if it can. */
function unsupported(): string {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  if (ios && !installed) return 'On iPhone and iPad, add the game to your Home Screen first (Share → Add to Home Screen), then open it from there and turn notifications on.';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return "This browser can't show notifications from the game.";
  return '';
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

/** Signs this device up (or changes what it gets). Must start from a tap, for the permission prompt. */
async function turnOn(auth: OnlineAuth, prefs: PushPrefs): Promise<void> {
  // Asked first, before anything else waits: Safari only shows the prompt straight after a tap.
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') {
    throw new Error('Notifications are blocked for the game. Allow them in your browser or phone settings, then try again.');
  }
  const reg = await registration();
  if (!reg) throw new Error('Notifications work in the game on its website or installed app.');
  const key = fromB64url(await new TableClient(auth).pushKey());
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await savePush(auth, sub.toJSON(), prefs);
  keepPrefs(prefs);
}

async function turnOff(auth: OnlineAuth): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await removePush(auth, sub.endpoint);
  await sub.unsubscribe().catch(() => false);
}

/** Stops this device getting the account's notifications, before signing out. Never throws. */
export async function forgetThisDevice(): Promise<void> {
  const auth = hooks?.auth;
  if (!auth?.current || notSetUp) return;
  try {
    const sub = await (await registration())?.pushManager.getSubscription();
    if (sub) await removePush(auth, sub.endpoint);
    await setAwake(auth, deviceId(), false);
  } catch {
    /* signing out carries on */
  }
  lastAwake = null;
}

// ---------- the profile page ----------

export function notifyPanelHtml(): string {
  if (!hooks?.auth?.current) return '';
  return `<section class="panel account-panel" id="notify-panel">
    <h2 class="step">Notifications</h2>
    <div id="notify-body" class="notify-body"><p class="fine">Checking…</p></div>
    <p class="form-error" id="notify-error" role="alert"></p>
  </section>`;
}

export async function bindNotifyPanel(): Promise<void> {
  const auth = hooks?.auth;
  const body = document.getElementById('notify-body');
  const err = document.getElementById('notify-error');
  if (!auth || !body || !err) return;
  const say = (msg: string) => (err.textContent = msg);
  const intro = `<p>Get a notification on this device when it's your turn at an online table, or when a friend invites you to theirs. Nothing is sent while you have the game open in front of you.</p>`;
  const why = unsupported();
  if (why) {
    body.innerHTML = `${intro}<p class="fine">${why}</p>`;
    return;
  }
  let on: PushPrefs | null = null;
  try {
    const sub = await (await registration())?.pushManager.getSubscription();
    on = sub ? await pushStatus(auth, sub.endpoint) : null;
  } catch (e) {
    if (e instanceof PushNotSetUpError) {
      body.innerHTML = `${intro}<p class="fine">Notifications aren't switched on for the game yet.</p>`;
      return;
    }
    if (!(e instanceof OnlineError)) throw e;
    say(e.message);
  }
  if (!document.body.contains(body)) return;
  const prefs = on ?? loadPrefs();
  const blocked = Notification.permission === 'denied';
  body.innerHTML = `${intro}
    <label class="toggle"><input type="checkbox" id="push-turns" ${prefs.turns ? 'checked' : ''}> When it's my turn at an online table</label>
    <label class="toggle"><input type="checkbox" id="push-invites" ${prefs.invites ? 'checked' : ''}> When a friend invites me to their table</label>
    ${on
      ? `<p class="fine">On for this device.</p><div class="row-btns"><button type="button" class="btn btn-sm" id="push-off">Turn off on this device</button></div>`
      : blocked
        ? `<p class="fine">Notifications are blocked for the game on this device. Allow them in your browser or phone settings, then come back here.</p>`
        : `<div class="row-btns"><button type="button" class="btn btn-sm btn-primary" id="push-on">Turn on for this device</button></div>`}`;
  const pick = (): PushPrefs => ({
    turns: (document.getElementById('push-turns') as HTMLInputElement).checked,
    invites: (document.getElementById('push-invites') as HTMLInputElement).checked,
  });
  const busy = (yes: boolean) => body.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((x) => (x.disabled = yes));
  const run = async (fn: () => Promise<void>) => {
    busy(true);
    say('');
    try {
      await fn();
      await bindNotifyPanel();
    } catch (e) {
      busy(false);
      say((e as Error).message);
    }
  };
  document.getElementById('push-on')?.addEventListener('click', () => void run(() => turnOn(auth, pick())));
  document.getElementById('push-off')?.addEventListener('click', () => void run(() => turnOff(auth)));
  for (const id of ['push-turns', 'push-invites']) {
    document.getElementById(id)?.addEventListener('change', () => {
      if (on) void run(() => turnOn(auth, pick()));
      else keepPrefs(pick());
    });
  }
}
