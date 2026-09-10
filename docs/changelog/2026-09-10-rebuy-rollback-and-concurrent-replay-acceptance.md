# Rebuy Rollback And Concurrent Replay Acceptance

## Scope

CA-03-01 and CA-03-11 in the 109-item accounting programme remain subject to production release and complete behavioral acceptance. This change extends the existing PR 4090 PostgreSQL funding rehearsal, preserving its current function fingerprints and accounting assertions.

## Change

The rehearsal already tested ordinary rebuy funding and immediate replay, but its late receipt failure and overlapping retry loops covered only reentry and addon. Include rebuy in those two existing behavioral cases and in the competing-token race so the same wallet, journal, escrow, stack, generation, receipt and wake invariants apply to all three purchase kinds. No production functions or balances change.

## Verification

The original rehearsal completed 20 groups. The extended rollback and same-token rehearsal completed 22 groups with exit 0. The final extension passed all 23 scenario assertions, including the competing-token rebuy, but its disposable PostgreSQL cleanup exceeded the runner's 15-second external timeout under concurrent disk load. PostgreSQL subsequently completed its 47.7-second shutdown checkpoint, and an independent pg_ctl status confirmed no server remained running. No success exit is claimed for that final invocation.

The independent satellite refund rehearsal completed all 8 groups with exit 0: approved cash provenance, fee and escrow rails, ordinary wallet and redeemed-ticket funding, late receipt rollback, overlapping refund/replay, and preservation under subsequent source replay. These cases do not certify tournament cancellation after prior awards or a persisted Spin draw.

Read-only production catalog checks matched process_tournament_rebuy (63e4762f2f293da5f2c66ae03fd92947), its money core (ebff39bd84c1a1ac9a75e7b09ceaa74b), and the registration operation wrapper (c80d08529c03284adc51c6cb03764a55). The fixture's older logger capture is deliberately replaced by source migration 20260910012633; that resulting source function body and the live logger both hash to f9d423ecda16d49d698a1b3735baf7cb.

## Current Dependency Parity

After integrating main 40886c94, the isolated runner now reproduces the exact source resolver transformation from 20260910020626 and the exact deduction function plus consistency postconditions from 20260910023919. Historical row repairs and the source migration's named live-event probe are outside this synthetic fixture. This verifies effective function bodies, not production migration-gate acceptance.

Every fresh scenario requires the current deduction hash 1835dbd974d8ba219cf37ab712a9ccbd and resolver hash f80eff4c311820670f1b71d15c29452d. The refreshed run completed all 23 groups and clean shutdown successfully, with evidence in /tmp/ca-registration-funding-pg17-pvtf7lb9/results.json. This supersedes the earlier cleanup-timeout limitation for the final current-source rehearsal.

Disposable cleanup now gives PostgreSQL a bounded 60-second checkpoint budget and its caller 75 seconds, based on the observed 47.7-second shutdown checkpoint under concurrent disk load. No production timeout or financial authority changed.

## Remaining Acceptance

CA-03-01 remains open for the complete current dependency graph, actual late-seat lifecycle, and knockout rebuy generation authority. In particular, the live fn_ca_settle_bounty_rebuy_generation_v1 helper is absent; ordinary purchase funding evidence cannot certify a missing bounty settlement dependency. Coordinate its M6 seat-exit prerequisite and release with the root owner.

CA-03-11 remains open for cancellation and interrupted-event behavioral acceptance. The old refundAndCloseCancelledTournament helper is no longer declared, imported or invoked under server/src or src at this checkout; its only remaining occurrence is a test assertion. Therefore the old all-entrants versus open-entrants/prize-positive comparison is not evidence of a current competing engine payer. The live atomic cancellation function calls the exact refund authority, but satellite unregister tests alone do not prove its treatment of prior awards, persisted draws or interruption policy. No new refund economics, production DDL, repair sweeper or financial write was introduced.
