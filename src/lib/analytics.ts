/**
 * Product Analytics (PostHog) — Phase 5.1.2b (Club Arena side)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Continuation of Phase 5.1.2 (World Hub signup + first_login funnels —
 * see /Users/smarter.poker/Documents/Smarter-Poker-World-Hub/src/lib/analytics.js).
 *
 * Canonical activation funnel:
 *   signup → first_login → first_table_seat → first_hand_played
 *   → first_session_of_30min
 *
 * This file ships the last three steps from inside the Club Arena SPA.
 *
 * Behavior:
 *   - no-ops silently if VITE_POSTHOG_KEY is unset (dev/CI/test)
 *   - lazy-loads posthog-js from CDN on first capture (keeps main bundle light)
 *   - queues up to 50 calls that fire before the SDK is loaded
 *   - first_* events are fired through `captureOnce()` which dedupes via
 *     localStorage so the funnel count is accurate even across reloads
 *
 * NOTE: Club Arena is a Vite SPA mounted at /hub/club-arena/ inside the
 * Next.js World Hub. This analytics module is ENTIRELY separate from the
 * WH-side module — each bundle needs its own PostHog SDK instance because
 * they run in a single browser context but are built + shipped independently.
 * Both modules use the same PostHog project + key, so events from both sides
 * roll up into the same person timeline.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const POSTHOG_HOST = 'https://us.i.posthog.com';

let _loaded = false;
let _loadPromise: Promise<unknown> | null = null;
const _queue: Array<[string, unknown[]]> = [];
const MAX_QUEUE = 50;
const ONCE_KEY_PREFIX = 'pa_once_';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function getKey(): string | undefined {
  // Vite exposes env vars as import.meta.env.VITE_*
  // Access guarded so we don't blow up in non-Vite test runners.
  try {
    return (import.meta as unknown as { env?: Record<string, string> })?.env?.VITE_POSTHOG_KEY;
  } catch {
    return undefined;
  }
}

function isEnabled(): boolean {
  return isBrowser() && !!getKey();
}

/**
 * Load posthog-js from CDN the first time we capture anything.
 */
function loadPosthog(): Promise<unknown> {
  if (_loadPromise) return _loadPromise;
  if (!isEnabled()) return Promise.resolve(null);

  _loadPromise = new Promise<unknown>((resolve) => {
    const w = window as unknown as {
      posthog?: Record<string, unknown> & { __SV?: number; _i?: unknown[][] };
    };
    // Official PostHog snippet — populates window.posthog with a proxy
    // that queues calls until the real SDK finishes downloading.
    (function (t: Window, e: Document) {
      const o: any = ((t as any).posthog = (t as any).posthog || []);
      if (!o.__SV) {
        let p: HTMLScriptElement;
        let u: HTMLScriptElement;
        let f: string[];
        let n: number;
        o._i = [];
        o.init = function (i: string, s: { api_host: string }, a?: string) {
          const g = function (t2: any, e2: string) {
            const o2 = e2.split('.');
            if (o2.length === 2) {
              t2 = t2[o2[0]];
              e2 = o2[1];
            }
            t2[e2] = function (...args: unknown[]) {
              t2.push([e2].concat(Array.prototype.slice.call(args, 0)));
            };
          };
          p = e.createElement('script');
          p.type = 'text/javascript';
          p.async = true;
          p.src = s.api_host + '/static/array.js';
          u = e.getElementsByTagName('script')[0] as HTMLScriptElement;
          u.parentNode!.insertBefore(p, u);
          f =
            'init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing startSessionRecording stopSessionRecording'.split(
              ' '
            );
          for (n = 0; n < f.length; n++) g(o, f[n]);
          o._i.push([i, s, a]);
        };
        o.__SV = 1;
      }
    })(window, document);

    const key = getKey();
    if (!key) {
      resolve(null);
      return;
    }

    (w.posthog as any).init(key, {
      api_host: POSTHOG_HOST,
      person_profiles: 'identified_only',
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: {
        // Poker-table UI has sticky buttons that flood autocapture
        // with rage-click noise; restrict to the core signals.
        dom_event_allowlist: ['click', 'change', 'submit'],
        css_selector_allowlist: [],
      },
      respect_dnt: true,
      mask_all_text: false,
      mask_all_element_attributes: false,
    });

    _loaded = true;
    // Drain the queue
    for (const [method, args] of _queue) {
      try {
        const ph = w.posthog as any;
        if (ph && typeof ph[method] === 'function') ph[method](...args);
      } catch {
        /* swallow */
      }
    }
    _queue.length = 0;
    resolve(w.posthog);
  });

  return _loadPromise;
}

function proxy(method: string, args: unknown[]): void {
  if (!isEnabled()) return;
  const w = window as unknown as { posthog?: Record<string, any> };
  if (_loaded && w.posthog && typeof w.posthog[method] === 'function') {
    try {
      w.posthog[method](...args);
    } catch {
      /* swallow */
    }
    return;
  }
  if (_queue.length < MAX_QUEUE) _queue.push([method, args]);
  loadPosthog();
}

/**
 * Capture a product event.
 */
export function capture(event: string, properties: Record<string, unknown> = {}): void {
  proxy('capture', [event, properties]);
}

/**
 * Capture an event AT MOST ONCE per browser per user. Used for the first_*
 * funnel events so reconnects, reloads, and realtime re-emits don't inflate
 * the funnel counts.
 *
 * Dedup key is scoped by userId when present — a user logging into the same
 * browser with a fresh account gets their own first_* events.
 */
export function captureOnce(
  event: string,
  userId: string | null,
  properties: Record<string, unknown> = {}
): boolean {
  if (!isBrowser()) return false;
  try {
    const scope = userId ? `u:${userId}` : 'anon';
    const key = `${ONCE_KEY_PREFIX}${event}:${scope}`;
    if (window.localStorage.getItem(key)) return false;
    window.localStorage.setItem(key, String(Date.now()));
  } catch {
    // localStorage denied (private mode, SSR shim) — fall through and
    // still fire the event. Better to over-count than to silently drop
    // someone's first_table_seat because the browser refuses storage.
  }
  capture(event, properties);
  return true;
}

/**
 * Identify the current user. Call on login + after signup. Safe to call
 * repeatedly — PostHog dedupes on its side.
 */
export function identify(userId: string, properties: Record<string, unknown> = {}): void {
  proxy('identify', [userId, properties]);
}

/**
 * Reset the client identity — call on logout.
 */
export function reset(): void {
  proxy('reset', []);
  // Don't blow away the once-fired keys on logout — they're scoped by
  // userId anyway, and nuking them would cause double-counts on re-login.
}

/**
 * Register super-properties attached to every subsequent capture.
 */
export function register(properties: Record<string, unknown>): void {
  proxy('register', [properties]);
}

/**
 * The canonical funnel steps — named constants so callers can't mistype the
 * event strings. Mirrors the World Hub module character-for-character.
 */
export const FunnelEvents = Object.freeze({
  SIGNUP: 'signup',
  FIRST_LOGIN: 'first_login',
  FIRST_TABLE_SEAT: 'first_table_seat',
  FIRST_HAND_PLAYED: 'first_hand_played',
  FIRST_SESSION_30MIN: 'first_session_of_30min',
});

export default { capture, captureOnce, identify, reset, register, FunnelEvents };
