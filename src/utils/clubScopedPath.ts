/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB-SCOPED PATHS — one vocabulary for "which club is this link about?"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02, binding:
 *
 *   "WHEN YOU GO TO THE HAMBURGER MENU INSIDE ANY CLUB, THAT ENTIRE HAMBURGER
 *    MENU NEEDS TO BE LINKED TO THAT CLUB. IF YOU ARE A PART OF MULTIPLE CLUBS
 *    (OR UNIONS) IT SHOULD ALWAYS BE OPEN TO THAT SPECIFIC CLUB, AND THE SLUGS
 *    MUST MATCH FOR PAGES LIKE THE LEADERBOARDS PAGE."
 *
 * WHAT WAS BROKEN. Club Arena has two kinds of club-scoped page:
 *
 *   1. Path-scoped   — `/clubs/:clubId/cashier`, `/clubs/:clubId/members`
 *   2. Query-scoped  — `/leaderboard?club=…`, `/marketplace?club=…`
 *
 * Every navigation surface knew how to build (1) and none of them built (2).
 * `getClubArenaNavigation` even had a `clubPath()` builder and applied it to
 * exactly one of its sixteen destinations. So a player standing inside Deep
 * Stack Society opened Leaderboards and landed on a page that had thrown the
 * club away, re-guessed one from `clubs[0]`, and rendered Club JAQK — a club
 * they are also in, which is what made it look like a display bug rather than
 * a lost parameter.
 *
 * WHY A SHARED HELPER RATHER THAN SIXTEEN TEMPLATE LITERALS. Before this file
 * there were five hand-written conventions for the same idea, disagreeing on
 * the identifier: `${club.slug || club.id}` (HomePage), `${target.id}`
 * (LegacyClubToolRedirect, ClubBottomNav), `${clubId}` raw (QuickActionsBar),
 * and the local `clubPath()` closure. A convention that lives in sixteen
 * places is not a convention; it is sixteen chances to drop the club. This
 * module is the one place that answers all three questions:
 *
 *   - which global routes are ABOUT a club (CLUB_SCOPED_GLOBAL_ROUTES)
 *   - how a club is stamped onto one (withClubContext)
 *   - how a page reads it back (readClubContextParam / findClubByParam)
 *
 * THE IDENTIFIER IS PASSED THROUGH UNCHANGED. Whatever the route carries —
 * slug, 6-digit club code, or UUID — is what gets stamped, so the address bar
 * keeps saying `deep-stack-society` rather than swapping in a UUID the player
 * has never seen. Dan's "THE SLUGS MUST MATCH" is that requirement exactly.
 * Readers resolve it with `resolveClubUUID`, which already accepts all three
 * (see `clubIdResolver.resolveClubIdFilter`). A reader that compares the raw
 * param against a UUID is the bug this shipped to fix; `matchesClubParam`
 * below exists so nobody writes that comparison by hand again.
 */

/**
 * Global routes that render CLUB-SCOPED data and therefore must carry the
 * club the player is standing in.
 *
 * Membership in this list is a claim about the PAGE, not about the link: a
 * route belongs here when showing it for the wrong club would show the player
 * the wrong numbers. `/settings`, `/profile`, `/legal/*`, `/friends`,
 * `/community`, `/search` and `/notifications` are deliberately absent — they
 * are about the person or the whole arena, not one club, and stamping a club
 * onto them would add a parameter nothing reads to every URL a player shares.
 *
 * Prefix matching is used, so `/tournament-results?filter=mine` and
 * `/leaderboard/history` are both covered by their parent entry.
 */
export const CLUB_SCOPED_GLOBAL_ROUTES: readonly string[] = [
  '/achievements',
  '/agent-dashboard',
  '/bonuses',
  '/cashier',
  '/challenges',
  '/data',
  '/disputes',
  '/hand-history',
  '/leaderboard',
  '/marketplace',
  '/messages',
  '/player-sessions',
  '/players',
  '/promotions',
  '/rakeback',
  '/rewards',
  '/session-history',
  '/stats',
  '/tournament-results',
  '/tournaments',
  '/transactions',
  '/vip',
  '/wallet',
  '/xmtt',
];

/** The query key. One constant so a typo cannot silently split the estate. */
export const CLUB_CONTEXT_PARAM = 'club';

