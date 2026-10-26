# A Slow Navigation Is Not A Cancelled One

Production post-deploy run 40242809027 (WebKit, 23:57 UTC) failed
`Create, Find and Join lead the arena with no Play Poker plate` with
"Navigation to /hub/club-arena/ is interrupted by another navigation to
/clubs/kings-club?\_cb=...". The trace shows the departure cancelling the club
page's chunk and data loads at 23:57:24.8, the lobby document still
outstanding, and the cache-busted reload of the club page at 23:57:35.4: the
navigation grace (10 s) had run out while the lobby was still loading right
after the 23:54 publish.

That reload could not fetch newer bytes. The page was already on the build
production served, and the origin's asset pool is append-only, so every
chunk it had asked for still existed. Recovery read the departure's
cancellations as staleness without checking.

When the grace ends and the page is still here, recovery now asks
`build-info.json` which build production serves. A document on that build
keeps waiting for its navigation, bounded by `CURRENT_BUILD_PATIENCE_MS`
(60 s) so a navigation that really was cancelled still gets its suspended
route back. A different build, an unreadable or slow answer (3 s bound), or a
local build recovers exactly as before. No reload budget is spent while
waiting.

Regression: `tests/chunk-load-recovery.test.ts`, "when the grace ends with the
page still here" - the slow-navigation and bounded-patience cases fail on the
previous code and pass now; newer-build and unreadable-build cases keep the
original recovery.

The same run's notification failure was a release change during the test
(09ea5c4 at start, 96818b8b at the closing check) and is not changed here.
