/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ChunkPreloader — Aggressive Critical Chunk Preloading
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * After the initial page render, this utility preloads the most commonly visited
 * page chunks during browser idle time. This ensures that when the user navigates
 * from the World Hub back into Club Arena, the JS chunks are already in the
 * browser's HTTP cache — eliminating the biggest source of re-entry latency.
 *
 * Strategy:
 * 1. Wait for initial render to complete (requestIdleCallback)
 * 2. Fire off dynamic import() calls for critical pages (these are the same
 *    imports used by lazyWithRetry in App.tsx)
 * 3. The browser caches the chunks — next time they're needed, it's instant
 *
 * This does NOT increase initial bundle size. Dynamic import() fetches the
 * chunks in the background without blocking the main thread.
 */

// Track whether preloading has already been triggered this session
let preloaded = false;

/**
 * Critical page imports — ordered by visit frequency.
 * These match the lazy() calls in App.tsx exactly.
 */
const CRITICAL_CHUNKS: Array<() => Promise<any>> = [
  () => import('../pages/HomePage'),
  () => import('../pages/ClubHomePage'),
  () => import('../pages/ProfilePage'),
  () => import('../pages/club/ClubDashboard'),
  () => import('../pages/SettingsPage'),
  () => import('../pages/PlayerWalletPage'),
  () => import('../pages/HandHistoryPage'),
  () => import('../pages/CashierPage'),
  () => import('../pages/NotificationsPage'),
  () => import('../pages/NavigateToMessenger'),
  // PERF PASS 2026-08-24 (boot cost): TablePage (~438KB JS + ~389KB CSS) and
  // MultiTablePage were preloaded here. Together they were the bulk of a
  // ~1.7MB speculative download paid by EVERY boot, including by the many
  // sessions that never open a table at all. They are still warmed the moment
  // the player shows intent: ROUTE_CHUNKS['/table/'] below is fired by
  // prefetchIntent() on hover / touchstart / focus of any table row, which
  // lands ~100ms before the tap and is enough to hide the fetch.
  // Do NOT put them back in this list.
  //
  // PlayerStatsPage intentionally NOT preloaded either: it pulls the ~314KB
  // recharts chart bundle, which most users never open. It lazy-loads on
  // navigation instead (route intent), saving that bandwidth on mobile.
];

/**
 * Should we speculatively download anything at all?
 *
 * Preloading is a bet that bandwidth is cheap. On a metered or slow connection
 * that bet is simply wrong: the user pays for chunks they may never navigate
 * to, and those fetches compete with the requests the current page actually
 * needs. `navigator.connection` is not implemented everywhere (Safari, Firefox),
 * so an absent API is treated as "proceed" — this guard only suppresses
 * preloading when the browser explicitly tells us the connection is poor or
 * metered.
 */
function shouldPreload(): boolean {
  if (typeof navigator === 'undefined') return false;
  const connection = (navigator as any).connection;
  if (!connection) return true; // API unavailable — assume a normal connection
  if (connection.saveData === true) return false; // Data Saver is an explicit "no"
  const effectiveType = connection.effectiveType;
  // Only '4g' (which is what Chrome reports for wifi and ethernet too) is fast
  // enough to justify speculative downloads. 'slow-2g' / '2g' / '3g' are not.
  if (typeof effectiveType === 'string' && effectiveType !== '4g') return false;
  return true;
}

/**
 * Preload critical chunks during idle time.
 * Safe to call multiple times — only runs once per session.
 */
export function preloadCriticalChunks(): void {
  if (preloaded) return;
  preloaded = true;

  // Data Saver on, or a connection the browser rates below 4g: do nothing at
  // all. Every chunk here is still reachable through lazyWithRetry on real
  // navigation, so skipping costs latency on one navigation and saves ~1MB.
  if (!shouldPreload()) return;

  const schedule =
    typeof requestIdleCallback === 'function'
      ? requestIdleCallback
      : (cb: () => void) => setTimeout(cb, 2000);

  // Wait for browser idle before starting preload
  schedule(() => {
    // Stagger imports to avoid a network burst
    CRITICAL_CHUNKS.forEach((importFn, index) => {
      setTimeout(() => {
        importFn().catch(() => {
          // Silently ignore — if a chunk fails to preload, the normal
          // lazyWithRetry mechanism will handle it when the user navigates
        });
      }, index * 150); // 150ms stagger between each chunk
    });

    // PERF PASS 2026-08-22: after the chunk preloads have been scheduled,
    // warm the player's card deck (~500KB of WebP) so the first hands dealt
    // never wait on image fetches. The service worker media cache makes this
    // a one-time cost per device; deckWarmer skips Data Saver / 2g users.
    setTimeout(
      () => {
        import('./deckWarmer')
          .then(({ warmDeckImages }) => warmDeckImages())
          .catch(() => {
            // Preloading is best-effort — the per-card PNG fallback still applies
          });
      },
      CRITICAL_CHUNKS.length * 150 + 3000
    );
  });
}

