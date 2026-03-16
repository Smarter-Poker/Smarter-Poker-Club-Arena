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
import { masterBus } from './MasterBus';
import { achievementTriggerService } from '../services/AchievementTriggerService';
import { postgresSyncHooks } from '../services/PostgresSyncHooks';
import { setSentryUser, clearSentryUser } from './SentryInit';
import { pushNotificationService } from '../services/PushNotificationService';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface UserProfile {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  vip_level: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond'; // Maps to DB `tier` column
  tier?: string; // Raw DB tier value (e.g. "Newcomer")
  created_at: string;
  updated_at?: string;
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
    // In same-origin iframe context, the Hub's session already exists in
    // localStorage under 'smarter-poker-auth'. Reading it directly is instant
    // (no API call, no navigator.locks contention). We only skip this and
    // fall back to getSession() if localStorage is empty or the JWT is expired.
    const localSession = this.readLocalSession();
    if (localSession) {
      console.log('[IdentityDNA] ⚡ Fast path: session found in localStorage');
      authenticated = true;
      userId = localSession.userId;
      username = localSession.username;
      sessionExpiresAt = localSession.expiresAt;
      // Note: We still call getSession() below to get the full Session object
      // for hydration, but we already have the user info for the status.
    }

    try {
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

        // Hydrate user store with session data
        await this.hydrateUserFromSession(session);

        // Emit auth event
        masterBus.emit('AUTH_STATE_CHANGED', {
          userId,
          isAuthenticated: true,
        });
      } else {
        // no-op — if localStorage had a session but getSession returned null,
        // the onAuthStateChange listener will handle sign-in when setSession runs
      }
    } catch (e: any) {
      // AbortError is benign — suppress it
      if (e?.name === 'AbortError' || e?.message?.includes('aborted')) {
        console.warn('  └─ Session check aborted (benign)');
      } else {
        console.error('  └─ Session Check Failed:', e);
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
   * The shared storageKey 'smarter-poker-auth' is written by both Hub and Club Arena.
   * Returns basic user info if a non-expired JWT exists, or null.
   */
  private readLocalSession(): {
    userId: string;
    username: string | null;
    expiresAt: string | null;
  } | null {
    try {
      const AUTH_KEY = 'smarter-poker-auth';
      const raw = localStorage.getItem(AUTH_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const token = data?.access_token;
      if (!token || typeof token !== 'string') return null;

      // Validate JWT structure
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      // Parse payload
      const payload = JSON.parse(atob(parts[1]));

      // Check expiry (60s buffer for clock skew)
      if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now() - 60_000) {
        return null; // Expired
      }

      // Extract user info from JWT sub claim
      const userId = payload.sub;
      if (!userId || typeof userId !== 'string') return null;

      const email = payload.email as string | undefined;
      const username = email?.split('@')[0] || null;
      const expiresAt =
        typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null;

      return { userId, username, expiresAt };
    } catch {
      return null; // Corrupted localStorage or malformed JWT
    }
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
                console.warn('[IdentityDNA] Ignoring concurrent SIGNED_IN — hydration in progress');
                break;
              }
              this.isHydrating = true;
              try {
                await this.hydrateUserFromSession(session);
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

                // Register push notifications
                pushNotificationService
                  .init()
                  .then(() => {
                    pushNotificationService.setExternalUserId(session.user.id);
                  })
                  .catch(() => {
                    /* OneSignal not configured */
                  });

                // Phase 7: Absolute Realtime Perfection (Listen to external/Admin Postgres mutations)
                postgresSyncHooks.init(session.user.id);
              } finally {
                this.isHydrating = false;
              }
            }
            break;

          case 'SIGNED_OUT':
            this.clearUser();
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
              // CRITICAL: Re-hydrate the user store on token refresh.
              // Without this, the Zustand store's isAuthenticated can become stale
              // after the JWT rotates, causing AuthGuard to redirect to /auth.
              // Use timeout to prevent profile load from blocking all auth events.
              try {
                const hydratePromise = this.hydrateUserFromSession(session);
                const timeoutPromise = new Promise<void>((_, reject) =>
                  setTimeout(() => reject(new Error('Profile hydration timeout')), 5000)
                );
                await Promise.race([hydratePromise, timeoutPromise]);
              } catch (err) {
                console.warn('[IdentityDNA] TOKEN_REFRESHED hydration issue:', err);
                // Still update status — user is authenticated even if profile load stalls
              }
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
              postgresSyncHooks.destroy();
              postgresSyncHooks.init(session.user.id);
            }
            break;

          case 'USER_UPDATED':
            if (session) {
              await this.hydrateUserFromSession(session);
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
   * Hydrate user store from session and load full profile
   */
  private async hydrateUserFromSession(session: Session): Promise<void> {
    const userId = session.user.id;
    const email = session.user.email;
    const metadata = session.user.user_metadata;

    // First, set basic info from session
    useUserStore.getState().setUser({
      id: userId,
      username: email?.split('@')[0] || 'Player',
      display_name: metadata?.display_name || metadata?.full_name || null,
      avatar_url: metadata?.avatar_url || null,
    });

    // Then, try to load full profile from database
    try {
      const profile = await this.loadUserProfile(userId);
      if (profile) {
        useUserStore.getState().setUser({
          id: profile.id,
          username: profile.username,
          display_name: profile.display_name,
          avatar_url: profile.avatar_url,
          vip_level: ((profile as any).tier ||
            profile.vip_level ||
            'bronze') as UserProfile['vip_level'], // DB uses `tier`, not `vip_level`
        });
      }
    } catch (e) {
      console.warn('🧬 [PROFILE] Could not load from database, using session data');
    }
  }

  /**
   * Load user profile from Supabase profiles table
   */
  async loadUserProfile(userId: string): Promise<UserProfile | null> {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      // Profile might not exist yet - this is okay for new users
      if (error.code !== 'PGRST116') {
        console.error('🧬 [PROFILE] Load error:', error.message);
      }
      return null;
    }

    return data as UserProfile;
  }

  /**
   * Clear user data on logout
   */
  private clearUser(): void {
    useUserStore.getState().logout();
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
        console.error('🧬 [LOGOUT] Error:', error.message);
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
