# The Find A Player console scrolls with the page on a phone

**Date:** 2026-10-12
**Surface:** `/hub/club-arena/clubs/:club/members` (Player Command roster)

## What broke

`.members-console` has been `position: sticky` at every width since the roster
rebuild (#1902, #1944), pinned at `top: 0` below 720px. On 2026-10-11 #6693
added the Export Scope note and the Metric Definitions disclosure to it. At
375 x 812 the pinned console grew to roughly 570px:

- the roster under it showed about one partial row (the Post-Deploy E2E
  failure screenshot shows "Papa Kacher" half hidden under the console), and
- opening Metric Definitions made the console taller than the screen. A sticky
  box taller than the viewport keeps its overflow below the fold for as long as
  its container scrolls, so the last definitions sat under the bottom
  navigation where no scroll could reach them.

Post-Deploy E2E run 38203364589 caught it in production through
`tests/e2e/mobile-chrome-occlusion.spec.ts`: "Wallets And Fees Are In Club
Chips" 74px under the bottom bar at 375px. The release before #6693
(e5303503b0, run 38198079415) passed the same spec.

## The fix

At 720px and below the console is `position: relative` and scrolls with the
page; the roster keeps its own scrolling viewport (`.members-viewport`). The
selection bar (`.members-bulk`), which was pinned 306px down the screen to sit
under the pinned console, now pins directly under the header between 431px
and 720px (it is already unpinned at 430px and below). Desktop is unchanged.

## The pin

`tests/e2e/css/club-members-containment.spec.ts` renders the production
stylesheet at 375px and 393px with Metric Definitions closed and open, a
40-row roster and a fixed bottom bar, and asks `elementFromPoint` whether a
finger lands on the first and tenth roster rows and on every definition once
each is scrolled into view. With the previous stylesheet those probes land on
the console instead.
