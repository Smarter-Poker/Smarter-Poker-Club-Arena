# A seat already bought is paid in cash, for two satellites (2026-10-03)

Phase 6 of 9 (money edges). Migration `20261003132723_a_seat_already_bought_is_paid_in_cash_for_two_satellites`. Settled under CLAUDE.md 10.9.

## What happened

WASP (`a497dbb8`) bought a seat in Friday Night Feature (`cfcf5abc`, 27.00 + 3.00) with 30.00 of their own SHARK CLUB chips at 18:49 on 2026-09-03. Later that evening they won two heads-up Friday Night Feature satellites (19.00 + 1.00, one 30.00 seat each):

| Satellite | Ended (UTC) | In | Runner-up | Union fee | Left in prize liability |
| --- | --- | --- | --- | --- | --- |
| `0d29dd54` | 22:30:18 | 40.00 | 8.00 | 2.00 | 30.00 |
| `781c8905` | 22:40:24 | 40.00 | 8.00 | 2.00 | 30.00 |

WASP already held the target seat. The seat carried no satellite origin, so the award called it unknown, paid nothing and filed `Satellite.seat_origin_unknown` "needs a human" (alerts `20abe32c`, `2e2ecd9d`). `FeeReconciler.satellite_conservation` then filed twice (`25399c02`, `71b057a7`) for exactly these two events: pool 38, seats 0 of 1, cash 8, one unpaid winner. The 30.00 of each seat stayed in the satellite's prize liability.

This is the railbirdd case of 2026-09-05 on two older events. Migration `20260905195011` ruled that a winner who bought the target seat is paid the seat in cash, and fixed the award so the engine pays it. It could not reach these two events because both were already terminal.

## The settlement

WASP is paid 30.00 per satellite, 60.00 in total, into their SHARK CLUB wallet (the club both buy-ins came from). The money comes from each satellite's own prize liability, so no house or club pays anything new.

Both satellites are COMPLETED and receipted, so nothing may name them: no obligation, no `tourney:` key, and no wallet row or journal leg carrying their tournament id. Per satellite, in one transaction:

1. `fn_ca_adjustment_under_10_9` records the approved adjustment with its paragraph.
2. `fn_ca_declare_ledger` names the counterparty, `prize_liability` of that satellite. The club_members journal writes one leg, prize_liability to player_wallet, in SHARK CLUB.
3. `fn_credit_and_log` credits WASP under the key `satellite-seat-cash:<satellite>:<WASP>`, so a replay pays nothing.
4. The adjustment is settled.

The four alerts close carrying the adjustment ids, keys, journal legs and wallet receipts. The tournaments, their payouts and their evidence are not touched. Nobody else is affected: both runners-up were paid their 8.00 and the union its fee. Nothing is taken back from anyone.

## Proof

The migration asserts its pre-image: the bought seat, each satellite still 40.00 in and 10.00 out, the four alerts open, no credit under either key. It asserts its post-image: WASP's SHARK CLUB wallet moved +60.00, each satellite's prize liability reads 0.00, and WASP carries exactly two journal legs in the transaction. It aborts on any difference and can be run as a rolled-back probe (`ca.seat_cash_probe = on`).

Pinned by `tests/a-seat-already-bought-is-paid-in-cash-for-two-satellites.law.test.ts`.
