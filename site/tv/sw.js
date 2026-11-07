// AMA TV: keeps each photo and video on the screen after its first download, so it comes from Supabase only once
// (the files never change: every upload gets a new name). Saves Supabase egress, and videos start straight away.
const CACHE = 'ama-tv-media-v1';
const MEDIA = /\/storage\/v1\/object\/public\/tv\//;
const inflight = new Map();   // a video asks for several parts at once: download it once

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || !MEDIA.test(e.request.url)) return;
  e.respondWith(serve(e.request));
});

async function whole(url) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url);
  if (hit) return hit;
  if (!inflight.has(url)) {
    inflight.set(url, (async () => {
      const net = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (net.ok) await cache.put(url, net.clone());
      return net;
    })().finally(() => setTimeout(() => inflight.delete(url), 1000)));
  }
  return (await inflight.get(url)).clone();
}

async function serve(req) {
  try {
    const url = req.url.split('#')[0], res = await whole(url);
    const range = req.headers.get('range');
    if (!range || !res.ok) return res;
    // Videos ask for a part of the file: cut it from the saved copy
    const blob = await res.blob(), size = blob.size, m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    let start = m[1] ? +m[1] : 0, end = m[2] ? +m[2] : size - 1;
    if (!m[1] && m[2]) { start = Math.max(0, size - +m[2]); end = size - 1; }
    end = Math.min(end, size - 1);
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(blob.slice(start, end + 1), { status: 206, headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
  } catch (e) {
    return fetch(req);   // anything odd: just download it as normal
  }
}
