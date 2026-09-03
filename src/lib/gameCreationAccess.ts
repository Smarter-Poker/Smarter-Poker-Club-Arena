/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHO IS ALLOWED TO BUILD A GAME FOR THIS CLUB
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The rule:
 *   • Standalone club (no union) — the club owner and club admins build its own
 *     cash games and tournaments.
 *   • Club inside a union      — only the union owner and union admins build.
 *     The club itself does not.
 *
 * That rule is enforced in the database (the `tables` INSERT policy and
 * `fn_create_tournament` both go through `fn_can_create_games`). This module is
 * the UI's way of asking the SAME question before it shows a form, so the page
 * can explain the answer instead of failing at submit.
 *
 * 2026-08-19. Before this, the create-table page asked a DIFFERENT question —
 * "is this club in a union?" — and if so it bounced EVERY visitor. That locked
 * out the union owner, who is precisely the person the rule says must be able to
 * build games for a union's clubs. There was no path at all: the 815 union
 * tables in production were all written server-side.
 *
 * Fails CLOSED. A network error, an unreadable answer, or a signed-out user all
 * come back as "not allowed" — the database would refuse the insert anyway, and
 * a wrong "yes" here means the owner fills in a long form for nothing.
 *
 * Pure on purpose: no Supabase import, so the fail-closed behaviour can be
 * tested without booting a client. The call itself lives in
 * services/GameAccessService.
 */
export type GameCreationReason =
  | 'ok'
  /** The club belongs to a union; the union builds its games. */
  | 'union_only'
  /** Signed in, but not an owner or admin of this club (or its union). */
  | 'not_owner_or_admin'
  | 'unknown_club'
  | 'not_signed_in'
  /** The check itself failed — treated as a refusal. */
  | 'check_failed';

export interface GameCreationAccess {
  allowed: boolean;
  /**
   * The union these games belong to, or null for a standalone club. Stamped
   * onto the created row so the union's own views (UnionDetailPage →
   * getUnionTables) find a game built through a member club.
   */
  unionId: string | null;
  reason: GameCreationReason;
}

export const GAME_CREATION_DENIED_MESSAGES: Record<Exclude<GameCreationReason, 'ok'>, string> = {
  union_only:
    'This club is part of a union. Cash games and tournaments here are built by the union.',
  not_owner_or_admin: 'Only the club owner or an admin can create games for this club.',
  unknown_club: 'That club could not be found.',
  not_signed_in: 'Please sign in to create a game.',
  check_failed: 'Could not confirm your permission to create games here. Please try again.',
};

const VALID_REASONS: GameCreationReason[] = [
  'ok',
  'union_only',
  'not_owner_or_admin',
  'unknown_club',
  'not_signed_in',
  'check_failed',
];

export const GAME_CREATION_DENIED: GameCreationAccess = {
  allowed: false,
  unionId: null,
  reason: 'check_failed',
};

/**
 * Turn whatever `fn_game_creation_access` returned into a value the UI can
 * trust. Pure, so the fail-closed behaviour is testable without a database.
 */
export function parseGameCreationAccess(raw: unknown): GameCreationAccess {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return GAME_CREATION_DENIED;
  const r = raw as Record<string, unknown>;

  // Only a literal `true` opens the gate. A missing field, a string 'true', or
  // anything else is a refusal.
  const allowed = r.allowed === true;

  const reason = VALID_REASONS.includes(r.reason as GameCreationReason)
    ? (r.reason as GameCreationReason)
    : allowed
      ? 'ok'
      : 'check_failed';

  // An "allowed" answer paired with a denial reason is self-contradictory —
  // refuse it rather than guess which half is right.
  if (allowed && reason !== 'ok') return GAME_CREATION_DENIED;
  if (!allowed && reason === 'ok') return GAME_CREATION_DENIED;

  const unionId = typeof r.union_id === 'string' && r.union_id.length > 0 ? r.union_id : null;

  return { allowed, unionId, reason };
}

/** The sentence to show someone who is not allowed. */
export function gameCreationDeniedMessage(access: GameCreationAccess): string {
  if (access.allowed) return '';
  const reason = access.reason === 'ok' ? 'check_failed' : access.reason;
  return GAME_CREATION_DENIED_MESSAGES[reason];
}
