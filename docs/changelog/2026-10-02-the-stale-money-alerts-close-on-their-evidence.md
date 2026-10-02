# The Stale Money Alerts Close On Their Evidence (2026-10-02)

`MoneyAlertsGoingUnread` was firing with ~536 unresolved `financial_alerts`.
Migration `20261002171245_the_stale_money_alerts_close_on_their_evidence`
(installed 17:15 UTC, recorded as 20261002171500) resolves the 369 whose
condition is proven settled from rows, each with its evidence in its
resolution note. No money row or function changes.

| Class | Count | Source                                                                           | Proof                                                                           |
| ----- | ----: | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A     |   249 | hand_history_failed / authoritative_hand_semantic_refusal, `lease_proof_expired` | no commit, no rake row, no ledger leg for the hand; table committed later hands |
| B     |    82 | Tournament.atomic_finish_refused (+ mirrors)                                     | COMPLETED, terminal receipt = payouts = pool (5,576.50), escrow 0               |
| C     |    14 | leave_pending_failed                                                             | moves_chips false; no unaccounted seat exit; no seat left pending               |
| D     |     5 | authoritative_hand_unreachable (+ mirror)                                        | same hand committed, post-commit completed                                      |
| E     |     5 | RakeSpec.checksum_unavailable                                                    | checksum now equals the compiled one; no drift                                  |
| F     |    14 | weekly union/club accounting incomplete (+ mirrors)                              | the 09-21 week is `complete` in union_accounting_runs                           |

Left open on purpose (not provable from rows today): 22
`fn_tournament_money_conservation` deltas (two events paid 180.00 over their
pool), 43 `fn_union_integrity_sweep` co-seating signals, 13
`fn_union_rake_basis_refresh` (the open-week snapshot has not refreshed since
2026-09-28 21:35), 7 `FeeReconciler.satellite_conservation` and older
singletons, including SHARK CLUB's past-due union statement.

The A class is 20 bursts of hands refused at engine generation changes
(lease expiry). Nothing moved, but the lease handoff that refuses them is the
f06 lease-custody work, not this change.
