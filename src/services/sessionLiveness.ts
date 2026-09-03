/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DEAD SESSION IS NOT A SIGNED-IN ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Measured on production 2026-09-03, on Dan's own live tab:
 *
 *   access token   valid signature, ES256, exp in 6.9 DAYS
 *   session_id     64cba0cf-…  -> NOT PRESENT in auth.sessions
 *   refresh token  "Invalid Refresh Token: Refresh Token Not Found"
 *   REST /clubs    200, real rows
 *   engine socket  wss://engine.smarter.poker/ws/multi -> 1006, every retry
 *
 * That combination is the whole bug, and it is silent by construction:
 *
 *   - PostgREST validates a JWT by SIGNATURE AND EXPIRY. It never asks whether
 *     the session behind it still exists, so every read keeps working and the
 *     app looks signed in.
 *   - The engine validates by asking GoTrue (`supabase.auth.getUser(token)`),
 *     which DOES check auth.sessions and answers
 *     403 session_not_found -> the upgrade is refused 401 -> close 1006.
 *
 * So the moment a session dies underneath a live tab, the player keeps their
 * data and loses every live update - tables, lobby, everything - with no error
 * they can act on and no prompt to sign in again. The access token's lifetime
 * is the blast radius: this project issues SEVEN-DAY tokens, so a corpse can
 * masquerade for a week.
 *
 * Sessions die for ordinary reasons - a sign-out in another tab, a revocation,
 * and above all refresh-token rotation: this origin serves BOTH the Hub and
 * Club Arena from one `smarter-poker-auth` key, and presenting an
 * already-rotated refresh token makes GoTrue revoke the whole family. See the
 * lock comment in src/lib/supabase.ts for the history.
 *
 * The engine is right to refuse. The client was wrong to keep asking with a
 * token it could have checked. This module is that check.
 *
 * WHAT IT WILL NOT DO. It signs out only when GoTrue says, in as many words,
 * that the session or its refresh token is GONE. A network failure, a 5xx, a
 * timeout, an offline browser - all leave the session alone, because "I could
 * not ask" is not "you are logged out", and the opposite mistake (signing a
 * player out mid-hand because a probe timed out) is far worse than the one
 * this fixes.
 */
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

/** Don't ask GoTrue more than this often, however many sockets are flapping. */
export const LIVENESS_PROBE_MIN_INTERVAL_MS = 30_000;

/** Broadcast so any surface can react (a banner, a redirect) rather than only this one. */
export const SESSION_DEAD_EVENT = 'smarter-poker:session-dead';

/**
 * The messages GoTrue uses when the session, or its refresh token, no longer
 * exists. Matching on meaning, not on one string: the wording has changed
 * twice and the status code alone is ambiguous (403 is also "banned").
 */
export function isSessionGoneMessage(message: string | null | undefined): boolean {
  const m = String(message ?? '').toLowerCase();
  if (!m) return false;
  return (
    m.includes('session_not_found') ||
    m.includes('session from session_id claim in jwt does not exist') ||
    m.includes('refresh token not found') ||
    m.includes('invalid refresh token') ||
    m.includes('auth session missing') ||
    m.includes('session expired') ||
    m.includes('user from sub claim in jwt does not exist')
  );
}

let lastProbeAt = 0;
let inFlight: Promise<boolean> | null = null;
let announced = false;

/** Test seam — the pins reset module state between cases. */
export function _resetSessionLivenessForTests(): void {
  lastProbeAt = 0;
  inFlight = null;
  announced = false;
}

function announceDead(reason: string): void {
  if (announced) return;
  announced = true;
  try {
    window.dispatchEvent(new CustomEvent(SESSION_DEAD_EVENT, { detail: { reason } }));
  } catch {
    /* a browser that refuses a CustomEvent still gets the signOut below */
  }
}

/**
 * Ask the SAME question the engine asks. Returns true when the session is live
 * or could not be checked, false only when GoTrue said it is gone.
 *
 * `getUser()` is deliberate: it is a network call that validates against
 * auth.sessions. `getSession()` reads localStorage and would cheerfully return
 * the corpse this function exists to find.
 */
export async function confirmSessionIsLive(reason: string): Promise<boolean> {
  if (inFlight) return inFlight;
  const now = Date.now();
  if (now - lastProbeAt < LIVENESS_PROBE_MIN_INTERVAL_MS) return true;
  lastProbeAt = now;

  inFlight = (async () => {
    try {
      const { data, error } = await supabase.auth.getUser();
      if (!error && data?.user) return true;
      if (!error) return true; // no user AND no error: not an answer, leave it alone
      if (!isSessionGoneMessage(error.message)) return true; // network / 5xx / unknown
      reportError(
        new Error(`[sessionLiveness] session is gone (${reason}): ${error.message}`),
        'SessionLiveness.session_gone'
      );
      announceDead(reason);
      try {
        // LOCAL only. A global sign-out would revoke sessions this tab does
        // not own, and the session it would revoke is already gone anyway.
        await supabase.auth.signOut({ scope: 'local' });
      } catch {
        /* the event above is what the app reacts to */
      }
      return false;
    } catch {
      return true; // threw = could not ask
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
