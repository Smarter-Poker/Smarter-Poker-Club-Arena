/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Supabase Client Configuration
 * ═══════════════════════════════════════════════════════════════════════════════
 * Connects to PokerIQ-Production (kuklfnapbkmacvwxktbh)
 *
 * Phase 2 (2026-05-18): Removed subscribeToTable(). Game state rides the
 * Hetzner engine WebSocket. 2026-08-22: Supabase Realtime is STILL used for
 * table presence, chat, reactions and throwables (TableWebSocket/RoomService)
 * — eventsPerSecond must stay a real limit (see below), not 0.
 */

import { createClient } from '@supabase/supabase-js';
import {
  readLocalSession as readLocalSessionShared,
  getTokenExpiry,
  AUTH_STORAGE_KEY,
} from './authUtils';
import { reportError } from '../utils/errorReporter';

// Environment validation - follows VITE_ prefix law
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// SECURITY: No hardcoded fallback credentials — env vars are required
if (!supabaseUrl || !supabaseAnonKey) {
  reportError(
    new Error(
      '[Supabase] VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in environment variables. ' +
        'Check your .env file.'
    ),
    'supabase.Supabase_VITE_SUPABASE_URL_and_VITE_SUPA'
  );
}

// Create the Supabase client.
// CRITICAL: storageKey MUST match Hub's 'smarter-poker-auth' for same-origin SSO.
// eventsPerSecond — the CLIENT->SERVER message rate limit the Realtime server
// enforces from the connection URL. See the note on the value below.
export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '', {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storageKey: 'smarter-poker-auth', // MUST match Hub for SSO
    flowType: 'implicit', // Avoids PKCE lock contention
    // CRITICAL: Bypass navigator.locks to prevent getSession() deadlock.
    // The default lock implementation acquires an exclusive Web Lock that
    // never releases if the initial getSession() network call is slow,
    // causing every subsequent auth operation to deadlock permanently.
    // Runtime: immediately invokes fn() without acquiring any Web Lock.
    // Cast bypasses LockFunc type incompatibility — the type varies across
    // @supabase/supabase-js minor versions (generic vs. concrete overloads).

    lock: (async (_name: any, _acquireTimeout: any, fn: any) => fn()) as any,
  },
  global: {
    // 2026-08-31: retry 503s PostgREST emits BEFORE executing the request
    // (PGRST001/002/003 — connection/schema-cache/pool). During a schema-cache
    // reload these otherwise fail live seating and dealing. Safe for POSTs:
    // the statement was never run. The retry loop lives in
    // src/lib/pgrstRetryFetch.ts and is dynamically imported on the FIRST
    // retryable 503, so the entry bundle only pays for this shim (Track
    // Bundle Size sits within ~1kB of its 320kB budget).
    fetch: async (input, init) => {
      const resp = await globalThis.fetch(input, init);
      if (resp.status !== 503) return resp;
      let code: unknown;
      try {
        code = (await resp.clone().json())?.code;
      } catch {
        return resp; // non-JSON 503 (gateway/maintenance) — not ours to retry
      }
      if (code !== 'PGRST001' && code !== 'PGRST002' && code !== 'PGRST003') return resp;
      const { retryPgrst503 } = await import('./pgrstRetryFetch');
      return retryPgrst503(input, init, resp);
    },
  },
  realtime: {
    params: {
      // 2026-08-22: was 0 ("Realtime is no longer used") — but that was never
      // true: TablePage still mounts a Supabase channel per table for
      // presence, chat, reactions and throwables, and eventsPerSecond is the
      // CLIENT->SERVER rate limit the Realtime server enforces from the
      // connection URL. At 0, every channel.track() and channel.send() was
      // refused server-side — presence/chat/reactions silently did nothing
      // and refused sends drove CHANNEL_ERROR reconnect loops. 10/s is ample
      // for presence + chat and still bounds abuse.
      eventsPerSecond: 10,
    },
  },
});

/**
 * Fast auth resolver — tries local session FIRST (instant), then getUser() as background refresh.
 * Same-origin auth — shared Supabase session via localStorage.
 *
 * Previous approach called getUser() first (network call to Supabase Auth),
 * which timed out after 10s every time, making page loads 10+ seconds.
 * Now: getSession() is instant (reads localStorage), so we use that immediately.
 */
