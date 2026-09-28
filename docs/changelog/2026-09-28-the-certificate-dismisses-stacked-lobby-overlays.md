# The certificate dismisses stacked lobby overlays in stacking order

Post-deploy run 36364137556 (engine `41b91390`) never reached a live table. The
"Live-table and engine verification" job died in global setup, before its first
test, with `locator.click: Target page, context or browser has been closed` from
the Diamond Spins invitation handler, while
`club-entry-message__btn--quiet ... from <div class="ca-modal-portal"> subtree
intercepts pointer events` repeated on every retry.

## Cause

- Every certificate run provisions a fresh account, so the fixture club's entry
  message is always shown once (the account has no `club_message_dismissals`
  row) and global setup retires it with "Do Not Show Me This Message Again". It
  was not a new message revision: SHARK CLUB is still on revision 1.
- The same zero-chip account holds welcome diamonds, so `DiamondBustPrompt` also
  opens. Both doors are the shared `Modal`, which portals a `.ca-modal-portal`
  at z-index 1000 onto `document.body`. With equal z-index, DOM order decides
  the top layer, and DOM order is whichever of their two independent reads
  answered last.
- `registerDiamondInvitationDismissal` assumed the invitation was always on top.
  When the greeting answered second it covered the invitation; the handler,
  triggered by the greeting click, clicked a Not Now the pointer could never
  reach, so the greeting click it was blocking timed out.
- Playwright runs locator handlers from an event listener. When setup gave up
  and closed the browser, the handler's still-retrying click rejected with no
  owner, and Node exited with that error instead of the click timeout that
  actually failed setup.

## Fix

- `tests/e2e/support/cashLobbyOverlays.ts`: the invitation's handler reads the
  real stack (hit-testing its Not Now) before acting. When the club entry
  message is above it, the handler yields to the greeting's owner, which is the
  action that triggered it, and runs again at the next action, when the
  invitation is on top. It no longer uses `times: 1` (a yield must not spend it)
  and uses `noWaitAfter` (it proves the invitation hidden itself when it acts).
  Anything else over the invitation is still clicked into and fails with
  Playwright's own "intercepts pointer events" error.
- `tests/e2e/global-setup.ts`: `dismissClubEntryMessage` collects a failed
  decline through `onFailure` and throws it from its own flow, with the greeting
  click's error as `cause`, so it can never become an unhandled rejection. After
  the dismissal persists, it retires the handler and declines an invitation that
  was underneath the greeting.

Nothing is skipped, retried or loosened. Each door closes through its real
player control, the greeting's dismissal still has to persist through
`fn_dismiss_club_message`, and an invitation that stays open after Not Now
still fails setup with its own error.

## Tests

- `tests/e2e/mobile-lobby-chrome.spec.ts` (CSS Beat E2E, chromium and WebKit):
  both doors on the real shared `Modal` in both opening orders, through global
  setup's dismissal and through `prepareCashLobbyActions`; an invitation that
  never closes fails setup loudly; an unowned layer over the invitation is
  reported, never clicked through. Fixture:
  `tests/e2e/helpers/stacked-lobby-doors-fixture.mjs`.
- `tests/unit/productionClubMessagePreflight.test.ts`: a failed decline is
  delivered as setup's rejection with the click error as cause, and a greeting
  above the invitation is yielded to without spending the handler.

Against the previous `cashLobbyOverlays.ts` and `global-setup.ts`, the two
"invitation opened first" cases fail with the production signature
(`<div class="ca-modal-content"> from <div class="ca-modal-portal"> subtree
intercepts pointer events` on the invitation's Not Now); with this change all
21 cases in the spec pass in Chromium and WebKit.
