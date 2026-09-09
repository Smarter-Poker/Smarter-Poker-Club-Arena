# Accounting Phase 3 Cutover And Publication Checkpoint

Phase 3 remains open. This checkpoint does not accept any of the 12 CA-03 controls in full.

## Verified Registration Publication

PR 4028 automatically merged as `0efc32921868dc5c0f11cf388c1becf02bd1932b` on 2026-09-09 at 21:52:23 UTC. All required CI passed on the failed-jobs rerun. The first run failed because the runner lost PostgreSQL shared-memory segment `/PostgreSQL.1613218852` during an existing agent-context test. No production code or assertions were weakened. The canceled redundant Agent Open PR job did not represent a failed test; the PR existed and automatically merged.

Fresh public and origin build-info both served `24a22ade8ac865b6f3ae4d3e0bc047e4bddff88d`, built 21:58:49 UTC by publisher 34409606874. Git ancestry proves inclusion of registration PR 4028 and seat-refund PR 4020 (`877bea76d5abdd4a0bb1405e55819ab6bd029ae1`). The served release and registration merge have identical source blobs:

- TournamentService.ts: `d2d03e230339cab4cf435c91d1ca0c0cffc64f26`
- TournamentUnregistrationIntent.ts: `856bcbb989bbb5ec1a566b6dc52d5c9b192dc924`

The additive registration receipt function and registry migration were previously applied and verified. Do not reapply them. Legacy initial registration retirement remains a separate open obligation.

Phase 2 final acceptance PR 4031 merged as `65931a248c4f35b15e6dbd50aedd3b2f8d08a576`. Its acceptance files exactly match the reviewed final record on main, and the served release includes that merge. The completed Phase 2 publication task was disabled.

## Strict Cutover Is Prepared, Not Applied

Seven tournament completion/pool guards remain disabled under the original staged rollout. Historical candidate `3005bad8f` was recovered for review; it was not an adopted migration on main. The prepared SQL is deliberately under `scripts/deploy`, not executable migration inventory.

Confirmed gaps and changes:

1. The historical request hook rejected authenticated player `process_tournament_rebuy` and `fn_decline_tournament_rebuy` requests before their authorized RPC bodies could run. Live catalog inspection confirms both RPCs intentionally grant authenticated execution. The prepared hook now permits only these two unmarked authenticated routes without granting manager proof. Service callers still need their exact manager lease.
2. The current atomic Spin draw RPC, `fn_spin_draw_and_settle_atomic`, was missing from the historical manager route list. It now requires the same exact manager authority. The actual TournamentManagerBase caller uses this RPC.
3. Historical certificate backfill and automatic financial-alert closure were removed from this prospective cutover. Retiring a repair function is not evidence that its historical findings are resolved.
4. The historical cutover requires the exact-seat hand-settlement expansion. Neither main nor the live 12-argument hand-commit body contains its exact-seat/time-bank markers. Live body MD5 was `04d222d651bcaed9c9712f45449f1295`. The staged migration retains this prerequisite and has NOT been applied.
5. The full legacy Stage-B rehearsal cannot establish that prerequisite: its fixture uses a hand-commit test double. The attempted rehearsal failed before cutover at the missing prerequisite. No fabricated source markers, skipped prerequisite, or weakened production assertion was introduced. Temporary harness changes were restored.

## Focused Verification

`scripts/dev/probe-tournament-player-request-routes.py` starts an isolated PostgreSQL server and installs the actual hook extracted from the prepared SQL. The original hook reproduced the authenticated rebuy refusal. After the fix, 18 cases passed:

- Authenticated rebuy and decline, including the gateway-prefixed route.
- Anonymous, unmarked service and ordinary-service refusal for manager routes.
- Browser manager impersonation refusal.
- Exact manager proof and stale generation refusal.
- Atomic Spin route authority.
- Ordinary engine coordination and unrelated shared service compatibility.

This probe verifies request routing and lease proof only. It does not simulate money movements or prove the complete 1,600-line cutover, hand expansion, or all tournament accounting. The existing chip-journal CI entrypoint invokes it with the same pinned PostgreSQL tools. No production transaction probes were used.

## Remaining Acceptance Work

- Review and implement the exact-hand prerequisite against current occupancy contracts and current function definitions; do not blindly revive historical SQL or its source hashes.
- Rehearse the complete cutover with the actual prerequisite definitions and prove compatible live engine adoption.
- Verify remaining manager/service route coverage before applying the reviewed cutover.
- Complete legacy initial registration retirement and the remaining funding, prize, bounty, Spin and satellite CA-03 obligations from the original plan.
- Preserve the separate Phase 4 worktree and its unpublished promo changes.

## Publication Operating Rule

The user explicitly requires immediate dispatch of an already-staged normal Hetzner deployment toward its scheduled window when no compatible deployment is active. Do not passively wait for that window before dispatching. Continue implementation while publication runs. Do not duplicate an active compatible dispatch, cancel shared deployments, force an engine restart, or treat dispatch/workflow success as proof of live adoption. Database contractions still require actual compatible runtime evidence.

## CI Client Compatibility

The first PR 4037 run failed because the pinned embedded PostgreSQL package ships no psql binary. The focused probe now uses the existing pinned Node query client when PGNODE is supplied, with explicit isolated host, port and role. All 18 cases passed through that client with inherited journal-runner connection variables present. No production SQL or behavioral assertion changed.
