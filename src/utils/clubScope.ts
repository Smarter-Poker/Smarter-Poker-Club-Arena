/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT A CLUB CAN SEE — WRITTEN ONCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23: "THIS CAN NEVER BREAK. ANY TIME THE UNION CREATES NEW
 * TABLES, THEY MUST BE DISPLAYED INSIDE THEIR ATTACHED CLUBS RIGHT AWAY."
 *
 * THE RULE
 *   A club inside a union sees every game the UNION owns, plus its OWN private
 *   games. Another club's private game is never visible.
 *   A standalone club sees what it owns.
 *
 * WHY THIS FILE EXISTS. That one sentence was, until today, written SIX times
 * in three different languages:
 *
 *   1. get_club_home's tables clause          (SQL)
 *   2. get_club_home's tournaments clause     (SQL)
 *   3. the cash-table fetch                   (PostgREST .or string)
 *   4. the tournament fetch                   (two separate queries)
 *   5. belongsInTableList                     (JS predicate, realtime)
 *   6. belongsInTournamentList                (JS predicate, realtime)
 *
 * On 2026-08-23 copy 2 was found still missing its union branch. A union club
 * therefore listed every union CASH TABLE and only its own private
 * tournaments — Shark Club and Club JAQK both showed 43 tables and ZERO Spins,
 * MTTs or heads-up games while the union ran 90 joinable ones. Somebody had
 * fixed the tables clause and not noticed the tournaments clause fifteen lines
 * below it.
 *
 * The realtime rules carried a comment saying they "MUST mirror the fetch
 * queries". That is the entire problem: a rule maintained by everybody
 * remembering to update six places is a rule that will diverge, and this one
 * has now diverged at least twice.
 *
 * So the rule lives here, once, in two shapes that are derived from the same
 * statement of it — one the database can filter on, one the client can test a
 * live row against. A test pins them to each other over a full matrix, so they
 * cannot answer differently.
 */

/** Who is looking, and whether they are inside a union. */
export interface ClubScope {
  /** The club whose lobby is open. */
  clubId: string;
  /** Its union, or null for a standalone club. */
  unionId: string | null;
  /**
   * Sibling club ids, used only in the standalone shape. Defaults to the club
   * itself, which is the correct answer for a club with no union.
   */
  siblingClubIds?: string[];
}

/** A row from `tables` or `tournaments`, as either the fetch or realtime sees it. */
export interface ScopableRow {
  club_id?: string | null;
  union_id?: string | null;
  is_private?: boolean | null;
}

/**
 * THE RULE, as a predicate. Used by the realtime admission checks so a row
 * arriving live is judged by exactly the same standard as one that was
 * fetched.
 */
export function inClubScope(row: ScopableRow | null | undefined, scope: ClubScope): boolean {
  if (!row) return false;

  if (scope.unionId) {
    // Every union-owned game...
    if (row.union_id === scope.unionId) return true;
    // ...plus this club's own private ones. Another club's private game is
    // deliberately invisible.
    return row.club_id === scope.clubId && row.is_private === true;
  }

  const siblings = scope.siblingClubIds?.length ? scope.siblingClubIds : [scope.clubId];
  return Boolean(row.club_id && siblings.includes(row.club_id));
}

/**
 * THE RULE, as a PostgREST `or` expression, for the union case.
 *
 * Kept beside the predicate on purpose: the two are checked against each other
 * by clubScope.test.ts across a matrix of rows, which is what makes "the live
 * list and the fetched list agree" a fact rather than a comment.
 */
export function clubScopeOrExpression(scope: ClubScope): string {
  if (!scope.unionId) {
    throw new Error(
      'clubScopeOrExpression is for union clubs; a standalone club filters by club_id'
    );
  }
  return `union_id.eq.${scope.unionId},and(club_id.eq.${scope.clubId},is_private.eq.true)`;
}

/**
 * The minimum surface of a PostgREST query builder this needs. Typed
 * structurally so it works for `tables` and `tournaments` alike without
 * importing Supabase's generics into a rule module.
 */
export interface ScopableQuery {
  or(filter: string): unknown;
  in(column: string, values: readonly string[]): unknown;
}

/**
 * Apply the rule to a query. THE ONLY WAY the lobby should scope a fetch.
 *
 * Tournaments used to be fetched as TWO queries — one for the club's private
 * games, a second for the union's — while tables used a single `or`. That
 * asymmetry is how both bugs hid: the tournament path simply looked different
 * enough that a fix to the table path did not obviously apply to it. One
 * shape now, for both.
 */
export function applyClubScope<Q extends ScopableQuery>(query: Q, scope: ClubScope): Q {
  if (scope.unionId) {
    query.or(clubScopeOrExpression(scope));
  } else {
    const siblings = scope.siblingClubIds?.length ? scope.siblingClubIds : [scope.clubId];
    query.in('club_id', siblings);
  }
  return query;
}