/**
 * Route-prefix -> chunk map for intent-driven warming.
 *
 * 2026-08-24 (perf pass): was an exact-match lookup, so every parameterised
 * route — '/table/:id', '/clubs/:id/...', '/profile/:userId' — could NEVER
 * match and hovering a table row warmed nothing. Now longest-prefix matched.
 * Each import is the same dynamic import App.tsx hands to lazyWithRetry, so
 * Vite emits no extra chunks and the browser module cache is shared; warming
 * an already-loaded chunk resolves instantly from cache.
 */
const ROUTE_CHUNKS: Record<string, () => Promise<any>> = {
  '/': () => import('../pages/HomePage'),
  '/profile': () => import('../pages/ProfilePage'),
  '/challenges': () => import('../pages/DailyChallengesPage'),
  '/settings': () => import('../pages/SettingsPage'),
  '/wallet': () => import('../pages/PlayerWalletPage'),
  '/hand-history': () => import('../pages/HandHistoryPage'),
  '/history': () => import('../pages/HandHistoryPage'),
  '/cashier': () => import('../pages/CashierPage'),
  '/marketplace': () => import('../pages/MarketplacePage'),
  '/notifications': () => import('../pages/NotificationsPage'),
  '/messages': () => import('../pages/NavigateToMessenger'),
  '/leaderboard': () => import('../pages/LeaderboardPage'),
  '/tournaments': () => import('../pages/TournamentPage'),
  '/tournament-lobby': () => import('../pages/tournament/TournamentLobbyPage'),
  '/tournament-results': () => import('../pages/tournament/TournamentResultsPage'),
  '/stats': () => import('../pages/PlayerStatsPage'),
  '/players': () => import('../pages/PlayerStatsPage'),
  '/table/': () => import('../pages/TablePage'),
  '/clubs/': () => import('../pages/ClubHomePage'),
  '/unions': () => import('../pages/UnionsPage'),
  '/achievements': () => import('../pages/AchievementsPage'),
  '/friends': () => import('../pages/FriendsPage'),
  '/search': () => import('../pages/SearchPage'),
  '/help': () => import('../pages/HelpPage'),
};

/**
 * Manually warm the cache for a specific path.
 * Call this when the user is likely to navigate to a specific page soon
 * (e.g., hovering over a navigation link, touching a table row).
 * Longest matching prefix wins: '/clubs/123/tournaments' warms via its
 * longest matching entry rather than the bare '/clubs/' one. Root ('/')
 * only matches exactly, never as a prefix.
 */
export function preloadRoute(path: string): void {
  if (!path) return;
  let bestKey: string | null = null;
  for (const key of Object.keys(ROUTE_CHUNKS)) {
    if (key === '/' ? path === '/' : path.startsWith(key)) {
      if (bestKey === null || key.length > bestKey.length) bestKey = key;
    }
  }
  if (!bestKey) return;
  ROUTE_CHUNKS[bestKey]().catch(() => {
    // Silently ignore preload failures — real navigation retries via lazyWithRetry
  });
}

/**
 * Spread-ready intent props for links, rows and buttons:
 *   <div {...prefetchIntent('/table/' + t.id)} onClick={...}>
 * Covers mouse (hover), touch (touchstart fires ~100ms before click) and
 * keyboard focus. Spread FIRST so a component's own handlers win when it also
 * needs the event.
 */
export function prefetchIntent(path: string): {
  onMouseEnter: () => void;
  onTouchStart: () => void;
  onFocus: () => void;
} {
  const fire = () => preloadRoute(path);
  return { onMouseEnter: fire, onTouchStart: fire, onFocus: fire };
}

/**
 * Warm the club lobby.
 *
 * Kept out of routeMap above because it is the only parameterised route that
 * matters here: every entry in that map is a literal path, and `/clubs/:id`
 * would never match a lookup by string.
 *
 * Worth warming specifically. ClubHomePage is the heaviest screen in the app
 * (the whole game lobby, its filters, the wallet and the live table grid) and
 * it is where the club carousel sends every single tap. Called when a card
 * settles in the middle, so by the time a player decides to open the club the
 * chunk is usually already there.
 *
 * Fire and forget, and idempotent: a repeated dynamic import of a module that
 * is already loaded resolves from cache without a second request.
 */
export function preloadClubLobby(): void {
  import('../pages/ClubHomePage').catch(() => {
    /* A failed preload must never surface: the real navigation will retry. */
  });
}
