/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A REVOKED SESSION IS NOT A RECONNECT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-04: "ALL TABLES INSIDE THE CLUB ARENA ARE CURRENTLY DOWN, NOBODY
 * CAN PLAY... THEY ALL JUST SAY 'RECONNECTING TO TABLE' AND IT NEVER DOES...
 * JUST SILENTLY FAILS."
 *
 * WHAT HAD HAPPENED. A World Hub cron (login-probe) had been pointed at his own
 * account and was calling a GLOBAL sign-out every fifteen minutes - revoking
 * every session he held, on every device, 76 times a day. The engine checks
 * each table socket with auth.getUser(); GoTrue said `session_not_found`; the
 * engine refused the upgrade with HTTP 401. And here is the part that belongs
 * to THIS file: the browser reports a pre-handshake refusal as close code 1006,
 * the same code as a dropped Wi-Fi link, so EngineStateClient did the only
 * thing 1006 can mean - reconnect, with the same dead token, on the backoff
 * ladder, forever. Twenty-two hours of "Reconnecting To The Table".
 *
 * Nothing else in the app noticed, for two reasons worth keeping in mind:
 *   - PostgREST checks the JWT SIGNATURE, not the session row. Every lobby
 *     query kept returning 200. The app looked signed in.
 *   - The access token lives seven days. supabase-js refreshes near expiry,
 *     so no refresh - the one call that would have said "your session is
 *     gone" - was ever attempted.
 *
 * WHAT THIS DOES. When the engine refuses a socket for AUTH (close 4401 with
 * an `auth:` reason - which the engine sends as of the same fix - or, for any
 * engine that still answers with a bare 401, three handshake failures in a
 * row with no open in between), ask GoTrue directly whether the session is
 * alive:
 *
 *   1. `supabase.auth.getUser()` - a network call that checks the SESSION.
 *      A definitive rejection (401/403: session_not_found, bad_jwt,
 *      user_not_found) means the token is dead. A network error means we do
 *      not know, and "we do not know" is NOT a reason to sign anyone out.
 *   2. If dead, one `refreshSession()`. If the refresh token is also dead
 *      (refresh_token_not_found, "Invalid Refresh Token"), the session is
 *      REVOKED, and the only way back is to sign in again.
 *   3. Then, and only then: clear the local session (scope 'local' - the
 *      server already has nothing to revoke), remember why, and send the
 *      player to the login page with a return path to this table. Loudly.
 *
 * WHAT IT NEVER DOES. It never signs a player out on a network error, a 5xx,
 * a timeout, or an engine restart. Those are the reconnect ladder's job, and
 * "the games can never freeze or die" (Dan, 2026-08-21) still stands: a
 * player with a LIVE session and a flaky link keeps retrying forever, as
 * before. This file only ends the pretence that a dead session is a flaky
 * link.
 */
import { AUTH_STORAGE_KEY } from './authUtils';

export type SessionVerdict = 'alive' | 'revoked' | 'unknown';

/** GoTrue error codes that mean the session or token will never work again. */
const DEFINITIVE_AUTH_CODES = new Set([
  'session_not_found',
  'bad_jwt',
  'user_not_found',
  'refresh_token_not_found',
  'refresh_token_already_used',
  'user_banned',
  'session_expired',
]);

/** sessionStorage key: why we bounced to login, for whoever renders it. */
export const SESSION_REVOKED_STORAGE_KEY = 'ca_session_revoked';

/** Login page on the World Hub; `no_session` is a code its copy table knows. */
export const LOGIN_PATH = '/auth/login';

/** Minimum gap between two probes, so a reconnect storm asks GoTrue once. */
const PROBE_THROTTLE_MS = 15_000;

interface AuthErrorLike {
  status?: number;
  code?: string;
  message?: string;
}

/**
 * Is this GoTrue error a DEFINITIVE "this session is dead", as opposed to
 * "could not ask"? Pure, so the law test can pin it.
 */
export function isDefinitiveAuthRejection(err: AuthErrorLike | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code || '').toLowerCase();
  if (DEFINITIVE_AUTH_CODES.has(code)) return true;
  const status = typeof err.status === 'number' ? err.status : 0;
  if (status === 401 || status === 403) return true;
  // auth-js formats a dead refresh token as "Invalid Refresh Token: ..." with
  // status 400 and, on older versions, no code.
  if (status === 400 && /invalid refresh token/i.test(String(err.message || ''))) return true;
  return false;
}

