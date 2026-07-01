/**
 * Skycare — Firebase Cloud Messaging Service Worker
 * Handles push notifications when the app is in the background or closed
 */

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyA7BHDcP-PVTpsaNu9TTWCnChfI0bnOLi8",
  authDomain: "groomer-ykf.firebaseapp.com",
  projectId: "groomer-ykf",
  storageBucket: "groomer-ykf.firebasestorage.app",
  messagingSenderId: "384366195372",
  appId: "1:384366195372:web:35d38ffbc947188d4a6509"
});

const messaging = firebase.messaging();

// Handle background push notifications
messaging.onBackgroundMessage((payload) => {
  console.log('Background message received:', payload);

  const { title, body, icon } = payload.notification || {};

  self.registration.showNotification(title || '✈ Skycare', {
    body: body || '☕ Hurry... gotta make coffee!',
    icon: icon || './icon-192.svg',
    badge: './icon-192.svg',
    tag: 'skycare-coffee',
    renotify: true,
    vibrate: [200, 100, 200],
    actions: [
      { action: 'open', title: 'Open Skycare' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  });
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If app is already open, focus it
      for (const client of clientList) {
        if (client.url.includes('groomers-ykf') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) {
        return clients.openWindow('https://aristihernandez-svg.github.io/groomers-ykf/');
      }
    })
  );
});
