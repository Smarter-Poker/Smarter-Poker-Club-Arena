/**
 * Supabase JWT authentication helper for HTTP requests.
 *
 * Extracted from `server/src/index.ts` in Phase U3.2 (2026-04-23) so all route
 * handlers under `server/src/handlers/*` can import it directly.
 * Behavior-preserving extraction — same cache semantics, same fallback order,
 * same background-refresh pattern.
 *
 * Auth performance fix (2026-04-14) — `supabase.auth.getUser(token)` is a network
 * round-trip to GoTrue that costs 2-4 seconds on every request. Heartbeats,
 * /action, /preaction etc. were ALL serialised behind that. The strategy is:
 *
 *   1. Fast path: in-memory cache with 60s TTL keyed on the exact token, so a
 *      token is verified against GoTrue at most once per 60s.
 *   2. Cache miss: full GoTrue verify (validates the signature) before we
 *      trust any claim. A short single-flight map coalesces concurrent
 *      requests carrying the same token so a burst (heartbeat + action + state)
 *      only triggers one verify.
 *
 * SECURITY FIX (2026-07-19) — the previous "local-decode fallback" trusted the
 * JWT's own `sub`/`exp` claims WITHOUT verifying the signature. A forged token
 * (`header.{"sub":"<victim>","exp":9999999999}.x`) was accepted on every
 * request (it never entered the cache, so it always took the unverified path),
 * allowing full account impersonation: reading opponents' hole cards via
 * GET /state, folding a victim's hand, cashing them out, or minting chips via
 * /addchips. The unsigned path is removed — a token is now only trusted after
 * GoTrue verifies its signature. The 60s cache keeps the common (repeat-token)
 * case a single network round-trip per minute; the single-flight map keeps a
 * concurrent burst to one round-trip.
 */

import type { IncomingMessage } from 'http';
import { supabase } from '../services/supabase.js';

const AUTH_CACHE_TTL_MS = 60_000; // 60s — tradeoff: faster response vs less-fresh revocation
const authCache = new Map<string, { userId: string; expiresAt: number }>();
// Coalesce concurrent verifications of the same token (single-flight).
const inFlight = new Map<string, Promise<{ userId: string } | null>>();

async function verifyWithGoTrue(token: string): Promise<{ userId: string } | null> {
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user?.id) return null;
    authCache.set(token, {
      userId: data.user.id,
      expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
    });
    return { userId: data.user.id };
  } catch {
    return null;
  }
}

export async function authenticateRequest(
  req: IncomingMessage
): Promise<{ userId: string } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  if (!token) return null;

  // Fast path: cached, signature-verified result still fresh.
  const cached = authCache.get(token);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return { userId: cached.userId };
  }

  // Cache miss — always verify the signature via GoTrue before trusting any
  // claim. Single-flight so a concurrent burst only verifies once.
  const existing = inFlight.get(token);
  if (existing) return existing;

  const p = verifyWithGoTrue(token).finally(() => {
    inFlight.delete(token);
  });
  inFlight.set(token, p);
  return p;
}

// Periodic cleanup of the auth cache — keeps memory bounded under churn.
// Runs once per import — module-scoped side effect matching the original
// behavior in index.ts. `.unref()` prevents it from keeping the process alive.
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of authCache) {
    if (entry.expiresAt <= now) authCache.delete(token);
  }
}, 30_000).unref();
