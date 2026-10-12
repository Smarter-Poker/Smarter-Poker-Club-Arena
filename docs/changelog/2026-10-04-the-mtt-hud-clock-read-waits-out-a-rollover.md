# The MTT HUD clock read waits out a level rollover (2026-10-04)

`Post-Deploy E2E`, run 37246061086, live-table MTT case: "The recovered MTT has no eligible natural HUD clock". The event was healthy. The reserved account's edge log shows the clock read for tournament `8c42b2c2` ($100 Freeroll, RUNNING, 320 players) at 00:13:04Z. Its `level_started_at` moved to 00:13:18Z, so at the read the current level had 14 s left. `eligibleHudClock` deliberately refuses a level with 20 s or less, because that level-up can fire before both HUDs watch.

The spec now asks again every 5 s for up to 45 s, which spans the rollover. The new level becomes the baseline, and `mttCaseTimeoutMs` sizes the case deadline from it. A tournament that is still ineligible after that (on break, add-on period, fewer than four players, terminal) is refused exactly as before.
