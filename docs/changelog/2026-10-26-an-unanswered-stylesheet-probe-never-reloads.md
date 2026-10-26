# An unanswered stylesheet probe never reloads

2026-10-26. Client only; no engine, migration or financial change. Follows
`2026-10-25-a-cancelled-stylesheet-is-not-a-stale-build.md`.

## What still happened

Production post-deploy run 40260290873 (client job 121372059495, build
2d8564c1d, which already carried the stylesheet probe) failed the same case
again: `production-mobile-lobby-chrome.spec.ts` "Create, Find and Join...",
"Navigation to /hub/club-arena/ is interrupted by another navigation to
/clubs/kings-club?\_cb=...".

The run's trace:

- -10.64 s: leaving the Kings Club lobby aborts its CashierPage,
  CashoutRequestModal and NotificationsPage stylesheets (and their scripts).
- No probe request reaches the network. A document that is being left gets
  no answer, so every verdict was `unknown`.
- -10.10 s: the player's navigation to `/hub/club-arena/` is still pending.
- 0.00 s, exactly `NAVIGATION_GRACE_MS` later: the old `unknown` branch reloads
  `/clubs/kings-club?_cb=...` over that navigation.

So the previous fix moved the reload ten seconds later but did not remove it.
A navigation pending for more than ten seconds is ordinary on a slow phone
connection.

## The fix

`recoverFailedStylesheet` never reloads on `unknown`. A reload needs the same
server the probe could not reach, so it cannot help. It asks again after
10 s, 20 s and 40 s (`UNANSWERED_STYLESHEET_REPROBE_MS`):

- `present`: the stylesheet is put back, with no reload.
- `gone` (404/410 or HTML): guarded recovery, as before.
- Still no answer after the last re-probe: the stylesheet is put back, so the
  browser loads it itself. Only a failure of that load, more than a minute
  after any navigation, reaches document recovery.

A document that really is leaving is gone before its next question.

## Tests

`tests/chunk-load-recovery.test.ts`: the old "waits out the navigation
grace" case (which pinned the reload) is replaced by three cases. One proves
no reload at any point while the server cannot be asked, with exactly four
probes and then the stylesheet put back. The other two act on a later 200
(put back) and a later 404 (recovers). Two of them fail on the previous code;
all 33 pass with the fix, along with the boundary, retry and boot tests (50).
