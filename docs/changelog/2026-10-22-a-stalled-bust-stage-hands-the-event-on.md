# A Stalled Bust Stage Hands The Event On

Engine change in #7713 (merged 2026-10-22 19:23 UTC). Database alarm `20261022172522_a_bust_backlog_pages_within_four_minutes.sql`, applied to production 2026-10-22 17:25 UTC (#7718).

Coffee Break Freeroll (PLO4) `f5a98d7e`, 16:17:04 to 16:40:33 UTC: one admitted elimination sweep never settled. The scheduler keeps a live sweep's slot by design, so the manager recorded no bust for 23 minutes. 308 busted players stayed `playing` at zero chips, every table break refused (`source_roster_disagrees:bust_unrecorded`) and every re-admission refused (`F06_MOVEMENT_ELIMINATION_UNPROVEN`). Six tables lost their dealer and the SLO paged "Tables Have Stopped Dealing". Only the stuck-table watchdog, ten minutes after the first table died, handed the event to a successor generation, which recorded the whole backlog within minutes.

What changed:

- A hand that ends with a zero stack starts a bust-wait clock that only a completed bust stage resets. A bust waiting two minutes, or a sweep in flight two minutes, hands the event to a fenced successor generation after every table finishes its hand, and pages `GameServer.stalled_elimination_sweep_handed_on` with the stage. A sweep that hangs, returns early on every pass, or errors in a loop all trip it.
- PKO: `fn_collect_bounty` refuses `bounty_generation_identity_required` when a player who rebought has one obligation per bust. The engine now proves the exact-hand obligation's complete money marker instead of failing the bust. All 342 such refusals in the nine hours before were already settled on the first attempt.
- `fn_ca_bust_backlog_page(4)` runs every two minutes (cron `ca-bust-backlog-page-2m`). It raises one critical financial alert per RUNNING event with a bust waiting more than four minutes and closes it when the backlog is recorded. `fn_ca_bust_backlog_stalled` already described this state; nothing had ever run it.

Tests: `server/src/tournament/aStalledEliminationSweepHandsTheEventOn.test.ts`.
