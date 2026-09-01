# Phase 4 and Phase 5.5 - post-deploy verification, and Phase 5 closed

2026-09-01, 18:47 UTC. Branch `phase5/post-deploy-verification`.

Dan: "Phase 5 is closed after the 14:00 CDT deploy and post-deploy
verification of Phase 4/5.5... verify the production SHA, cron/function state,
permissions, and core health gates, update the changelog with the results,
then move to Phase 6."

This is that verification.

---

## 1. Production SHA

Production engine is serving build **`3f03e4d2`**, started **18:42 UTC**.

| commit      | what it carries                                                                                     | in the running build                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `f7f30d564` | Phase 4 - orphaned-seat repair, the five-minute COMPLETING dwell, the `tournamentOwnedTables` prune | yes                                                                                    |
| `596eaed4a` | Phase 5.5 - a sat-out seat acts on the same beat as every other seat                                | yes                                                                                    |
| `e35b7300d` | Phase 5.3 - the duel repeat-pairing migration                                                       | yes                                                                                    |
| `4a129e29d` | the rulings pin (tests and docs only)                                                               | no - merged 18:41, one minute after the build was cut. It changes no engine behaviour. |

**A note on how it landed.** The deploy that shipped this was a
`workflow_dispatch` at 18:36 UTC, which is 13:36 Chicago - OUTSIDE the five
restart windows. It ran for 5m46s rather than skipping in seconds, so it was
dispatched with `force: true` by another actor. The window gate itself is
working: the 14:58 UTC scheduled run correctly reported "outside the restart
window" and did nothing. Recorded here because Dan's rule is that restarts
happen at 04:00, 10:00, 14:00, 18:00 and 22:00 Chicago, and a forced override
is a deliberate act that should be visible.

**Why the earlier deploys failed.** Three dispatched deploys failed today
(15:25, 15:37, 15:54 UTC) on the financial health-gate:
`trailing 4h unexplained chip supply is -4162775.63`. No chips were missing.
Two consecutive supply snapshots double-counted one mint with opposite signs -
13:05 recorded `+1,582,258` unexplained and 14:05 recorded `-5,743,762` - and
recomputing the mint for every one of those windows afterwards returns
`0.00`. The gate sums a trailing four hours, so it failed while only one half
of that pair sat inside the window. It cleared on its own at 18:05 when the
14:05 snapshot aged out. The `[skip-financial-gate]` escape hatch was NOT used.

## 2. Cron and function state

| object                       | state                      |
| ---------------------------- | -------------------------- |
| `fn_ca_collusion_scan`       | exists                     |
| `fn_ca_duel_pairing_scan`    | exists                     |
| cron `ca-collusion-daily`    | `20 4 * * *`, **active**   |
| cron `ca-duel-pairing-daily` | `35 4 * * *`, **active**   |
| `ca_guard_inventory`         | 2 active rows, one per job |

## 3. Permissions

| grant                                                 | value     |
| ----------------------------------------------------- | --------- |
| `anon` may execute `fn_ca_duel_pairing_scan`          | **false** |
| `authenticated` may execute `fn_ca_duel_pairing_scan` | **false** |
| `anon` may execute `fn_ca_collusion_scan`             | **false** |

Both scans are reachable only by the scheduler and the service role, which is
what `REVOKE ALL ... FROM PUBLIC, anon, authenticated` in each migration is for.

## 4. Core health gates

| gate                                                            | value     | verdict                            |
| --------------------------------------------------------------- | --------- | ---------------------------------- |
| Orphaned live seats on closed tables under a live tournament    | 0         | **PASS**                           |
| Tournaments stuck COMPLETING more than 5 minutes                | 0         | **PASS**                           |
| RUNNING tournaments silent more than 30 minutes with 2+ playing | 0         | **PASS**                           |
| Trailing 4h unexplained chip supply                             | -1,364.74 | **PASS** (gate trips at 5,000)     |
| Duel repeat-pairing signal rows                                 | 0         | expected - no pair has met 8 times |

The first and third rows are the two shapes Phase 4 was written for. The
tournament that prompted it - `$100 Freeroll - 12:00 AM`, RUNNING and silent
for 5h21m with one entrant stranded on a closed table - resolved itself after
about eleven hours through the twelve-hour startup sweep, which is exactly the
worst case the audit predicted. The repair now catches that shape within a
minute of a discovery pass.

## 5. Engine liveness after the restart

Five minutes in, from `/health` on build `3f03e4d2`:

```
activeTables      90   (16 at one minute, rehydrating)
handsInFlight     46
stalledTableCount  0
dealRate          silentChecks 0, belowFloorChecks 0, killsInWindow 0
discoveryStaleMs 118
status            ok
```

The deal-rate verifier - the engine's own judgment of whether tables that
should be dealing are dealing - reports zero below-floor checks and zero kills.

Per-minute hands dealt, across the restart:

```
18:40  187      pre-restart baseline
18:41  157
18:42   12      restart
18:43   35
18:44   66
18:45   76
18:46   75
18:47  111
18:48  117
```

Stated honestly: at the time of writing, seven minutes in, the rate is still
climbing back toward the ~200/min baseline rather than having reached it, and
`activeTables` was 90 of the usual ~120. That is table rehydration, and it is
monotonic. What says it is rehydration rather than a fault is the engine's own
liveness telemetry alongside it: zero stalled tables, zero silent checks, zero
below-floor checks, zero kills, and discovery fresh at 118ms. There is no
second dip. If the rate had plateaued instead, that would be a finding and
this section would say so.

---

## Phase 5 of 7: CLOSED

| item                               | outcome                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 chip-dump detection            | Already shipped 2026-08-31. `fn_ca_collusion_scan` + cron active, ran 04:20 today, succeeded. Zero signals because 2 humans were seated in 7 days and exactly 1 transfer was human against human. **No second detector was built.**                                                                                             |
| 5.2 scoring calibrated to noise    | The 169,523 flags at an average suspicion of 96.8 are in `collusion_tracking`, which nothing writes any more. The live surface uses strict thresholds.                                                                                                                                                                          |
| 5.3 duel re-entry limits           | Signal shipped (`fn_ca_duel_pairing_scan`, 8 meetings and 0.8 win share, calibrated against a board whose maximum pairing is 5). **Signal-only by Dan's ruling**; a 30-day review is scheduled for 2026-10-01 to bring him the distribution, flagged pairs, false-positive analysis and a recommended enforcement threshold.    |
| 5.4 heads-up disconnect protection | Notice and time bank were already correct: `is_disconnected` is published in three engine snapshot paths and rendered by `DisconnectToast` plus the seat overlay, and a mid-turn disconnect can neither spend a time bank nor move the deadline. All-in protection and the no-pause rule are Dan's rulings 2 and 3, now pinned. |
| 5.5 sit-out beat                   | Shipped and live in `3f03e4d2`.                                                                                                                                                                                                                                                                                                 |
| 5.6 insurance / run-it-twice       | Dan's ruling 4. Already refused on every tournament table by his own 2026-08-26 cash-only ruling - live check: of 2,127 duel and 5,527 spin tables created in two days, zero had either feature on. Pinned.                                                                                                                     |

All four of Dan's rulings are pinned in
`server/src/tournament/headsUpIntegrityRulings.law.test.ts` and registered in
`docs/LAWS.md`.

**Next: Phase 6 - presentation and UX (15 items).**
