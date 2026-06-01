// IndoResto Service Worker — PWA Offline Support
const CACHE_NAME = 'indoresto-v1';
const OFFLINE_URL = '/offline.html';

const STATIC_ASSETS = [
  '/',
  '/apps/queue/',
  '/apps/menu/',
  '/apps/kds/',
  '/apps/server-tablet/',
  '/apps/payment/',
  '/offline.html',
  '/public/manifest.json',
  'https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=DM+Sans:wght@400;500;600&display=swap',
];

// ── INSTALL: pre-cache all static assets ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── ACTIVATE: clean up old caches ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── FETCH: network-first for API, cache-first for static ──
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API calls: network-first, no cache
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
    event.respondWith(
      fetch(request).catch(() => new Response(
        JSON.stringify({ error: 'offline', message: 'Tidak ada koneksi internet' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      ))
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          // Cache successful GET responses
          if (request.method === 'GET' && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Return offline page for navigation requests
          if (request.mode === 'navigate') {
            return caches.match(OFFLINE_URL);
          }
        });
    })
  );
});

// ── BACKGROUND SYNC: queue order mutations when offline ──
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-orders') {
    event.waitUntil(syncPendingOrders());
  }
  if (event.tag === 'sync-queue') {
    event.waitUntil(syncPendingQueue());
  }
});

async function syncPendingOrders() {
  const db = await openDB();
  const pending = await db.getAll('pending-orders');
  for (const order of pending) {
    try {
      await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order),
      });
      await db.delete('pending-orders', order.id);
    } catch (err) {
      console.error('Sync failed for order', order.id, err);
    }
  }
}

async function syncPendingQueue() {
  const db = await openDB();
  const pending = await db.getAll('pending-queue');
  for (const entry of pending) {
    try {
      await fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
      await db.delete('pending-queue', entry.id);
    } catch (err) {
      console.error('Sync failed for queue entry', entry.id, err);
    }
  }
}

// Simple IndexedDB wrapper
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('indoresto-offline', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pending-orders')) {
        db.createObjectStore('pending-orders', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('pending-queue')) {
        db.createObjectStore('pending-queue', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve({
      getAll: (store) => new Promise((res, rej) => {
        const tx = e.target.result.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      }),
      delete: (store, key) => new Promise((res, rej) => {
        const tx = e.target.result.transaction(store, 'readwrite');
        const req = tx.objectStore(store).delete(key);
        req.onsuccess = () => res();
        req.onerror = () => rej(req.error);
      }),
    });
    req.onerror = () => reject(req.error);
  });
}

// ── PUSH NOTIFICATIONS: kitchen ready alerts ──
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const options = {
    body: data.body || 'Pesanan siap disajikan',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: data.tag || 'order-ready',
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: data.url || '/apps/server-tablet/' },
    actions: [
      { action: 'serve', title: '✓ Sajikan', icon: '/icons/action-serve.png' },
      { action: 'dismiss', title: 'Tutup' },
    ],
  };
  event.waitUntil(self.registration.showNotification(data.title || '🔔 IndoResto', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'serve') {
    event.waitUntil(clients.openWindow('/apps/server-tablet/'));
  } else if (event.notification.data?.url) {
    event.waitUntil(clients.openWindow(event.notification.data.url));
  }
});
