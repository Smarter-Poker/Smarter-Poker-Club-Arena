# A cancelled stylesheet is not a stale build

2026-10-25. Client only; no engine, migration or financial change.

## What failed

Production post-deploy run 40242809027 (client job 121318525896, build
`96818b8b0`) failed one sweep case, `production-mobile-lobby-chrome.spec.ts`
"Create, Find and Join lead the arena with no Play Poker plate":

> page.goto: Navigation to "https://smarter.poker/hub/club-arena/" is
> interrupted by another navigation to
> "https://smarter.poker/hub/club-arena/clubs/kings-club?_cb=1792972655062"

The two client failures repaired earlier the same day (#8079/#8082 slug
lookups, #8080 Game Lobby Close beneath the ticker) both passed in that run.

## The cause, read from the run's trace

The Kings Club lobby warms other routes in the background. When the test
navigated away, the browser aborted every in-flight warm load at the same
instant (ProfilePage, PlayerAvatar, StandardContentLayout, StreakFire,
ClubDashboard, RoleBadge - JavaScript and CSS). An aborted CSS preload reaches
`installVitePreloadErrorRecovery` as "Unable to preload CSS", and that branch
called `recoverFromStaleChunk` immediately: a cache-busted reload of the page
being left, which replaced the navigation the player had started.

The 2026-10-23 navigation guard (`documentIsNavigatingAway`) did not see the
departure because it is armed by `beforeunload`/`pagehide`, and a
browser-initiated navigation does not reliably dispatch `beforeunload` before
it aborts the old document's loads.

## The fix

`src/utils/lazyWithRetry.ts`: a failed stylesheet is checked with the server
before the document is replaced. The origin answers a retired hashed asset
with 404 and a current one with 200 `text/css` (measured on both
`smarter.poker/hub/club-arena/assets/*` and `ca-static.smarter.poker/assets/*`).

- Present: the stylesheet is put back as Vite would have inserted it, so the
  route never renders unstyled (2026-10-14 iPad rule preserved) and no reload
  or reload budget is spent. If the restored link itself fails, guarded
  recovery runs.
- Gone (404/410, or an HTML answer): guarded recovery runs as before.
- Unknown (probe could not answer): recovery waits `NAVIGATION_GRACE_MS`, so a
  page that is really leaving is gone before it fires.

JavaScript import recovery is unchanged.

## Tests

`tests/chunk-load-recovery.test.ts`: six new cases (still served, exact
address probed, restored link failing, retired, HTML answer, unanswerable
probe) and the existing CSS recovery case now stubs the server's 404. Five of
the new cases fail on the previous code; all 27 pass with the fix.
