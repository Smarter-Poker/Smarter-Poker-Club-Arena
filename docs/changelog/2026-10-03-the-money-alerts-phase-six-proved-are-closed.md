# The money alerts phase six proved are closed (2026-10-03)

Phase 6 of 9 (money edges). Migration `20261003141247_the_money_alerts_phase_six_proved_are_closed`. Records only: no chips move and no function changes.

## Twenty-nine alerts, each read against production

| Verdict | Count | Alerts |
| --- | --- | --- |
| Settled: the payment exists | 10 | `c9218f6d`, `33991c6b`, `47506cba`, `0a9d77aa`, `bd0bb791`, `092a8ee5`, `84b46569`, `96f552c4`, `ea4f6976`, `7c9622bd` |
| Not short: the guarantee was paid in full | 1 | `cc1fb3cc` |
| Overpay to players, never taken back | 1 | `77bdb12a` |
| Obsolete: the condition is gone | 4 | `3fedee22`, `45e48bee`, `7b4857a4`, `a47b57a2` |
| Satellite conserved, nothing paid twice | 5 | `76922a03`, `d0d749bd`, `7063a4cc`, `f8e50325`, `179ea940` |
| Not player money, or not owed by ruling | 8 | `71b94744`, `de19ec95`, `2849b60d`, `ebec3ad9`, `164c1866`, `f25660dc`, `7d3623ec`, `248ee0b7` |

Each alert closes with its own note naming the payout, ledger leg or receipt that settles it, or the ruling that decides it. The two `FeeReconciler.satellite_conservation` alerts about WASP's satellites close with their payment in `20261003132723`.

Since 2026-10-03 there are 0 open tournament obligations and 0 prize or bounty escrow residuals on any COMPLETED tournament.

## Two adjustment records

- **`04069754` is now settled.** It is the 10x spin runner-up's 2.00 on `6d688095`. Its obligation `fc19154d` was paid through it on 2026-09-09 (0.60 + 1.40), but the adjustment still read `approved`.
- **`41b3c7a0`'s decision note is restated.** It is MamaGia's rejected duplicate. The note now names the adjustment that actually paid her: `d8e908a3` (place 1 of `f7412940`, owed 13,441.68, paid 13,441.68, 2026-09-09 06:03:41).

## Left as it is, by ruling

Midway Union's union-as-a-club scope still holds 1,767 `pending` rakeback periods from 2026-08-10 to 09-06, 280,142.41 in all. Dan ruled on 2026-09-02 (`20260902172302`) that the weeks before 2026-09-07 are deliberately never settled, because they would pay out on the old basis that credited the union-as-a-club. The rows are kept unchanged as the record of that basis.

Pinned by `tests/the-money-alerts-phase-six-proved-are-closed.law.test.ts`.
