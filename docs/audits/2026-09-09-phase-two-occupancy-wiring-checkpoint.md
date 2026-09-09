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

## Administrative retry identity follow-up

Added /admin/kick-occupancy, with existing table-admin authorization before receipt lookup or engine dispatch. Cached cashout receipts return before consulting a replacement seat. An immediate cash kick requires its committed receipt; failed removals do not create success moderation events.

IntegrityActionService now shares the persisted occupancy-request implementation with voluntary leave. Kick requests use a separate key and retain the original reason across unknown-outcome retries. The legacy HTTP route remains for the compatibility transition and must be retired with direct SQL privileges.

Verification: 12 administrative handler tests; four actual loopback HTTP/router/JSON checks (auth and receipt storage mocked, not production E2E); 50 focused client tests. Full client suite passed 17,304 tests. Full server suite passed 7,821 tests with one old exact-source forced-option assertion failing; updated that assertion to include forced authority plus occupancy. Type errors in two test assertions were corrected. Full combined verification is required again after integrating current main.

Administrative moderation-history insertion is still outside the financial transaction. Do not describe it as an immutable atomic administrative audit record. Bulk action identity, original authorization context for receipts after table deletion, native/multi-tab browser acceptance and the remaining SQL wrappers are still open.

## Main integration verification

Merged main 5b92dc787 into the occupancy branch without discarding the new add-on delivery, financial presentation push, parallel departure reads, or common busted-seat release. The common release now passes the captured occupancy and refuses cleanup of a replacement occupancy. Parallel departure results retain both user and occupancy identity.

Merged verification: 17,377 client tests in 1,253 files passed; 8,063 server tests in 599 files passed. The 52 opt-in PostgreSQL tests passed separately in the isolated harness (they are skipped in the ordinary server run). Server TypeScript passed. Six initial integration-fixture failures came from main's new post-confirmation financial presentation push; the fixture now isolates that notification and verifies no notification before a confirmed cashout and one after confirmation. The focused departure/rebuy/read-overlap suites pass all 25 tests.

This records local integration evidence only. Occupancy migration, compatible engine/client adoption, legacy entrypoint retirement, remaining departure ownership and full Phase 2 acceptance remain open. No production occupancy migration or publication occurred in this verification.

## Engine-only occupancy cashout authority

The new unpublished occupancy RPC originally retained an authenticated-owner grant. That would let a browser bypass the engine's live-hand boundary even with correct occupancy identity. Its grant is now service-role only and its body independently requires engine authority before receipt access or mutation. An owner identity or club-admin session marker is insufficient. The browser and admin HTTP handlers already route through the engine.

All 55 isolated PostgreSQL cases pass, including direct-owner voluntary/forced rejection with no ledger, balance, seat or receipt mutation; grants for all three app roles; rejection of direct owner replay after commit; and successful engine replay of the original receipt. Existing legacy live RPC grants are unchanged by this local correction and remain a coordinated retirement gate.

## Table-close and held-departure follow-up

Read-only production inspection confirmed both close triggers are enabled. The shared close helper skipped missing-club seats and non-positive or malformed amounts; its caller could then release unpaid seats. The second trigger swallowed cashout errors. The new reserved migration 20260909024909 routes all active occupancies through the bound transaction, including zero stacks, and propagates failure. It preserves tournament exclusion and the existing service-only grant.

The isolated harness loads exact read-only exports of both old functions and applies the complete guarded migration twice. All 60 database tests pass: zero/positive close receipts and replay; missing-club refusal; rollback of an earlier payout when a later occupancy is invalid; and the actual trigger rolling back status, wallet, seat, and receipts on an injected payout failure before succeeding on retry.

This does not close the live-hand or lock-order acceptance gates. Status triggers enter with the table row already locked, so outer transaction ordering and engine-driven table-close ownership still require review before this migration can be published. No production DDL was executed.

A separate source review found clock refusal cleared the persistent pending flag while retaining only an in-memory map. The service now keeps the accepted departure pending for the same occupancy; a countdown callback cannot cancel it. Its focused retry/restart-boundary verification is recorded after execution.

