// AMA Toolkit: Grading Floor offline copy. Keeps the floor page and everything it loads on this device so it opens
// with no signal. Our own files: network first (a new deploy shows up straight away), this device's copy if there's
// no signal. Libraries and fonts from CDNs: this device's copy first. Supabase (the data) is never cached here;
// offline.js handles that.
const CACHE = 'ama-floor-v1';
const SHELL = ['/grading/floor/', '/grading/floor/event.js', '/grading/floor/offline.js', '/grading/floor/manifest.webmanifest',
  '/config.js', '/hub-signin.js', '/idle-logout.js', '/icons/ama-id-cards.png', '/icons/ama-apple-touch.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js',
  'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('ama-floor-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), ms))]);
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || /supabase\.co$/.test(url.hostname)) return;
  const ours = url.origin === self.location.origin;
  const cdn = /(^|\.)jsdelivr\.net$|fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!ours && !cdn) return;
  if (ours) {
    // the floor page itself (any ?day=...) and our scripts: network first, fall back to the copy here
    const key = req.mode === 'navigate' ? '/grading/floor/' : req;
    e.respondWith(timeout(fetch(req), 4000).then(r => { if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(key, cp)); } return r; })
      .catch(() => caches.match(key, { ignoreSearch: true }).then(m => m || caches.match('/grading/floor/'))));
    return;
  }
  e.respondWith(caches.match(req).then(m => m || fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return r; })));
});
