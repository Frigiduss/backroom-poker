// Service worker for the installed app (scripts/build.mjs copies it to dist/sw.js and fills in
// the version). Pages always come from the network first, so a new deploy shows up on the next
// open; the cached copy is only used offline. Online play (Supabase) is never touched.
const VERSION = '__VERSION__';
const CACHE = `brp-${VERSION}`;
const FONTS = `brp-fonts`;
const SHELL = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];
/** How long a page request may take before the saved copy is shown instead. */
const SLOW_MS = 6000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('brp-') && k !== CACHE && k !== FONTS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.startsWith(new URL(self.registration.scope).pathname)) {
    event.respondWith(networkFirst(req, url));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(fonts(req));
  }
  // Anything else (Supabase, the table server) goes straight to the network as if there were no worker.
});

// ---------- notifications (src/online/push.ts sends them) ----------

self.addEventListener('push', (event) => {
  let msg = null;
  try {
    msg = event.data ? event.data.json() : null;
  } catch {
    msg = null;
  }
  if (!msg || typeof msg !== 'object') return;
  const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const kind = msg.kind === 'invite' ? 'invite' : 'turn';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    // Someone looking at the game right now sees it there already.
    if (wins.some((w) => w.focused && w.visibilityState === 'visible')) return undefined;
    return self.registration.showNotification(String(msg.title || 'Back Room Poker').slice(0, 80), {
      body: String(msg.body || '').slice(0, 200),
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      // One notification per table: a newer one replaces the last, and still buzzes.
      tag: `table-${code}`,
      renotify: true,
      data: { kind, code },
    });
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const code = String(data.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const kind = data.kind === 'invite' ? 'invite' : 'turn';
  const scope = self.registration.scope;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (wins) => {
    const win = wins.find((w) => w.url.startsWith(scope));
    if (win) {
      await win.focus().catch(() => undefined);
      win.postMessage({ type: 'brp-open', kind, code });
      return;
    }
    // Your turn: straight back to the table (joining a table you're at just sits you back down).
    // An invite: the game opens and shows the invite with Join and Watch.
    await self.clients.openWindow(kind === 'turn' && code ? `${scope}?join=${code}` : scope);
  }));
});

/** Fresh from the server (skipping the browser's HTTP cache), saved for offline; the saved copy if that fails. */
async function networkFirst(req, url) {
  const cache = await caches.open(CACHE);
  // Query strings like ?watch=CODE are the same page.
  const key = url.origin + url.pathname;
  const saved = await cache.match(key);
  const fresh = fetch(req.mode === 'navigate' ? url.href : req, { cache: 'no-cache', credentials: 'same-origin' })
    .then((res) => {
      if (res.ok && res.type === 'basic') void cache.put(key, res.clone());
      return res;
    });
  if (!saved) return fresh;
  const slow = new Promise((resolve) => setTimeout(() => resolve(saved), SLOW_MS));
  return Promise.race([fresh.catch(() => saved), slow]);
}

/** Google Fonts files never change under the same URL, so the saved copy is used when there is one. */
async function fonts(req) {
  const cache = await caches.open(FONTS);
  const saved = await cache.match(req);
  const fresh = fetch(req).then((res) => {
    if (res.ok || res.type === 'opaque') void cache.put(req, res.clone());
    return res;
  });
  if (saved) {
    fresh.catch(() => {});
    return saved;
  }
  return fresh;
}
