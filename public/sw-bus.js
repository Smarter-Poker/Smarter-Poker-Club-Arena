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
// How stale a cached media entry may be before it is REALLY revalidated.
// See the media branch of the fetch handler for why this number has to exist.
const MEDIA_REVALIDATE_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Age of a cached response, from the origin's own Date header.
 *
 * Returns Infinity when there is no usable Date, which makes an unknown age
 * behave as "revalidate now". That is the safe direction: the failure this
 * whole mechanism exists to prevent is serving something old forever, so an
 * entry we cannot date should be checked, not trusted.
 */
function cachedAgeMs(response) {
  const raw = response && response.headers.get('date');
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? Date.now() - parsed : Infinity;
}
const MAX_CACHE_ENTRIES = 400; // Evict oldest chunk entries beyond this (a full
// deploy emits ~330 hashed chunks, so 300 could evict live code mid-session)
const MAX_MEDIA_ENTRIES = 600; // Cards (104/deck-style) + tiles + icons + logos fit comfortably

// App-shell assets to warm at install time. EMPTY in source — the build
// (scripts/optimize-dist-media.mjs) injects the entry chunk, modulepreloaded
// vendors and entry CSS for the exact bundle being deployed, and stamps
// DEPLOY_TS above with the build time. With this, a returning player gets the
// whole shell from cache even if HTTP cache was evicted, and the new SW
// pre-fetches the new hashed chunks the moment a deploy lands.
const PRECACHE_URLS = [];

// The canonical cache key for the SPA shell document. Every /hub/club-arena/*
// navigation serves the same index.html (SPA fallback rewrite), so all of
// them share one cached entry.
const SHELL_KEY = '/hub/club-arena';

// The shell entries are inserted FIRST, at install, so a naive oldest-first
// eviction deletes exactly the files the app cannot boot without. Anything in
// this set is exempt from trimming for the life of the versioned cache.
const PROTECTED_PATHS = new Set([SHELL_KEY, '/hub/club-arena/offline.html', ...PRECACHE_URLS]);

// Documents under /hub/club-arena/ that are NOT the SPA shell. The standalone
// Diamond bonus test entry (dist/diamond-test.html; its own hashed chunks sit
// in /assets/ as diamond-test.*) is a different page: served from SHELL_KEY it would boot the
// arena in place of the test page, and stored under SHELL_KEY it would boot the
// test page in place of the arena for every navigation until the next
// revalidation. These bypass shellFromCache and always go to the network.
const STANDALONE_DOCUMENTS = new Set(['/hub/club-arena/diamond-test.html']);

/**
 * Trim cache to maxEntries — prevents unbounded growth across deploys.
 * Each deploy creates new hashed filenames; old ones stay cached forever without this.
 *
 * 2026-08-24: this used to evict oldest-first with no exemptions. The shell,
 * the entry chunk and the vendor chunks are written at install and are
 * therefore the OLDEST entries in the cache, so the first trim past the cap
 * threw away precisely the boot set the precache exists to hold — and the
 * cache-first shell below would then serve an HTML file whose scripts were
 * gone. Protected paths are skipped, and the cap is measured against the
 * evictable remainder.
 */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const evictable = keys.filter((req) => {
    try {
      return !PROTECTED_PATHS.has(new URL(req.url).pathname);
    } catch {
      return true;
    }
  });
  // Delete oldest evictable entries (first in = oldest), 50 extra for headroom
  const deleteCount = Math.min(evictable.length, keys.length - maxEntries + 50);
  for (let i = 0; i < deleteCount; i++) {
    await cache.delete(evictable[i]);
  }
}

