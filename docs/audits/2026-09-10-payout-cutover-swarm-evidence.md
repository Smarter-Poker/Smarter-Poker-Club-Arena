# Phase 3 Payout Cutover Evidence

Source base: 8b859c0254d7d4f264a757af416bb9570b85b0a2. Scope: CA-03-04, CA-03-05, CA-03-06 and CA-03-07. All remain open pending complete behavioral and release evidence.

## Verified Fixture Correction

The shared terminal fixture inherited level 0 and a level 4 entry cutoff. Closure, final-deal replay and mixed-mystery replay therefore stopped at the actual entry-window guard before reaching their intended money assertions. The fixture now explicitly represents a running tournament after its published purchase windows close. The hand-boundary probe retains its own explicit open rebuy window.

The new SQL probe uses the real trg_tournament_pool_finalization_window_guard on a temporary table. Six native PostgreSQL scenarios passed: closed-window finalization, refusal to reopen a finalized pool, open level registration, open timed registration, uncapped re-entry and an unexpired add-on promise. Both the synthetic template and temporary table rolled back; auth.users remained empty afterward. This proves the fixture correction, not complete terminal money acceptance.

## Dependency Diagnosis

The disposable current_replay schema already contains the M1 Spin cutover/draw authority, M2 cancellation receipts and unwinds, and M4 payout-source correction products. It omits their data because the source dump was schema only. Replaying M1 is incorrect: its historical prerequisite includes the now-retired one- and two-argument registration functions. M3 obligation-retirement metadata is absent. M5 terminal completion and M6 seat-exit authority products are absent.

Direct replay of the complete tracked M5 migration passed installation steps but failed its final satellite receipt privilege check, rolling back the whole transaction. The donor receipt function has NULL ACL, which grants PUBLIC execution. Production read-only catalog evidence shows owner-only execution. The donor function body also differs from the current production body. This is a stale rehearsal baseline, not evidence that the production receipt exposes that privilege.

Automatic approval review rejected exporting the cloud function definition into a local temporary file, and then rejected installing the existing tracked function and its ACL in the disposable database as an indirect retry. Neither denied operation ran. No further attempt was made. The M5 replay remains blocked at this source/ACL prerequisite; the seven production guards were not changed.

After a representative baseline is authorized and restored, execute M5, preserve the exact-hand restoration, then execute M6 and its dependent forward migrations. The bounty rebuy-generation follow-up requires M6. Do not use the older full_stage1 snapshot as proof of current source behavior. Do not fabricate migration receipts or rerun historical financial repairs to populate a schema-only dump.

## Remaining Acceptance Gates

| Control                       | Required Evidence Before Closure                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA-03-04, Payout Authority    | Run terminal completion, full rollback after injected downstream failure, immutable receipt replay and exact payout recipient/amount checks on current authorities. Verify the coordinated production cutover and engine adoption.      |
| CA-03-05, Disabled Safeguards | Prove all seven guards and the strict single-obligation payer activate together; refusal and replay must preserve the entire state. Verify protocol-2 lease admission and the live catalog only through the coordinating release owner. |
| CA-03-06, Final Deals         | Run the fixed-place plus five-player chop receipt test with closed entry windows. Trace each consent to its exact immutable proposal and participants; generic voter presence alone is insufficient.                                    |
| CA-03-07, Guarantees          | Preserve actual overlay rollback, transient retry, once-only funding, ledger/escrow proof and private routing evidence. Rerun the terminal guarantee rollback probe against current M5/M6 after the baseline prerequisite is resolved.  |

Production engine mutation, deployment dispatch, Stage-B DDL, financial corrections and publication are outside this swarm lane. The existing release coordinator owns those actions.

## Final Deal Consent Finding

Tracked fn_cast_tournament_deal_vote(uuid), in 20260908042000_bounty_elimination_outbox_is_atomic_and_recoverable.sql, validates the authenticated live entrant and writes only tournament_id plus user_id. fn_settle_tournament_final_table_deal in 20260909042455_tournament_cash_settlement_has_one_atomic_authority.sql locks and counts that voter membership at lines 2985-2999, then prices the deal using current chip stacks. The vote contains no proposal, version, amount or stack fingerprint. Receipt replay verifies the committed payout afterward, but does not bind the earlier consent to that payout proposal. CA-03-06 therefore has a concrete unresolved consent-version gap. Server and client need one approved proposal contract before this control can close; this lane does not invent new payout economics.

## Source Verification

The existing terminal, guarantee, payout and retirement guards cover 61 unique tests. First run: 60 passed, one filesystem scan timed out under parallel machine load. The unchanged affected file subsequently passed all five tests in isolation. Native fixture proof: six passed. TypeScript compilation is not certified because dependency provisioning and then full-disk exhaustion prevented a reliable clean run. No TypeScript source changed. Local publication is performed only by the coordinating root agent.
