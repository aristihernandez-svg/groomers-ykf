// Groomers YKF — Service Worker v3
// Strategy: network-first, wipe all old caches on activate

const CACHE = 'groomers-v50';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('message', e => {
  if(e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ── Push notifications (FCM via GitHub Actions) ──
self.addEventListener('push', e => {
  let data = { title: '✈ Skycare', body: '☕ Hurry... gotta make coffee!' };
  try { if(e.data) data = e.data.json(); } catch(_) {}
  e.waitUntil(
    self.registration.showNotification(data.title || '✈ Skycare', {
      body: data.body,
      icon: '/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
      badge: '/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
      tag: data.tag || 'skycare',
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: data.url || 'https://aristihernandez-svg.github.io/groomers-ykf/' }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || 'https://aristihernandez-svg.github.io/groomers-ykf/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for(const c of list) {
        if(c.url.includes('groomers-ykf') && 'focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
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
