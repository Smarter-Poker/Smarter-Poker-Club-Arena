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

### Engine And Service Integration

Eight additional tests in CashoutDepartureIntegration.test.ts execute the real engine departure methods and the real cashout service through its normal module exports. Only the database transport is substituted. Both eviction and zero-stack paths retain tracking after a lost response, malformed receipt or rejected outcome, then emit exactly one departure on a subsequent confirmed no-active-seat receipt. Waitlist offers and departure events wait for a complete receipt. All eight tests and server TypeScript passed. These tests close the engine/service wiring gap, but do not assert a live database commit, browser rendering or deployed runtime adoption.

The latest CI run for #3818, 34248426139, completed successfully. Server tests, TypeScript, client shards and structural checks passed. Live production E2E, post-deploy verification, production build and animation checks were skipped. Follow-up PR #3823 is open and retains separate CI and deployment obligations.

## Verified Follow-up And PostgreSQL Recovery (17:37 UTC)

PR #3823 merged as 4d1aa1ee45dc576ffd2322c537037e833fcac646. Its full server CI passed 7,578 tests across 564 files, plus 92 preliminary checks; required client/type/source checks passed. Browser, animation, live E2E and deployment/build jobs were skipped.

PR #3837 merged as 8e89ccc64732cc1479ae5f50295597f82c367103. It restores bootstrap authority during shutdown and preserves the absolute reconnect deadline during clock handoff. First CI identified and led to correction of a real deadline defect. The next CI attempt passed those tests but failed the unmodified randomized shuffle distribution check (33.677 against 32.91). One unchanged failed-job rerun completed successfully; do not erase the earlier result or describe it as RNG certification.

The isolated PostgreSQL 17.11 probe now runs the real engine departure methods and real cashout service through an RPC adapter executing actual PostgreSQL transactions. Six scenarios pass: eviction and zero-stack departure, each under normal success, lost response after commit, and an injected seat-exit error after the credit statement. They assert preserved in-memory tracking on unknown outcomes, rollback of credit/idempotency/session effects on database failure, one eventual departure, and no duplicate credit on retry.

Run: bash scripts/dev/probe-departure-postgres.sh. It owns and removes a socket-only disposable database; no live connection or production wallet credentials are used. The ordinary server suite skips these six tests unless that runner supplies the private database socket. The separate probe execution, not a skipped CI result, is the pass evidence.

Installed-function fingerprints were checked read-only against production and match the probe exactly:

- atomic_seat_cashout_locked: 0b4260da309101634851da9c63df5180.
- atomic_credit_wallet_and_log: ca0a0d6fe1f01c1f2bed49e7db1fd7e8.

The credit fixture is a pinned read-only export including later dynamic migration patches; it is not a migration. An initial probe using the older CREATE declaration was superseded by the matching installed definition. Authorization, session policy, wallet provisioning, ledger triggers, PostgREST and browser rendering remain explicit fixture boundaries, assigned to their later phases. This evidence closes the isolated engine/service/database departure-and-retry scenario, not those broader audits.

The normal containing engine rollout and this evidence branch's push/CI/merge still require verification. Phase 1 remains open until those gates are satisfied.

PR #3840 initial CI caught a portability defect in the probe's safety check: a hardcoded temporary-directory prefix. The runner and test now share the OS temporary directory, resolve its real path, and still require the private departure fixture directory and socket. This corrects the fixture rather than exempting it from the portability gate. Separate PostgreSQL execution remains required for the six opt-in cases.

## Containing Deployment Verified (18:01 UTC)

Normal Hetzner workflow 34258578581, job 102170524208, passed its server tests and deployed the explicitly selected 4932f6f91ad9b08300cf20afbeb9576b6559770f. Cutover began inside the scheduled break; the container started at 17:55:33 UTC. Public version and container health passed at 17:56:01, current was promoted, and engine_leader independently reported the new version at 17:56:03. Deployment truth attempt 241 records shipped=true. No forced restart was used.

Read-only inspection inside the running image confirms receipt validation, unhandled cashout failure propagation, eviction and busted departure after awaited cashout, bootstrap shutdown context binding, and absolute reconnect deadline handoff. All six affected production files in main matched their verified #3837 merge before deployment. The deployed commit contains #3809, #3818, #3823 and #3837.

At 18:01:05 UTC, cache-busted engine health returned HTTP 200, status ok, version4932f6f9, maintenance idle, all eight resume waves complete, 242/242 tables resumed and zero stalled tables. Both frontend endpoints independently returned4932f6f91ad9b08300cf20afbeb9576b6559770f, built17:39:49 by publisher34257700085. A transient503 was observed during announced cutover; subsequent health and thaw checks passed.

The scoped Phase1 implementation, isolated engine/service/database recovery and deployed runtime gates are now evidenced. PR#3840 carries the reproducible probe and this record; its latest required CI and merge must pass before the phase completion announcement. This test/documentation branch changes no production behavior, so it does not require another engine restart.

Full requirement rows remain pending for their later scopes: A02 financial animations, O01 parity on every later repaired path, O02 full operation-specific triggers and policies, and O12 later release records. The broader216-requirement audit and7038-file review are not completed by this phase.
