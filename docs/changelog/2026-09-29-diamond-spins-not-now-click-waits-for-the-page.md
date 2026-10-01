# The Diamond Spins Not Now click waits for the page, and reports what the page did

Date: 2026-09-29. Owner: Horse Brain Phase 6A certificate lane.

## What failed

Production live-table certificate run 36533736673 (WebKit). MTT, Spin and Sit
& Go passed. The cash case failed inside the Diamond Spins invitation handler:
`locator.click` on the `Not Now` plate reported `element is not stable` and hit
its 10 second budget. Nothing in the cash logic under test had run yet.

## What the trace says

- The Modal was mounted before the click started (frame snapshot at 656.26s;
  click at 656.44s). The entrance is one 350ms keyframe run.
- The click's first stability check took 5.0s to answer (656.70s to 661.51s)
  and the retry used the remaining 5s without answering. Two checks used the
  whole old budget.
- `fn_diamond_games_entry` ran once, so the modal did not remount or flicker.
- Screencast frames were identical across the stall, so nothing visible moved.

## What the card does in isolation

Real `Modal` plus real `SpadeConsole` (crest diamond, art inlined), 390x664,
Chromium: the `Not Now` plate reaches its final rectangle 409ms after mount
(375ms with the main thread held 180ms of every 200ms) and the click lands in
33ms (399ms while held). Nothing else moves a plate. So the 5s per check was
the page's frame clock while the offer opened over a freshly loaded 466-game
lobby on a shared runner, whose chunks were still arriving in 2-5s responses.
Playwright WebKit could not be run locally at the pinned revision, so this is
Chromium evidence plus the WebKit trace, not a WebKit reproduction.

## The change

`tests/e2e/support/cashLobbyOverlays.ts`

- Two stages, because a covered plate must still be reported fast. Stage one is
  the unchanged 10s real click. A layer that intercepts the pointer is named by
  Playwright's own call log inside it and is reported exactly as before, with
  no second wait and no extra question to the page. The first version of this
  change simply raised the click to 30s; CSS Beat E2E on PR 5597 caught that
  it made the "unowned layer over the invitation" case (a 12s tab click that
  must see the handler's report) report nothing in time, on Chromium and WebKit.
- Only a click that ended without an interception, meaning the control was
  never given a settled frame to be judged on, gets stage two: a second real
  click with `DIAMOND_DECLINE_STALL_EXTENSION_MS` = 20s (30s in all). It keeps
  every actionability check (visible, enabled, stable, receives pointer
  events) and is never forced or skipped.
- When it still fails, the error carries Playwright's full message and reports
  the page's frame clock (animation frames in one second, and the plate
  rectangle before and after) or that the page gave no answer within 3s. The
  next failure separates a card that keeps moving from a page that stopped
  giving out frames.
- The invitation must still be hidden 8s after the click, and a greeting stacked
  above it is still yielded to, unchanged.

`tests/unit/diamondDeclineClickBudget.test.ts` pins the 10s covered-plate
budget, the 20s extension (past two measured 5s stalls), the exact click
arguments in order, the frame clock report, the covered path taking one click
with no frame-clock question, and the no-answer report. A single 10s click (the
old behaviour) fails the stall case.

## Not changed, and why

The lobby's main-thread cost while it hydrates is a product performance
question, not certified here. If the frame-clock report shows a card that keeps
moving instead of a stalled page, that is a product defect and is fixed in the
client with its own test.
