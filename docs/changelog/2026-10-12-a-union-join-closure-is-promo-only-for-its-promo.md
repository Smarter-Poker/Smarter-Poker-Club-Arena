# A Union Join Closure Is Promo Only For Its Promo Part (2026-10-12)

## What Happened

At 04:06 UTC Deep Stack Society joined the Midway Union (migration 20261012040553). `fn_close_club_wallets_on_union_join` closed the club's BBJ pool into its main bank as one `chip_transactions` row of type `bbj_promo_sweep`: 68,795.45 = main 42,734.14 + backup 26,061.31 + promo 0.00. It uses that type on purpose, so `fn_bbj_conservation_check`, which balances the whole pool, counts the closure as an outflow.

`fn_bbj_promo_bank_check` balances the promo bank alone and read every `bbj_promo_sweep` row as promo. From 04:52 UTC the conservation sweep reported 75,500.66 over-swept (64,360.31 unexplained, incident 56a3d34c): exactly the 6,705.21 pre-triple-bank gap the check already explains plus the 68,795.45 closure. `fn_bbj_promo_facts`, which shows an operator a pool's promo swept all time, read the same row the same way.

## Fix

Migration `20261012113912_a_union_join_closure_is_promo_only`: both promo readers count a `union_join` closure by its own `bbj_promo` amount. Every other sweep row, and the whole-pool check, are unchanged. No chip moved and nobody is short: the closure was right, only its promo reading was wrong.

## Proof

The migration's own proof requires the promo bank to reconcile. Live result: over-swept 6,705.21, explained by the pre-triple-bank era (11,140.09), unexplained 0, reconciles true.

Law: `tests/a-union-join-closure-is-promo-only-for-its-promo.law.test.ts`.
