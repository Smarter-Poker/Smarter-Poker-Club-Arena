# Phase 2 occupancy wiring checkpoint

Status: IN PROGRESS. This is a local checkpoint, not phase acceptance or publication evidence.

## Implemented in this checkpoint

- Versioned /leave-occupancy route authenticates the player, binds table/seat/occupancy, and retrieves original committed receipts before consulting an engine.
- Browser persists original occupancy before sending, retains unknown outcomes across retries/reloads, validates receipts, and does not fall back to direct financial RPCs or seat writes.
- TableService uses that contract and reports the committed amount. Presentation-history failure cannot negate a committed cashout.
- Deferred cash and tournament departure await a write scoped to the original occupancy before success.
- Hand preparation and leave share a serial boundary. A delayed deal revalidates its selected roster; queued leaves preserve the original target.
- Shutdown retains process ownership until accepted boundary work completes.
- Folded participants remain tied to settlement; the previously published correction's source assertions are aligned here.

## Verification

- Isolated PostgreSQL: 45 passed. Actual PostgreSQL transactions test replay, identity, authorization, rollback, concurrency, transition guards and lock order. The occupancy migration is not applied to production.
- Formatted server suite: 7,791 passed; 45 PostgreSQL tests skipped by that ordinary run and run separately above; one test file skipped.
- Full formatted client suite: 17,295 passed and one whitespace-sensitive source assertion failed. That assertion was corrected without changing production code; the house-law, browser intent and TableService receipt suites then passed. Do not represent this as a newly rerun full client suite.
- Browser and server TypeScript checks passed after formatting.
- Mocked boundary tests prove exclusion during asynchronous preparation, release on exception, stale queued target refusal, delayed response replacement protection and teardown ownership.
- Browser module tests simulate persisted requests. Actual browser reload/multi-tab/native-storage acceptance and live HTTP integration are still required.

## Publication evidence

- Folded correction was separately merged via PR #3905 as e272f61bc5359a7b92f76cc85be06e95668d8508 and its frontend publication was verified previously.
- Latest public frontend observation: 38bb18e12cacf0e8774ee1f9da1ee260f35d7788, build 2026-09-09T01:22:54Z, run 34298804855. Ancestry of this new observation is not yet checked.
- Latest engine observation: status ok, version 9ef973e9. Earlier ancestry check established this is not a descendant of the folded correction. Engine adoption remains pending; no forced restart was performed.
- This occupancy branch and migration remain unpublished. Do not deploy the frontend before the matching database and engine contract is verified.

## Remaining gates

1. Persist forced departure authority by occupancy; the current user-keyed in-memory forcedLeaves set is insufficient across rejoin/restart.
2. Align pending-departure enumeration, refusal callbacks and all post-await cleanup with occupancy; check errors and remove redundant non-atomic recounts.
3. Audit other departure writers against hand preparation and ownership (eviction, held clock, engine retirement and administrative paths). The new serial boundary currently covers leaveTable and dealHand, not every exit.
4. Align atomic_table_cashout, player_leave_table, fn_admin_kick_player, closing-table and cash-cluster wrappers; preserve user/parent/seat lock order.
5. Retire unbound HTTP and external direct canonical RPC access after compatible engine/client adoption.
6. Verify database grants for occupancy reads, native persistent storage, multi-tab locking, router HTTP behavior, lost-response reloads and tournament UI behavior.
7. Review hand timeout/interrupted settlement and all remaining Phase 2 poker-rule, escrow, RNG/privacy, showdown, bomb-pot, timer and maintenance acceptance evidence.
8. Merge current main and preserve other active work before release; rerun required combined gates.
9. Short-lock-timeout migration application, CI/Hetzner publication and actual engine adoption evidence.
10. Close Phase 2 only with transaction-level and deployed acceptance evidence; Phase 3 has not started.

## Durable authority follow-up checkpoint

Still IN PROGRESS and unpublished.

Implemented after the first checkpoint:

- Engine-only fn_request_seat_departure records occupancy-bound authority and seat flags in one transaction. Forced authority is retained across retries and fresh connections; ordinary retries cannot downgrade it.
- Removed the user-keyed forcedLeaves memory set. Pending cashout gets effective forced authority from the durable occupancy record.
- Clock-held departures use an occupancy map, reject stale refusal callbacks, wait for settlement, exclude all live-hand participants including folded players, and share the hand-start boundary.
- Confirmed held departures remove the exact occupancy from the engine roster. Sit-out visibility writes include captured occupancy.
- Pending enumeration/read and refusal-write errors are checked. Removed its second unlocked count write and duplicate seat-open notification; canonical cashout owns those outcomes.
- TableService administrative kicks use the existing engine endpoint instead of directly cashing out in SQL. Malformed success responses are refused. The browser no longer writes a separate recount after kicking.
- Changed the legacy-credit transition guard to an aggregate to avoid the live EXISTS row-goal plan's repeated nested scan.

Verification of the combined formatted source:

- Full client suite: 17,302 passed in 1,250 files.
- Full server suite: 7,806 passed; 52 opt-in PostgreSQL tests skipped there, one file skipped.
- Isolated PostgreSQL suite: all 52 passed, rerun after the transition-guard change.
- Browser and server type checks passed.
- Focused durable service/engine checks: 126 passed before the final combined run.
- Admin browser-to-service boundary: six tests passed, included in full client count.
- Read-only live preflight: zero active legacy-credit conflicts at observation time.
- Live table-level SELECT grants permit authenticated/service-role occupancy reads after migration.
- Live direct canonical cashout and fn_admin_kick_player still grant authenticated execution. Retirement remains REQUIRED after replacement engine/client adoption.
- Live wrapper definitions inventoried: atomic_table_cashout MD5 7727f35b5aef8797fb0332ddcf002419; admin kick 513389f0cac8712718f2e620cfc4cf28; closing cashout 8d4ff093b7dd4f305322f75e76a5b999; cluster tick 91ab73af90af13767d5782407286cd5b; player_leave_table cbab2d426b0ec091b5b09f3e76eec640.
- Engine health still advertised 9ef973e9; inspecting that revision confirms its leave predicate still excludes folded participants. Do not mark the previously merged folded correction as engine-adopted.

Remaining mandatory work includes admin retry identity and immutable administrative outcome, all indirect SQL callers and their outer lock ownership, legacy privilege retirement, held-request restart semantics, browser/native/multi-tab/live HTTP verification, current-main integration, migration application and scheduled engine adoption, and the remaining Phase 2 rule/lifecycle acceptance matrix. No Phase 3 work has started.
