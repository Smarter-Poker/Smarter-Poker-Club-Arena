/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA API CLIENT — the single client->server path for privileged actions
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 * ---------------
 * Money/privileged RPCs in Supabase are granted to `service_role` ONLY. A direct
 * browser `supabase.rpc('mint_club_chips', ...)` therefore returns
 * `42501 permission denied` -- the button looks wired but can never succeed.
 * A live grant sweep found 45 such call sites (verified via
 * `has_function_privilege('authenticated', oid, 'EXECUTE') = false`).
 *
 * The World Hub API routes under `/api/club-arena/*` are the sanctioned path:
 * each one authenticates the caller from the JWT (so the actor cannot be spoofed
 * by a client-supplied id), enforces its own authorization, applies rate limits,
 * economy caps, settlement locks and idempotency, and writes the audit trail
 * before calling the privileged RPC with the service role.
 *
 * Every client feature that needs a privileged action goes through here.
 */

import { supabase } from '../lib/supabase';
import { uuid } from '../pages/marketplace/marketplaceShared';

export interface ClubArenaApiOptions {
  /**
   * Send an `X-Idempotency-Key`. Default true -- safe for the mutating routes,
   * which de-duplicate double-taps on laggy mobile networks. Set false for
   * naturally-repeatable reads.
   */
  idempotent?: boolean;
  /** Override the HTTP method. Defaults to POST (all mutating routes are POST). */
  method?: 'POST' | 'GET';
}

/**
 * POST a body to `/api/club-arena/<endpoint>` with the caller's Supabase JWT.
 *
 * Throws on transport failure, non-2xx, or a `{ success: false }` payload, using
 * the server-supplied error message so the UI can surface the real reason
 * (insufficient balance, cap exceeded, settlement locked, not authorized).
 */
export async function callClubArenaApi<T = Record<string, unknown>>(
  endpoint: string,
  body: Record<string, unknown> = {},
  opts: ClubArenaApiOptions = {}
): Promise<T & { success: true }> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (opts.idempotent !== false) {
    // crypto.randomUUID is undefined on http origins and Safari < 15.4; every
    // purchase/mutation goes through here, so it must not throw there.
    headers['X-Idempotency-Key'] = uuid();
  }

  const response = await fetch(`/api/club-arena/${endpoint}`, {
    method: opts.method || 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const data = await response
    .json()
    .catch(() => ({ success: false, error: `HTTP ${response.status}` }));

  if (!data?.success) {
    throw new Error(data?.error || `Request failed (HTTP ${response.status})`);
  }

  return data as T & { success: true };
}

export default callClubArenaApi;
