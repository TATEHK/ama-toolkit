// AMA Gradings: receives phone notifications (e.g. a Black Belt Club card to write).
// Push-only — it deliberately does no offline caching, so the app always loads fresh.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'AMA Gradings', {
    body: d.body || '',
    icon: '/icons/ama-id-cards.png',
    badge: '/icons/ama-id-cards.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/grading/coloured-belts/black-belt-club' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/grading/coloured-belts/black-belt-club';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.indexOf('/grading/coloured-belts/') !== -1 && 'focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
