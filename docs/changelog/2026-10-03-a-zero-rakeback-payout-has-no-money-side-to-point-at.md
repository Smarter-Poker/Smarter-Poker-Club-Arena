# A zero rakeback payout has no money side to point at (2026-10-03)

Phase 6 of 9 (money edges). Migration `20261003135041_a_zero_rakeback_payout_has_no_money_side_to_point_at`, live as schema_migrations `20261003140647`.

## What was wrong

`fn_ca_settlement_correctness_check` re-filed incident `d88f0566` every hour from 2026-10-02 06:15 (28 sightings): "rakeback marked paid with no linked wallet transaction". It named period payout `e7f0b9bc`.

That payout is 0.00. A SHARK CLUB player's rake contribution was 0.08, and 5% of it is 0.004. The routed rakeback stage writes one `paid` row per certified period and moves chips only when the amount is above zero, so a 0.00 row never has a wallet transaction. It is the only such row among 5,362 paid payouts; every payout above zero carries its pointer. Nothing was owed and nothing was missing.

## What changed

The evidence check now asks only a payout (`payout_amount > 0`) or a transfer (`rakeback_amount > 0`) that moved chips for its pointer. Every other check in the function is unchanged. The redefinition is declared to the guard watch in the same transaction.

The incident was resolved with its root cause. The settler-lag incident from 2026-10-02 was resolved at the same time: the stall was fixed at the source that day by #5864 and #5870, and the settler has read healthy since (lag 0.34 h at 13:47 on 2026-10-03).

Pinned by `tests/a-zero-rakeback-payout-has-no-money-side-to-point-at.law.test.ts`.
