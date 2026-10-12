# The Money Checks Read The Diamond Book

**Date:** 2026-10-09

A platform Diamond Arena tournament keeps its money in its own ledger, `poker_diamond_tournament_ledger`: every entry, overlay, prize, bounty, satellite seat and fee is a leg there, and none of it touches `wallet_transactions`, `chip_ledger` or `rake_records`. Five tournament money checks read only the chip records, so Diamond events that had paid out to the last Diamond read as unfunded, unpaid or uncollected, burying any real alert under false ones.

| Check                                                                                                               | False alarms on 2026-10-09                                                             | Now reads                                           |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `fn_tournament_money_conservation` (via `fn_tournament_conservation_delta` and `fn_tournament_conservation_deltas`) | 7 "paid out money it never collected" warnings on Sunday Deep Stack satellites         | The event's Diamond escrow balance                  |
| `fn_payout_guarantee_check`                                                                                         | 97 `earner_not_paid` criticals on 27 events                                            | Diamond prize and bounty legs beside wallet credits |
| `fn_ca_tournament_settlement_mismatch` (ratchet `tournament_underpaid_48h`)                                         | 26 "underpaid" events                                                                  | Diamond prize legs beside wallet credits            |
| `fn_uncollected_entry_check`                                                                                        | 546 seats in one pass                                                                  | A Diamond entry leg as the entry witness            |
| `fn_pay_backed_payout_shortfalls`                                                                                   | Would have read the Diamond Sunday $200 Deep Stack as holding 2,200 of satellite seats | Diamond events are outside the chip sweep           |

Both migrations were proved on production in rolled-back transactions first, then applied (versions 20261009151510 and 20261009151711). Immediately after: the payout check cleared all 97 alerts and raised none, the conservation check closed all 7, the underpaid count fell from 26 to 0 and the entry check reported 0. Non-Diamond events have no Diamond legs, so their arithmetic is unchanged; the conservation scalar and set function agree on every event checked. No money moved.

The rake audit (`fn_rake_bbj_audit`) already read Diamond rake accruals since 20261008144428. It reads zero violations and its own clean-window path closed its 51 open alerts.

Law: `tests/the-money-checks-read-the-diamond-book.law.test.ts`.
