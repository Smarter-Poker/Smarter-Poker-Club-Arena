/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Auth Guard Component (HARDENED)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Protects routes that require authentication.
 * Redirects to /auth ONLY as a last resort when ALL evidence of a session is gone.
 *
 * CRITICAL DESIGN PRINCIPLES:
 * 1. NEVER redirect to /auth if there's any valid session evidence
 *    (store, localStorage, getSession)
 * 2. On navigation between pages, check store FIRST (instant, no async)
 * 3. localStorage JWT check is the safety net when store is empty
 * 4. getSession() is the final fallback for OAuth callbacks
 * 5. Auth state listener is owned by IdentityDNA — AuthGuard does NOT create
 *    its own onAuthStateChange listener
 * 6. If sign-out is detected, DOUBLE-CHECK localStorage before redirecting
 *    to prevent race conditions from transient store resets
 */

import { ReactNode, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useUserStore } from '../../stores/useUserStore';

const AUTH_STORAGE_KEY = 'smarter-poker-auth';
const SESSION_CHECK_TIMEOUT = 5000; // 5s max wait for getSession (increased from 3s)

interface AuthGuardProps {
  children: ReactNode;
}

/**
 * Fast session check from localStorage (bypasses navigator.locks).
 * Returns true if a non-expired JWT exists in localStorage.
 */
function hasLocalSession(): boolean {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    const token = data?.access_token;
    if (!token || typeof token !== 'string') return false;
    // Validate JWT structure (must have exactly 3 parts)
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    // Check expiry from JWT payload (with 60s buffer for clock skew)
    const payload = JSON.parse(atob(parts[1]));
    return payload.exp * 1000 > Date.now() - 60_000;
  } catch {
    // Malformed JWT, corrupted localStorage, etc. — treat as no session
    return false;
  }
}

/**
 * Hydrate the Zustand user store from a Supabase session if it's empty.
 */
function hydrateStoreFromSession(session: {
  user: { id: string; email?: string; user_metadata?: Record<string, any> };
}): void {
  const storeUser = useUserStore.getState().user;
  if (storeUser) return; // Already hydrated — skip

  const { id, email, user_metadata } = session.user;
  useUserStore.getState().setUser({
    id,
    username: email?.split('@')[0] || 'Player',
    display_name: user_metadata?.display_name || user_metadata?.full_name || null,
    avatar_url: user_metadata?.avatar_url || null,
  });
}

/**
 * Hydrate the Zustand user store from localStorage session data.
 * Used when getSession() times out but we know a valid JWT exists.
 */
function hydrateStoreFromLocalStorage(): void {
  const storeUser = useUserStore.getState().user;
  if (storeUser) return; // Already hydrated

  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    const token = data?.access_token;
    if (!token || typeof token !== 'string') return;
    // Validate JWT structure before decoding
    const parts = token.split('.');
    if (parts.length !== 3) return;
    // Decode JWT payload to get user ID and email
    const payload = JSON.parse(atob(parts[1]));
    if (payload.sub) {
      useUserStore.getState().setUser({
        id: payload.sub,
        username: payload.email?.split('@')[0] || 'Player',
        display_name: null,
        avatar_url: null,
      });
    }
  } catch (err) {
    console.error('[AuthGuard] Error:', err);
    // Silent — best effort
  }
}

/**
 * Comprehensive auth check that uses ALL available evidence.
 * Returns true if the user should be considered authenticated.
 */
function isDefinitelyAuthenticated(): boolean {
  // Check 1: Zustand store (fastest — in-memory)
  if (useUserStore.getState().isAuthenticated && useUserStore.getState().user) {
    return true;
  }

  // Check 2: localStorage JWT (fast — no async, no locks)
  if (hasLocalSession()) {
    return true;
  }

  return false;
}

