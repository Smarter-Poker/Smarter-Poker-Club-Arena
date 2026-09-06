/**
 * Pure helper functions for the engine WebSocket transport.
 * Kept in their own module so they can be unit-tested without pulling in
 * the full EngineWebSocketServer class (which at import-time initializes
 * Supabase and refuses to load without a service role key).
 */

/**
 * Parse `/ws/table/:tableId` and reject anything else. Returns the tableId
 * lowercased, or null if the path is malformed / doesn't match the route.
 */
export function parseTableIdFromPath(pathname: string | undefined): string | null {
  if (!pathname) return null;
  const m =
    /^\/ws\/table\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(
      pathname
    );
  return m ? m[1].toLowerCase() : null;
}

/**
 * Extract the Bearer JWT from a Sec-WebSocket-Protocol header. Accepts
 * either a raw comma-separated string or the array-form some proxies pass.
 * Returns the token if it matches the three-segment JWT shape; null otherwise.
 */
export function extractBearerToken(
  rawProtocolHeader: string | string[] | undefined
): string | null {
  if (!rawProtocolHeader) return null;
  const joined = Array.isArray(rawProtocolHeader) ? rawProtocolHeader.join(',') : rawProtocolHeader;
  const parts = joined
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bearerIdx = parts.findIndex((p) => p.toLowerCase() === 'bearer');
  if (bearerIdx === -1) return null;
  const next = parts[bearerIdx + 1];
  if (!next) return null;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(next)) return null;
  return next;
}

// ─── Token verdicts: "no" is not one thing (2026-09-04) ──────────────────────
//
// THE OUTAGE. From 2026-09-03 20:45 UTC a World Hub cron signed in as Dan and
// then called a global signOut() every fifteen minutes, revoking every session
// he had. The engine's auth.getUser() got `session_not_found`, both upgrade
// handlers wrote a bare `HTTP/1.1 401` BEFORE the WebSocket handshake, and a
// browser reports a pre-handshake refusal as close code 1006 - the same code
// it uses for a dropped Wi-Fi link. EngineStateClient did the only thing 1006
// can mean and reconnected with the same dead token on its backoff ladder,
// forever. Twenty-two hours of "Reconnecting To The Table" while the lobby
// worked, because PostgREST checks signatures, not sessions.
//
// Two changes, both here so the table and channel servers cannot drift:
//
//   1. A verdict says WHY. A token GoTrue definitively rejects (revoked
//      session, bad signature, deleted user) is `denied: 'invalid'`; GoTrue
//      being unreachable or answering 5xx is `denied: 'unavailable'`. They
//      used to collapse into the same null and the same 401.
//   2. An invalid token is refused AFTER the handshake, with close code 4401
//      and a reason the browser can read. That is the code EngineStateClient
//      has handled as CLOSE_AUTH_FAILED since day one - the server simply
//      never sent it. 'unavailable' stays a pre-handshake 503: the client
//      sees 1006 and keeps retrying, which is exactly right for an auth
//      outage that is not the player's fault.

export type TokenDenial = { userId?: undefined; denied: 'invalid' | 'unavailable'; code: string };
export type TokenVerdict = { userId: string; denied?: undefined } | TokenDenial;

/**
 * The denial in a verdict, or null when the token is good. `null` from an
 * injected verifier (the pre-2026-09-04 contract) is an invalid token.
 */
export function tokenDenial(verdict: TokenVerdict | null | undefined): TokenDenial | null {
  if (!verdict) return { denied: 'invalid', code: 'invalid' };
  if (typeof verdict.userId === 'string' && verdict.userId) return null;
  const d = verdict as TokenDenial;
  return {
    denied: d.denied === 'unavailable' ? 'unavailable' : 'invalid',
    code: d.code || 'invalid',
  };
}

/**
 * GoTrue statuses that mean "this token will never work again": the session
 * row is gone (global sign-out, admin sign-out, password change), the
 * signature is wrong or the signing key was retired, or the user is deleted.
 * Anything else (0 = fetch failed, 429, 5xx) is a temporary inability to
 * check, and a temporary inability to check must never become a refusal.
 */
export function classifyGetUserError(
  err:
    | {
        status?: number;
        code?: string;
        message?: string;
      }
    | null
    | undefined
): { denied: 'invalid' | 'unavailable'; code: string } {
  const status = typeof err?.status === 'number' ? err.status : 0;
  const code = String(err?.code || '').trim() || (status ? `http_${status}` : 'unreachable');
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return { denied: 'invalid', code };
  }
  return { denied: 'unavailable', code };
}

/**
 * Close-frame reason for a refused upgrade. RFC 6455 caps the reason at 123
 * bytes and the client keys on the `auth:` prefix, so it is short and
 * mechanical: `auth:session_not_found`, `auth:bad_jwt`, `auth:user_not_found`.
 */