Verification update: 86 focused service/departure/read-overlap tests pass; server TypeScript passes. The ordinary pending-departure read remains the owner of accepted requests after restart; no new watcher or reconciler was added.

Compatibility review then found that an older engine could use the canonical cashout during adoption without the new wrapper, leaving no durable receipt. Receipt insertion now belongs to the canonical transaction itself, after credit/exit/session/count updates and before commit. The wrapper validates identity and returns/replays that original outcome. Both zero and positive legacy-engine calls are covered by bound replay tests. All 62 isolated PostgreSQL cases pass, including both complete migrations applied twice. The new canonical pg_get_functiondef MD5 is 8d84b96cb2e7649ee2bf7ecf1f7028c9. Older local fingerprints above are historical, not the current migration output.

Remaining release gates are unchanged: live outer lock ordering, engine hand ownership for every close ingress, retired unbound interfaces, coordinated schema/engine/frontend publication and actual adoption. This batch is local and is not a Phase 2 completion claim.

## Legacy HTTP retirement and destination-write proof

The old /leave handler no longer acknowledges a cashout or hands cleanup to the browser when an engine is absent. Both /leave and /admin/kick require reload and cannot consult a replacement seat. Bound endpoints remain the supported path. Actual local HTTP tests cover successful bound replay, authenticated legacy rejection and unauthenticated rejection. The 84 focused handler cases passed; 164 handler/service/source-law cases passed after updating two obsolete source pins. Server types passed after correcting a test fixture type. The full server run before those two source-pin updates had 8,066 passing cases and exactly those two failures; do not present that run as a full pass.

Reserved migration 20260909031204 is the final adoption stage: it revokes browser execution of canonical cashout and all app-role execution of the retired SQL admin kick. It must follow verified new engine/frontend adoption, not precede it. The isolated harness applies it twice and verifies actual SET ROLE authenticated rejection without writes. It has not been applied live.

Read-only inspection confirmed the installed credit routine ca0a0d6fe1f01c1f2bed49e7db1fd7e8 ignores a destination update affecting zero rows; wallet_transactions.balance_after permits NULL. fn_ensure_club_wallet only returns membership existence and does not create a wallet. The isolated missing-membership cashout regression failed before correction (64 passed, 1 failed: expected exception did not occur). The fixture now models the actual boolean existence helper.

Reserved independent migration 20260909031958 requires a successful destination club_members update before any credit journal or caller cashout can commit. Its non-club branch is unchanged. All 68 isolated tests pass after correction, including cashout, rakeback, tournament-prize and refund missing-destination rollback. Shared credit output MD5: ffc49583c6142ea0929f247edc65e219. This identifies a reproducible code defect, not proof that it caused any particular historical incident. Independent publication is being prepared; no production change is claimed here.

## Verified destination release and native retry follow-up

The independent destination-credit fix was published through PR #3925, merged as e970c09bfab3828707b471f976771826d7e699de. CI run 34307621500 succeeded. The public frontend advertised that merge, build 2026-09-09T03:40:14Z, run 34307860062. Production catalog migration 20260909034315 installed the guarded destination-write correction; read-only verification returned credit-function MD5 ffc49583c6142ea0929f247edc65e219. Its standalone disposable PostgreSQL script also passes valid credit, replay, missing destination rollback and retained inactive-account cases. These observations supersede the pending-release statement above.

An engine health observation advertised 5b92dc78, which includes the folded-participant correction. No forced restart was performed. This is not adoption evidence for the unpublished occupancy contract.

Actual headless Chrome reproduced a two-tab race in SeatLeaveIntent: a queued request could read the replacement occupancy after the first request resolved. Capturing persisted intent before waiting for the native Web Lock now retains the invocation's original action. The committed browser fixture uses the real service module, native localStorage and Web Locks, with local simulated API/database boundaries. Six scenarios pass: leave and kick, queue after initial persistence, both tabs queued before persistence, and truncated committed response followed by reload/retry. Both requests retain occupancy A and return its original 25-chip outcome rather than targeting replacement B's 40 chips. This is not physical-device/PWA or production financial E2E evidence.

