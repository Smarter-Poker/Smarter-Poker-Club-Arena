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
import { masterBus } from '../core/MasterBus';

/** How long before another shell reload may be attempted in this tab. */
export const RELOAD_COOLDOWN_MS = 10 * 60 * 1000;

/** Both conditions must hold continuously for this long before reloading. */
export const SETTLE_MS = 3000;

/**
 * Dan 2026-08-29 ("it like glitches and reloads... it looks like broken
 * code"): a reload that must happen anyway looks worst when it lands seconds
 * AFTER the app has painted. Inside this window from page start the settle
 * delay is skipped — the sooner a genuinely-stale boot restarts, the more it
 * reads as part of loading and the less state the player has built to lose.
 * All other guards (not at a table, visible, cooldown) still apply.
 */
export const STARTUP_WINDOW_MS = 15 * 1000;

/** The settle delay to use for a reload decided at `pageAgeMs` into the page. */
export function settleDelayMs(pageAgeMs: number): number {
  return pageAgeMs < STARTUP_WINDOW_MS ? 0 : SETTLE_MS;
}

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

/** How often the resume-path staleness probe may touch the network. */
export const STALE_CHECK_MIN_INTERVAL_MS = 60 * 1000;

/**
 * The entry chunk named by a shell document. Vite writes exactly one
 * `assets/index-<hash>.js` module script into index.html per build, so the
 * name IS the build identity — two shells naming different entries are two
 * different deploys, with no build-info fetch or baked-in sha required.
 */
export function extractEntryScript(html: string): string | null {
  const m = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
  return m ? m[0] : null;
}