function splitPath(path: string): { base: string; query: string; hash: string } {
  const hashAt = path.indexOf('#');
  const hash = hashAt >= 0 ? path.slice(hashAt) : '';
  const withoutHash = hashAt >= 0 ? path.slice(0, hashAt) : path;
  const queryAt = withoutHash.indexOf('?');
  return {
    base: queryAt >= 0 ? withoutHash.slice(0, queryAt) : withoutHash,
    query: queryAt >= 0 ? withoutHash.slice(queryAt + 1) : '',
    hash,
  };
}

function normalize(base: string): string {
  return base.replace(/\/+$/, '') || '/';
}

/**
 * True when `path` is a global route whose content is about one club.
 *
 * Already-scoped paths (`/clubs/…`) and union paths (`/unions/…`) answer
 * false: they carry their own identity in the path and must never be given a
 * second, possibly contradicting one in the query.
 */
export function isClubScopedGlobalRoute(path: string): boolean {
  if (!path) return false;
  const base = normalize(splitPath(path).base);
  if (base === '/clubs' || base.startsWith('/clubs/')) return false;
  if (base === '/unions' || base.startsWith('/unions/')) return false;
  return CLUB_SCOPED_GLOBAL_ROUTES.some((route) => base === route || base.startsWith(`${route}/`));
}

/**
 * Stamp the current club onto a navigation target.
 *
 * Returns `path` untouched when there is no club to carry, when the path
 * already scopes itself (a `/clubs/…` route, or one that already names a
 * club), or when the destination is not about a club at all. Existing query
 * parameters and fragments are preserved — `/tournament-results?filter=mine`
 * keeps its filter and gains its club.
 */
export function withClubContext(path: string, clubId?: string | null): string {
  if (!clubId || !path) return path;
  if (!isClubScopedGlobalRoute(path)) return path;

  const { base, query, hash } = splitPath(path);
  const params = new URLSearchParams(query);
  // An explicit club already on the link wins. Callers that mean to override
  // it (the Owner Prize Tools picker, for one) say so by building the param
  // themselves, and this must not fight them.
  if (params.get(CLUB_CONTEXT_PARAM)) return path;

  params.set(CLUB_CONTEXT_PARAM, clubId);
  return `${base}?${params.toString()}${hash}`;
}

/**
 * Read the club a page was asked to show.
 *
 * Accepts either a raw search string (`location.search`) or a live
 * `URLSearchParams`. Returns null rather than an empty string so a caller can
 * write `readClubContextParam(search) ?? fallback` without a truthiness trap.
 */
export function readClubContextParam(
  search: string | URLSearchParams | null | undefined
): string | null {
  if (!search) return null;
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const raw = params.get(CLUB_CONTEXT_PARAM);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return raw;
  }
}

/**
 * Does this club record answer to the identifier in the URL?
 *
 * THE POINT OF THIS FUNCTION. `LeaderboardPage` asked
 * `clubs.some((c) => c.id === requestedClubId)`, which is true only when the
 * URL carries a UUID. A slug — the thing `SlugEnforcer` rewrites every club
 * path to, and the thing Dan sees in his address bar — failed that test
 * silently and fell through to `clubs[0]`. That single `===` is the whole
 * reported bug.
 *
 * Comparison is case-insensitive because slugs and UUIDs are both
 * case-insensitive identifiers, and a link that has been title-cased in
 * transit should still open the right club.
 */
export function matchesClubParam(
  club: { id?: string | null; slug?: string | null; club_id?: string | number | null },
  param: string | null | undefined
): boolean {
  if (!param) return false;
  const wanted = param.trim().toLowerCase();
  if (!wanted) return false;
  return [club.id, club.slug, club.club_id]
    .filter(
      (candidate): candidate is string | number => candidate !== null && candidate !== undefined
    )
    .some((candidate) => String(candidate).toLowerCase() === wanted);
}

/**
 * Find the club a URL is asking for, or null when it names one the viewer is
 * not in. NULL IS A MEANINGFUL ANSWER and callers must not paper over it with
 * `|| clubs[0]`: a link to a club you have left should say so, not quietly
 * show you a different club's money.
 */
export function findClubByParam<
  T extends { id?: string | null; slug?: string | null; club_id?: string | number | null },
>(clubs: readonly T[], param: string | null | undefined): T | null {
  if (!param) return null;
  return clubs.find((club) => matchesClubParam(club, param)) ?? null;
}
