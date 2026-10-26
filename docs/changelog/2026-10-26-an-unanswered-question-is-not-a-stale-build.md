# An Unanswered Question Is Not A Stale Build

Production post-deploy run 40260290873 (03:45 UTC, live build 798c8e5)
failed `Create, Find and Join lead the arena with no Play Poker plate` with
"Navigation to /hub/club-arena/ is interrupted by another navigation to
/clubs/kings-club?\_cb=..." for the third time, after #8100 and #8101.

The trace shows the lobby document requested at 03:45:40.942 and still
outstanding when the cache-busted reload of the club page started at
03:45:51.039, about ten seconds later. No `build-info.json` request appears
anywhere in the trace. The page being left could not start a new load, so the
build read that #8100 added failed at once ("Load failed"), and an unreadable
answer recovered exactly like a newer build. The reload then cancelled the
slow navigation that had made the read impossible.

#8140 made the build read three-valued (`this` / `other` / `unknown`) and
fixed the stylesheet path. The departure grace still reloaded on anything but
`this`. It now recovers early only when production positively names a
different build; the live build and "could not tell" both keep waiting,
still bounded by `CURRENT_BUILD_PATIENCE_MS` (60 s), so a navigation that
really was cancelled still gets its suspended route back. Nothing changes
when no navigation is under way.

Regression: `tests/chunk-load-recovery.test.ts`. The unreadable-departure,
never-completed and deferred-hard-reload cases fail on the previous code
(3 failed) and pass now (35 passed).