/**
 * ── THE RESUME PATH, WHICH NOTHING ELSE COVERS (2026-08-29) ────────────────
 *
 * Every mechanism above this line is driven by a NAVIGATION: the SW
 * revalidates the shell when one happens, the browser re-checks sw-bus.js
 * when one happens, and `reg.update()` runs once at app start. An installed
 * PWA brought back from the app switcher performs none of those — the old
 * JS simply resumes — so a device that lives in the switcher can run a
 * bundle for DAYS after it was replaced, and no message ever arrives to set
 * `pending`.
 *
 * That is not a hypothetical. It is the mechanism behind every "this
 * regressed" report where the code had not changed: Dan's phone showing the
 * pre-#950 felt on 2026-08-29 hours after the fix was verified live, the
 * 2026-08-28 card-size report, the session observed executing
 * TablePage-CUTgsJU_ chunks while build-info reported a sha four deploys
 * newer. The phone was not seeing regressions — it was time-travelling
 * between bundles on its own schedule.
 *
 * So on every return to visibility this hook now does the two things a
 * navigation would have done, throttled to once a minute:
 *
 *   1. asks the SW registration to update, so a rotated sw-bus.js installs
 *      (→ controllerchange → the gate's existing path);
 *   2. fetches the live shell itself (`cache: 'no-cache'` — and a plain
 *      fetch is NOT intercepted by sw-bus.js's navigation branch, so this
 *      reads the server, not the cache) and compares its entry chunk name
 *      to the one this session is executing. A mismatch means the running
 *      bundle is not the deployed bundle → `pending`, and the same gate
 *      that has always decided WHEN applies: never at a table, never
 *      hidden, cooldown respected.
 *
 * The reload rules do not change here. A player seated at a table keeps
 * their bundle until they leave — this only makes sure the app KNOWS it is
 * stale, which is the half that was missing.
 */
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
      // meantime must not be reloaded out of it. During the startup window
      // the delay is zero (see settleDelayMs) — the timeout still fires
      // asynchronously and still re-checks every condition.
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
        /* 2026-08-29 telemetry: every shell reload is counted, with the page
           age at the moment it fired. A reload inside the startup window is
           the fix working (adopt before the player settles in); one long
           after paint is the glitch Dan reported — the rate of the latter is
           what must stay at zero. */
        masterBus.emit('SHELL_RELOADED', { pageAgeMs: Math.round(performance.now()) });
        window.location.reload();
      }, settleDelayMs(performance.now()));
    };

    /**
     * Dan 2026-08-29: SHELL_UPDATED and controllerchange used to arm the
     * reload BLINDLY, and both fire in situations where the running bundle is
     * already current — the SW's freshness race can serve the NEW shell on
     * the very navigation whose revalidation then reports "changed", and a
     * new SW claiming this page says nothing about which shell this page is
     * executing. Every one of those blind arms was a full visible reboot of
     * a session that had nothing to gain from it. So: verify first. Only a
     * page whose running entry chunk differs from the deployed one arms the
     * gate. Offline or unrecognisable shells verify as "not stale" — a
     * reload can't help either case.
     */
    let verifying = false;
    const verifyThenArm = (source: 'shell-updated' | 'controllerchange') => {
      if (!armed || pending || verifying) return;
      const running = extractEntryScript(document.documentElement.outerHTML);
      if (!running) return; // dev server or unknown shell shape: stand down
      const base =
        import.meta.env.BASE_URL && import.meta.env.BASE_URL !== '/'
          ? import.meta.env.BASE_URL
          : '/';
      verifying = true;
      fetch(`${base}index.html`, { cache: 'no-cache' })
        .then((res) => (res.ok ? res.text() : null))
        .then((html) => {
          const deployed = html ? extractEntryScript(html) : null;
          const stale = !!deployed && deployed !== running;
          /* 2026-08-29 telemetry: emitted for BOTH outcomes — the not-stale
             result is the SW freshness race doing its job, and its share is
             the KPI that says the open-from-Hub glitch fix is holding. */
          if (deployed) {
            masterBus.emit('SHELL_STALENESS_CHECKED', { stale, source, running, deployed });
          }
          if (stale) {
            pending = true;
            attempt();
          }
        })
        .catch(() => {
          /* offline or blocked: nothing to adopt, nothing to do */
        })
        .finally(() => {
          verifying = false;
        });
    };

    const onMessage = (event: MessageEvent) => {
      const type = (event.data as { type?: string } | null)?.type;
      if (type !== 'SHELL_UPDATED') return;
      verifyThenArm('shell-updated');
    };

    /* A new service worker taking control means new chunk names are being
       served from here on. Adopt them at a safe moment rather than letting
       this session finish on a half-rotated bundle — but only after the
       verify above confirms this page is actually running the old ones. */
    const onControllerChange = () => {
      verifyThenArm('controllerchange');
    };

    /* The resume-path probe. See the block comment above the hook. */
    let lastStaleCheckAt = 0;
    const checkStaleness = () => {
      if (!armed) return;
      const now = Date.now();
      if (now - lastStaleCheckAt < STALE_CHECK_MIN_INTERVAL_MS) return;
      lastStaleCheckAt = now;

      // 1. Let the browser discover a rotated sw-bus.js without a navigation.
      navigator.serviceWorker
        .getRegistration()
        .then((reg) => reg?.update())
        .catch(() => {});

      // 2. Compare the deployed shell's entry chunk against the one running.
      const running = extractEntryScript(document.documentElement.outerHTML);
      if (!running) return; // dev server or a shell shape we do not recognise
      const base =
        import.meta.env.BASE_URL && import.meta.env.BASE_URL !== '/'
          ? import.meta.env.BASE_URL
          : '/';
      fetch(`${base}index.html`, { cache: 'no-cache' })
        .then((res) => (res.ok ? res.text() : null))
        .then((html) => {
          if (!html) return;
          const deployed = extractEntryScript(html);
          const stale = !!deployed && deployed !== running;
          if (deployed) {
            masterBus.emit('SHELL_STALENESS_CHECKED', {
              stale,
              source: 'resume-probe',
              running,
              deployed,
            });
          }
          if (stale) {
            pending = true;
            attempt();
          }
        })
        .catch(() => {
          /* offline or blocked: nothing to adopt, nothing to do */
        });
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') checkStaleness();
      attempt();
    };
    /* pageshow fires when a PWA or bfcache page resumes without a real
       navigation — the exact case the probe exists for. */
    const onPageShow = () => checkStaleness();
    /* Leaving a table is the single most likely moment for this to become
       safe, and it produces no event of its own — the router replaces the
       path without touching the SW. Poll cheaply instead of reaching into
       the router from the app root. */
    const poll = window.setInterval(attempt, 5000);

    navigator.serviceWorker.addEventListener('message', onMessage);
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);

    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.clearInterval(poll);
      window.clearTimeout(timer);
    };
  }, []);
}
