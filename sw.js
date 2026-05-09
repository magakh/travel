// Travel app service worker — handles background notifications
const CACHE = 'travel-sw-v1';

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Check for due reminders every minute via periodic sync or message
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'CHECK_REMINDERS') {
    checkAndFireReminders(e.data.reminders);
  }
});

// Triggered by periodic background sync (where supported)
self.addEventListener('periodicsync', e => {
  if (e.tag === 'reminder-check') {
    e.waitUntil(
      self.clients.matchAll().then(clients => {
        if (!clients.length) checkStoredReminders();
      })
    );
  }
});

async function checkStoredReminders() {
  // Attempt to read from cache storage as simple KV
  try {
    const cache = await caches.open(CACHE);
    const resp = await cache.match('reminders');
    if (!resp) return;
    const reminders = await resp.json();
    checkAndFireReminders(reminders);
  } catch(e) {}
}

function checkAndFireReminders(reminders) {
  if (!reminders || !reminders.length) return;
  const now = Date.now();
  reminders.forEach(r => {
    const msUntil = r.fireAt - now;
    if (msUntil <= 0 && msUntil > -120000) { // due within last 2 mins
      self.registration.showNotification('⏰ ' + r.name, {
        body: 'Starting at ' + r.time + ' — leave now to arrive on time!',
        icon: '/travel/favicon.ico',
        badge: '/travel/favicon.ico',
        tag: 'booking-' + r.name,
        requireInteraction: true,
        data: { url: r.url }
      });
    }
  });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/travel/Trip.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        if (c.url.includes('Trip.html')) { c.focus(); return; }
      }
      return self.clients.openWindow(url);
    })
  );
});
