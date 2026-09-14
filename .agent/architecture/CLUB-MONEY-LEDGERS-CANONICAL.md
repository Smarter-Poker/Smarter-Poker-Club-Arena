# Club money ledgers: rake rule updated 2026-09-11

Dan explicitly requires standalone club rake to burn chips. Union rake may remain in the union wallet. This supersedes the former standalone rake-to-treasury rule in this document.

| Store                       | Role in rake settlement                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `clubs.chip_treasury`       | Existing operational bankroll. Standalone rake never adds to it.                                                   |
| `clubs.chip_pool`           | Separate existing chip store. Rake never adds to it.                                                               |
| `club_wallets.chip_balance` | Existing balance. Rake updates the separate period/lifetime counters without crediting this balance.               |
| `union_wallets.rake_wallet` | Retains rake routed to the union under the existing game-routing rules.                                            |
| `chip_retirement`           | Noncirculating destination for standalone rake. Its immutable journal leg is linked to a burn in `ca_mint_ledger`. |

Cash settlement deducts rake from the felt before routing it. The standalone path journals that deduction to retirement; it must not debit an existing treasury or wallet again. `p_rake` is the rake itself. The separately priced BBJ contribution retains its jackpot route and is not subtracted from the burn or burned a second time.

Tournament rake leaves fee liability through the existing settlement receipt and escrow trigger. Standalone settlement journals `prize_liability -> chip_retirement`; union settlement keeps its existing union credit. Terminal validation accepts the new destination while retaining its other financial and lifecycle checks.

`atomic_distribute_rake` owns cash counters, destination and idempotency. `fn_settle_tournament_rake` owns the event receipt. The legacy TypeScript `logRakeCollection` delegates to the atomic cash transaction. The old two-argument `credit_club_rake_to_treasury` and its deprecated alias cannot establish a hand/event identity and must refuse a new credit.

Historical receipts retain their original meaning. Replaying a hand or event that was already credited must neither credit it again nor retroactively burn it. This forward-only change does not move historical balances, rewrite old journal rows, consolidate existing stores or change funded rakeback obligations.

The migration and isolated tests are implementation evidence, not proof that production has adopted the policy. Publication and native terminal verification must be recorded separately.