/**
 * The background token refresh is THROTTLED, and that is a fix, not a
 * micro-optimisation.
 *
 * `getAuthUser` is called by nearly every component that needs to know who is
 * signed in, and the fast path below fired a fire-and-forget
 * `supabase.auth.getUser()` on EVERY call. Measured on production 2026-08-28,
 * opening one tournament page: **13 requests to `/auth/v1/user`**, up to 492ms
 * each, every one of them discarded, all of them competing for the same
 * connections as the queries the page actually needed.
 *
 * The client is created with `autoRefreshToken: true`, so the SDK already
 * refreshes on its own timer — this call was only ever a nudge. One nudge a
 * minute is a nudge; thirteen in a second is a stampede.
 *
 * `_authRefreshInFlight` also collapses concurrent nudges, so the very first
 * burst on a cold page makes one request rather than one per component.
 */
const AUTH_REFRESH_MIN_INTERVAL_MS = 60_000;
let _lastAuthRefreshAt = 0;
let _authRefreshInFlight: Promise<unknown> | null = null;

function nudgeTokenRefresh() {
  if (_authRefreshInFlight) return;
  if (Date.now() - _lastAuthRefreshAt < AUTH_REFRESH_MIN_INTERVAL_MS) return;
  _lastAuthRefreshAt = Date.now();
  _authRefreshInFlight = supabase.auth
    .getUser()
    .catch(() => {})
    .finally(() => {
      _authRefreshInFlight = null;
    });
}

export async function getAuthUser(timeoutMs = 5000) {
  // FAST PATH: getSession() reads from localStorage — instant, no network call
  try {
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();
    if (session?.user) {
      // Refresh the token in the background if it has not been nudged
      // recently. See nudgeTokenRefresh above for why the throttle exists.
      nudgeTokenRefresh();
      return { data: { user: session.user }, error: null };
    }
    if (sessionError) {
      console.warn('[getAuthUser] getSession() error:', sessionError.message);
    }
  } catch (err) {
    console.warn('[getAuthUser] getSession() threw:', err);
  }

  // SLOW PATH: No local session — try getUser() with timeout as last resort
  try {
    const userPromise = supabase.auth.getUser();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`getUser timeout (${timeoutMs}ms)`)), timeoutMs)
    );
    return await Promise.race([userPromise, timeoutPromise]);
  } catch (err) {
    console.warn('[getAuthUser] getUser() also failed:', err);
    /**
     * `failed: true` distinguishes "THE READ BROKE" from "there is no user"
     * (Dan 2026-08-28 round 2).
     *
     * Both outcomes previously arrived as `{ data: { user: null } }`, and
     * callers cannot tell a signed-out visitor from a five-second timeout by
     * looking at a null. ClubHomePage acted on that null by navigating to
     * `/invite/:clubId` — so a slow network, on a client that had a perfectly
     * good session, threw a SEATED PLAYER off /table/* with no gesture at all,
     * taking the action bar and every running table's container with it.
     *
     * A missing user is a fact. A failed read is not evidence of anything, and
     * nothing destructive should be built on it. Existing callers reading only
     * `data` / `error` are unaffected.
     */
    return { data: { user: null }, error: err, failed: true as const };
  }
}

// Export type-safe database interface
export type SupabaseClient = typeof supabase;

