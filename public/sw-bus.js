/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Service Worker — Asset Cache + MasterBus Background Notifications
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two responsibilities:
 * 1. CACHE-FIRST for hashed JS/CSS chunks — eliminates re-download on re-entry
 * 2. Background notifications via MasterBus postMessage
 *
 * Cache strategy:
 * - JS/CSS files with content hashes (e.g., HomePage-abc123.js) → Cache-first
 *   These files are immutable (hash changes on content change), so cache-first
 *   is safe and gives instant loads on re-entry from the World Hub.
 * - Images → Stale-while-revalidate (show cached, update in background)
 * - HTML/API → Network-first (always fresh)
 */

// eslint-disable-next-line no-restricted-globals
const sw = self;

// DEPLOY VERSION — updated by CI/build to bust the service worker cache.
// When this changes, the browser detects a new SW → install → activate → clears old caches.
// Format: ISO timestamp of last deploy. Update via: sed -i "s/DEPLOY_TS.*/DEPLOY_TS = '$(date -u +%Y%m%d%H%M%S)';/" public/sw-bus.js
const DEPLOY_TS = '20260417223500';
const CACHE_NAME = `club-arena-${DEPLOY_TS}`;
const MAX_CACHE_ENTRIES = 200; // Evict oldest entries when cache grows beyond this

/**
 * Trim cache to MAX_CACHE_ENTRIES — prevents unbounded growth across deploys.
 * Each deploy creates new hashed filenames; old ones stay cached forever without this.
 */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    // Delete oldest entries (first in = oldest)
    const deleteCount = keys.length - maxEntries + 50; // Batch-delete 50 extra for headroom
    for (let i = 0; i < deleteCount; i++) {
      await cache.delete(keys[i]);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ASSET CACHING — Cache-first for immutable hashed chunks
// ═══════════════════════════════════════════════════════════════════════════════

sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only cache same-origin requests
  if (url.origin !== sw.location.origin) return;

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip API, auth, and realtime requests
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/auth/') ||
      url.pathname.includes('supabase') ||
      url.pathname.includes('realtime')) return;

  // CRITICAL: Never intercept HTML navigation requests — always serve fresh from network.
  // This prevents the SW from serving a stale index.html that references old chunk hashes.
  if (event.request.mode === 'navigate' ||
      event.request.destination === 'document' ||
      url.pathname.endsWith('.html') ||
      url.pathname.endsWith('/') ||
      url.pathname === '/hub/club-arena' ||
      url.pathname.startsWith('/hub/club-arena/') && !url.pathname.includes('/assets/')) {
    // Let the browser handle navigation requests normally (network-first)
    return;
  }

  const isHashedAsset = /[-\.][a-zA-Z0-9_]{4,}\.(js|css|woff2?)$/.test(url.pathname);
  const isImage = /\.(png|jpg|jpeg|webp|svg|gif|ico)$/.test(url.pathname);

  if (isHashedAsset) {
    // Cache-first: hashed assets are immutable — serve from cache if available
    // With network fallback: if cached response is somehow corrupt/stale, try network
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((response) => {
            if (response.ok) {
              cache.put(event.request, response.clone());
              // Async eviction — don't block response
              trimCache(CACHE_NAME, MAX_CACHE_ENTRIES);
            }
            return response;
          }).catch(() => {
            // Network failed and no cache — return a proper error so the app
            // can trigger its chunk-reload recovery logic instead of hanging
            return new Response('/* chunk load failed */', {
              status: 503,
              headers: { 'Content-Type': 'application/javascript' },
            });
          });
        })
      )
    );
  } else if (isImage) {
    // Stale-while-revalidate: show cached image instantly, update in background
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(event.request).then((cached) => {
          const fetchPromise = fetch(event.request).then((response) => {
            if (response.ok) {
              cache.put(event.request, response.clone());
            }
            return response;
          }).catch(() => {
            // Offline: return cached version, or a transparent 1x1 PNG if nothing cached
            if (cached) return cached;
            // No cache + no network = return empty transparent image to prevent crash
            return new Response(new Uint8Array(0), {
              status: 200,
              headers: { 'Content-Type': 'image/png' },
            });
          });

          return cached || fetchPromise;
        })
      )
    );
  }
  // All other requests (API, etc.) fall through to normal network fetch
});

// ═══════════════════════════════════════════════════════════════════════════════
//  MASTER BUS NOTIFICATIONS — Background push for critical events
// ═══════════════════════════════════════════════════════════════════════════════

const EVENT_LABELS = {
    BALANCE_UPDATED: '💰 Balance Updated',
    CLUB_JOINED: '♠️ Club Joined',
    CLUB_LEFT: '🚪 Left Club',
    TABLE_SEATED: '🎯 Seated at Table',
    TABLE_LEFT: '👋 Left Table',
};

sw.addEventListener('message', (event) => {
    if (event.data?.type !== 'BUS_EVENT') return;

    const { type: eventType, payload } = event.data.event || {};
    const title = EVENT_LABELS[eventType] || `🚌 ${eventType}`;

    // Only show notification if page is not visible
    // (clients.matchAll checks if any tab is focused)
    sw.clients.matchAll({ type: 'window', includeUncontrolled: false }).then(clients => {
        const anyFocused = clients.some(c => c.visibilityState === 'visible');
        if (anyFocused) return; // Don't notify if user is looking at the app

        let body = '';
        if (eventType === 'BALANCE_UPDATED') {
            body = `Source: ${payload?.source || 'unknown'}`;
        } else if (eventType === 'CLUB_JOINED' || eventType === 'CLUB_LEFT') {
            body = payload?.clubName || payload?.clubId || '';
        } else if (eventType === 'TABLE_SEATED' || eventType === 'TABLE_LEFT') {
            body = `Table: ${payload?.tableId || ''}`;
        }

        sw.registration.showNotification(title, {
            body,
            icon: '/favicon.ico',
            badge: '/favicon.ico',
            tag: `bus-${eventType}`,
            renotify: true,
            silent: false,
        });
    });
});

// Notification click → focus the app tab
sw.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        sw.clients.matchAll({ type: 'window' }).then(clients => {
            if (clients.length > 0) {
                clients[0].focus();
            } else {
                sw.clients.openWindow('/');
            }
        })
    );
});

// Install: skip waiting so new SW activates immediately
sw.addEventListener('install', () => sw.skipWaiting());

// Activate: claim clients + clean up old caches
sw.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            sw.clients.claim(),
            // Clean up any old cache versions
            caches.keys().then((keys) =>
                Promise.all(
                    keys
                        .filter((key) => key !== CACHE_NAME)
                        .map((key) => caches.delete(key))
                )
            ),
        ])
    );
});

