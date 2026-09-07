# 2026-09-07 - one refused bounty pool does not stop the sweep

`ca-bounty-backpay-hourly` failed on every run from 08:12 UTC (14 in a row)
with `fn_finalize_bounty_pool: residual of 2310.00 ... refused (escrow_short)`
for "Sunday Funday High Roller PKO". The refusal is correct - the one payer
holds less escrow for that bank than the residual owed and must not invent
chips - and the payer already raises its own critical alert. The defect was
the sweep: oldest-first, one RAISE aborts the run, every pool behind the short
one stays unpaid for as long as the short one exists.

`fn_backpay_unfinalised_bounty_pools` now attempts each pool inside its own
exception block, reports a refusal once per tournament
(`fn_backpay_unfinalised_bounty_pools` / `refused:<id>`), and moves on. The
payment path is unchanged. Probed rolled-back on production: the old body
aborts, the new body returns `events_refused: 2, chips_refused: 7735` and
would have settled anything behind them. Applied live 21:45 UTC; the live
run returns the same. The two refused pools (7,735 chips of PKO bounty
residual with short escrow) are the chip-standard workstream's open
`fn_settle_tournament_obligation` alerts; this change pays nothing for them
and hides nothing about them.
