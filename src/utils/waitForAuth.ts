/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  waitForAuth — Lightweight iframe auth readiness check
 * ═══════════════════════════════════════════════════════════════════════════════
 * In iframe context, the parent (smarter.poker) sends auth via postMessage.
 * The Supabase session is set asynchronously via setSession() in App.tsx.
 *
 * CRITICAL FIX (v3): supabase.auth.getSession() HANGS in iframe context because
 * the Supabase client's internal _initialize() promise never resolves. The init
 * flow calls _recoverAndRefresh() which makes an API call that hangs in the iframe
 * sandbox. Since getSession() awaits this init promise, it hangs forever.
 *
 * Fix: In iframe mode, bypass getSession() entirely and read the session from
 * localStorage directly — the same proven approach IdentityDNA uses. The shared
 * storageKey 'smarter-poker-auth' is written by both Hub and Club Arena (SSO).
 *
 * Usage:
 *   const ready = await waitForAuth();
 *   if (!ready) return; // Auth not available
 */

import { supabase } from '../lib/supabase';

const AUTH_STORAGE_KEY = 'smarter-poker-auth';
const MAX_WAIT_MS = 5000; // Total max wait for postMessage auth delivery
const POLL_INTERVAL_MS = 100; // Check localStorage every 100ms

/**
 * Read session from localStorage directly — instant, no SDK calls.
 * Returns user info if a non-expired JWT exists, null otherwise.
 * Mirrors IdentityDNA.readLocalSession() logic.
 */
function readLocalSession(): { userId: string; email?: string } | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
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

    const userId = payload.sub;
    if (!userId || typeof userId !== 'string') return null;

    return { userId, email: payload.email };
  } catch {
    return null; // Corrupted localStorage or malformed JWT
  }
}

/**
 * Wait for auth to be ready. Returns true if authenticated, false if timed out.
 *
 * Strategy by context:
 * - Iframe: Read session from localStorage directly (instant, bypasses hanging SDK)
 * - Standalone: Use getSession() with timeout protection
 */
export async function waitForAuth(isMountedCheck?: () => boolean): Promise<boolean> {
  const inIframe = typeof window !== 'undefined' && window.parent !== window;

  // ── IFRAME PATH: Read localStorage directly ──
  // getSession() hangs in iframe because Supabase's _initialize() makes an API call
  // that never resolves. Bypass it entirely — localStorage is the source of truth
  // since Hub and Club Arena share the 'smarter-poker-auth' storageKey (SSO).
  if (inIframe) {
    // Fast check: session might already be in localStorage
    const session = readLocalSession();
    if (session) {
      console.log('[waitForAuth] ✅ Session found in localStorage (instant)');
      return true;
    }

    // Poll localStorage until the parent's postMessage auth arrives
    // App.tsx calls setSession() which writes to localStorage via the SDK
    const start = Date.now();
    while (Date.now() - start < MAX_WAIT_MS) {
      if (isMountedCheck && !isMountedCheck()) return false;

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const polledSession = readLocalSession();
      if (polledSession) {
        console.log(`[waitForAuth] ✅ Session found after ${Date.now() - start}ms`);
        return true;
      }
    }

    console.warn('[waitForAuth] ⏱️ Timed out waiting for session in localStorage');
    return false;
  }

  // ── STANDALONE PATH: Use SDK getSession() with timeout ──
  try {
    const getSessionPromise = supabase.auth.getSession();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('getSession timeout (3s)')), 3000)
    );
    const {
      data: { session },
    } = await Promise.race([getSessionPromise, timeoutPromise]);
    if (session?.user) return true;
  } catch (err) {
    console.warn('[waitForAuth] getSession() failed or timed out:', err);
    // Last resort: check localStorage directly
    const local = readLocalSession();
    if (local) return true;
  }

  return false;
}

/**
 * Get the authenticated user for data queries.
 * In iframe mode, reads from localStorage to avoid the hanging getSession() issue.
 * Returns a user-like object compatible with Supabase's User type.
 */
export function getAuthUserFromLocal(): { id: string; email?: string } | null {
  const session = readLocalSession();
  if (!session) return null;
  return { id: session.userId, email: session.email };
}