/**
 * CACHE-FIRST navigation, revalidated in the background.
 *
 * 2026-08-24 — this was network-first with a 3.5s deadline, and that deadline
 * was being paid by every single entry into Club Arena. Tapping the tile in
 * the World Hub blocked on a full HTML round trip to Vercel before one byte of
 * the app could start, even though a byte-identical shell was already sitting
 * in this cache from install. On a phone that is 300-800ms of nothing, and it
 * is the first thing the player experiences.
 *
 * The shell is now returned from cache immediately — no network in the
 * critical path at all — and a fresh copy is fetched alongside it to update
 * the cache for next time.
 *
 * WHY A STALE SHELL IS SAFE HERE, which is the whole question:
 *
 *  - The shell and the exact hashed chunks it references are precached
 *    TOGETHER, in the same deploy-versioned cache, by the install handler
 *    below. A cached shell can therefore always resolve its own scripts from
 *    cache-first even after the server has rotated to new filenames.
 *  - trimCache above will not evict that set, which is what would otherwise
 *    break this the moment a session touched 400 chunks.
 *  - A new deploy ships a new sw-bus.js (DEPLOY_TS changes), so the browser
 *    installs a new SW, precaches the NEW shell + chunks, skipWaiting()s and
 *    claims. The following navigation serves the new shell. One extra
 *    navigation of latency on a deploy, in exchange for removing a round trip
 *    from every navigation.
 *  - When the background revalidation shows the shell has changed under a
 *    still-current SW, clients are told, so the app can refresh itself at a
 *    moment of its own choosing rather than mid-hand (see SHELL_UPDATED).
 *
 * ── THE BOUNDED FRESHNESS RACE (Dan 2026-08-29) ────────────────────────────
 *
 * Pure cache-first had a visible cost Dan ordered stopped: open Club Arena
 * right after a deploy (which, at this repo's deploy cadence, is MOST opens)
 * and the app boots the one-deploy-old shell, then SHELL_UPDATED lands and
 * useShellUpdateGate hard-reloads the page seconds after it painted. Dan:
 * "it like glitches and reloads... it looks like broken code."
 *
 * So the revalidation fetch — which was already being made on every
 * navigation — is now given a short, fixed budget to answer BEFORE the
 * cached shell is returned. If the network wins, the session boots the
 * CURRENT shell and there is nothing to reload later: no glitch at all.
 * If the budget expires first, the cached shell is served exactly as
 * before and the gate remains the (verified) fallback.
 *
 * This is NOT the 2026-08-24 network-first regression coming back:
 *  - the deadline is SHELL_FRESH_RACE_MS, not 3500ms, and on expiry the
 *    answer is the instant cached shell, never a spinner;
 *  - offline rejects the fetch immediately, so the offline path costs ~0ms;
 *  - the request was already on the wire for revalidation — the race adds
 *    no network traffic, only a bounded wait for work already in flight.
 */
const SHELL_FRESH_RACE_MS = 300;

