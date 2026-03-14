/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  lazyWithRetry — Chunk-Load Error Recovery for Lazy Routes
 * ═══════════════════════════════════════════════════════════════════════════════
 * Wraps React.lazy() with automatic retry + full-page reload on persistent
 * chunk load failures. This handles the common scenario where:
 *
 * 1. A new deployment invalidates old chunk hashes
 * 2. A network blip causes a chunk fetch to fail
 * 3. CDN edge cache serves a stale or missing chunk
 *
 * Without this, the user sees an infinite loading spinner because Suspense
 * has no error recovery — it just keeps showing the fallback.
 *
 * STRATEGY:
 * - Retry the dynamic import up to 3 times with exponential backoff
 * - If all retries fail, force a full page reload (clears stale cache)
 * - Track reload attempts in sessionStorage to prevent infinite reload loops
 */

import { lazy, ComponentType } from 'react';

const RELOAD_KEY = 'club_arena_chunk_reload';
const MAX_RELOADS = 2; // Max full-page reloads before giving up

function getReloadCount(): number {
  try {
    return parseInt(sessionStorage.getItem(RELOAD_KEY) || '0', 10);
  } catch {
    return 0;
  }
}

function incrementReloadCount(): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(getReloadCount() + 1));
  } catch {
    // sessionStorage unavailable
  }
}

function clearReloadCount(): void {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    // sessionStorage unavailable
  }
}

export function lazyWithRetry<T extends ComponentType<any>>(
  importFn: () => Promise<{ default: T }>,
  retries = 3
): React.LazyExoticComponent<T> {
  return lazy(async () => {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const module = await importFn();
        // Success — clear any reload counter
        clearReloadCount();
        return module;
      } catch (error: any) {
        const isChunkError =
          error?.name === 'ChunkLoadError' ||
          error?.message?.includes('dynamically imported module') ||
          error?.message?.includes('Failed to fetch') ||
          error?.message?.includes('Loading chunk') ||
          error?.message?.includes('Loading CSS chunk');

        if (!isChunkError || attempt === retries - 1) {
          // Not a chunk error or final retry — try a full reload
          if (isChunkError && getReloadCount() < MAX_RELOADS) {
            console.warn(
              `[lazyWithRetry] Chunk load failed after ${retries} retries. Reloading page (attempt ${getReloadCount() + 1}/${MAX_RELOADS})...`
            );
            incrementReloadCount();
            window.location.reload();
            // Return a never-resolving promise to prevent rendering during reload
            return new Promise<never>(() => {});
          }
          throw error;
        }

        // Wait with exponential backoff before retrying
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
        console.warn(
          `[lazyWithRetry] Chunk load failed (attempt ${attempt + 1}/${retries}), retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error('lazyWithRetry: exhausted all retries');
  });
}

export default lazyWithRetry;
