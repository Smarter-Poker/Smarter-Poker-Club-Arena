/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Supabase Client Configuration
 * ═══════════════════════════════════════════════════════════════════════════════
 * Connects to PokerIQ-Production (kuklfnapbkmacvwxktbh)
 *
 * Phase 2 (2026-05-18): Removed subscribeToTable() and set eventsPerSecond: 0
 * to prevent any accidental Supabase Realtime connections. All real-time
 * functionality has been migrated to the Hetzner engine WebSocket.
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
// eventsPerSecond: 0 — disables the Supabase Realtime heartbeat / multiplexer.
// All real-time functionality now goes through the Hetzner engine WebSocket.
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
    // LockFunc requires Promise<void> return — await fn() then return void.
    lock: async (_name: string, _acquireTimeout: number, fn: () => Promise<unknown>): Promise<void> => {
      await fn();
    },
  },
  realtime: {
    params: {
      // 0 = effectively disabled. Supabase Realtime is no longer used in
      // Club Arena — all channels have been migrated to the Hetzner WebSocket.
      // This prevents the Supabase client from opening a Realtime WS connection
      // which would count against MAU even if no channels are subscribed.
      eventsPerSecond: 0,
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
export async function getAuthUser(timeoutMs = 5000) {
  // FAST PATH: getSession() reads from localStorage — instant, no network call
  try {
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();
    if (session?.user) {
      // Fire getUser() in background to refresh the token if needed — don't await
      supabase.auth.getUser().catch(() => {});
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
    return { data: { user: null }, error: err };
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
          `[Supabase] Proactive token refresh — expires in ${Math.round(timeUntilExpiry / 1000)}s`
        );
        supabase.auth.refreshSession().catch((err) => {
          console.warn('[Supabase] Proactive refresh failed:', err);
        });
      } else if (timeUntilExpiry <= 0) {
        lastRefreshAttempt = Date.now();
        // Token already expired — try to refresh anyway
        console.warn('[Supabase] Token expired — attempting emergency refresh');
        supabase.auth.refreshSession().catch((err) => {
          reportError(err, 'supabase.Emergency_refresh_failed');
          // If refresh token is dead, force signOut to prevent zombie session
          if (
            String(err).includes('Invalid Refresh Token') ||
            String(err).includes('invalid_grant')
          ) {
            reportError(
              new Error('[Supabase] Refresh token is dead — forcing sign out'),
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
          console.debug('[Supabase] Tab visible — refreshing session proactively');
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
