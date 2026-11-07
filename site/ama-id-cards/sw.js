// AMA ID Cards: keeps the app working when the signal drops.
// The app itself is fetched fresh when possible and served from the phone when not.
// Libraries and fonts never change at the same address, so they are kept once downloaded.
// Supabase requests (member data) are never stored here.

const CACHE = 'ama-cards-v10';
const SHELL = ['./', './index.html', './config.js', './hub-signin.js', './manifest.webmanifest', './icon-192.png', './apple-touch-icon.png'];
const LIB_HOSTS = /(^|\.)(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function store(req, res) {
  if (res && (res.ok || res.type === 'opaque')) {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy));
  }
  return res;
}

// Try the network, but give up after a few seconds on a weak signal
function networkFirst(req) {
  // no-cache: always check with GitHub for a newer version instead of using the browser's 10-minute copy
  const fromNetwork = fetch(req, { cache: 'no-cache' }).then(res => store(req, res));
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000));
  return Promise.race([fromNetwork, timeout]).catch(() =>
    caches.match(req).then(hit => hit || fromNetwork.catch(() => caches.match('./index.html')))
  );
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req));
  } else if (LIB_HOSTS.test(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => store(req, res))));
  }
  // Everything else (Supabase) goes straight to the network as normal
});

// ---------- Notifications ----------
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'AMA ID Cards', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) {
        c.postMessage({ open: 'queue' });
        return c.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
