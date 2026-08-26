/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AUTH TOKEN CACHE — synchronous access token for zero-latency connections
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (perf pass 2026-08-24):
 * Every engine WebSocket connect and many API calls started with
 * `await supabase.auth.getSession()`. Even when that call resolves from
 * localStorage it is asynchronous, schedules microtasks through auth-js, and
 * under contention has been observed to cost tens to hundreds of ms on the
 * critical join-table path. The token itself changes only on login, logout,
 * and refresh — all of which announce themselves via onAuthStateChange.
 *
 * So: keep the current access token in module memory, updated by the auth
 * event stream, and hand it out SYNCHRONOUSLY. `getFreshAccessToken()` is the
 * drop-in async replacement for the old getSession() pattern: it returns the
 * cached token on the fast path (no awaiting auth-js) and only falls back to
 * a real getSession() call when the cache is empty or the token is within its
 * expiry margin — preserving the 2026-08-22 fix where getSession() REFRESHES
 * an expired token (a raw localStorage read never refreshes, which 4401-looped
 * devices that suspended past expiry).
 */

import { readLocalSession, getTokenExpiry } from './authUtils';

/** Refresh when less than this many ms of validity remain. */
const EXPIRY_MARGIN_MS = 60_000;

let cachedToken: string | null = null;
/** Expiry in ms epoch, or null when the token has no exp claim. */
let cachedExpiryMs: number | null = null;
let initialized = false;

function adoptToken(token: string | null): void {
  cachedToken = token;
  cachedExpiryMs = token ? getTokenExpiry(token) : null;
}

/**
 * Install the onAuthStateChange listener that keeps the cache current.
 * Idempotent. Called lazily by the getters, and explicitly from
 * ServiceBootstrap so the cache is warm before the first table join.
 *
 * The supabase client is imported dynamically so this module stays free of an
 * eager dependency (mirrors EngineStateClient, which is unit-tested under
 * jsdom without the app env). The synchronous localStorage seed below means
 * callers never wait on that import.
 */
export function initAuthTokenCache(): void {
  if (initialized) return;
  initialized = true;

  // Seed synchronously from localStorage — valid-or-null, expiry-checked.
  adoptToken(readLocalSession()?.accessToken ?? null);

  void import('./supabase')
    .then(({ supabase }) => {
      supabase.auth.onAuthStateChange((_event, session) => {
        adoptToken(session?.access_token ?? null);
      });
      // Also adopt whatever the SDK already holds (covers a refresh that
      // happened between our seed and the listener install).
      void supabase.auth
        .getSession()
        .then(({ data }) => {
          if (data.session?.access_token) adoptToken(data.session.access_token);
        })
        .catch(() => {
          /* cache keeps the localStorage seed */
        });
    })
    .catch(() => {
      /* env without the app supabase client (tests) — localStorage seed only */
    });
}

/**
 * SYNCHRONOUS fast path. Returns the cached token if it exists and is not
 * within the expiry margin; otherwise null (caller should use
 * getFreshAccessToken, which can refresh).
 */
export function getCachedAccessToken(): string | null {
  if (!initialized) initAuthTokenCache();
  if (!cachedToken) return null;
  if (cachedExpiryMs !== null && cachedExpiryMs - Date.now() < EXPIRY_MARGIN_MS) return null;
  return cachedToken;
}

/**
 * Async token getter for connection paths. Fast path resolves in the same
 * microtask from the in-memory cache. Slow path (cache empty or near expiry)
 * calls supabase.auth.getSession(), which refreshes an expired token, then
 * falls back to the raw localStorage read as a last resort.
 */
export async function getFreshAccessToken(): Promise<string | null> {
  const fast = getCachedAccessToken();
  if (fast) return fast;

  try {
    const { supabase } = await import('./supabase');
    const { data } = await supabase.auth.getSession();
    const t = data.session?.access_token ?? null;
    if (t) {
      adoptToken(t);
      return t;
    }
  } catch {
    /* fall through to localStorage */
  }
  return readLocalSession()?.accessToken ?? null;
}
