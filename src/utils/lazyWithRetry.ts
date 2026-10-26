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

/**
 * THE RELOAD GUARD IS KEYED BY BUILD (2026-10-23, client_crash_log 3015: an
 * iPhone at a live table, "Importing a module script failed.", on a URL that
 * already carried the `_cb` of an earlier recovery reload). The guard used to
 * be one counter per tab with a budget of two, so a tab that had spent its
 * reloads on one publish had none left for the next, and the stale import
 * fell through to the table's error boundary as a "crash". Each build now
 * gets exactly one hard reload: the document that reloads into a newer build
 * starts that build's own budget, while a build whose chunks genuinely cannot
 * load still stops after one reload instead of looping.
 */
const BUILD_ID: string = (() => {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    const version = env?.VITE_APP_VERSION;
    return typeof version === 'string' && version.trim() !== '' ? version.trim() : 'dev';
  } catch {
    return 'dev';
  }
})();
const RELOAD_KEY = `${STORAGE_KEYS.CHUNK_RELOAD}:${BUILD_ID}`;
const MAX_RELOADS = 1; // One guarded hard reload per build
let recoveryStarted = false;

/** The sessionStorage key that guards this build's single recovery reload. */
export function chunkReloadGuardKey(): string {
  return RELOAD_KEY;
}

/**
 * A PAGE THAT IS LEAVING IS NOT A STALE PAGE (2026-10-23, production
 * post-deploy: "Navigation to /hub/club-arena/ is interrupted by another
 * navigation to /clubs/kings-club?_cb=..."). When a player navigates away,
 * the browser cancels the old document's in-flight requests, its lazy chunks
 * and preloads included. Those cancellations reject exactly like a retired
 * chunk ("Importing a module script failed", "Load failed"), and recovery
 * answered them with a cache-busted reload of the page being LEFT, which
 * hijacked the navigation the player had just started and sent them back.
 *
 * While a navigation is under way, recovery waits. If the page is still here
 * once the grace period ends, the navigation was cancelled or never happened
 * and the failure was real, so recovery runs then. If the navigation
 * completed, this document no longer exists and nothing runs.
 */
export const NAVIGATION_GRACE_MS = 10_000;
let leavingAt = Number.NEGATIVE_INFINITY;
let deferredRecovery: ReturnType<typeof setTimeout> | null = null;

function markLeaving(): void {
  leavingAt = Date.now();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', markLeaving);
  window.addEventListener('pagehide', markLeaving);
  // Restored from the back/forward cache: this document is in use again.
  window.addEventListener('pageshow', (event) => {
    if ((event as PageTransitionEvent).persisted) leavingAt = Number.NEGATIVE_INFINITY;
  });
}

/** True while this document is being navigated away from. */
export function documentIsNavigatingAway(now = Date.now()): boolean {
  return now - leavingAt < NAVIGATION_GRACE_MS;
}

/**
 * A SLOW NAVIGATION IS NOT A CANCELLED ONE (2026-10-25, production
 * post-deploy, WebKit: "Navigation to /hub/club-arena/ is interrupted by
 * another navigation to /clubs/kings-club?_cb=..." again, ten seconds after
 * the lobby was requested). The grace above assumed a navigation that has
 * not finished in ten seconds never will. Right after a publish the lobby
 * document took longer than that, the deferred recovery fired while it was
 * still loading, and its cache-busted reload of the page being left cancelled
 * the navigation the player had started.
 *
 * That reload could not have fetched anything newer: the document was already
 * running the build production serves, and the origin's asset pool is
 * append-only, so every chunk it asked for still existed. The departure's
 * cancellations had been read as staleness without ever checking. So when the
 * grace ends and the page is still here, recovery first asks production which
 * build it serves. A document on that build keeps waiting for its navigation,
 * bounded by CURRENT_BUILD_PATIENCE_MS so a navigation that really was
 * cancelled still gets its suspended route back. A different build, an
 * unreadable answer, or a local build recovers exactly as before.
 */
export const CURRENT_BUILD_PATIENCE_MS = 60_000;
export const LIVE_BUILD_READ_TIMEOUT_MS = 3_000;

const BUILD_INFO_URL: string = (() => {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    const base = env?.BASE_URL;
    const root = typeof base === 'string' && base !== '' ? base : '/';
    return `${root.endsWith('/') ? root : `${root}/`}build-info.json`;
  } catch {
    return '/build-info.json';
  }
})();

