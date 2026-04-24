/**
 * Supabase JWT authentication helper for HTTP requests.
 *
 * Extracted from `server/src/index.ts` in Phase U3.2 (2026-04-23) so all route
 * handlers under `server/src/handlers/*` can import it directly.
 * Behavior-preserving extraction — same cache semantics, same fallback order,
 * same background-refresh pattern.
 *
 * Auth performance fix (2026-04-14) — `supabase.auth.getUser()` is a network
 * round-trip to GoTrue that costs 2-4 seconds on every request. Heartbeats,
 * /action, /preaction etc. were ALL serialised behind that. The strategy is:
 *
 *   1. Fast path: in-memory cache with 60s TTL
 *   2. Local-decode fallback: trust the JWT's own exp claim, refresh cache in bg
 *   3. Last resort: full GoTrue verify (cache miss AND local decode rejected)
 */

import type { IncomingMessage } from 'http';
import { supabase } from '../services/supabase.js';

const AUTH_CACHE_TTL_MS = 60_000; // 60s — tradeoff: faster response vs less-fresh revocation
const authCache = new Map<string, { userId: string; expiresAt: number }>();

/** Manually decode a Supabase JWT payload (base64url middle segment). */
function decodeJwtPayload(token: string): { sub?: string; exp?: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // base64url -> base64
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(json);
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

  // Fast path: cached verification still fresh (and not past JWT exp).
  const cached = authCache.get(token);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return { userId: cached.userId };
  }

  // Local-decode fallback: if the JWT's own exp hasn't passed, trust it for
  // this request and refresh the GoTrue cache in the background. Avoids
  // blocking the player on a slow auth network call. Falls back to a full
  // GoTrue verify only if local decode also failed.
  const claims = decodeJwtPayload(token);
  if (claims?.sub && typeof claims.exp === 'number' && claims.exp * 1000 > now) {
    const userId = claims.sub;
    // Background refresh — don't await. Even if it fails, we still served
    // this request from local decode.
    void supabase.auth.getUser(token).then(
      ({ data, error }) => {
        if (!error && data?.user?.id) {
          authCache.set(token, {
            userId: data.user.id,
            expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
          });
        }
      },
      () => {
        /* silent — local decode already accepted */
      }
    );
    return { userId };
  }

  // Last resort: full GoTrue verify. Only hit when both cache miss AND local
  // decode rejected (token expired or malformed).
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    authCache.set(token, {
      userId: data.user.id,
      expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
    });
    return { userId: data.user.id };
  } catch {
    return null;
  }
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
