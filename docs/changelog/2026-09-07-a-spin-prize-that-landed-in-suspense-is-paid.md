# 2026-09-07 - a spin prize that landed in suspense is paid, and the audit learns what a spin owes

## The settlement (10.9)

"20 Chip Deep Stack Spin PLO5" (0ec5d7b2) ended 22:03:55 UTC with its champion,
horse b474bb12, owed 100.00 and paid nothing: the one payer refused with
`escrow_short` ("the escrow holds 0.00 for that bank"). Read from rows:
fn_spin_settle_game drew a 5x at 21:48:30 and debited the club's spin reserve
by 100 (spin_reserve_ledger jackpot_draw -100), but the auto-ledger's primary
INSERT of that leg (spin_prize -> prize_liability) was rejected - the reason
is not recorded anywhere - and its fallback wrote `adjustment` spin_reserve ->
settlement_suspense. With the category changed, `zz_ca_escrow_reserve_leg`
never credited the tournament escrow (reserve_in stayed 0). The 100 chips left
the reserve and reached nobody. The only such case in seven days.

Migration `20260907224500` posts the correction leg (settlement_suspense ->
prize_liability, 100.00, the same precedent the chip-standard workstream used
on 2026-09-06), credits the escrow with `fn_ca_escrow_apply(reserve_in 100)`,
and pays the place-1 obligation through `fn_tournament_payout_reconcile` /
`fn_settle_tournament_obligation` - the one payer, idempotent on the
obligation row. Proven rolled back first (escrow 0 -> 100, wallet 14,146.60 ->
14,246.60), then applied with those numbers asserted. Eight alerts resolved
with the resolution note. Nobody paid twice, nothing taken back, no wallet
row hand-written.

## The false positive (34 alerts)

`FeeReconciler.prize_disbursement` had raised PRIZE_DISBURSEMENT hourly for 24
hours for a 1-chip 10x spin: "pool 3, disbursed 10, excess 7". A Spin pays
buy_in x multiplier from the spin reserve; its `prize_pool` column is the
buy-ins. Migration `20260907225000` makes the audit use the advertised prize
for spins (the engine's rewrite of prize_pool to the drawn prize is no longer
what the audit depends on). All 34 alerts resolved as false positives.

## Root cause, filed, not fixed here

`fn_ca_autoledger` swallows the reason a leg was rejected and falls through to
`adjustment` -> `settlement_suspense`. A rejected PRIZE leg must raise a
financial alert naming the SQLSTATE and the tournament, so a champion is
never silently unpaid. `settlement_suspense` carried 1,776 legs / 672k chips
today alone (adjustment and rakeback categories) - the chip-standard
workstream's open problem; see the issue filed with this changelog.

## Still open in the alert table (chip-standard workstream)

- Sunday $200 Deep Stack: two places short 180.00 each (escrow bank short).
- PLO4 Heads-Up 25: 71.25 refused, escrow 0 for that bank (same shape as the
  spin above - a heads-up prize leg that never reached escrow; not settled here
  because I did not read its rows).
- Sunday Funday High Roller PKO: 5,425 + 2,310 bounty pool unpaid (escrow
  short - the pools the backpay sweep now skips instead of aborting on).
- Sunrise / Midnight Bounty: 10.00 / 24.00 bounty residue.