/** True only when production positively reports this document's own build. */
export async function liveBuildIsThisDocument(): Promise<boolean> {
  // A local build reports 'dev', which never equals a published ca_sha.
  if (typeof fetch !== 'function') return false;
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      controller?.abort();
      resolve(false);
    }, LIVE_BUILD_READ_TIMEOUT_MS);
  });
  const read = (async (): Promise<boolean> => {
    try {
      const response = await fetch(BUILD_INFO_URL, {
        cache: 'no-store',
        signal: controller?.signal,
      });
      if (!response.ok) return false;
      const info = (await response.json()) as { ca_sha?: unknown } | null;
      return typeof info?.ca_sha === 'string' && info.ca_sha.trim() === BUILD_ID;
    } catch {
      // Offline, refused or malformed: this cannot prove the bundle is current.
      return false;
    }
  })();
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run `recover` once the current navigation has had its chance to finish. */
function afterNavigationGrace(recover: () => void): void {
  if (deferredRecovery !== null) return;
  const departedAt = leavingAt;
  const schedule = (wait: number): void => {
    deferredRecovery = setTimeout(() => {
      void (async () => {
        if (
          Date.now() - departedAt < CURRENT_BUILD_PATIENCE_MS &&
          (await liveBuildIsThisDocument())
        ) {
          // Still current, so a reload cannot help and would cancel the
          // navigation if it is merely slow. Keep the single deferral armed.
          schedule(NAVIGATION_GRACE_MS);
          return;
        }
        deferredRecovery = null;
        recover();
      })();
    }, wait);
  };
  schedule(Math.max(0, leavingAt + NAVIGATION_GRACE_MS - Date.now()));
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

export function clearChunkRecoveryState(): void {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
    // The per-tab counter this build-keyed guard replaced.
    sessionStorage.removeItem(STORAGE_KEYS.CHUNK_RELOAD);
    sessionStorage.removeItem('ca-chunk-hardreload');
  } catch {
    // sessionStorage unavailable
  }
}

/**
 * Vite, Chromium and WebKit use different errors for the same stale-deploy
 * condition. Keep one matcher for lazy routes, boot-time imports and Vite's
 * `vite:preloadError` event so one path cannot silently regress behind the
 * others.
 */
