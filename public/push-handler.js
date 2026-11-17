self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data ? event.data.text() : '' }; }
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'نقطة الشحن';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : 'تمت إضافة تحديث جديد.',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: typeof payload.tag === 'string' ? payload.tag : 'chargerpoint-update',
    data: { url: typeof payload.url === 'string' ? payload.url : '/public/about' },
    renotify: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = event.notification && event.notification.data && event.notification.data.url;
  const target = new URL(typeof raw === 'string' ? raw : '/public/about', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
    for (const client of clients) {
      if ('focus' in client) {
        if ('navigate' in client) await client.navigate(target.href);
        return client.focus();
      }
    }
    return self.clients.openWindow(target.href);
  }));
});