async function shellFromCache(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(SHELL_KEY);

  const revalidate = fetch(event.request, { cache: 'no-cache' })
    .then(async (response) => {
      if (!response || !response.ok) return response;
      // Compare before storing so we can tell clients something actually moved.
      let changed = false;
      if (cached) {
        try {
          const [before, after] = await Promise.all([cached.clone().text(), response.clone().text()]);
          changed = before !== after;
        } catch {
          /* comparison is best-effort */
        }
      }
      await cache.put(SHELL_KEY, response.clone());
      if (changed) {
        const clients = await sw.clients.matchAll({ type: 'window' });
        clients.forEach((c) => c.postMessage({ type: 'SHELL_UPDATED' }));
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // The bounded freshness race — see the block comment above. The fetch is
    // already in flight for revalidation; give it SHELL_FRESH_RACE_MS to land
    // so a post-deploy entry can boot the current shell instead of booting
    // stale and being reloaded out from under the player seconds later.
    const fresh = await Promise.race([
      revalidate,
      new Promise((resolve) => setTimeout(resolve, SHELL_FRESH_RACE_MS)),
    ]);
    if (fresh && fresh.ok) {
      // revalidate has fully settled (compare + cache.put done); the response
      // body itself is unconsumed — only clones were read. Serve it.
      return fresh;
    }
    // Keep the revalidation alive past the response we are about to return.
    event.waitUntil(revalidate);
    return cached;
  }

  // Nothing cached yet (first ever visit, or the cache was cleared): this is
  // the only path that waits on the network, and it is once per device.
  const fresh = await revalidate;
  if (fresh && fresh.ok) return fresh;
  const offline = await cache.match('/hub/club-arena/offline.html');
  if (offline) return offline;
  return fresh || fetch(event.request);
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

  // Navigations into Club Arena: CACHE-FIRST, revalidated in the background.
  // The shell HTML is precached at install time TOGETHER with the chunks it
  // references (same versioned cache), so what we serve is always internally
  // consistent. See shellFromCache above for why serving a shell that may be
  // one deploy old is the right trade here.
  const isClubArenaNav =
    (event.request.mode === 'navigate' || event.request.destination === 'document') &&
    (url.pathname === '/hub/club-arena' || url.pathname.startsWith('/hub/club-arena/')) &&
    !STANDALONE_DOCUMENTS.has(url.pathname);
  if (isClubArenaNav) {
    event.respondWith(shellFromCache(event));
    return;
  }

  // CRITICAL: other HTML/documents are never intercepted — always fresh.
  if (!isMedia &&
      (event.request.mode === 'navigate' ||
      event.request.destination === 'document' ||
      url.pathname.endsWith('.html') ||
      url.pathname.endsWith('/') ||
      url.pathname === '/hub/club-arena' ||
      (url.pathname.startsWith('/hub/club-arena/') &&
        !url.pathname.includes('/assets/') &&
        !url.pathname.includes('/fonts/')))) {
    // Let the browser handle navigation requests normally (network-first)
    return;
  }

  // WHAT COUNTS AS AN IMMUTABLE ASSET — path, not filename shape.
  //
  // 2026-08-23: this was /[-.][a-zA-Z0-9_]{4,}\.(js|css)$/ and it matched NONE
  // of the files this build produces. vite.config.ts emits
  // `assets/[name]-[hash]-v6.js`, so every chunk ends `-v6.js`; the regex
  // needed four or more characters between the last separator and the
  // extension and `v6` is two. Measured against the live bundle:
  //
  //   index-jBJgC_ty-v6.js        false
  //   vendor-react-BPB2zS-3-v6.js false
  //   index-C3-fYKPl-v6.css       false
  //   TablePage-Iv6ZwCFl-v6.js    false
  //
  // So the cache-first branch below was dead for every real asset. The
  // versioned cache was filled at install by PRECACHE_URLS and then never
  // read: chunks went to the network on every load, the offline app shell
  // booted to a shell whose scripts could not load, and the 503
  // chunk-load-failed recovery path never ran. The `-v6` suffix has been
  // there since long before the precache was added, so this never worked.
  //
  // Matching on the DIRECTORY is precise and cannot drift with the filename
  // template: /assets/ and /fonts/ are exactly the two directories the
  // precache scanner collects from (scripts/optimize-dist-media.mjs), and
  // both are content-hashed and served immutable. sw-bus.js itself sits at
  // the club-arena root, so it is not matched here and keeps revalidating.
  const isHashedAsset =
    (url.pathname.startsWith('/hub/club-arena/assets/') ||
      url.pathname.startsWith('/hub/club-arena/fonts/')) &&
    /\.(js|css)$/.test(url.pathname);
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
    // ─────────────────────────────────────────────────────────────────────
    // STALE-WHILE-REVALIDATE, AND THIS TIME THE REVALIDATE HALF RUNS
    // ─────────────────────────────────────────────────────────────────────
    // The previous version called plain `fetch(event.request)` here and the
    // comment above it claimed the revalidation was "answered by the
    // browser's HTTP cache — no network cost". That was true, and it was the
    // bug. A default fetch for a response still inside its freshness window
    // never reaches the server, and these paths are served
    // `Cache-Control: public, max-age=2592000`. So the background half was a
    // no-op for THIRTY DAYS, and MEDIA_CACHE is not versioned, so a file
    // replaced at the same path was invisible to every returning player,
    // indefinitely.
    //
    // Measured on production 2026-08-28: the satellite icon had been
    // replaced twice and shipped correctly both times. A `fetch` from inside
    // the page with `cache: 'reload'` still returned the ORIGINAL 19,441-byte
    // artwork, because `cache: 'reload'` bypasses the HTTP cache but not this
    // service worker. curl, which has neither, got the new bytes. Two clients
    // on one machine seeing different images is what sent us looking here.
    //
    // THE FIX IS TWO PARTS, AND BOTH ARE LOAD-BEARING:
    //
    // 1. `cache: 'no-cache'` on the background request. That forces a
    //    CONDITIONAL request — the browser sends If-None-Match with the
    //    stored ETag — so the server actually gets asked. Unchanged media
    //    answers 304 with no body, which is a few hundred bytes, not the
    //    image. This is the line that makes the word "revalidate" true.
    //
    // 2. A 6-hour floor before we bother. Without it, part 1 would put a
    //    conditional request on the wire for EVERY image on EVERY page view —
    //    roughly 120 of them on a table, on a phone, on cellular — to
    //    discover that ~all of them are unchanged. Below the floor we return
    //    the cached copy and touch the network zero times, exactly as before.
    //
    // So a media file replaced at a stable path now reaches everyone within
    // one revalidation window instead of never. That is a repair, not a
    // licence: version the FILENAME when you replace artwork you need people
    // to see immediately (`satellite-winner-v3.png`, `btn-hamburger-v4.png`),
    // because a new URL is correct on the very first paint and this is only
    // correct on the next one.
    //
    // `event.waitUntil` keeps the worker alive for the background half. We
    // have already handed the page a response by then, and without it the
    // browser is free to kill the worker mid-write and the cache never
    // updates — which would leave this looking fixed while behaving exactly
    // as it did before.
    event.respondWith(
      caches.open(MEDIA_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached && cachedAgeMs(cached) < MEDIA_REVALIDATE_AFTER_MS) {
            return cached;
          }

          const revalidate = fetch(
            new Request(event.request, { cache: 'no-cache' })
          ).then((response) => {
            if (response.ok) {
              cache.put(event.request, response.clone());
              trimCache(MEDIA_CACHE, MAX_MEDIA_ENTRIES);
            }
            return response;
          }).catch(() => {
            // Offline: the cached copy, however old, beats a broken image.
            if (cached) return cached;
            // No cache and no network. An empty PNG keeps the layout intact
            // rather than surfacing a browser error glyph mid-hand.
            return new Response(new Uint8Array(0), {
              status: 200,
              headers: { 'Content-Type': 'image/png' },
            });
          });

          if (cached) {
            event.waitUntil(revalidate);
            return cached;
          }
          return revalidate;
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
            const rawName = payload?.clubName || payload?.clubId || '';
            body = rawName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
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
