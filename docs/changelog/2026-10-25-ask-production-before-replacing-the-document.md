# Ask Production Before Replacing The Document

Production post-deploy run 40260290873 (WebKit, 03:45 UTC) failed
`Create, Find and Join lead the arena with no Play Poker plate` with the same
"Navigation to /hub/club-arena/ is interrupted by another navigation to
/clubs/kings-club?\_cb=..." after both #8100 and #8101 were live.

The trace: the departure aborted the club page's background CSS preloads at
03:45:40.4, the stylesheet probe from #8101 could not answer (WebKit refuses
every new fetch from a document whose navigation is pending - the trace
records no request at all for the next ten seconds), and its 'unknown' branch
scheduled recovery `NAVIGATION_GRACE_MS` later. That navigation fired no
beforeunload, so nothing marked the page as leaving, and at 03:45:51.0 the
cache-busted reload cancelled the lobby navigation.

A clock cannot tell a slow navigation from a stale page; production can.
Recovery that is uncertain now reads `build-info.json` before it replaces the
document:

- a newer live build: recover now;
- no answer (what a pending navigation looks like in WebKit): ask again each
  grace period, up to `CURRENT_BUILD_PATIENCE_MS` (60 s);
- the current build while the page is leaving: keep waiting, same bound;
- the current build with no departure: recover now, as before.

This applies to the stylesheet probe's 'unknown', to the deferred departure
recovery, and to any failure that arrives during or after a departure (not
only inside the first ten seconds). A failure with no departure and no
uncertainty still recovers at once, and no waiting spends reload budget.

Tests: `tests/chunk-load-recovery.test.ts`. Four existing cases pinned
"recover at the grace when the live build is unreadable"; that behaviour is
the defect, so they now assert waiting until the patience ends, and two new
cases cover a late failure after the grace and an unanswered stylesheet meeting
a newer live build. All six fail on the previous code.
