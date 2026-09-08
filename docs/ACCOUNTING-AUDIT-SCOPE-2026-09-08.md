# Accounting Audit Scope And Acceptance

All rows below are required scope. Shared trigger hardening is not completion of the callers that use it.

| Area                  | Paths To Trace                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cash games            | Buy-in, rebuy, add-on, pot and side-pot settlement, split boards, uncalled returns, insurance, departures and cashout                                  |
| Rake attribution      | Each hand and player's weighted contribution, rake caps, rounding, hand history and rake records                                                       |
| Rake distribution     | Union to club to super-agent/agent/sub-agent to player; commission/rakeback entitlements, rates, margins, settlements and payment receipts             |
| BBJ                   | Hand contribution, main bank, backup bank, promo bank, split residues, internal transfers, triggers, recipient allocations and payouts                 |
| Cashier               | Send, take back, reversal, cashout request/approval/release/cancel, escrow, tickets issued/transferred/redeemed/cancelled/refunded                     |
| Tournaments           | MTT, rebuy/re-entry/add-on, guarantees, satellite seats/cash substitutes, ordinary bounty, PKO and mystery bounty, all final/partial/cancelled payouts |
| Short formats         | Spins and Sit & Go buy-ins, prize reserves, multipliers, rake, payouts, cancellations and refunds                                                      |
| Treasury and union    | Every bank, reserve, promo/insurance wallet, union-to-club and intra-wallet transfer, owner/agent allocation                                           |
| Issuance and diamonds | Authorized chip mint/burn and diamond debit/credit/spend/refund/reward/exchange; explicit source and asset conversion records                          |
| Reporting             | Ledger-derived balances and histories, rake/BBJ attribution versus actual payments, outstanding liabilities and incident classification                |

For each operation, verify the caller's identity and scope, exact asset and precision, authorized source, locked balances, destination/escrow/entitlement, balanced journal, stable operation identity bound to its payload, commit receipt, concurrent retries, lost responses, crash boundaries, and end-to-end UI/engine wiring.

Cash chips, tournament play chips, diamonds, ticket entitlements and attribution statistics are different quantities. Each must be conserved or changed by its explicitly authorized issuance/redemption rule; reporting must not add unrelated assets or treat a statistical rake credit as a second cash payment.

Confirmed and addressed so far: eight journal functions that swallowed posting failures; satellite awards that survived transfer/receipt failure or short funding; promo client retries that generated a fresh payment identity; cashout escrow counterparties and receipt rollback/replay boundaries; duplicate hand-roster conservation and new hand-receipt payload binding; union close calendar alignment and overlapping-period prevention. Their individual changelogs contain tests and deployment status.

Open structural findings: cash-hand stacks, rake and BBJ still use separate transactions; stack-settlement failure responses can be discarded by callers; horse funding retry identities and ambiguous responses need alignment; wallet and cashier replay receipts require payload-binding review; legacy global-wallet transfer wiring needs review; historical incident families have not all been traced to a verified correction.

No global completion claim is made by this document.
