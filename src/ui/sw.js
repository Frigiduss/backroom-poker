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