// ══════════════════════════════════════════════════════════════════════════════
// SAME-ORIGIN SSO — Club Arena shares auth with Hub via localStorage
// ══════════════════════════════════════════════════════════════════════════════
// Since Club Arena is now served at smarter.poker/hub/club-arena (same origin),
// it automatically shares the 'smarter-poker-auth' localStorage key with the Hub.
// No postMessage or iframe handshake needed - just use the same storageKey above.
if (typeof window !== 'undefined') {
  // ══════════════════════════════════════════════════════════════════════════
  // SESSION MIGRATION — Move sessions from old default key to shared key
  // ══════════════════════════════════════════════════════════════════════════
  // Users who logged in before the SSO update may have their session stored
  // under the default Supabase key. This migrates them to the shared key.
  const OLD_DEFAULT_KEY = 'sb-kuklfnapbkmacvwxktbh-auth-token';
  const NEW_SHARED_KEY = AUTH_STORAGE_KEY;
  const MIGRATION_FLAG = 'smarter_poker_auth_migration';

  try {
    const hasMigrated = localStorage.getItem(MIGRATION_FLAG);
    const hasNewSession = localStorage.getItem(NEW_SHARED_KEY);
    const hasOldSession = localStorage.getItem(OLD_DEFAULT_KEY);

    if (!hasMigrated && !hasNewSession && hasOldSession) {
      localStorage.setItem(NEW_SHARED_KEY, hasOldSession);
      localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());
      // Reload to pick up the migrated session
      window.location.reload();
    } else if (!hasMigrated) {
      // Mark as checked even if no migration needed
      localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());
    }
  } catch (e) {
    reportError(e, 'supabase.Migration_error');
  }

  // Session status logged by AntiGravityBoot — no duplicate getSession() here
  // (duplicate calls cause navigator.locks deadlock)

  // ══════════════════════════════════════════════════════════════════════════
  // PROACTIVE TOKEN REFRESH — Prevents session expiration from ever logging out
  // ══════════════════════════════════════════════════════════════════════════
  // Supabase's autoRefreshToken only refreshes when getSession() is called or
  // on a timer that can miss if the tab is backgrounded. This proactive refresh
  // checks the JWT expiry every 60 seconds and triggers a refresh 5 minutes
  // before expiry, ensuring the user NEVER gets logged out due to token expiry.
  const REFRESH_CHECK_INTERVAL = 60_000; // Check every 60 seconds
  const REFRESH_BUFFER = 5 * 60_000; // Refresh 5 minutes before expiry
  let lastRefreshAttempt = 0;
  const REFRESH_DEBOUNCE = 5_000; // 5s debounce to prevent duplicate refreshes

  // getTokenExpiry is now imported from lib/authUtils — single source of truth

  setInterval(() => {
    try {
      const raw = localStorage.getItem(NEW_SHARED_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      const token = data?.access_token;
      if (!token || typeof token !== 'string') return;

      const expiresAt = getTokenExpiry(token);
      if (!expiresAt) return; // Malformed JWT — skip
      const timeUntilExpiry = expiresAt - Date.now();

      // Debounce: skip if we refreshed recently
      if (Date.now() - lastRefreshAttempt < REFRESH_DEBOUNCE) return;

      if (timeUntilExpiry < REFRESH_BUFFER && timeUntilExpiry > 0) {
        lastRefreshAttempt = Date.now();
        console.debug(
          `[Supabase] Proactive token refresh - expires in ${Math.round(timeUntilExpiry / 1000)}s`
        );
        supabase.auth.refreshSession().catch((err) => {
          console.warn('[Supabase] Proactive refresh failed:', err);
        });
      } else if (timeUntilExpiry <= 0) {
        lastRefreshAttempt = Date.now();
        // Token already expired — try to refresh anyway
        console.warn('[Supabase] Token expired - attempting emergency refresh');
        supabase.auth.refreshSession().catch((err) => {
          reportError(err, 'supabase.Emergency_refresh_failed');
          // If refresh token is dead, force signOut to prevent zombie session
          if (
            String(err).includes('Invalid Refresh Token') ||
            String(err).includes('invalid_grant')
          ) {
            reportError(
              new Error('[Supabase] Refresh token is dead - forcing sign out'),
              'supabase.Refresh_token_is_dead__forcing_sign_out'
            );
            supabase.auth
              .signOut()
              .catch((e) => console.warn('[Supabase] Failed to force sign out:', e));
          }
        });
      }
    } catch (e) {
      reportError(e, 'supabase');
      // Silent — best effort
    }
  }, REFRESH_CHECK_INTERVAL);

  // Also refresh when the tab becomes visible (user returns from another tab)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      try {
        // Debounce: skip if interval just refreshed
        if (Date.now() - lastRefreshAttempt < REFRESH_DEBOUNCE) return;

        const raw = localStorage.getItem(NEW_SHARED_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        const token = data?.access_token;
        if (!token || typeof token !== 'string') return;

        const expiresAt = getTokenExpiry(token);
        if (!expiresAt) return; // Malformed JWT
        const timeUntilExpiry = expiresAt - Date.now();

        // If less than 10 minutes until expiry, refresh on tab focus
        if (timeUntilExpiry < 10 * 60_000) {
          lastRefreshAttempt = Date.now();
          console.debug('[Supabase] Tab visible - refreshing session proactively');
          supabase.auth.refreshSession().catch((e) => {
            console.warn('[Supabase] Proactive refresh on tab focus failed:', e);
          });
        }
      } catch (e) {
        reportError(e, 'supabase.addEventListener');
        // Silent
      }
    }
  });
}
