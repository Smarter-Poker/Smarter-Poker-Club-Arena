/// <reference lib="webworker" />

/**
 * ♠ CLUB ARENA — Service Worker
 * Provides offline support and caching for PWA
 */

const CACHE_NAME = 'club-arena-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.json',
  '/hub/club-arena/poker-chip-logo.png',
];

// Install: Cache static assets
self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  (self as any).skipWaiting();
});

// Activate: Clean old caches
self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      );
    })
  );
  (self as any).clients.claim();
});

// Fetch: Network-first for API, cache-first for assets
self.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip external requests
  if (!url.origin.includes(self.location.origin)) return;

  // API requests: Network first, fallback to cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
          return response;
        })
        .catch(() => caches.match(request) as Promise<Response>)
    );
    return;
  }

  // Navigation requests (HTML): Network only, fallback to offline page
  // Ensures users always get the latest index.html on reload, avoiding white screens
  // and stuck deployments.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful responses in background
          if (response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch(() => caches.match('/offline.html') as Promise<Response>)
    );
    return;
  }

  // Static assets (JS/CSS/images): Cache first, fallback to network
  // Safe because Vite hashes asset filenames, so old cached assets don't conflict.
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cache, but also update in background
        fetch(request).then((response) => {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, response);
          });
        });
        return cachedResponse;
      }

      return fetch(request)
        .then((response) => {
          // Cache successful responses
          if (response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          return new Response('', { status: 408, statusText: 'Offline' });
        });
    })
  );
});

// Push notification handler
self.addEventListener('push', (event: PushEvent) => {
  const data = event.data?.json() || {};

  const options: NotificationOptions = {
    body: data.body || 'New notification from Club Arena',
    icon: '/hub/club-arena/poker-chip-logo.png',
    badge: '/hub/club-arena/poker-chip-logo.png',
    vibrate: [200, 100, 200],
    data: data.url || '/',
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'close', title: 'Dismiss' },
    ],
  };

  event.waitUntil((self as any).registration.showNotification(data.title || 'Club Arena', options));
});

// Notification click handler
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();

  if (event.action === 'close') return;

  event.waitUntil((self as any).clients.openWindow(event.notification.data || '/'));
});

export {};
