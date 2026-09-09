// sw.js — Service worker MyWattUp
// À servir depuis la racine du site (https://tondomaine.com/sw.js)
// pour pouvoir contrôler toutes les pages de l'app.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Réception d'une notification push envoyée par /api/send-reminders
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'MyWattUp', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'MyWattUp';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icons/apple-touch-icon.png',
    badge: payload.badge || '/icons/favicon-32.png',
    data: { url: payload.url || '/#dashboard' },
    tag: payload.tag || 'mywattup-notification',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Clic sur la notification : ouvre ou refocus l'app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/#dashboard';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