The remaining engine absent-roster fallback is removed. Voluntary and forced requests without their original occupancy fail without a database lookup, financial mutation or success event. Bound reserved-seat departures still cash out through the engine. The obsolete browser-handoff source assertion now requires retirement and engine ownership.

Combined verification after these changes: all 17,377 client tests in 1,253 files and all 8,070 server tests in 599 files passed. Both TypeScript checks passed. The ordinary server run skips 68 opt-in PostgreSQL cases; those passed separately in the preceding database verification and were not rerun for this TypeScript-only change.

Phase 2 remains IN PROGRESS. The occupancy bundle remains unpublished/unapplied. Admin immutable transaction-backed audit, indirect SQL departure/close ownership and lock ordering, remaining lifecycle/rule acceptance, coordinated contract adoption, and final deployed verification remain mandatory.

## Administrative authority transaction checkpoint

The old handler submitted moderation history after the departure succeeded and ignored insertion failure. The replacement passes actor and club from the existing authorization result, validates the reason, and requires an engine-only database transaction before cashout or a deferred acknowledgement.

Migration 20260909040806 stores original actor, club, reason and occupancy in a private retained table and writes the existing moderation event in the same transaction as the accepted forced departure. Retries preserve the first authorization and do not duplicate that event. Application roles cannot directly read, overwrite or delete the retained authority. It has no cascading foreign keys. The moderation event explicitly represents departure_requested; the existing occupancy cashout receipt, joined by occupancy_id, is proof of completed payment.

The engine performs this transaction inside its seat boundary after rejecting an all-in departure, before an immediate or reserved-seat cashout, and before deferred success. The handler no longer writes fire-and-forget history. Request-body actor/club fields are not trusted.

Verification: 130 focused engine/handler/service tests; 73 disposable PostgreSQL transaction tests with the whole migration applied twice; full server 8,083 tests passed (73 database cases skipped there and run separately); full client 17,377 tests passed. Server and client TypeScript checks passed. Database tests cover audit insertion failure rolling back flags and authority, original-author retention, exact replay, profile/seat deletion retention, actual role denial, and stale-occupancy refusal. Existing moderation schema and its cascading profile FK were inspected read-only before building the fixture.

This migration and the occupancy bundle remain local and unapplied. Publication requires the remaining SQL hand-boundary/outer-lock work and compatible schema/engine/client adoption. This is not Phase 2 acceptance. Historical audit backfill, retained-authorization inspection after table deletion and session-close reason classification remain explicit review items.

## Prepared cashout ownership checkpoint

An actual ServerTableEngine regression reproduced premature teardown: prepareNextHand started processLeavePending in parallel with the roster read; the read failed, and stop released resources while that cashout was still pending. A Promise.race step budget could detach the same writer.

Preparation now acquires the existing seat boundary and joins the roster read, raw cashout and budget result using Promise.allSettled. A failed read or elapsed budget cannot cancel a database transaction or establish that its owner may be replaced. Reads remain parallel. Confirmed departures filter both the local and returned roster by original occupancy, preserving a replacement seat. The boundary releases in finally only after the accepted cashout settles. No watcher/reconciler or new timer was added.

Verification: the original teardown case failed before correction. All 13 ownership tests passed after correction; the full server suite then passed 8,084 tests (73 opt-in database cases skipped). A second regression was subsequently added and all 14 ownership tests passed, proving elapsed-budget ownership, next-boundary exclusion and replacement preservation. The affected client timing law passed all eight tests and server TypeScript passed after the final test addition. The full client suite had passed 17,377 tests immediately before this server-only change; it has not been repeated for this checkpoint.

This remains part of the unpublished occupancy bundle. SQL-driven cluster cashouts and close ownership, compatibility adoption and deployed verification remain open; Phase 2 is not complete.
