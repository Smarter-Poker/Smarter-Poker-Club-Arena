/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  waitForAuth — Lightweight iframe auth readiness check
 * ═══════════════════════════════════════════════════════════════════════════════
 * In iframe context, the parent (smarter.poker) sends auth via postMessage.
 * The Supabase session is set asynchronously via setSession() in App.tsx.
 *
 * CRITICAL: We must wait for the actual Supabase session (not just the Zustand
 * store) because IdentityDNA populates the store from a localStorage JWT before
 * setSession() completes. Queries that run before setSession() will fail with
 * RLS because the SDK doesn't have a valid session yet.
 *
 * Usage:
 *   const ready = await waitForAuth();
 *   if (!ready) return; // Auth not available
 */

import { supabase } from '../lib/supabase';

const MAX_WAIT_MS = 5000; // Total max wait (increased from 3s to 5s for postMessage latency)
const POLL_INTERVAL_MS = 100; // Check session every 100ms (getSession is local/fast)

/**
 * Wait for auth to be ready. Returns true if authenticated, false if timed out.
 * In iframe context: polls getSession() until the Supabase SDK has a valid session
 * (set by App.tsx's postMessage handler calling setSession()).
 */
export async function waitForAuth(isMountedCheck?: () => boolean): Promise<boolean> {
  // Fast path: check if Supabase already has a session
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.user) return true;
  } catch {
    // continue to polling
  }

  // Not in iframe? No postMessage auth coming — give up.
  const inIframe = typeof window !== 'undefined' && window.parent !== window;
  if (!inIframe) {
    return false;
  }

  // In iframe: poll getSession() until setSession() from postMessage resolves.
  // getSession() reads from the SDK's in-memory store — it's instant after
  // setSession() has been called. No network calls, no Supabase hammering.
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    if (isMountedCheck && !isMountedCheck()) return false;

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.user) return true;
    } catch {
      // continue polling
    }
  }

  // Timed out — no session available
  console.warn('[waitForAuth] Timed out waiting for Supabase session in iframe');
  return false;
}
