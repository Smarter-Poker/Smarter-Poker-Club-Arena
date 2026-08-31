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
import { STORAGE_KEYS } from '../lib/storage';

const RELOAD_KEY = STORAGE_KEYS.CHUNK_RELOAD;
const MAX_RELOADS = 2; // Max full-page reloads before giving up

export function isChunkLoadError(error: unknown): boolean {
  const candidate = error as { name?: string; message?: string } | null;
  return (
    candidate?.name === 'ChunkLoadError' ||
    candidate?.message?.includes('Importing a module script failed') === true ||
    candidate?.message?.includes('error loading dynamically imported module') === true ||
    candidate?.message?.includes('Unable to preload CSS') === true ||
    candidate?.message?.includes('dynamically imported module') === true ||
    candidate?.message?.includes('Failed to fetch') === true ||
    candidate?.message?.includes('Loading chunk') === true ||
    candidate?.message?.includes('Loading CSS chunk') === true
  );
}

/**
 * Retry a deferred, non-render-blocking module during an atomic publish.
 * Unlike lazyWithRetry, this never reloads the page: callers use it for boot
 * warmers and telemetry that must not interrupt a usable route.
 */
export async function importWithRetry<T>(
  importFn: () => Promise<T>,
  retries = 4,
  baseDelayMs = 500
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await importFn();
    } catch (error) {
      lastError = error;
      if (!isChunkLoadError(error) || attempt === retries - 1) throw error;
      const delay = Math.min(baseDelayMs * 2 ** attempt, 4_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

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

/**
 * Dan 2026-08-19: a plain window.location.reload() does NOT fix a stale chunk.
 * The 404 happens because the page is running an OLD index.html that still
 * references a chunk the latest deploy deleted — and reloading re-serves that
 * SAME cached HTML (from the service worker, the bfcache, or the CDN edge), so
 * the app loops back into the identical error. That is exactly what Dan hit:
 * "Failed to fetch dynamically imported module ... HamburgerMenu-<hash>.js".
 *
 * Recovery has to invalidate the HTML itself: drop the service worker, purge
 * the Cache Storage it was serving from, then navigate with a cache-busting
 * query so the browser and the edge are both forced to fetch a fresh document.
 */
async function hardReload(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    }
  } catch {
    /* ignore — best effort */
  }
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
    }
  } catch {
    /* ignore — best effort */
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('_cb', String(Date.now()));
    window.location.replace(url.toString());
  } catch {
    window.location.reload();
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
        /* SAFARI PHRASES IT DIFFERENTLY, AND THAT IS THE WHOLE BUG (Dan,
           2026-08-24, from an iPhone: "Importing a module script failed.").
           Every matcher below was written against Chrome's wording, so on iOS
           a stale chunk after a deploy fell straight past the retry AND past
           the hard reload, and the app just showed its error card — which is
           why Register, Details and Join all died on the same screen while
           the desktop recovered silently. */
        const isChunkError = isChunkLoadError(error);

        if (!isChunkError || attempt === retries - 1) {
          // Not a chunk error or final retry — try a full reload
          if (isChunkError && getReloadCount() < MAX_RELOADS) {
            console.warn(
              `[lazyWithRetry] Chunk load failed after ${retries} retries. Reloading page (attempt ${getReloadCount() + 1}/${MAX_RELOADS})...`
            );
            incrementReloadCount();
            void hardReload();
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
