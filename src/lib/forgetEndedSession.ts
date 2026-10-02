/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SESSION THE SERVER HAS ENDED IS ENDED HERE TOO (2026-09-29)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * @supabase/auth-js 2.90 (this app's version) signs out by asking the server
 * first. When the server has already ended the session it answers 403
 * session_not_found, the library turns that into AuthSessionMissingError, and
 * `signOut()` returns it WITHOUT removing the local copy. Later versions ignore
 * that error and finish the sign-out; this one leaves the player signed in on a
 * session the server no longer has, holding an access token that stays valid
 * until it expires - days, on this project.
 *
 * Found on the Android emulator after Close My Account: the account was closed
 * and its sessions removed, the app said "Your Session Expired", kept the closed
 * account's session, and put the scrubbed profile's Complete Your Profile card
 * on screen. The same happens after any sign-out elsewhere that ended this
 * session: sign out everywhere, a password change, a revoked login.
 *
 * This finishes the sign-out the way the library does once the server agrees:
 * the stored session, its code verifier and the cached user are removed, and
 * SIGNED_OUT reaches every listener - IdentityDNA's cleanup, the native session
 * mirror, AuthGuard's redirect.
 *
 * When an upgrade makes signOut() finish on its own, the first case in
 * tests/unit/aSessionTheServerEndedIsSignedOut.test.ts fails on purpose: delete
 * this file and its call in IdentityDNA.logout().
 */
import type { SupabaseClient } from '@supabase/supabase-js';

type Auth = SupabaseClient['auth'];
/** The library's own post-sign-out step; private in its types, so reached structurally. */
type RemovesSession = { _removeSession?: () => Promise<void> };

export async function forgetEndedSession(auth: Auth): Promise<void> {
  const remove = (auth as unknown as RemovesSession)._removeSession;
  if (typeof remove !== 'function') {
    throw new Error('supabase-js no longer has _removeSession: see src/lib/forgetEndedSession.ts');
  }
  await remove.call(auth);
}
