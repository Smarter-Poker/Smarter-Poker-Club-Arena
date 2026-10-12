/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A DEAD SESSION IS A SIGN-IN, NOT A RETRY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Diamond Phase 11, line 7 (2026-09-30). A session revoked elsewhere - signed
 * out on another device, a global sign-out, a session past its window - keeps
 * an access token that verifies until it expires, so reads keep working and
 * only the doors that ask fn_caller_session_is_live() can tell. They say so by
 * name, read from production that day:
 *
 *   atomic_table_buyin            28000  SESSION_REVOKED: this session is signed out - sign in again
 *   fn_ca_cash_buyin_receipt      28000  SESSION_REVOKED: sign in again to check your buy-in
 *   send_wallet_diamond_transfer  42501  authentication_required
 *   the Diamond staff doors       28000  diamond_staff_session_required
 *
 * The buy-in sheet and the Send Diamonds form answered all of them with their
 * "not confirmed yet, retry" copy. That kept the saved request - rightly: a
 * retry reuses its key, so it can never become a second buy-in or a second
 * transfer - and then asked for the one thing that cannot work, because the
 * retry fails the same way until the player signs in again. Now a dead session
 * says so, the saved request stays exactly as it was (neither journal is
 * purged by a sign-out), and the page is handed to lib/sessionRevoked, which
 * asks GoTrue first and only on a definite answer prompts and sends the player
 * to sign in and back to this page.
 *
 * SQLSTATE 28000 is the estate's "sign in again" code at every door. 42501 is
 * also "not allowed" for many other reasons, so it counts only with the
 * transfer door's exact name.
 */
export function isDeadSessionRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === '28000') return true;
  return code === '42501' && message === 'authentication_required';
}

/**
 * Hand a dead session to the one place that decides whether to sign out.
 * Lazy: the module is only needed after a door has already refused.
 */
export function askToSignInAgain(source: string): void {
  void import('./sessionRevoked')
    .then((m) => m.handleEngineAuthRejection(source))
    .catch(() => {
      /* a chunk that will not load must never sign anyone out */
    });
}
