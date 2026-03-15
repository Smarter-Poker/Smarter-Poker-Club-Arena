/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  waitForAuth — Lightweight iframe auth readiness check
 * ═══════════════════════════════════════════════════════════════════════════════
 * In iframe context, the parent (smarter.poker) sends auth via postMessage.
 * Instead of polling getSession() 10 times (hammering Supabase), this utility
 * checks the Zustand store first (instant), then falls back to a single
 * getSession() call with a short timeout.
 *
 * Usage:
 *   const ready = await waitForAuth();
 *   if (!ready) return; // Auth not available
 */

import { useUserStore } from '../stores/useUserStore';
import { supabase } from '../lib/supabase';

const MAX_WAIT_MS = 3000; // Total max wait
const POLL_INTERVAL_MS = 150; // Check store every 150ms

/**
 * Wait for auth to be ready. Returns true if authenticated, false if timed out.
 * Checks the Zustand store first (no network call), then falls back to getSession().
 */
export async function waitForAuth(isMountedCheck?: () => boolean): Promise<boolean> {
  // Fast path: store already has a user
  const storeUser = useUserStore.getState().user;
  if (storeUser?.id) return true;

  // Not in iframe? Single getSession() check is enough.
  const inIframe = typeof window !== 'undefined' && window.parent !== window;
  if (!inIframe) {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      return !!session?.user;
    } catch {
      return false;
    }
  }

  // In iframe: poll the Zustand store (no network calls) until populated by postMessage handler
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    if (isMountedCheck && !isMountedCheck()) return false;

    const user = useUserStore.getState().user;
    if (user?.id) return true;

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Final fallback: one getSession() call
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return !!session?.user;
  } catch {
    return false;
  }
}
