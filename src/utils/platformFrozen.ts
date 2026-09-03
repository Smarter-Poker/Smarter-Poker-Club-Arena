/**
 * Recognise the freeze guard's refusal wherever a money RPC is called.
 *
 * During the :55 maintenance break, every chip- or seat-moving write is
 * refused in Postgres (zz_freeze_guard, errcode 55006, message prefixed
 * PLATFORM_FROZEN). That refusal is CORRECT behaviour, and it must never be
 * shown to a player as a raw database error: the honest message is that the
 * platform is on its announced break and their action will succeed in a few
 * minutes.
 *
 * Copy rules (CLAUDE.md 5.7 / 10.7): Title Case, no em dashes - this string
 * goes through the Toast layer verbatim.
 */

export const PLATFORM_FROZEN_MESSAGE =
  'The Platform Is On Its Scheduled Maintenance Break. Nothing Is Lost. Please Try Again When Play Resumes At The Top Of The Hour.';

export function isPlatformFrozenError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; message?: string; details?: string; hint?: string };
  if (e.code === '55006') return true;
  const text = `${e.message ?? ''} ${e.details ?? ''} ${e.hint ?? ''}`;
  return text.includes('PLATFORM_FROZEN');
}

/** The message a player should see for `err`, or null when it is not the freeze. */
export function platformFrozenMessage(err: unknown): string | null {
  return isPlatformFrozenError(err) ? PLATFORM_FROZEN_MESSAGE : null;
}
