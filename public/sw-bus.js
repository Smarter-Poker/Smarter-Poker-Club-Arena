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
const DEPLOY_TS = '20260822000000';
// PERF PASS 2026-08-22: two caches instead of one.
// - CHUNK_CACHE is versioned by deploy: hashed JS/CSS filenames change every
//   build, so old entries are dead weight the moment a new SW activates.
// - MEDIA_CACHE is deliberately NOT versioned: cards, tiles, icons, logos and
//   videos keep the same URLs across deploys. Nuking them on every deploy
//   (the old behavior) forced players to re-download ~60 MB of media that had
//   not changed. Media staleness is handled by stale-while-revalidate below.
const CACHE_NAME = `club-arena-${DEPLOY_TS}`;
const MEDIA_CACHE = 'club-arena-media-v1';
const MAX_CACHE_ENTRIES = 300; // Evict oldest chunk entries beyond this
const MAX_MEDIA_ENTRIES = 600; // Cards (104/deck-style) + tiles + icons + logos fit comfortably

// App-shell assets to warm at install time. EMPTY in source — the build
// (scripts/optimize-dist-media.mjs) injects the entry chunk, modulepreloaded
// vendors and entry CSS for the exact bundle being deployed, and stamps
// DEPLOY_TS above with the build time. With this, a returning player gets the
// whole shell from cache even if HTTP cache was evicted, and the new SW
// pre-fetches the new hashed chunks the moment a deploy lands.
const PRECACHE_URLS = [];

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

// The canonical cache key for the SPA shell document. Every /hub/club-arena/*
// navigation serves the same index.html (SPA fallback rewrite), so all of
// them share one cached entry.
const SHELL_KEY = '/hub/club-arena';

/**
 * Network-first navigation with a 3.5s deadline. A fresh response updates the
 * cached shell; a timeout, network error, or 5xx serves the shell that was
 * precached at install alongside its exact chunks.
 */
async function networkFirstShell(request) {
  const cache = await caches.open(CACHE_NAME);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      cache.put(SHELL_KEY, response.clone());
      return response;
    }
    // Server error: prefer the known-good cached shell over an error page
    const cached = await cache.match(SHELL_KEY);
    return cached || response;
  } catch (err) {
    clearTimeout(timer);
    const cached = await cache.match(SHELL_KEY);
    if (cached) return cached;
    const offline = await cache.match('/hub/club-arena/offline.html');
    if (offline) return offline;
    throw err;
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

  // Media files are cacheable regardless of which directory serves them.
  // PERF PASS 2026-08-22: the old navigation guard below excluded EVERYTHING
  // under /hub/club-arena/ except /assets/ — which meant cards/, images/,
  // game-card-icons/, club-logos/ and videos/ (the ~60 MB that actually makes
  // the table and lobby feel slow) were never cached by this SW at all.
  const isMedia = /\.(png|jpg|jpeg|webp|avif|svg|gif|ico|mp4|webm|woff2?)$/i.test(url.pathname);

  // Navigations into Club Arena: NETWORK-FIRST so deploys propagate exactly
  // as before, but with a fast fallback to the precached app shell when the
  // network is slow (>3.5s) or down. The shell HTML is precached at install
  // time TOGETHER with the chunks it references (same versioned cache), so
  // the fallback is always internally consistent — this is what lets the app
  // boot instantly on a dead connection instead of white-screening.
  const isClubArenaNav =
    (event.request.mode === 'navigate' || event.request.destination === 'document') &&
    (url.pathname === '/hub/club-arena' || url.pathname.startsWith('/hub/club-arena/'));
  if (isClubArenaNav) {
    event.respondWith(networkFirstShell(event.request));
    return;
  }

  // CRITICAL: other HTML/documents are never intercepted — always fresh.
  if (!isMedia &&
      (event.request.mode === 'navigate' ||
      event.request.destination === 'document' ||
      url.pathname.endsWith('.html') ||
      url.pathname.endsWith('/') ||
      url.pathname === '/hub/club-arena' ||
      (url.pathname.startsWith('/hub/club-arena/') && !url.pathname.includes('/assets/')))) {
    // Let the browser handle navigation requests normally (network-first)
    return;
  }

  const isHashedAsset = /[-\.][a-zA-Z0-9_]{4,}\.(js|css)$/.test(url.pathname);
  const isImage = isMedia;

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
    // Stale-while-revalidate: show cached media instantly, update in background.
    // With the long-lived Cache-Control headers on these paths, the background
    // revalidation is answered by the browser's HTTP cache — no network cost.
    event.respondWith(
      caches.open(MEDIA_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          const fetchPromise = fetch(event.request).then((response) => {
            if (response.ok) {
              cache.put(event.request, response.clone());
              trimCache(MEDIA_CACHE, MAX_MEDIA_ENTRIES);
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

// Install: precache the app shell — the HTML document AND the chunk/CSS list
// the build injected for this exact deploy — into the versioned cache, then
// activate immediately. Fetch failures (offline install, mid-deploy 404) are
// swallowed — the runtime paths cover anything missed.
sw.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            const jobs = PRECACHE_URLS.map((url) =>
                fetch(url).then((res) => {
                    if (res.ok) return cache.put(url, res);
                }).catch(() => {})
            );
            // The shell document, stored under its canonical key so every
            // /hub/club-arena/* navigation can fall back to it. cache:
            // 'no-cache' forces revalidation so the snapshot matches the
            // deploy that shipped this SW version.
            jobs.push(
                fetch('/hub/club-arena', { cache: 'no-cache' }).then((res) => {
                    if (res.ok) return cache.put(SHELL_KEY, res);
                }).catch(() => {})
            );
            jobs.push(
                fetch('/hub/club-arena/offline.html').then((res) => {
                    if (res.ok) return cache.put('/hub/club-arena/offline.html', res);
                }).catch(() => {})
            );
            return Promise.allSettled(jobs);
        }).then(() => sw.skipWaiting())
    );
});

// Activate: claim clients + clean up old caches
sw.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            sw.clients.claim(),
            // Clean up any old cache versions
            caches.keys().then((keys) =>
                Promise.all(
                    keys
                        .filter((key) => key !== CACHE_NAME && key !== MEDIA_CACHE)
                        .map((key) => caches.delete(key))
                )
            ),
        ])
    );
});

