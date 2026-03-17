/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Supabase Client Configuration
 * ═══════════════════════════════════════════════════════════════════════════════
 * Connects to PokerIQ-Production (kuklfnapbkmacvwxktbh)
 */

import { createClient, RealtimeChannel } from '@supabase/supabase-js';

// Environment validation - follows VITE_ prefix law
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// SECURITY: No hardcoded fallback credentials — env vars are required
if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    '[Supabase] VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in environment variables. ' +
      'Check your .env file.'
  );
}

// Create the Supabase client with realtime enabled for live traffic
// CRITICAL: storageKey MUST match Hub's 'smarter-poker-auth' for same-origin SSO
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
    lock: async (_name: string, _acquireTimeout: number, fn: () => Promise<any>) => fn(),
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});

/**
 * Timeout-protected getUser() wrapper with localStorage fallback.
 *
 * CRITICAL FIX (v3): In iframe context, BOTH getUser() and getSession() hang:
 * - getUser() hangs because the API call is blocked by iframe sandbox
 * - getSession() hangs because Supabase's internal _initialize() promise never
 *   resolves (it calls _recoverAndRefresh() which makes an API call that hangs)
 *
 * Fix: In iframe mode, read the session directly from localStorage. The shared
 * storageKey 'smarter-poker-auth' is written by both Hub and Club Arena (SSO).
 * This bypasses all SDK internal state and returns instantly.
 */
export async function getAuthUser(timeoutMs = 6000) {
  const inIframe = typeof window !== 'undefined' && window.parent !== window;

  // ── IFRAME FAST PATH ──
  // Both getUser() and getSession() hang in iframe context.
  // Read from localStorage directly — instant, no SDK calls needed.
  // The 'smarter-poker-auth' key is the SSO session shared with the Hub.
  if (inIframe) {
    const maxRetries = 10;
    const retryInterval = 200; // ms
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const raw = localStorage.getItem('smarter-poker-auth');
        if (raw) {
          const data = JSON.parse(raw);
          if (data?.user?.id) {
            return { data: { user: data.user }, error: null };
          }
        }
        // If no session yet and we have retries left, wait briefly
        // (setSession from postMessage may be in-flight)
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, retryInterval));
          continue;
        }
        return { data: { user: null }, error: null };
      } catch (sessionErr) {
        console.warn('[getAuthUser] iframe localStorage read failed:', sessionErr);
        return { data: { user: null }, error: sessionErr };
      }
    }
    return { data: { user: null }, error: null };
  }

  // ── STANDALONE PATH (non-iframe) ──
  try {
    const userPromise = supabase.auth.getUser();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`getUser timeout (${timeoutMs}ms)`)), timeoutMs)
    );
    return await Promise.race([userPromise, timeoutPromise]);
  } catch (err) {
    console.warn('[getAuthUser] getUser() failed, falling back to getSession():', err);
    // Fallback: getSession() reads from localStorage — instant, no API call
    try {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();
      if (session?.user) {
        return { data: { user: session.user }, error: null };
      }
      return { data: { user: null }, error: sessionError || err };
    } catch (sessionErr) {
      console.warn('[getAuthUser] getSession() fallback also failed:', sessionErr);
      return { data: { user: null }, error: sessionErr };
    }
  }
}

// Filter options for realtime subscriptions
interface SubscribeFilter {
  column: string;
  value: string;
}

