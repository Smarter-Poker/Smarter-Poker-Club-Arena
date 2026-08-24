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
  // PERF PASS 3 (2026-08-22): TablePage is the single heaviest chunk
  // (~413KB JS + ~383KB CSS) and the most common heavy destination — every
  // player who sits down needs it. Warming it last (after the light pages)
  // makes the first table entry instant instead of paying ~150KB gzipped at
  // the moment the player taps a table.
  () => import('../pages/TablePage'),
  // MultiTablePage is the live table surface PersistentTableLayer actually
  // mounts — small itself, but warming it completes the instant-seat path.
  () => import('../pages/MultiTablePage'),
  // PlayerStatsPage intentionally NOT preloaded: it pulls the ~314KB recharts
  // chart bundle, which most users never open. It lazy-loads on navigation
  // instead (route intent), saving that bandwidth on mobile.
];

/**
 * Preload critical chunks during idle time.
 * Safe to call multiple times — only runs once per session.
 */
export function preloadCriticalChunks(): void {
  if (preloaded) return;
  preloaded = true;

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
 * Manually warm the cache for a specific path.
 * Call this when the user is likely to navigate to a specific page soon
 * (e.g., hovering over a navigation link).
 */
export function preloadRoute(path: string): void {
  const routeMap: Record<string, () => Promise<any>> = {
    '/': () => import('../pages/HomePage'),
    '/profile': () => import('../pages/ProfilePage'),
    '/challenges': () => import('../pages/DailyChallengesPage'),
    '/settings': () => import('../pages/SettingsPage'),
    '/wallet': () => import('../pages/PlayerWalletPage'),
    '/hand-history': () => import('../pages/HandHistoryPage'),
    '/cashier': () => import('../pages/CashierPage'),
    '/marketplace': () => import('../pages/MarketplacePage'),
    '/notifications': () => import('../pages/NotificationsPage'),
    '/messages': () => import('../pages/NavigateToMessenger'),
    '/leaderboard': () => import('../pages/LeaderboardPage'),
    '/tournaments': () => import('../pages/tournament/TournamentLobbyPage'),
    '/stats': () => import('../pages/PlayerStatsPage'),
  };

  const importFn = routeMap[path];
  if (importFn) {
    importFn().catch(() => {
      // Silently ignore preload failures
    });
  }
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
