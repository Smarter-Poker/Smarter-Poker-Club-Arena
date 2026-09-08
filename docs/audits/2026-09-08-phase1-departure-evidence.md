# Phase 1 Departure Evidence — September 8, 2026

Status: incomplete. Club Arena only. World Hub and the excluded Bots, Horses And Real-Time Assistance workstream are not covered. The 7,038-file inventory is not proof of review.

## Benchmark And Acceptance

Primary comparator checked September 8: [PokerStars server crashes and game outcomes](https://www.pokerstars.com/help/articles/server-crash-web-article/95188/). It documents recording completed-hand transactions and restoring pre-hand balances for interrupted cash hands. This establishes an observable accounting/recovery comparison, not evidence of PokerStars' internal RPC design or an industry-wide architecture mandate. Full interrupted-hand rollback verification belongs to phase 7; this phase does not certify it.

Our departure acceptance is an engineering requirement: an unknown cashout outcome cannot be represented to players as a confirmed departure. Only a validated receipt may trigger seat departure and tracking cleanup. Retries must use the authoritative cashout path. Database wallet movements are not manually exercised against live players for this check.

## Caller Review

| Surface                              | Finding and disposition                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared cashout helpers               | #3809 validates receipts; #3818 propagates failures to callers without onFailed instead of returning zero as success. Callback users retain their explicit failure contract.        |
| Away/sit-out eviction                | #3818 moves departure after cashout confirmation and filters only confirmed exits, retaining skipped live all-in players.                                                           |
| Zero-stack no-rebuy sweep            | Follow-up a08e689b16 moves the departure event after confirmation and removes the alternate fallback. Failure retains roster/grace state for retry.                                 |
| Immediate voluntary and forced leave | ServerTableEngineSeating awaits explicit success or checks failure callback before teardown. Forced absent-roster cashout now throws on failure before forgetting continuity state. |
| Held voluntary leave                 | ServerTableEngineBase releases tracking and emits only when voluntary cashout returns ok.                                                                                           |
| Pending departures                   | processLeavePending checks locked/failed flags before reporting users as cashed out. Wider enumeration/read-error behavior remains a later reliability review item.                 |

## Verification

Two new zero-stack behavioral tests fail before the correction due to premature seat_left events. After the correction, 74 focused tests pass across receipt validation, eviction outcomes, rebuy ledger protection and sit-out safeguards. Server TypeScript passes. Normal follow-up push gate: 419 tests across 52 files pass. This is not a full-suite or live behavior pass.

#3818 merged as ab0f53926ac53c7b8b3d0d7be1278e9fd08e7500. Its earlier full CI attempt had 7,565 passing tests and one worker readiness timeout in an existing benchmark. Do not equate merge with proof that every CI job passed. Follow-up a08e689b16f260160a4ba983ba5cd96b37f3e4ee is pushed; automatic PR/CI/merge and runtime adoption remain independently checked.

At 16:08 UTC, engine health returned HTTP 200, status ok, version c3821317, zero stalled tables and inactive maintenance. That version lacks #3818 and the zero-stack follow-up. At approximately 16:09 UTC, both frontend build-info endpoints returned 8b898b16d4099b1d7cd3d22df55d45914e03e230, built 16:02:33 UTC by publisher run 34248296270. Frontend agreement does not deploy server fixes.

## Still Required Before Phase Closure

Confirm follow-up PR and required CI jobs; verify merged source includes each correction; verify the scheduled Hetzner engine rollout adopts a containing version; validate departure/retry behavior through an authorized isolated end-to-end scenario. Skipped browser checks are not passes. Reconcile the original 216-requirement register with the coverage baseline. No forced restart, wallet edit, hook bypass or F30 gate bypass is authorized by this evidence.