export function authRejectionReason(code: string): string {
  const safe = String(code || 'invalid')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 60);
  return `auth:${safe}`;
}

/**
 * Verify a bearer JWT with Supabase and say why when it fails. `getUser` is a
 * network call to GoTrue that checks the SESSION, not just the signature -
 * which is the whole point: it is the one check that knows a revoked session
 * from a live one.
 */
export async function verifySupabaseToken(
  auth: {
    getUser: (jwt: string) => Promise<{
      data: { user: { id: string } | null } | null;
      error: { status?: number; code?: string; message?: string } | null;
    }>;
  },
  token: string
): Promise<TokenVerdict> {
  if (!token) return { denied: 'invalid', code: 'missing' };
  try {
    const { data, error } = await auth.getUser(token);
    if (error) return classifyGetUserError(error);
    if (!data?.user?.id) return { denied: 'invalid', code: 'no_user' };
    return { userId: data.user.id };
  } catch (err) {
    return classifyGetUserError(err as { status?: number; code?: string });
  }
}

// ─── The refusal counter: 22 hours of 401s and nothing paged ────────────────
//
// Every socket Dan opened was refused, four times an hour for a day, and no
// alert fired, because a refused upgrade was not a number anywhere. This
// counter is rendered by GameServer.getPrometheusMetrics() (the always-on
// exposition, not the ENGINE_METRICS-gated registry) and watched by
// EngineRefusingSessions in infra/monitoring/alert-rules.yml.
//
// Labels: path (table | multi | channel), denied (invalid | unavailable). The
// GoTrue code is deliberately NOT a label - it is bounded but it is noise for
// an alert; the close reason carries it to the one client that needs it.

const wsAuthRefusals = new Map<string, number>();

export function recordWsAuthRefusal(
  path: 'table' | 'multi' | 'channel',
  denied: 'invalid' | 'unavailable'
): void {
  const key = `${path}|${denied}`;
  wsAuthRefusals.set(key, (wsAuthRefusals.get(key) ?? 0) + 1);
}

/** Prometheus exposition lines for the refusal counter (always present, even at zero). */
export function wsAuthRefusalPrometheusLines(): string[] {
  const lines = [
    '# HELP poker_ws_auth_refused_total WebSocket upgrades refused for auth (label: path, denied). invalid = GoTrue rejected the session; unavailable = GoTrue could not be asked',
    '# TYPE poker_ws_auth_refused_total counter',
  ];
  for (const path of ['table', 'multi', 'channel'] as const) {
    for (const denied of ['invalid', 'unavailable'] as const) {
      lines.push(
        `poker_ws_auth_refused_total{path="${path}",denied="${denied}"} ${wsAuthRefusals.get(`${path}|${denied}`) ?? 0}`
      );
    }
  }
  return lines;
}

/** Test seam. */
export function _resetWsAuthRefusalsForTests(): void {
  wsAuthRefusals.clear();
  wsProtocolRefusals.clear();
}

// ─── The protocol counter (Phase 4 audit, 2026-09-05) ───────────────────────
//
// The auth counter above exists because 22 hours of refusals were not a number
// anywhere. The protocol gate shipped with exactly that defect: it refuses a
// socket and records nothing, so the day `MIN_CLIENT_PROTOCOL` is raised, the
// wave of stale tabs being turned away would be invisible - and that wave is
// the ONE thing you want to watch on that day, because it tells you whether it
// is draining (tabs reloading, as designed) or flat (tabs reloading into the
// same refusal, which would be a loop).
//
// It should read zero forever until a floor is raised, and then spike and
// drain. One label, the socket it happened on.

const wsProtocolRefusals = new Map<string, number>();

export function recordWsProtocolRefusal(path: 'table' | 'multi' | 'channel'): void {
  wsProtocolRefusals.set(path, (wsProtocolRefusals.get(path) ?? 0) + 1);
}

/** Prometheus lines for the protocol counter (always present, even at zero). */
export function wsProtocolRefusalPrometheusLines(): string[] {
  const lines = [
    '# HELP poker_ws_protocol_refused_total WebSocket upgrades refused for speaking a protocol older than the engine serves (label: path). Zero until MIN_CLIENT_PROTOCOL is raised; then it should spike and drain as stale tabs fetch a new bundle',
    '# TYPE poker_ws_protocol_refused_total counter',
  ];
  for (const path of ['table', 'multi', 'channel'] as const) {
    lines.push(
      `poker_ws_protocol_refused_total{path="${path}"} ${wsProtocolRefusals.get(path) ?? 0}`
    );
  }
  return lines;
}
