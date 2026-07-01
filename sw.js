// Groomers YKF — Service Worker v2
// Strategy: network-first, wipe all old caches on activate

const CACHE = 'groomers-v5';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('message', e => {
  if(e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Always try network first; fall back to cache for offline
  if(e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        // Cache a copy for offline fallback (only same-origin, OK responses)
        if(resp.ok && e.request.url.startsWith(self.location.origin)) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(()=>{});
        }
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
