# Phase 3 SNG And Spin Recovery Evidence

The installed played-Spin proof now executes in the disposable PostgreSQL funding rehearsal. The previous runner supplied fixed `ok=false` and `ok=true` answers instead of executing this helper. This change replaces those answers with the exact installed SQL.

On 2026-09-10 the revised runner passed **58 PostgreSQL checks**, including one accepted played-state case and fourteen invalid-state cases added here. The existing funded-draw, concurrent-reserve, receipt replay, refund refusal and legacy-adoption cases also passed with the real helper installed.

## Source Identity

| Installed Function                                     | Verified Identity                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `fn_prove_played_spin_launch_recovery(uuid)`           | Body MD5 `b7bc1bb46141fb6bd415b3658e622a3b`                                                    |
| `fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)` | Definition MD5 `1c911e3ada50ffe0493b9b375e3fa9ae`; body MD5 `b303d83aadd381950dfe658578767a4c` |

These identities were read from the live catalog on 2026-09-10. The runner checks the actual helper body and the composed atomic definition before exercising their behavior. New read-shape column types were compared with the live catalog.

## What The New Cases Prove

The actual helper accepts an original field of three paid identities after one zero-stack elimination has vacated. Two live stacks must agree with the roster and preserve all 900 starting chips. The composed atomic function replays the exact original receipt, including the eliminated identity, rather than rerolling. A legacy funded draw without a receipt is adopted once with its original projected rules and an explicitly unavailable historical probability snapshot.

Fourteen controlled invalid states cover missing, premature or foreign-table hand evidence; a busted player retaining a live chair; divergent or inflated stacks; duplicate buy-in receipts; absent entitlements; wrong charge and reserve counterparties; incorrect resulting reserve balance; uncovered escrow; SNG classification; and two-seat table capacity. Each case requires both the real proof and the atomic call to refuse. Whole-row snapshots of thirteen fixture relations remain unchanged by the refused atomic call.

## Limits

This is a focused predicate and receipt-composition rehearsal, not a complete Stage 1 schema replay. The new journal, escrow, hand, roster and seat transition rows are controlled evidence inputs. Their production writers, full foreign-key/trigger graph, real hand settlement and runtime launch completion are not invoked by this fixture. Maintenance, reserve ownership and RNG remain the existing controlled dependencies. No production financial rows were written, and no migration or engine behavior changed.

The original 36-check correction remains historical evidence. The 58-check result is a new execution of the current composed atomic authority; it does not retroactively certify broader financial or lifecycle contracts.

## Control Disposition

| Control | Status After This Work                 | Remaining Acceptance                                                                                                             |
| ------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| S01     | Open                                   | Concurrent final-seat admission must run through one funded startup transaction.                                                 |
| S02     | Open                                   | Execute real last-seat join versus unregister, including seating and refund outcome.                                             |
| S03     | Open                                   | Verify supported SNG sizes, time banks, structures and special payouts together.                                                 |
| S04     | Open                                   | Verify the complete SNG escrow-to-obligation writer path.                                                                        |
| S05     | Open                                   | Verify fee-escrow closure and explained residuals with retained prize history.                                                   |
| S06     | Partial, Current SQL Rehearsed         | Complete reveal/runtime failover integration with the stored entrant and rule receipt.                                           |
| S07     | Partial, Current SQL Rehearsed         | Complete production-equivalent entry, journal, escrow and payout writer composition.                                             |
| S08     | Open                                   | Verify shared reveal delivery before every participant's first deal/action timer.                                                |
| S09     | Partial                                | Exercise every actual probability tier's stack, levels and payouts. The funding fixture uses a controlled two-tier distribution. |
| S10     | Open                                   | Reconcile actual odds, reserve contribution/draw accounting and approved peak-exposure policy.                                   |
| S12     | Open                                   | Verify heads-up action order and simultaneous-bust outcomes across engine, history and payout display.                           |
| AX08    | Open                                   | Same complete final-registration/unregister startup race required by S01 and S02.                                                |
| AX09    | Partial, Actual Played Proof Rehearsed | Complete the runtime crash-before-spinner recovery path.                                                                         |

No whole control or phase is marked complete by this evidence file. S11 and AX10 cancellation policy are owned by the separate cancellation lane.

## Reproduction

```sh
PATH=/opt/homebrew/bin:$PATH POKER_AUDIT_SPIN_LOG=/tmp/codex-phase3-installed-played-spin-proof.log python3 scripts/dev/probe-spin-funding-pg17.py
```

Result: `58 PostgreSQL checks passed.` The runner creates a PostgreSQL 17 socket-only cluster, accepts no remote database URL, and removes the disposable cluster on exit. The local execution log was `/tmp/codex-phase3-installed-played-spin-proof.log`; the one-line result was `/tmp/codex-phase3-played-run.log`.

The runner calls `played_spin_proof_cases.py` directly and loads `fixtures/spin-funding/played-proof-bootstrap.sql` plus `installed-played-proof.sql`. The captured production helper is not replaced with a success/failure stub.
