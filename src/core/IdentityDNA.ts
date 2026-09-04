/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🧬 IDENTITY DNA — Authentication & User Profile Layer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Identity DNA is the user identity backbone of Club Arena, managing:
 * - Real Supabase authentication with session persistence
 * - Auth state change listeners
 * - User profile hydration from database
 * - Secure logout with full store cleanup
 *
 * NO DEMO DATA - All operations are real.
 */

import { Session, AuthChangeEvent } from '@supabase/supabase-js';
import { useUserStore } from '../stores/useUserStore';
import { supabase } from '../lib/supabase';
import { readLocalSession as readLocalSessionShared, SPA_AUTH_BREADCRUMB } from '../lib/authUtils';
import { masterBus } from './MasterBus';
import { achievementTriggerService } from '../services/AchievementTriggerService';
import { postgresSyncHooks } from '../services/PostgresSyncHooks';
import { setSentryUser, clearSentryUser } from './SentryInit';
import { clearSessionCache } from '../hooks/useSessionCache';
import { useHeaderDataStore } from '../stores/useHeaderDataStore';
import { reportError } from '../utils/errorReporter';
import { clearUserCaches } from '../utils/clearUserCaches';
import { PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface UserProfile {
  id: string;
  username: string;
  display_name: string | null;
  /* The columns `playerDisplayName` resolves over. Without `alias` on this
     type, the profile this class loads could not carry the poker alias, and
     the write it makes into the store erased whatever the store already knew
     (Dan 2026-09-03). Optional because a row may legitimately have none. */
  alias?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  display_name_preference?: string | null;
  use_real_name?: boolean | null;
  avatar_url: string | null;
  vip_level: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond'; // Maps to DB `tier` column
  tier?: string; // Raw DB tier value (e.g. "Newcomer")
  created_at: string;
  updated_at?: string;
  player_number?: number;
}

export interface IdentityDNAStatus {
  loaded: boolean;
  authenticated: boolean;
  userId: string | null;
  username: string | null;
  sessionExpiresAt: string | null;
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IDENTITY DNA SINGLETON
// ═══════════════════════════════════════════════════════════════════════════════

class IdentityDNACore {
  private status: IdentityDNAStatus | null = null;
  private authListener: { data: { subscription: { unsubscribe: () => void } } } | null = null;
  private initialized: boolean = false;
  private isHydrating: boolean = false; // Guard against concurrent SIGNED_IN events

  /**
   * Initialize Identity DNA
   * Sets up auth listener and loads current session
   */
  async init(): Promise<IdentityDNAStatus> {
    if (this.initialized) {
      return this.status!;
    }

    // Check for existing session
    let authenticated = false;
    let userId: string | null = null;
    let username: string | null = null;
    let sessionExpiresAt: string | null = null;

    // Set up auth state listener FIRST
    this.setupAuthListener();

    // ── FAST PATH: localStorage session warming ──
    // The shared session exists in localStorage under 'smarter-poker-auth'.
    // Reading it directly is instant (no API call, no navigator.locks contention).
    // We only fall back to getSession() if localStorage is empty or JWT is expired.
    const localSession = this.readLocalSession();
    if (localSession) {
      console.debug('[IdentityDNA] Fast path: session found in localStorage');
      authenticated = true;
      userId = localSession.userId;
      username = localSession.username;
      sessionExpiresAt = localSession.expiresAt;
      // Note: We still call getSession() below to get the full Session object
      // for hydration, but we already have the user info for the status.
    }

    try {
      // ── STANDARD AUTH PATH (same-origin shared session) ──
      // Timeout protection — getSession() can hang if navigator.locks contend
      const sessionPromise = supabase.auth.getSession();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('getSession timeout (8s)')), 8000)
      );
      const {
        data: { session },
        error,
      } = await Promise.race([sessionPromise, timeoutPromise]);

      if (session && !error) {
        authenticated = true;
        userId = session.user.id;
        username = session.user.email?.split('@')[0] || null;
        sessionExpiresAt = session.expires_at
          ? new Date(session.expires_at * 1000).toISOString()
          : null;

        // Hydrate user store with session data (synchronous)
        this.hydrateUserFromSession(session);
        this.loadProfileInBackground(session.user.id);

        // Emit auth event
        masterBus.emit('AUTH_STATE_CHANGED', {
          userId,
          isAuthenticated: true,
        });
      }
    } catch (e: any) {
      // AbortError is benign — suppress it
      if (e?.name === 'AbortError' || e?.message?.includes('aborted')) {
        console.warn('  └─ Session check aborted (benign)');
      } else {
        reportError(e, 'IdentityDNA._Session_Check_Failed');
      }
    }

    // Build status
    this.status = {
      loaded: true,
      authenticated,
      userId,
      username,
      sessionExpiresAt,
      timestamp: new Date().toISOString(),
    };

    this.initialized = true;

    // DETERMINISTIC PROOF

    return this.status;
  }

  /**
   * Read session from localStorage directly — instant, no API call needed.
   * Delegates to shared lib/authUtils.readLocalSession() to avoid duplication.
   */
  private readLocalSession(): {
    userId: string;
    username: string | null;
    expiresAt: string | null;
  } | null {
    const session = readLocalSessionShared();
    if (!session) return null;
    return {
      userId: session.userId,
      username: session.username,
      expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
    };
  }

  /**
   * Set up Supabase auth state listener
   * This persists throughout the app lifecycle
   */
  private setupAuthListener(): void {
    this.authListener = supabase.auth.onAuthStateChange(
      async (event: AuthChangeEvent, session: Session | null) => {
        switch (event) {
          case 'SIGNED_IN':
            if (session) {
              // Guard against concurrent SIGNED_IN events (e.g. parent sends two auth tokens)
              if (this.isHydrating) {
                console.warn('[IdentityDNA] Ignoring concurrent SIGNED_IN - hydration in progress');
                break;
              }
              this.isHydrating = true;
              try {
                // CRITICAL: hydrateUserFromSession is now SYNCHRONOUS (no await needed).
                // It only sets basic user info from the JWT. Profile loading from DB
                // happens in background to avoid the initialization deadlock.
                this.hydrateUserFromSession(session);
                this.loadProfileInBackground(session.user.id);
                this.updateStatus(true, session);

                // Set Sentry user context
                setSentryUser({
                  id: session.user.id,
                  email: session.user.email,
                  username:
                    session.user.user_metadata?.username || session.user.email?.split('@')[0],
                });

                masterBus.emit('AUTH_STATE_CHANGED', {
                  userId: session.user.id,
                  isAuthenticated: true,
                });

                // Trigger login achievement (for login streaks, daily logins, etc.)
                achievementTriggerService
                  .onLogin(session.user.id)
                  .catch((err) => console.warn('[Achievements] Login trigger failed:', err));

                // Push enrolment is NOT wired here. It used to boot the
                // OneSignal SDK and hand it this user id; OneSignal was retired
                // on 2026-08-19 and the SDK was removed on 2026-08-29, so both
                // calls are gone. The live path is PushSubscriptionSync +
                // FirstRunPushPrompt, mounted at the app root in App.tsx, which
                // enrol against the ROOT service worker. Nothing belongs here.

                // Phase 7: Absolute Realtime Perfection (Listen to external/Admin Postgres mutations)
                // FIX 5: Wrapped in try/catch — don't let realtime init failure crash the auth flow
                try {
                  postgresSyncHooks.init(session.user.id);
                } catch (syncErr) {
                  reportError(syncErr, 'IdentityDNA.PostgresSyncHooks_init_failed_on_SIGNED_');
                  // Non-fatal — user is still authenticated, just realtime may be degraded
                }
              } finally {
                this.isHydrating = false;
              }
            }
            break;

          case 'SIGNED_OUT':
            this.clearUser();
            // The SPA breadcrumb outlives the store the same way storage does.
            // Left behind, AuthGuard treats every sign-out as "recently
            // authenticated" and delays the redirect by 800ms.
            try { sessionStorage.removeItem(SPA_AUTH_BREADCRUMB); } catch { /* private mode */ }
            // Storage outlives the store. Until 2026-08-23 nothing here
            // touched it, so the next person to use the device was served
            // the previous account's cached clubs, hand history and lobby.
            clearUserCaches();
            clearSentryUser(); // Clear Sentry user context
            postgresSyncHooks.destroy(); // Shut down external DB listener
            this.updateStatus(false, null);
            masterBus.emit('AUTH_STATE_CHANGED', {
              userId: null,
              isAuthenticated: false,
            });
            break;

          case 'TOKEN_REFRESHED':
            if (session) {
              // Re-hydrate basic user info (synchronous) and load profile in background
              this.hydrateUserFromSession(session);
              this.loadProfileInBackground(session.user.id);
              this.updateStatus(true, session);

              // Re-emit auth state to ensure all listeners know we're still active
              masterBus.emit('AUTH_STATE_CHANGED', {
                userId: session.user.id,
                isAuthenticated: true,
              });

              // CRITICAL: Re-initialize PostgresSyncHooks with the fresh token.
              // The old realtime channel was authenticated with the previous JWT.
              // After token rotation, Supabase's server may reject events on the
              // stale channel, silently breaking all realtime subscriptions.
              // This is the #1 cause of "connectivity issues" — the WebSocket
              // stays connected but receives zero events because the token expired.
              //
              // FIX 5: Wrapped in try/catch with retry. Previously, if init() threw,
              // the old channel was already destroyed and no new channel was created,
              // silently killing ALL realtime updates for the rest of the session.
              try {
                postgresSyncHooks.destroy();
                postgresSyncHooks.init(session.user.id);
              } catch (syncErr) {
                reportError(syncErr, 'IdentityDNA.PostgresSyncHooks_reinit_failed_retrying');
                // Retry once after a short delay — transient failures are common during token rotation
                setTimeout(() => {
                  try {
                    postgresSyncHooks.destroy(); // Clean up any partial state
                    postgresSyncHooks.init(session.user.id);
                    console.debug('[IdentityDNA] PostgresSyncHooks re-init succeeded on retry');
                  } catch (retryErr) {
                    reportError(retryErr, 'IdentityDNA.PostgresSyncHooks_reinit_FAILED_on_retry');
                    // Emit bus event so UI can show a connectivity warning
                    // Using REALTIME_DISCONNECTED (registered type) since realtime is effectively down
                    masterBus.emit('REALTIME_DISCONNECTED', {
                      channelName: 'postgres-sync-hooks',
                      reason: 'PostgresSyncHooks init failed after token refresh',
                    });
                  }
                }, 2000);
              }
            }
            break;

          case 'USER_UPDATED':
            if (session) {
              this.hydrateUserFromSession(session);
              this.loadProfileInBackground(session.user.id);
              masterBus.emit('USER_PROFILE_LOADED', {
                userId: session.user.id,
              });
            }
            break;
        }
      }
    );
  }

  /**
   * Hydrate user store from session — synchronous part only.
   * Sets basic user info from the JWT/session immediately.
   *
   * CRITICAL: This method must NOT make any Supabase queries because it runs
   * inside _notifyAllSubscribers() during SDK initialization. Supabase queries
   * internally call getSession() → await initializePromise → DEADLOCK because
   * init hasn't finished yet (it's waiting for us to return).
   *
   * Profile loading happens separately via loadProfileInBackground().
   */
  private hydrateUserFromSession(session: Session): void {
    const userId = session.user.id;
    const email = session.user.email;
    const metadata = session.user.user_metadata;

    /* Set basic info from session — instant, no SDK calls.

       THE JWT'S `full_name` IS A REAL NAME AND BELONGS IN `full_name` (Dan
       2026-09-03: "IT SHOULD SAY THE POKER ALIAS (KingFish) NOT DAN BEKAVAC").
       This used to fold it into `display_name`, which is exactly the column the
       arena resolver falls back to - so the card's first paint printed the
       player's legal name, and kept printing it on any route where the full
       profile load never ran. Filed in its own field, `playerDisplayName`
       recognises it as the real name and refuses it on an arena surface, and
       the social surface gets a correct one for free. */
    useUserStore.getState().setUser({
      id: userId,
      username: email?.split('@')[0] || 'Player',
      display_name: metadata?.display_name || null,
      full_name: metadata?.full_name || null,
      avatar_url: metadata?.avatar_url || null,
    });
  }

  /**
   * Load full user profile from database in the background.
   * This is separated from hydrateUserFromSession to avoid the initialization
   * deadlock — see the CRITICAL note above.
   *
   * Uses a small delay (setTimeout 0) to ensure the SDK's initializePromise
   * has resolved before making any Supabase queries.
   */
  private loadProfileInBackground(userId: string): void {
    // Use setTimeout(0) to break out of the _notifyAllSubscribers synchronous chain.
    // This ensures initializePromise resolves before we call getSession() via a query.
    setTimeout(async () => {
      try {
        const profile = await this.loadUserProfile(userId);
        if (profile) {
          useUserStore.getState().setUser({
            id: profile.id,
            username: profile.username,
            display_name: profile.display_name,
            /* The name columns travel WITH the profile. Without them this
               write - the last one to land on a cold load - replaced a store
               that already knew the alias with one that did not. */
            alias: profile.alias ?? null,
            first_name: profile.first_name ?? null,
            last_name: profile.last_name ?? null,
            full_name: profile.full_name ?? null,
            display_name_preference: profile.display_name_preference ?? null,
            use_real_name: profile.use_real_name ?? null,
            avatar_url: profile.avatar_url,
            vip_level: ((profile as any).tier ||
              profile.vip_level ||
              'bronze') as UserProfile['vip_level'],
            player_number: profile.player_number,
          });
          console.debug('[IdentityDNA] Full profile loaded from database');
        }
      } catch (e) {
        console.warn('[PROFILE] Could not load from database, using session data');
      }
    }, 0);
  }

  /**
   * Load user profile from Supabase profiles table
   */
  async loadUserProfile(userId: string): Promise<UserProfile | null> {
    /**
     * Dan 2026-08-20: this was `select('*')` and it ALWAYS failed — 403 on
     * every load, for signed-in users too. `profiles` has 114 columns but
     * `authenticated` is granted SELECT on 103: email, phone,
     * stripe_customer_id, is_farming_flagged and seven others are deliberately
     * withheld. Postgres refuses the whole statement when a star-select
     * touches an ungranted column, so the profile silently never loaded and
     * the catch below wrote it off as an expected anon/RLS denial. It was
     * neither anon nor RLS — the row policy is `true`.
     *
     * Ask for the columns this actually returns. Adding one here means
     * checking it is granted first.
     */
    const { data, error } = await supabase
      .from('profiles')
      /* PLAYER_NAME_COLUMNS is the list `playerDisplayName` resolves over, and
         it is imported rather than retyped so this select and the store's can
         never drift apart again. All eight are granted to `authenticated` -
         verified against the live schema, and it matters: per the note above,
         ONE ungranted column 403s the whole statement and the profile then
         silently never loads. */
      .select(
        `id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url, tier, created_at, updated_at, player_number`
      )
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      // PGRST116 = row not found (new user, profile not yet created)
      // 42501 = permission denied — expected when anon/unauthenticated session hits RLS
      // Both are non-actionable — do not report to Sentry
      const isBenign =
        error.code === 'PGRST116' ||
        error.code === '42501' ||
        error.message?.includes('permission denied');
      if (!isBenign) {
        reportError(error, 'IdentityDNA.Load_error');
      } else {
        console.debug('[IdentityDNA] Profile load skipped (expected):', error.code, error.message);
      }
      return null;
    }

    if (!data) return null;
    return data as UserProfile;
  }

  /**
   * Clear user data on logout
   */
  private clearUser(): void {
    useUserStore.getState().logout();
    useHeaderDataStore.getState().teardown();
    clearSessionCache();
  }

  /**
   * Update internal status
   */
  private updateStatus(authenticated: boolean, session: Session | null): void {
    this.status = {
      loaded: true,
      authenticated,
      userId: session?.user?.id || null,
      username: session?.user?.email?.split('@')[0] || null,
      sessionExpiresAt: session?.expires_at
        ? new Date(session.expires_at * 1000).toISOString()
        : null,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Perform secure logout
   */
  async logout(): Promise<void> {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        reportError(error, 'IdentityDNA.Error');
        throw error;
      }
      // Auth listener will handle the rest
    } catch (e) {
      // Force clear even if Supabase fails
      this.clearUser();
      throw e;
    }
  }

  /**
   * Get current status
   */
  getStatus(): IdentityDNAStatus | null {
    return this.status;
  }

  /**
   * Check if loaded
   */
  isLoaded(): boolean {
    return this.status?.loaded === true;
  }

  /**
   * Check if authenticated
   */
  isAuthenticated(): boolean {
    return this.status?.authenticated === true;
  }

  /**
   * Get current user ID
   */
  getUserId(): string | null {
    return this.status?.userId || null;
  }

  /**
   * Cleanup (for unmounting)
   */
  cleanup(): void {
    if (this.authListener) {
      this.authListener.data?.subscription?.unsubscribe();
      this.authListener = null;
    }
    this.initialized = false;
    this.status = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// Singleton instance
export const identityDNA = new IdentityDNACore();

// Convenience functions
export async function initIdentityDNA(): Promise<IdentityDNAStatus> {
  return identityDNA.init();
}

export function getIdentityDNAStatus(): IdentityDNAStatus | null {
  return identityDNA.getStatus();
}

export function isIdentityDNALoaded(): boolean {
  return identityDNA.isLoaded();
}

export function isAuthenticated(): boolean {
  return identityDNA.isAuthenticated();
}
