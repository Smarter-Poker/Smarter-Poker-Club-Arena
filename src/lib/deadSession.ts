/**
 * A SIGNED-OUT SESSION MUST NOT KEEP PLAYING.
 *
 * Dan, 2026-09-03: "I WAS LOGGED OUT, BUT SOMEHOW ABLE TO, SIT DOWN AND BUY
 * CHIPS AND GET DEALT A HAND. THAT CAN NEVER HAPPEN... EVER."
 *
 * The database half of that is closed in migration
 * 20260903213000_a_dead_session_moves_no_money: this project issues SEVEN-DAY
 * access tokens and PostgREST only checks a JWT's signature and expiry, so a
 * signed-out tab kept a working credential for the rest of the week. The money
 * doors now ask whether the session behind the token still exists and raise
 * SESSION_REVOKED when it does not.
 *
 * This is the other half. A refusal the player cannot act on is not enough:
 * the felt is still on screen, the seat is still drawn, and the next tap tries
 * again. When the server says the session is gone, the client has to STOP
 * BEING AT A TABLE. Signing out locally does exactly that and nothing more:
 * `IdentityDNA` clears the user store on SIGNED_OUT, `PersistentTableLayer`
 * renders nothing without a user, so every TablePage unmounts and every engine
 * socket closes on the same tick.
 *
 * WHY LOCAL SCOPE. `signOut({ scope: 'local' })` clears this device. A global
 * sign-out would also revoke the player's OTHER devices, and a session that
 * has already been revoked server-side needs no revoking - the goal here is
 * only to stop this tab from acting as somebody who is no longer signed in.
 *
 * Idempotent: several doors can fail at once (buy-in, rebuy, a seat read) and
 * they must produce ONE sign-out and one redirect, not a storm.
 */
import { reportError } from '../utils/errorReporter';

let standingDown = false;

/** Does this error mean the caller's session no longer exists? */
export function isDeadSessionError(raw: unknown): boolean {
  const err = raw as { message?: string; code?: string; status?: number } | null;
  const msg = String(err?.message ?? raw ?? '');
  if (/SESSION_REVOKED/i.test(msg)) return true;
  // PostgREST/GoTrue's own vocabulary for a token it will not accept.
  if (/JWT expired|invalid claim|bad_jwt|session[_ ]not[_ ]found/i.test(msg)) return true;
  if (err?.code === 'PGRST301') return true; // JWT invalid / expired
  if (err?.status === 401) return true;
  return false;
}

/**
 * Stand the player down: sign this device out, which unmounts every live
 * table, then send them to the sign-in screen. Safe to call from anywhere and
 * as often as you like.
 *
 * Returns true when this call is the one that started the stand-down, so a
 * caller can choose to stay quiet rather than also showing its own error.
 */
export function standDownDeadSession(context: string): boolean {
  if (standingDown) return false;
  standingDown = true;

  reportError(new Error(`dead session at ${context}`), 'auth.session_revoked', { context });

  void (async () => {
    try {
      const { supabase } = await import('./supabase');
      await supabase.auth.signOut({ scope: 'local' });
    } catch {
      /* Even if sign-out fails, the redirect below still leaves the table. */
    } finally {
      try {
        // A full document load, not a router navigation: it guarantees no
        // engine socket, timer or cached identity survives into the signed-out
        // state, which is the whole point of standing down.
        window.location.assign('/auth?reason=signed_out');
      } catch {
        /* non-browser (tests) */
      }
    }
  })();

  return true;
}

/** Test hook - the module-level latch must not leak between cases. */
export function __resetStandDownForTests(): void {
  standingDown = false;
}