export function isChunkLoadError(error: unknown): boolean {
  const candidate = error as { name?: string; message?: string } | null;
  return (
    candidate?.name === 'ChunkLoadError' ||
    candidate?.message?.includes('Importing a module script failed') ||
    candidate?.message?.includes('error loading dynamically imported module') ||
    candidate?.message?.includes('Unable to preload CSS') ||
    candidate?.message?.includes('dynamically imported module') ||
    candidate?.message?.includes('Failed to fetch') ||
    candidate?.message?.includes('Loading chunk') ||
    candidate?.message?.includes('Loading CSS chunk') ||
    false
  );
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
export async function hardReload(): Promise<void> {
  if (documentIsNavigatingAway()) {
    afterNavigationGrace(() => void hardReload());
    return;
  }
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
  // The purge above is asynchronous; a navigation may have started meanwhile.
  if (documentIsNavigatingAway()) {
    afterNavigationGrace(() => void hardReload());
    return;
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('_cb', String(Date.now()));
    window.location.replace(url.toString());
  } catch {
    window.location.reload();
  }
}

/**
 * Recover every dynamic import, including boot-time service imports that are
 * not rendered through React.lazy(). The boolean tells a caller whether the
 * error was recognized and recovery owns it; recognized errors are not sent
 * to the console as product failures while the document is being replaced.
 */
function canOwnChunkRecovery(error: unknown): boolean {
  return isChunkLoadError(error) && (recoveryStarted || getReloadCount() < MAX_RELOADS);
}

export type BoundaryChunkOutcome = 'not-chunk' | 'recovering' | 'exhausted';

/**
 * ONE ANSWER FOR EVERY ERROR BOUNDARY. A lazy component that failed to load
 * reaches whichever boundary sits above it - the table tile, the page, a stats
 * panel, the route, the root - and React.lazy() call sites that do not use
 * lazyWithRetry reach them directly. Each boundary asks here first:
 *
 * - 'not-chunk': an ordinary render error; report it as a crash as before.
 * - 'recovering': a stale or missing chunk this document is now replacing
 *   with a cache-busted reload. Not a crash, and never written to
 *   client_crash_log; the boundary paints nothing while the page navigates.
 * - 'exhausted': a chunk/module load failure after this build's one reload
 *   was already spent. The boundary shows its fallback (with its reload
 *   action), and the failure goes to the first-party error sink with code
 *   CHUNK_LOAD_EXHAUSTED (see reportExhaustedChunkLoad) - an asset or network
 *   outage stays visible, but it is not a render crash and is not written to
 *   client_crash_log.
 */
export function claimChunkErrorForBoundary(error: unknown): BoundaryChunkOutcome {
  if (!isChunkLoadError(error)) return 'not-chunk';
  if (!canOwnChunkRecovery(error)) return 'exhausted';
  void recoverFromStaleChunk(error);
  return 'recovering';
}

export function reportExhaustedChunkLoad(error: unknown, surface: string): void {
  // Lazy import: the reporter must not ride in this module's import graph
  // just to record a rare outage, and a failure here must never throw.
  void import('./errorReporter')
    .then((m) =>
      m?.captureClientError?.(error, `chunk-load-exhausted:${surface}`, {
        code: 'CHUNK_LOAD_EXHAUSTED',
        build: BUILD_ID,
      })
    )
    .catch(() => undefined);
}

export async function recoverFromStaleChunk(error: unknown): Promise<boolean> {
  if (!canOwnChunkRecovery(error)) return false;
  if (recoveryStarted) return true;
  // A cancelled load during navigation spends no reload budget.
  if (documentIsNavigatingAway()) {
    afterNavigationGrace(() => void recoverFromStaleChunk(error));
    return true;
  }

  recoveryStarted = true;
  incrementReloadCount();
  await hardReload();
  return true;
}

/**
 * Vite emits this before a failed preload rejects. JavaScript importers own
 * retry and recovery so optional imports cannot replace a usable document.
 * Failed CSS still needs document recovery: Vite remembers that dependency
 * as seen even after its failed link is removed, so retry alone can skip it.
 */
/**
 * A STYLESHEET THAT FAILED IS NOT A STYLESHEET THAT LOADED (Dan 2026-10-14,
 * iPad: "THE ENTIRE DISPLAY PAGE LOOKS SUPER ZOOMED IN ... INSTEAD OF LOADING
 * NORMALLY" - the lobby drawn with no CSS: raw buttons, sr-only labels showing,
 * art stretched to full width).
 *
 * Vite's preloader skips a CSS dependency whose <link> is already in the
 * document, and it does not distinguish a link that LOADED from one that
 * ERRORED. So after one failed CSS fetch, every retry of that route "found"
 * its stylesheet and rendered without it. Removing the failed link clears the
 * DOM entry, but Vite also remembers it in an internal seen-dependency map.
 * The guarded document recovery below resets that map for the next load.
 */
function failedStylesheetHref(error: unknown): string | undefined {
  const message = (error as { message?: string } | null)?.message ?? '';
  return /Unable to preload CSS for (\S+)/.exec(message)?.[1];
}

export function dropFailedStylesheet(error: unknown): boolean {
  const href = failedStylesheetHref(error);
  if (!href || typeof document === 'undefined') return false;
  let removed = false;
  document.querySelectorAll('link[rel="stylesheet"]').forEach((node) => {
    const link = node as HTMLLinkElement;
    const attr = link.getAttribute('href') ?? '';
    if (attr === href || link.href === href || link.href.endsWith(href)) {
      link.remove();
      removed = true;
    }
  });
  return removed;
}

/**
 * A CANCELLED STYLESHEET IS NOT A STALE BUILD (2026-10-25, production
 * post-deploy run 40242809027: "Navigation to /hub/club-arena/ is interrupted
 * by another navigation to /clubs/kings-club?_cb=..."). The club lobby warms
 * other routes' chunks in the background. When the player starts a navigation
 * the browser aborts every one of those in-flight loads, and the aborted CSS
 * preloads (PlayerAvatar, ProfilePage, ClubDashboard...) reach this handler as
 * "Unable to preload CSS". The navigation guard above cannot see that
 * navigation - a browser-initiated one does not always fire beforeunload
 * first - so a stylesheet that was never stale reloaded the page being left
 * and sent the player back to it.
 *
 * So the server is asked before the document is replaced. The origin answers
 * a retired hashed asset with 404 and a current one with 200 text/css:
 *
 * - 'present': the build is current and the load was cancelled or blipped.
 *   The stylesheet is put back exactly as Vite would have inserted it, so the
 *   route never renders unstyled (the 2026-10-14 iPad bug), and no reload or
 *   reload budget is spent.
 * - 'gone': the asset is retired; guarded document recovery runs as before.
 * - 'unknown': the probe itself could not answer (offline, aborted, 5xx).
 *   Recovery waits out the navigation grace period and then runs, so a page
 *   that really is leaving is gone before it fires.
 */
export type StylesheetProbe = 'present' | 'gone' | 'unknown';

export async function probeStylesheet(href: string): Promise<StylesheetProbe> {
  if (typeof fetch !== 'function') return 'unknown';
  try {
    const base = typeof document !== 'undefined' ? document.baseURI : undefined;
    const url = new URL(href, base).toString();
    const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (res.status === 404 || res.status === 410) return 'gone';
    if (!res.ok) return 'unknown';
    const type = res.headers?.get?.('content-type') ?? '';
    // An HTML fallback answering 200 for a missing asset is not a stylesheet.
    return type === '' || /css/i.test(type) ? 'present' : 'gone';
  } catch {
    return 'unknown';
  }
}

function reinstateStylesheet(href: string, onError: () => void): void {
  if (typeof document === 'undefined') {
    onError();
    return;
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.setAttribute('href', href);
  link.addEventListener('error', () => {
    link.remove();
    onError();
  });
  document.head.appendChild(link);
}

export async function recoverFailedStylesheet(href: string, error: unknown): Promise<void> {
  const verdict = await probeStylesheet(href);
  if (verdict === 'present') {
    reinstateStylesheet(href, () => void recoverFromStaleChunk(error));
    return;
  }
  if (verdict === 'gone') {
    void recoverFromStaleChunk(error);
    return;
  }
  setTimeout(() => void recoverFromStaleChunk(error), NAVIGATION_GRACE_MS);
}

export function installVitePreloadErrorRecovery(): () => void {
  const onPreloadError = (event: Event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    // Let Vite reject into the importing caller. Cancelling here resolves its
    // import to undefined and skips both importWithRetry's non-disruptive
    // retries and lazyWithRetry's bounded retries. Automatically recovering
    // JavaScript here would interrupt optional warmers that handle errors.
    // Critical lazy imports still request recovery after exhausting retries.
    // CSS is different: Vite marks dependencies seen before fetching, so a
    // retry in this document can silently skip the failed stylesheet. Preserve
    // guarded recovery for CSS, without cancelling its original rejection.
    const href = failedStylesheetHref(payload);
    dropFailedStylesheet(payload);
    if (href !== undefined) void recoverFailedStylesheet(href, payload);
  };
  window.addEventListener('vite:preloadError', onPreloadError);
  return () => window.removeEventListener('vite:preloadError', onPreloadError);
}

/**
 * THE RELOAD BUDGET IS PER INCIDENT, NOT PER TAB (Dan 2026-10-14). The budget
 * (MAX_RELOADS) stops a broken deploy from reload-looping, and it lived in
 * sessionStorage with nothing that ever cleared it. A tab left open across a
 * day of publishes spent its two reloads on the first two stale chunks and
 * then had no recovery at all for every later one. A document that has run
 * cleanly for a minute has proved the last recovery worked, so the budget is
 * returned. A reload loop still trips it: each loop iteration fails within
 * seconds, long before this fires.
 */
export function releaseChunkRecoveryBudgetWhenStable(stableMs = 60_000): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const timer = window.setTimeout(() => {
    if (!recoveryStarted) clearChunkRecoveryState();
  }, stableMs);
  return () => window.clearTimeout(timer);
}

export function lazyWithRetry<T extends ComponentType<any>>(
  importFn: () => Promise<{ default: T }>,
  retries = 3
): React.LazyExoticComponent<T> {
  return lazy(async () => {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const module = await importFn();
        // Another preload listener can cancel Vite's event and resolve to
        // undefined. If recovery or navigation already owns that failure,
        // keep React suspended instead of passing it an invalid module.
        if (module == null || module.default == null) {
          if (recoveryStarted || documentIsNavigatingAway()) return new Promise<never>(() => {});
          throw new Error('Lazy route module has no default export');
        }
        // Another lazy module succeeding does not prove the failed route
        // recovered. Preserve the tab's budget across document replacements.
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
          if (canOwnChunkRecovery(error)) {
            if (!recoveryStarted) {
              console.warn(
                `[lazyWithRetry] Chunk load failed after ${retries} retries. Reloading page (attempt ${getReloadCount() + 1}/${MAX_RELOADS})...`
              );
            }
            void recoverFromStaleChunk(error);
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