// Subscribe to realtime changes on a database table
export function subscribeToTable<T>(
  tableName: string,
  callback: (data: T) => void,
  filter?: SubscribeFilter
): () => void {
  const channelName = filter ? `${tableName}:${filter.column}:${filter.value}` : tableName;

  const channel: RealtimeChannel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: tableName,
        filter: filter ? `${filter.column}=eq.${filter.value}` : undefined,
      },
      (payload) => {
        callback(payload.new as T);
      }
    )
    .subscribe();

  // Return unsubscribe function
  return () => {
    supabase.removeChannel(channel);
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// REALTIME BROADCAST — Ephemeral hand state (no database table needed)
// ══════════════════════════════════════════════════════════════════════════════
// HeadlessTableEngine broadcasts hand state updates to a channel per table.
// useTableStore subscribes to the same channel to receive live game data.
// This is much faster than postgres_changes and doesn't require a hand_states table.

/**
 * Broadcast hand state to all subscribers for a given table.
 * Called by HeadlessTableEngine on every hand event.
 *
 * CRITICAL: Supabase Realtime requires channels to be subscribed (joined)
 * before .send() can deliver messages. We use a Promise-based ready pattern
 * so ALL sends (including those arriving during the subscribe handshake)
 * are queued until the channel is confirmed SUBSCRIBED.
 */
const broadcastReady = new Map<string, Promise<ReturnType<typeof supabase.channel>>>();

export function broadcastHandState(tableId: string, handState: Record<string, unknown>): void {
  const channelName = `hand-state:${tableId}`;

  // Create a ready Promise on first call; reuse on subsequent calls
  if (!broadcastReady.has(channelName)) {
    const readyPromise = new Promise<ReturnType<typeof supabase.channel>>((resolve) => {
      const channel = supabase.channel(channelName);
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          resolve(channel);
        }
      });
    });
    broadcastReady.set(channelName, readyPromise);
  }

  // All calls (including during subscribe handshake) queue on the same Promise
  broadcastReady.get(channelName)!.then((channel) => {
    channel
      .send({
        type: 'broadcast',
        event: 'hand_state',
        payload: handState,
      })
      .catch((err: unknown) => {
        console.warn(`[Broadcast] Failed to send hand state for ${tableId}:`, err);
      });
  });
}

/**
 * Clean up a broadcast channel when a table engine stops.
 * Prevents resource leaks in the broadcastReady Map.
 */
export function cleanupBroadcastChannel(tableId: string): void {
  const channelName = `hand-state:${tableId}`;
  const ready = broadcastReady.get(channelName);
  if (ready) {
    ready.then((channel) => {
      channel
        .unsubscribe()
        .catch((e) => console.warn('[Supabase] Failed to unsubscribe from broadcast channel:', e));
      supabase.removeChannel(channel);
    });
    broadcastReady.delete(channelName);
  }
}

/**
 * Subscribe to hand state broadcasts for a given table.
 * Returns an unsubscribe function.
 */
export function subscribeToHandState(
  tableId: string,
  callback: (handState: Record<string, unknown>) => void
): () => void {
  const channelName = `hand-state:${tableId}`;
  const channel = supabase
    .channel(channelName)
    .on('broadcast', { event: 'hand_state' }, (payload) => {
      callback(payload.payload as Record<string, unknown>);
    })
    .subscribe();

  return () => {
    channel
      .unsubscribe()
      .catch((e) => console.warn('[Supabase] Failed to unsubscribe from hand state channel:', e));
    supabase.removeChannel(channel);
  };
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
  const NEW_SHARED_KEY = 'smarter-poker-auth';
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
    console.error('[SSO] Migration error:', e);
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

  /** Safely parse JWT expiry. Returns null if token is malformed. */
  function getTokenExpiry(token: string): number | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(atob(parts[1]));
      return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    } catch {
      return null;
    }
  }

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
        console.log(
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
          console.error('[Supabase] Emergency refresh failed:', err);
          // If refresh token is dead, force signOut to prevent zombie session
          if (
            String(err).includes('Invalid Refresh Token') ||
            String(err).includes('invalid_grant')
          ) {
            console.error('[Supabase] Refresh token is dead — forcing sign out');
            supabase.auth
              .signOut()
              .catch((e) => console.warn('[Supabase] Failed to force sign out:', e));
          }
        });
      }
    } catch {
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
          console.log('[Supabase] Tab visible — refreshing session proactively');
          supabase.auth.refreshSession().catch((e) => {
            console.warn('[Supabase] Proactive refresh on tab focus failed:', e);
          });
        }
      } catch {
        // Silent
      }
    }
  });
}