export function AuthGuard({ children }: AuthGuardProps) {
  // CRITICAL: Check ALL evidence sources synchronously on mount.
  // This prevents the loading flash on navigation between protected routes.
  const initiallyAuthenticated = isDefinitelyAuthenticated();

  const [isLoading, setIsLoading] = useState(!initiallyAuthenticated);
  const [isAuthenticated, setIsAuthenticated] = useState(initiallyAuthenticated);
  const location = useLocation();

  // Hydrate store from localStorage if store is empty but localStorage has session
  useEffect(() => {
    if (initiallyAuthenticated && !useUserStore.getState().user) {
      hydrateStoreFromLocalStorage();
    }
  }, [initiallyAuthenticated]);

  useEffect(() => {
    let cancelled = false;

    async function checkAuth() {
      // FAST PATH: Already determined to be authenticated synchronously
      if (isDefinitelyAuthenticated()) {
        if (!cancelled) {
          // Ensure store is hydrated
          if (!useUserStore.getState().user) {
            hydrateStoreFromLocalStorage();
          }
          setIsAuthenticated(true);
          setIsLoading(false);
        }
        return;
      }

      // SLOW PATH: No evidence in store or localStorage.
      // Try getSession() as final fallback (handles OAuth callbacks, etc.)
      try {
        const sessionPromise = supabase.auth.getSession();
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('getSession timeout')), SESSION_CHECK_TIMEOUT)
        );
        const {
          data: { session },
        } = await Promise.race([sessionPromise, timeoutPromise]);

        if (!cancelled) {
          if (session) {
            hydrateStoreFromSession(session);
            setIsAuthenticated(true);
          } else {
            // FINAL CHECK: Before declaring unauthenticated, check localStorage
            // one more time (race condition: IdentityDNA may have just written it)
            if (hasLocalSession()) {
              hydrateStoreFromLocalStorage();
              setIsAuthenticated(true);
            } else {
              setIsAuthenticated(false);
            }
          }
          setIsLoading(false);
        }
      } catch (err) {
        console.error('[AuthGuard] Error:', err);
        // getSession timed out. Check localStorage one final time before giving up.
        if (!cancelled) {
          if (hasLocalSession()) {
            hydrateStoreFromLocalStorage();
            setIsAuthenticated(true);
          } else {
            setIsAuthenticated(false);
          }
          setIsLoading(false);
        }
      }
    }

    checkAuth();

    return () => {
      cancelled = true;
    };
  }, []);

  // React to store sign-out events — but with EXTRA safety checks.
  // CRITICAL: Do NOT redirect to /auth on transient store resets.
  // Always double-check localStorage before allowing a redirect.
  const storeAuthenticated = useUserStore((s) => s.isAuthenticated);
  const storeUser = useUserStore((s) => s.user);

  useEffect(() => {
    // If the store says authenticated, trust it and ensure our state matches
    if (storeAuthenticated && storeUser) {
      if (!isAuthenticated) {
        setIsAuthenticated(true);
        setIsLoading(false);
      }
      return;
    }

    // Store says NOT authenticated — but is it a real sign-out or a transient reset?
    if (!isLoading && isAuthenticated && !storeAuthenticated) {
      // SAFETY NET: Check localStorage before redirecting.
      // If localStorage still has a valid session, this is a transient store reset
      // (e.g., from a token refresh race condition). Do NOT redirect.
      if (hasLocalSession()) {
        console.warn(
          '[AUTH GUARD] Store cleared but localStorage has valid session — re-hydrating instead of redirecting'
        );
        hydrateStoreFromLocalStorage();
        // Do NOT set isAuthenticated to false
        return;
      }

      // localStorage is also empty — this is a real sign-out
      console.debug('[AUTH GUARD] Real sign-out detected (store + localStorage both empty)');
      setIsAuthenticated(false);
    }
  }, [storeAuthenticated, storeUser, isLoading, isAuthenticated]);

  // Show loading state
  if (isLoading) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #0A0A0F 0%, #12121A 100%)',
          color: '#FFFFFF',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>♠</div>
          <div style={{ color: '#A0A0B8' }}>Loading...</div>
        </div>
      </div>
    );
  }

  // Redirect to auth ONLY if not authenticated
  if (!isAuthenticated) {
    return <Navigate to="/auth" state={{ from: location }} replace />;
  }

  // Render protected content
  return <>{children}</>;
}

export function GuestGuard({ children }: AuthGuardProps) {
  const initiallyAuthenticated = isDefinitelyAuthenticated();

  const [isLoading, setIsLoading] = useState(!initiallyAuthenticated);
  const [isAuthenticated, setIsAuthenticated] = useState(initiallyAuthenticated);

  useEffect(() => {
    let cancelled = false;

    async function checkAuth() {
      if (isDefinitelyAuthenticated()) {
        if (!cancelled) {
          setIsAuthenticated(true);
          setIsLoading(false);
        }
        return;
      }

      try {
        const sessionPromise = supabase.auth.getSession();
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('getSession timeout')), SESSION_CHECK_TIMEOUT)
        );
        const {
          data: { session },
        } = await Promise.race([sessionPromise, timeoutPromise]);
        if (!cancelled) {
          setIsAuthenticated(!!session || hasLocalSession());
          setIsLoading(false);
        }
      } catch (err) {
        console.error('[AuthGuard] Error:', err);
        if (!cancelled) {
          setIsAuthenticated(hasLocalSession());
          setIsLoading(false);
        }
      }
    }

    checkAuth();

    // GuestGuard keeps a lightweight listener since IdentityDNA
    // might fire SIGNED_IN after the initial check (e.g. OAuth callback)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled) {
        setIsAuthenticated(!!session);
        setIsLoading(false);
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  if (isLoading) {
    return null;
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
