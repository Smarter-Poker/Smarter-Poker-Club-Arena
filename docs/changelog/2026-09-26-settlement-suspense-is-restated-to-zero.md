# Settlement suspense is restated to zero, journal only (2026-09-26)

Owner authorization, Dan, 2026-09-26: "Post correction legs to zero it."

## What was wrong

`ca_ledger_accounts` declares `settlement_suspense` must_be_zero. On the journal it
stood at +4,170,904.48 (7,743 legs in for 21,730,142.57, 4,676 out for 17,559,238.09,
first leg 2026-08-31 14:40:51, last 2026-09-14 06:27:40). `fn_ca_autoledger` books
the other side of any balance write whose writer did not declare a counterparty
to suspense, so every leg in that account is half of a real movement whose other
half was written somewhere else.

Pairing the 12,419 legs by exact instant and amount, 5,750 pair off (17,310,078.63
each way): one transaction, A to suspense and suspense to B, is a transfer from A
to B routed through the corridor and needs nothing. Eight more legs are four
cross-instant pairs already cancelled by earlier corrections. The other 6,661 legs
are the whole balance:

| Finding |  Legs | Net into suspense | What it is                                                                                                                  | Restated against    |
| ------- | ----: | ----------------: | --------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| L01     |   416 |     +4,160,000.00 | agent to member distributions of 2026-09-01; each has a same-instant member credit twin written against `table_stack(NULL)` | `table_stack(NULL)` |
| L02     | 3,791 |       +214,665.00 | spin prize draws; 3,755 winners were paid exactly the draw through `table_stack(NULL)`                                      | `table_stack(NULL)` |
| L03     |   626 |        -41,342.04 | spin reserve intake before the spin writer declared categories                                                              | `table_stack(NULL)` |
| L04     |   626 |        +39,874.00 | spin draws of the same period                                                                                               | `table_stack(NULL)` |
| L05     |    12 |         +1,269.00 | union guarantee overlays of twelve completed tournaments                                                                    | `table_stack(NULL)` |
| L06     |     1 |           +246.82 | `fn_charge_place_overpays`, duplicate place overpays of six completed tournaments                                           | `table_stack(NULL)` |
| L07     |     4 |           +108.00 | tournament buy-ins of four completed tournaments                                                                            | `table_stack(NULL)` |
| L08     |     1 |            +10.00 | write failure 825 compensation, a buy-in whose event was never named                                                        | `table_stack(NULL)` |
| L09     | 1,023 |         -5,162.49 | union rake credited with no counterparty                                                                                    | `table_stack(NULL)` |
| L10     |    27 |            -70.75 | club wallet rake mirror of the same hands                                                                                   | `table_stack(NULL)` |
| L11     |   115 |            -19.55 | jackpot contributions                                                                                                       | `table_stack(NULL)` |
| L12     |     2 |           -119.53 | table cash-outs                                                                                                             | `table_stack(NULL)` |
| L13     |    13 |         +3,423.12 | owner-ordered pool and bank resets of 2026-09-01 (chips removed by fiat)                                                    | `chip_retirement`   |
| L14     |     2 |         -1,977.10 | the same opening baseline setting the BBJ to 1,000 (chips created by fiat)                                                  | `issuance_reserve`  |
| L15     |     2 |       -200,000.00 | 100,000.00 opening treasuries of two certification clubs, later retired                                                     | `issuance_reserve`  |

Why not `prize_liability` for the spin draws: all 3,791 events are COMPLETED and
`fn_terminal_tournament_evidence_is_immutable` refuses any new journal row naming
a terminal tournament. Their winners were paid through `table_stack(NULL)`, so that
is the side the draw legs belong to. Their `prize_liability` journal is left
exactly as it was, so it is no worse; the same holds for L05, L06 and L07.
Measured per tournament, restating to `prize_liability` would have made 54 spin
events and every overlay event read further from their obligation.

## What changed

Migration `20260926060005_settlement_suspense_is_restated_to_its_real_counterparties`:

- `fn_ca_restate_must_be_zero_account` posts one correction per finding through
  the unchanged correction authority `fn_ca_post_correction` (one leg per linked
  incident, full request intent retained), files and closes a linkage incident per
  finding, maps every restated leg in `ca_journal_restatement_legs`, re-baselines
  `ca_must_be_zero_state` to 0.00 and writes a receipt. It refuses to commit unless
  the account reads 0.00 and a content hash of every balance-bearing table is
  identical before and after inside one REPEATABLE READ snapshot.
- `fn_ca_restate_settlement_suspense_20260926` is the one-off: one operation id,
  service_role only, and it refuses unless the live journal reproduces every
  finding's leg count, amount and id-list md5 exactly. A replay returns the receipt.
- The flow readers of suspense (flow arm of `fn_ca_suspense_regression_check`,
  `fn_ca_quick_reconcile` 3g, `fn_ca_undeclared_leg_check`,
  `fn_ca_chip_store_coverage_gaps`) now exclude corrections posted through
  `fn_ca_post_correction`, the rule `fn_ca_trial_balance` and the supply meter
  already apply. The balance arm still counts every leg.
- The balance arm's closure could never succeed: it wrote closure_basis
  `condition_no_longer_holds`, which the `ca_drift_incidents` CHECK does not allow,
  and no `correction_ref`, which `fn_ca_resolution_needs_a_cause` refuses. It now
  closes as `verified_remeasured` with `correction_ref` "verified: balance arm
  re-measured ...".

## Regression

`scripts/ci/test-settlement-suspense-restatement.py` (CI accounting shard 1) runs
production's exact pinned definitions in an owned PG17 cluster: RED shows the
installed closure refused; GREEN proves the restatement, every refusal, the replay,
the closure and that an undeclared leg still raises every flow finding.
