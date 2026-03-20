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
  () => import('../pages/club/ClubLobby'),
  () => import('../pages/ClubCarouselPage'),
  () => import('../pages/ProfilePage'),
  () => import('../pages/club/ClubDashboard'),
  () => import('../pages/SettingsPage'),
  () => import('../pages/PlayerWalletPage'),
  () => import('../pages/HandHistoryPage'),
  () => import('../pages/CashierPage'),
  () => import('../pages/NotificationsPage'),
  () => import('../pages/MessagesPage'),
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
    '/clubs': () => import('../pages/ClubCarouselPage'),
    '/profile': () => import('../pages/ProfilePage'),
    '/settings': () => import('../pages/SettingsPage'),
    '/wallet': () => import('../pages/PlayerWalletPage'),
    '/hand-history': () => import('../pages/HandHistoryPage'),
    '/cashier': () => import('../pages/CashierPage'),
    '/notifications': () => import('../pages/NotificationsPage'),
    '/messages': () => import('../pages/MessagesPage'),
    '/leaderboard': () => import('../pages/LeaderboardPage'),
    '/tournaments': () => import('../pages/tournament/TournamentLobbyPage'),
  };

  const importFn = routeMap[path];
  if (importFn) {
    importFn().catch(() => {
      // Silently ignore preload failures
    });
  }
}
