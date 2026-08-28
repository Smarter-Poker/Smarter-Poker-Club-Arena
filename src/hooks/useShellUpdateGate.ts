/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE OTHER HALF OF SHELL_UPDATED (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `public/sw-bus.js` serves the app shell CACHE-FIRST and revalidates it in the
 * background. That is a deliberate, well-argued trade — it removes a full HTML
 * round trip from every entry into Club Arena — and its safety argument, in the
 * service worker's own words, is:
 *
 *   "When the background revalidation shows the shell has changed under a
 *    still-current SW, clients are told, so the app can refresh itself at a
 *    moment of its own choosing rather than mid-hand (see SHELL_UPDATED)."
 *
 * The service worker holds up its end: it compares the revalidated shell
 * against the cached one and posts `{ type: 'SHELL_UPDATED' }` to every window.
 *
 * NOTHING IN THE APP HAS EVER LISTENED FOR IT. The message went to a client
 * that had no handler, so "the app can refresh itself" described code that did
 * not exist, and the cached shell — with the exact hashed chunk names it was
 * built against, all of them pinned cache-first — kept being served for the
 * life of the session. On a PWA or a tab that is never closed, that is days.
 *
 * Observed on production 2026-08-28: `build-info.json` reported ca_sha
 * 4474ef1b while the very same tab was executing `TablePage-CUTgsJU_-v6.js`
 * from an older build. Every fix shipped in between was invisible to that
 * session — which is the most likely explanation for a player reporting a bug
 * that had already been fixed and deployed.
 *
 * ── WHEN IT IS SAFE TO APPLY ────────────────────────────────────────────────
 *
 * Never mid-hand. A reload during a hand costs the player their seat view,
 * their timer and their nerve, and the service worker's comment names that
 * case specifically. The gate therefore waits for a moment that is boring by
 * construction:
 *
 *   1. the player is not looking at a table (no /table/ route), AND
 *   2. the page is visible (reloading a hidden tab burns the update on a
 *      session nobody is watching, and Safari may defer it anyway), AND
 *   3. a short settle delay has passed with both still true.
 *
 * A player sitting at a table simply keeps the old bundle until they leave it,
 * which is exactly the promise the service worker made.
 *
 * ── WHY IT CANNOT LOOP ──────────────────────────────────────────────────────
 *
 * A reload that lands on the same stale shell would post SHELL_UPDATED again
 * and reload again, forever. Two independent guards:
 *
 *   - `sessionStorage` records the moment of the last shell reload; another is
 *     refused inside RELOAD_COOLDOWN_MS. sessionStorage rather than localStorage
 *     so a genuinely new tab is never punished for an older tab's reload.
 *   - the handler disarms itself after firing once per mount.
 *
 * If the reload does not pick up the new shell, the player is no worse off than
 * before this file existed: they are on the old bundle and nothing loops.
 */
import { useEffect } from 'react';

/** How long before another shell reload may be attempted in this tab. */
export const RELOAD_COOLDOWN_MS = 10 * 60 * 1000;

/** Both conditions must hold continuously for this long before reloading. */
export const SETTLE_MS = 3000;

const RELOAD_KEY = 'ca_shell_reload_at';

/**
 * Is the player looking at a poker table right now?
 *
 * Read from the URL rather than from React state on purpose: this hook is
 * mounted once at the app root, above the router's table routes, so it cannot
 * see table state — and the URL is the one signal that is correct for both the
 * single-table route and the multi-table shell that hosts it.
 */
export function isAtTable(pathname: string): boolean {
  return /\/table\//.test(pathname);
}

/**
 * May a shell reload be attempted now?
 *
 * Exported for the unit test, which is the only honest way to pin a rule whose
 * real trigger is a service-worker message and a page reload.
 */
export function mayReloadForShell(opts: {
  pathname: string;
  visible: boolean;
  lastReloadAt: number | null;
  now: number;
}): boolean {
  if (isAtTable(opts.pathname)) return false;
  if (!opts.visible) return false;
  if (opts.lastReloadAt != null && opts.now - opts.lastReloadAt < RELOAD_COOLDOWN_MS) return false;
  return true;
}

export function useShellUpdateGate(): void {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    let pending = false;
    let armed = true;
    let timer = 0;

    const readLastReload = (): number | null => {
      try {
        const raw = sessionStorage.getItem(RELOAD_KEY);
        const n = raw ? Number(raw) : NaN;
        return Number.isFinite(n) ? n : null;
      } catch {
        // Private mode or blocked storage: treat as "never reloaded". The
        // once-per-mount disarm below is still a hard stop, so this cannot
        // become a loop even with no storage at all.
        return null;
      }
    };

    const attempt = () => {
      if (!pending || !armed) return;
      const ok = mayReloadForShell({
        pathname: window.location.pathname,
        visible: document.visibilityState === 'visible',
        lastReloadAt: readLastReload(),
        now: Date.now(),
      });
      if (!ok) return;

      // Re-check after the settle delay: a player who opened a table in the
      // meantime must not be reloaded out of it.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!pending || !armed) return;
        if (
          !mayReloadForShell({
            pathname: window.location.pathname,
            visible: document.visibilityState === 'visible',
            lastReloadAt: readLastReload(),
            now: Date.now(),
          })
        ) {
          return;
        }
        armed = false;
        try {
          sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
        } catch {
          /* storage blocked - the disarm above is the real guard */
        }
        window.location.reload();
      }, SETTLE_MS);
    };

    const onMessage = (event: MessageEvent) => {
      const type = (event.data as { type?: string } | null)?.type;
      if (type !== 'SHELL_UPDATED') return;
      pending = true;
      attempt();
    };

    /* A new service worker taking control means new chunk names are being
       served from here on. Same treatment: adopt them at a safe moment rather
       than letting this session finish on a half-rotated bundle. */
    const onControllerChange = () => {
      pending = true;
      attempt();
    };

    const onVisibility = () => attempt();
    /* Leaving a table is the single most likely moment for this to become
       safe, and it produces no event of its own — the router replaces the
       path without touching the SW. Poll cheaply instead of reaching into
       the router from the app root. */
    const poll = window.setInterval(attempt, 5000);

    navigator.serviceWorker.addEventListener('message', onMessage);
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(poll);
      window.clearTimeout(timer);
    };
  }, []);
}
