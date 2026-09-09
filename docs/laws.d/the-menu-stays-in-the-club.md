# tests/the-menu-stays-in-the-club.law.test.ts

Dan, 2026-09-02: "WHEN YOU GO TO THE HAMBURGER MENU INSIDE ANY CLUB, THAT ENTIRE
HAMBURGER MENU NEEDS TO BE LINKED TO THAT CLUB ... AND THE SLUGS MUST MATCH FOR
PAGES LIKE THE LEADERBOARDS PAGE." Standing inside Deep Stack Society, he
opened Leaderboards and got Club JAQK. Two faults, either sufficient: the nav
config had a `clubPath()` builder and used it on four of sixteen destinations,
so Leaderboards was handed nothing; and the page matched the URL's club with
`club.id === param`, true only for a UUID while SlugEnforcer guarantees a slug,
then fell through to `clubs[0]` so the wrong club arrived with no error. One
helper (`clubScopedPath.ts`) now stamps `?club=<the identifier the route is
already using>` onto exactly the routes that render club-scoped data, at one
point on the way out of the nav config so a destination added later cannot be
added club-blind; the hamburger reads `workspace.routeClubId` so the club
survives past the first hop onto a global route; and the page resolves slug,
6-digit code or UUID and says so when the URL names a club the viewer is not
in. The law pins every stamped destination, that the identifier is passed
through unchanged, that personal routes stay unstamped, that an already-scoped
`/clubs/…` path is never given a second club, and that switching club in the
drawer swaps the club on a club-scoped page rather than throwing the page away.