/**
 * Does an engine close frame say "auth", as opposed to "gone"? The engine
 * closes with 4401 and an `auth:<code>` reason for a token GoTrue rejected.
 */
export function isEngineAuthClose(code: number | undefined, reason: string | undefined): boolean {
  return code === 4401 || /^auth:/.test(String(reason || ''));
}

interface SupabaseAuthLike {
  getUser: () => Promise<{ data: { user: unknown } | null; error: AuthErrorLike | null }>;
  refreshSession: () => Promise<{
    data: { session: unknown } | null;
    error: AuthErrorLike | null;
  }>;
  signOut: (opts: { scope: 'local' }) => Promise<{ error: AuthErrorLike | null }>;
}

/**
 * Ask GoTrue whether the current session is alive. Exported with the auth
 * client injectable so the unit test can drive every branch without a
 * network.
 */
export async function probeSessionAlive(auth: SupabaseAuthLike): Promise<SessionVerdict> {
  let userRes: Awaited<ReturnType<SupabaseAuthLike['getUser']>>;
  try {
    userRes = await auth.getUser();
  } catch {
    return 'unknown';
  }
  if (!userRes.error && userRes.data?.user) return 'alive';
  if (!isDefinitiveAuthRejection(userRes.error)) return 'unknown';

  // The access token is dead. The refresh token may not be - a rotated
  // signing key, for instance, kills the access token but not the session.
  let refreshRes: Awaited<ReturnType<SupabaseAuthLike['refreshSession']>>;
  try {
    refreshRes = await auth.refreshSession();
  } catch {
    return 'unknown';
  }
  if (!refreshRes.error && refreshRes.data?.session) return 'alive';
  if (isDefinitiveAuthRejection(refreshRes.error)) return 'revoked';
  return 'unknown';
}

let inFlight: Promise<SessionVerdict> | null = null;
let lastProbeAt = 0;
let lastVerdict: SessionVerdict = 'unknown';
let redirecting = false;

/** Test seam. */
export function _resetSessionRevokedStateForTests(): void {
  inFlight = null;
  lastProbeAt = 0;
  lastVerdict = 'unknown';
  redirecting = false;
}

/**
 * Where to send the player back to after they sign in: this table, on the
 * World Hub path the SPA is mounted under.
 */
export function loginRedirectUrl(pathname: string, search: string): string {
  // window.location.pathname already carries the SPA base (/hub/club-arena);
  // a react-router location would not. Accept either and never double it.
  const p = pathname.startsWith('/') ? pathname : '/' + pathname;
  const back = (p.startsWith('/hub/club-arena') ? p : '/hub/club-arena' + p) + (search || '');
  return `${LOGIN_PATH}?authError=no_session&redirect=${encodeURIComponent(back)}`;
}

/**
 * The engine refused a socket for auth (or has refused the handshake several
 * times in a row). Decide whether that is a dead session - and if it is, end
 * the pretence and send the player to sign in.
 *
 * Returns the verdict so the caller can decide whether to keep its reconnect
 * ladder running ('alive' / 'unknown': yes; 'revoked': the page is leaving).
 */
export async function handleEngineAuthRejection(source: string): Promise<SessionVerdict> {
  if (redirecting) return 'revoked';
  if (inFlight) return inFlight;
  const now = Date.now();
  if (now - lastProbeAt < PROBE_THROTTLE_MS) return lastVerdict;
  lastProbeAt = now;

  inFlight = (async () => {
    let verdict: SessionVerdict = 'unknown';
    try {
      const { supabase } = await import('./supabase');
      verdict = await probeSessionAlive(supabase.auth as unknown as SupabaseAuthLike);
      if (verdict === 'revoked') {
        redirecting = true;
        try {
          sessionStorage.setItem(
            SESSION_REVOKED_STORAGE_KEY,
            JSON.stringify({ at: new Date().toISOString(), source })
          );
        } catch {
          /* private mode: the redirect itself is the message */
        }
        // Local scope only: the server has nothing left to revoke, and a
        // global sign-out from here would be the outage in reverse.
        try {
          await supabase.auth.signOut({ scope: 'local' });
        } catch {
          try {
            localStorage.removeItem(AUTH_STORAGE_KEY);
          } catch {
            /* nothing more to clear */
          }
        }
        if (typeof window !== 'undefined') {
          window.location.assign(
            loginRedirectUrl(window.location.pathname, window.location.search)
          );
        }
      }
    } catch {
      verdict = 'unknown';
    } finally {
      lastVerdict = verdict;
      inFlight = null;
    }
    return verdict;
  })();
  return inFlight;
}
