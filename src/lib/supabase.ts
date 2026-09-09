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
import { readLocalSession as readLocalSessionShared, AUTH_STORAGE_KEY } from './authUtils';
import { reportError } from '../utils/errorReporter';
import { IS_NATIVE_BUILD } from './appBase';

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
    // ════════════════════════════════════════════════════════════════════════
    // autoRefreshToken IS THE ONE AND ONLY REFRESHER IN THIS APP.
    // ════════════════════════════════════════════════════════════════════════
    // Do not add a setInterval refresher, a visibilitychange refresher, or a
    // hand-rolled POST to /auth/v1/token beside it. Supabase refresh tokens
    // ROTATE: the old token dies the moment a refresh succeeds, so a second
    // refresher holding the previous value gets
    //   "Invalid Refresh Token: Refresh Token Not Found"
    // and the SDK treats that as a dead session. See the block removed from
    // the bottom of this file on 2026-09-01.
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storageKey: 'smarter-poker-auth', // MUST match Hub for SSO
    flowType: 'implicit', // Avoids PKCE lock contention
    // ════════════════════════════════════════════════════════════════════════
    // NO `lock` OVERRIDE HERE — THE DEFAULT navigator.locks IMPLEMENTATION IS
    // LOad-BEARING. (2026-09-01)
    // ════════════════════════════════════════════════════════════════════════
    // This slot used to hold
    //     lock: (async (_name, _acquireTimeout, fn) => fn()) as any,
    // i.e. "run the critical section immediately, acquire nothing", added to
    // dodge a suspected getSession() deadlock.
    //
    // That override is what let the Hub and Club Arena clobber each other's
    // rotating refresh token. Both deployments are served from the same origin
    // and share the storageKey above, so the SDK's Web Lock is the ONLY thing
    // serialising their refreshes. With the lock stubbed out, two clients could
    // read the same refresh_token and POST it concurrently: whichever landed
    // second presented an already-rotated token and got
    //   "Invalid Refresh Token: Refresh Token Not Found",
    // and a half-written session in the shared key produced
    //   "crypto: refresh token length is not valid".
    // The resulting signOut() removed the shared key, whose `storage` event
    // then bounced every other open tab to /auth/login?redirect= .
    //
    // If a lock-related hang is ever observed again, fix it with a timeout on
    // the acquisition — never by disabling cross-tab serialisation while two
    // apps share one storage key.
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
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(`${supabaseUrl?.replace(/\/+$/, '')}/auth/v1/`)) {
        // A timed-out socket waiter does not release auth-js's lock. Bound
        // the actual auth network/body operation, preserving the SDK as the
        // only refresher and its retryable-error session retention.
        const { fetchAuthWithDeadline } = await import('./authFetchDeadline');
        return fetchAuthWithDeadline(input, init);
      }
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
 * 2026-09-01: the background `supabase.auth.getUser()` "nudge" that used to run
 * on the fast path below is GONE.
 *
 * It had already been throttled to one call a minute (it was firing 13 times
 * on a single tournament page load, up to 492ms each, every result discarded).
 * The throttle made it cheap; it did not make it correct. `getUser()` validates
 * the access token against GoTrue and, when that token is near expiry, drives
 * the SDK toward a refresh — a refresh the client performs anyway on its own
 * timer, because `autoRefreshToken: true` is set above.
 *
 * With the Web Lock restored, a nudge is not dangerous the way it was. It is
 * simply another caller poking a rotating refresh token for no benefit, on a
 * key shared with the Hub. `getSession()` on the line below already returns the
 * session from storage, and the SDK refreshes it on schedule. Nothing here
 * needs a network round-trip.
 */
export async function getAuthUser(timeoutMs = 5000) {
  // FAST PATH: getSession() reads from localStorage — instant, no network call
  try {
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();
    if (session?.user) {
      // No background nudge here — autoRefreshToken is the single refresher.
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
// NATIVE: skipped. No player ever signed in to the app under the old default
// key, and the reload below would restart the app for nothing.
if (typeof window !== 'undefined' && !IS_NATIVE_BUILD) {
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
  // REMOVED 2026-09-01 — "PROACTIVE TOKEN REFRESH" (setInterval + visibilitychange)
  // ══════════════════════════════════════════════════════════════════════════
  // A module-level `setInterval(..., 60_000)` used to live here. Every minute it
  // read the shared 'smarter-poker-auth' key, decoded the JWT expiry, and called
  // `supabase.auth.refreshSession()` when the token was within 5 minutes of
  // expiring (or already expired). A `visibilitychange` listener did the same on
  // tab focus, with a 10-minute window. On `invalid_grant` / `Invalid Refresh
  // Token` the expired branch then called `supabase.auth.signOut()` to "prevent
  // a zombie session".
  //
  // Every part of that was actively harmful:
  //
  //   * It duplicated `autoRefreshToken: true`, which is set on this very
  //     client. Refresh tokens ROTATE — the old value is invalidated the instant
  //     a refresh succeeds — so two refreshers sharing one token is not
  //     redundancy, it is a race. The loser presents a rotated token and gets
  //     "Invalid Refresh Token: Refresh Token Not Found".
  //
  //   * It ran at MODULE SCOPE, so it fired once per tab, in a page that shares
  //     its storageKey with the Hub — every open tab racing the same token.
  //
  //   * Its own error handler escalated the race into a logout: signOut()
  //     removes the shared key, and the resulting cross-tab `storage` event
  //     bounced EVERY open tab to /auth/login?redirect= . One transient refresh
  //     failure logged the user out everywhere.
  //
  // The stated justification — "autoRefreshToken can miss if the tab is
  // backgrounded" — is not a reason to add a second refresher. The SDK reconciles
  // on visibility change itself, and a token that did expire while backgrounded
  // is refreshed on the next call through the (locked, serialised) SDK path.
  //
  // DO NOT REINSTATE. If session expiry is ever suspected again, instrument the
  // SDK's own TOKEN_REFRESHED / SIGNED_OUT events via onAuthStateChange first —
  // do not add a competing refresher.
}
