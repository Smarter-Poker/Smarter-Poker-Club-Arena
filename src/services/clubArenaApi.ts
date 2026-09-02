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
import { uuid } from '../utils/uuid';

export interface ClubArenaApiOptions {
  /**
   * Send an `X-Idempotency-Key`. Default true -- safe for the mutating routes,
   * which de-duplicate double-taps on laggy mobile networks. Set false for
   * naturally-repeatable reads.
   */
  idempotent?: boolean;
  /**
   * The key to send, when the caller owns one.
   *
   * WHY THIS EXISTS (Dan 2026-08-25). Without it this function minted a fresh
   * uuid() on EVERY call - per request, not per purchase INTENT. So the shape
   * the header is meant to defend against was undefended: Confirm fires, the
   * server commits, the response is lost (mobile network drop, tab
   * backgrounded), the user sees "Purchase failed" and taps Confirm again -
   * and the server receives a DIFFERENT key for the same intent, so it debits
   * a second time. A retry has to carry the same key as the attempt it is
   * retrying, which only the caller knows.
   */
  idempotencyKey?: string;
  /** Override the HTTP method. Defaults to POST (most mutating routes are POST).
   *  PATCH/DELETE added 2026-08-27 for the house-ads admin route, which is a
   *  real CRUD surface rather than a single action. */
  method?: 'POST' | 'GET' | 'PATCH' | 'DELETE';
  /** Query-string parameters. DELETE carries its target in the URL, not a body. */
  query?: Record<string, string | number | undefined | null>;
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
    // The caller's key when it has one (a retry of the SAME intent must reuse
    // it); otherwise a fresh one. crypto.randomUUID is undefined on http
    // origins and Safari < 15.4, so uuid() must not throw there.
    headers['X-Idempotency-Key'] = opts.idempotencyKey || uuid();
  }

  const method = opts.method || 'POST';
  let url = `/api/club-arena/${endpoint}`;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const q = qs.toString();
    if (q) url += `?${q}`;
  }

  const response = await fetch(url, {
    method,
    headers,
    /* GET and DELETE carry no body. Sending one is a spec violation that some
       runtimes reject outright, and a GET with a body silently breaks caching
       proxies. */
    ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
  });

  const data = await response
    .json()
    .catch(() => ({ success: false, error: `HTTP ${response.status}` }));

  if (!data?.success) {
    // Preserve the server's machine-readable flags (soldOut, alreadyOwned,
    // hasSales, ...). Callers previously saw only the message and could not
    // react — e.g. refresh the shop when an item turned out to be sold out.
    const err = new Error(data?.error || `Request failed (HTTP ${response.status})`) as Error & {
      status?: number;
      data?: Record<string, unknown>;
    };
    err.status = response.status;
    err.data = data && typeof data === 'object' ? data : undefined;
    throw err;
  }

  return data as T & { success: true };
}

export default callClubArenaApi;
