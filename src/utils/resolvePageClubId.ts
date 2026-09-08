/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHICH CLUB IS THIS PAGE ABOUT? — one resolver, one order of preference
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `clubScopedPath.ts` answers the outbound half of Dan's 2026-09-02 rule: every
 * link carries the club you are inside. This is the inbound half — how a page
 * that lives at a GLOBAL path decides which club to render.
 *
 * WHAT WAS THERE INSTEAD. Five pages each hand-rolled the same fallback, and
 * every copy was the same bug — a `club_members` read narrowed to one row:
 *
 *     .from('club_members').select('club_id')
 *       .eq('user_id', user.id)
 *       .limit(1).maybeSingle()
 *
 * whose single row was taken as "the" club.
 *
 * `.limit(1)` with NO `.order()` asks Postgres for "a" membership, not "the"
 * membership. For a player in one club it looks correct forever; for a player
 * in several it returns whichever row the planner reaches first, which can
 * change between two page loads with no user action. That is how the
 * Leaderboards bug felt to Dan — a page confidently showing a club he was not
 * in — and the same shape sat in Marketplace, XMTT, the admin and agent
 * dashboards, and the Flash Pool balance.
 *
 * THE ORDER, and why each step is where it is:
 *
 *   1. THE ROUTE PATH (`/clubs/:clubId/...`). An explicit address. Nothing
 *      outranks it.
 *   2. THE `?club=` PARAM. What the nav stamped, or what the player pasted.
 *      Equally explicit; the path simply cannot disagree with it, because
 *      `withClubContext` refuses to stamp a path that already scopes itself.
 *   3. THE LAST CLUB VISITED. `clubQuickLink.resolveTargetClub` already owns
 *      this rule and `CashierPage`/`LegacyClubToolRedirect` already follow it,
 *      so a shortcut opens where the player last was.
 *   4. THE FIRST ELIGIBLE CLUB, deterministically — `resolveTargetClub` sorts
 *      unions out and takes the head of a stable list, rather than whatever
 *      the database happened to return.
 *
 * It returns the club's UUID, because that is what every downstream query
 * wants, while the URL keeps whatever identifier it was already using. A
 * resolution failure returns null, and null MEANS null — a caller must render
 * "pick a club" rather than silently substituting a different one.
 */

import { resolveClubUUID, isUUID } from './clubIdResolver';
import { readClubContextParam } from './clubScopedPath';
import {
  fetchQuickLinkClubs,
  readCachedQuickLinkClubs,
  readLastClubId,
  resolveTargetClub,
} from './clubQuickLink';

export interface ResolvePageClubOptions {
  /** `useParams().clubId` when the page is also mounted under `/clubs/:clubId`. */
  routeClubId?: string | null;
  /** `location.search` or a URLSearchParams. */
  search?: string | URLSearchParams | null;
  /** The signed-in user id. Without it only steps 1-2 can answer. */
  userId?: string | null;
  /**
   * When false, steps 3-4 are skipped and an absent/unresolvable identifier
   * returns null. Use for pages where showing "some club" is worse than
   * showing nothing — anything that spends, transfers or settles.
   */
  allowFallback?: boolean;
}

/**
 * Resolve the club a global-path page should render, as a UUID.
 *
 * Never throws: a lookup failure is reported by `resolveClubUUID` and degrades
 * to the next step, because a page that cannot name a club should offer a
 * chooser, not an error dialog.
 */
export async function resolvePageClubId({
  routeClubId,
  search,
  userId,
  allowFallback = true,
}: ResolvePageClubOptions): Promise<string | null> {
  // 1 + 2 — an explicit identifier, in either of its two legal homes.
  const explicit = routeClubId || readClubContextParam(search ?? null);
  if (explicit) {
    const resolved = await resolveClubUUID(explicit);
    /* `resolveClubUUID` deliberately fails OPEN, returning the raw input when
       it cannot resolve it (hundreds of legacy call sites depend on that). A
       slug handed to a UUID column is a 22P02 a long way from its cause, so
       an unresolved value is treated as "no such club" here rather than
       passed on. */
    if (isUUID(resolved)) return resolved;
    if (!allowFallback) return null;
  }

  if (!allowFallback || !userId) return null;

  // 3 + 4 — last visited, then the first eligible club, both from the shared
  // rule in clubQuickLink rather than a fresh unordered query.
  // The cache is per account: without the user id it answers [] by design, so
  // an argument-less call here was a network round trip on every resolution.
  const cached = resolveTargetClub(readCachedQuickLinkClubs(userId));
  if (cached?.id) return cached.id;

  const clubs = await fetchQuickLinkClubs(userId);
  return resolveTargetClub(clubs)?.id ?? null;
}

/**
 * Choose one club from a list the CALLER has already filtered.
 *
 * The admin and agent dashboards must not use the general fallback above:
 * their fallback is deliberately role-filtered (staff memberships, agent
 * memberships), and picking a club where the viewer is an ordinary member
 * would hand them a page their own role check then refuses.
 *
 * What they had instead was `mems[0].club_id` on a query with no `ORDER BY`,
 * so an operator working two clubs got whichever row Postgres returned first
 * — stable enough to look correct in testing, and free to change on any plan
 * change. This keeps their filter and fixes only the choice: the club they
 * were last in wins, otherwise the first of a caller-ordered list.
 */
export function pickPreferredClubId(
  candidateIds: readonly (string | null | undefined)[]
): string | null {
  const ids = candidateIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) return null;
  const last = readLastClubId();
  if (last && ids.includes(last)) return last;
  return ids[0];
}

/**
 * Did the URL name a club that could not be resolved?
 *
 * Callers use this to tell "you gave me a bad link" apart from "you gave me no
 * link", which is the distinction the old `|| clubs[0]` fallback destroyed.
 */
export function hasUnresolvableClubParam(
  search: string | URLSearchParams | null | undefined,
  resolvedClubId: string | null
): boolean {
  return Boolean(readClubContextParam(search ?? null)) && !resolvedClubId;
}
