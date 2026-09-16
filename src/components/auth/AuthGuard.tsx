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

import { ReactNode, useEffect, useState, useRef } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useUserStore } from '../../stores/useUserStore';
import { readLocalSession, hasLocalSession, SPA_AUTH_BREADCRUMB } from '../../lib/authUtils';
import { reportError } from '../../utils/errorReporter';
import { IS_NATIVE_BUILD } from '../../lib/appBase';
import { signInUrl } from '../../lib/signIn';

const SESSION_CHECK_TIMEOUT = 5000; // 5s max wait for getSession (increased from 3s)

/**
 * SPA Navigation Breadcrumb — tracks that the user was previously authenticated
 * in this browser session. Used to prevent spurious redirects during in-SPA
 * navigation when a token refresh or transient store reset occurs.
 */
// SPA_AUTH_BREADCRUMB now lives in lib/authUtils so the sign-out path can
// clear the same key this writes. Nothing used to clear it at all.

function markAuthenticated(): void {
  try {
    sessionStorage.setItem(SPA_AUTH_BREADCRUMB, Date.now().toString());
  } catch {
    /* storage full */
  }
}

/** Was the user authenticated in this session within the last 30 minutes? */
function wasRecentlyAuthenticated(): boolean {
  try {
    const ts = sessionStorage.getItem(SPA_AUTH_BREADCRUMB);
    if (!ts) return false;
    const elapsed = Date.now() - parseInt(ts, 10);
    return elapsed < 30 * 60 * 1000; // 30 minutes
  } catch {
    return false;
  }
}

interface AuthGuardProps {
  children: ReactNode;
  loadingFallback?: ReactNode;
  /**
   * Rendered INSTEAD of redirecting when there is no session. Used by the
   * arena root so a signed-out visitor (and Googlebot) gets the public
   * Poker Arena landing page rather than a bounce to the login form.
   * Signed-in players are unaffected: `children` renders as before.
   */
  publicFallback?: ReactNode;
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
  /* The JWT's `full_name` is a REAL NAME and is filed as one, not folded into
     `display_name` (Dan 2026-09-03: "IT SHOULD SAY THE POKER ALIAS (KingFish)
     NOT DAN BEKAVAC"). `display_name` is the arena resolver's last resort, so a
     legal name parked there gets printed at the tables. Matching note in
     IdentityDNA.hydrateUserFromSession. */
  useUserStore.getState().setUser({
    id,
    username: email?.split('@')[0] || 'Player',
    display_name: user_metadata?.display_name || null,
    full_name: user_metadata?.full_name || null,
    avatar_url: user_metadata?.avatar_url || null,
  });
}

/**
 * Hydrate the Zustand user store from localStorage session data.
 * Uses shared readLocalSession() from lib/authUtils — no duplicate JWT parsing.
 */
function hydrateStoreFromLocalStorage(): void {
  const storeUser = useUserStore.getState().user;
  if (storeUser) return; // Already hydrated

  const session = readLocalSession();
  if (session) {
    useUserStore.getState().setUser({
      id: session.userId,
      username: session.username || 'Player',
      display_name: null,
      avatar_url: null,
    });
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

export function AuthGuard({ children, loadingFallback, publicFallback }: AuthGuardProps) {
  // CRITICAL: Check ALL evidence sources synchronously on mount.
  // This prevents the loading flash on navigation between protected routes.
  const initiallyAuthenticated = isDefinitelyAuthenticated();

  const [isLoading, setIsLoading] = useState(!initiallyAuthenticated);
  const [isAuthenticated, setIsAuthenticated] = useState(initiallyAuthenticated);
  const location = useLocation();

  // Retry-before-redirect counter — prevents spurious redirects during in-SPA navigation
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 800; // Short delay between retries

  // Mark breadcrumb when authenticated (so future AuthGuard instances know
  // the user was recently authenticated in this SPA session)
  useEffect(() => {
    if (isAuthenticated) {
      markAuthenticated();
    }
  }, [isAuthenticated]);

  // Cleanup retry timer on unmount
  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

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
              // RETRY GUARD: If the user was recently authenticated in this SPA session,
              // don't give up immediately — a token refresh may be in-flight.
              if (wasRecentlyAuthenticated() && retryCountRef.current < MAX_RETRIES) {
                retryCountRef.current++;
                console.warn(
                  `[AUTH GUARD] Session missing but user was recently authenticated - retry ${retryCountRef.current}/${MAX_RETRIES}`
                );
                retryTimerRef.current = setTimeout(() => {
                  if (!cancelled) checkAuth();
                }, RETRY_DELAY_MS);
                return; // Don't set unauthenticated yet
              }
              setIsAuthenticated(false);
            }
          }
          setIsLoading(false);
        }
      } catch (err) {
        reportError(err, 'AuthGuard.Error');
        // getSession timed out. Check localStorage one final time before giving up.
        if (!cancelled) {
          if (hasLocalSession()) {
            hydrateStoreFromLocalStorage();
            setIsAuthenticated(true);
          } else {
            // RETRY GUARD: Same logic — retry before giving up
            if (wasRecentlyAuthenticated() && retryCountRef.current < MAX_RETRIES) {
              retryCountRef.current++;
              console.warn(
                `[AUTH GUARD] getSession() failed but user was recently authenticated - retry ${retryCountRef.current}/${MAX_RETRIES}`
              );
              retryTimerRef.current = setTimeout(() => {
                if (!cancelled) checkAuth();
              }, RETRY_DELAY_MS);
              return;
            }
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
          '[AUTH GUARD] Store cleared but localStorage has valid session - re-hydrating instead of redirecting'
        );
        hydrateStoreFromLocalStorage();
        // Do NOT set isAuthenticated to false
        return;
      }

      // BREADCRUMB CHECK: If user was recently authenticated in this SPA session,
      // delay the redirect to allow token refresh to complete.
      if (wasRecentlyAuthenticated()) {
        console.warn(
          '[AUTH GUARD] Store cleared and localStorage empty, but user was recently authenticated - delaying redirect'
        );
        // Wait and re-check before redirecting
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => {
          // Final check after delay
          if (hasLocalSession()) {
            hydrateStoreFromLocalStorage();
            setIsAuthenticated(true);
          } else if (isDefinitelyAuthenticated()) {
            setIsAuthenticated(true);
          } else {
            console.debug('[AUTH GUARD] Confirmed real sign-out after delay');
            setIsAuthenticated(false);
          }
        }, RETRY_DELAY_MS);
        return;
      }

      // localStorage is also empty and no breadcrumb — this is a real sign-out
      console.debug('[AUTH GUARD] Real sign-out detected (store + localStorage both empty)');
      setIsAuthenticated(false);
    }
  }, [storeAuthenticated, storeUser, isLoading, isAuthenticated]);

  // Show loading state
  if (isLoading) {
    if (loadingFallback) return <>{loadingFallback}</>;
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
    if (publicFallback !== undefined) return <>{publicFallback}</>;
    const back = location.pathname + location.search + location.hash;
    if (IS_NATIVE_BUILD) {
      // NATIVE (2026-09-07): there is no World Hub in the bundle, so the
      // in-app AuthPage is the login page. Routed in-SPA: no reload, and the
      // way back is an in-app path. src/lib/signIn.ts decides the shape.
      return <Navigate to={signInUrl(back)} replace />;
    }
    // WEB, HARDENED: Always redirect to the canonical World Hub login page
    // instead of the regressed internal SPA auth component.
    window.location.href = signInUrl(back);
    return null;
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
        reportError(err, 'AuthGuard.Error');
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
