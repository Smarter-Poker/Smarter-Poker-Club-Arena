# 2026-09-04 - chip standard Phase 5: escrow becomes a balance

**Branch** `fix/chip-std-phase-5`. Two migrations, applied to production, probed rolled-back first, mirrored byte-exact: `20260904220932_phase_5_1_the_escrow_becomes_a_balance` (22:09 UTC) and `PART_TWO_VERSION_phase_5_1_part_two_the_escrow_goes_live` (inside the 22:55 platform freeze). Law test `tests/the-escrow-is-a-balance.law.test.ts`. Every figure read from production between 21:50 and 23:05 UTC. The epoch reset gate sits between Phase 4 and this phase in the roadmap; it is Dan's event (one-word calls on the historic write-offs) and this phase does not need it: the escrow opens each event from what it really holds.

## What was true

A tournament's money was three counters on the `tournaments` row (`prize_pool`, `bounty_pool`, `total_rake`) that no path was obliged to keep true - the shadow found the prize counter wrong on 1,146 of 1,739 recent events - and one shadow (`fn_ca_tournament_escrow`) that re-derives the truth after the fact from the operational rows every path does write: `wallet_transactions` (entries, rebuys, add-ons, prizes, bounties, refunds), `rake_records` (the fee per entry, written with the entry: 199 of 200 recent events; the satellite seat), the overlay legs in `chip_ledger`, `tournament_payouts` (satellite seats), `tournament_rake_settlements` (the fee leaving). The shadow balanced 589 of 589 asserted events in the last three hours and 900 of 900 today. The settle function's only cap was the prize counter plus five cents; the ledger's own per-tournament identity (`prize_liability` in against out) held for 5,126 of 6,091 completed events in 24h, the rest missing an inflow leg (Deep Stack rake before the counterparty fix, overlays), which is why the balance is fed by the operational rows and not by the journal.

## 5.1 The escrow is a balance

`tournament_escrow`: prize, bounty and fee banks, each derived from its own components on every write (`prize_balance = (gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in - prize_out - refund_prize`; `bounty_balance = bounty_in - bounty_out - refund_bounty`; `fee_balance = fee_entries_in + satellite_fee_in - fee_out - refund_fee`), maintained by six triggers in the same transaction as each operational row, through one door (`fn_ca_escrow_apply`). The rules are the shadow's, applied as the rows land: an entry carries its bounty (a rebuy the rounded bounty, an add-on none); the fee row lands with the entry; a refund is apportioned by the event's own split; a satellite seat is a prize paid in kind; the fee leaves when it settles.

**An event pays only what it holds.** An outflow that would take a bank below zero is refused inside the write that paid it, so the wallet credit and the escrow debit stand or fall together (R1 at the constraint, `P0403 escrow_short`). `fn_settle_tournament_obligation` reads the balance before it credits (`fn_ca_escrow_can_pay`: places and seats from the prize bank, bounties from the bounty bank, a refund from all three) and refuses with `escrow_short` and the balances in the alert; the old counter cap survives only for an event the balance has never seen, which after part two is no event at all, since the first row of any event opens it.

**First sight opens from the shadow.** An event that began before the balance existed is opened from `fn_ca_tournament_escrow` on its first row (the row included, so nothing is counted twice). The live events were opened together with the triggers inside the 22:55 freeze, when the money tables are quiet: creating six triggers on busy tables in one transaction outside the freeze deadlocked against live multi-table writers twice (22:04, 22:09 UTC), which is why the phase is two migrations.

**The close is judged (R5, reported).** Reaching COMPLETED with prize or bounty left files a `settlement_error` incident with the banks; the fee bank settles after close and is not judged there. Holding an event in COMPLETING until it is at zero is engine work, named below. The hourly shadow keeps running and now compares itself to the balance for every event touched in the last hour (`fn_ca_escrow_balance_drift`, appended to the shadow's own cron command), filing on disagreement, so a rule the triggers and the shadow disagree on is an incident, not a silent drift.

**Spins are tracked, not refused** (`enforced = false`): their prize comes from `spin_reserve` by multiplier, not from entries. Their reserve already serialises draws on the pool row and subtracts drawn-but-unsettled prizes from affordability; 0 shortfalls in 7 days over 7,968 draws a day.

Probed, rolled back (22:0x UTC, on a live RUNNING event and a completed spin): opened equal to the shadow; an entry of 10.00 with a 1.00 fee moved prize +9.00 and fee +1.00 through the triggers; a prize the bank could pay went through, one it could not was refused inside the write; the settle function refused an over-balance place with `escrow_short`; a refund apportioned; a spin was tracked and never refused.

## Live after part two

FILLED_AFTER_PART_TWO

## 5.2 and 5.3, named

- 5.2 the spin `pending` sub-balance reserved at draw: the reserve today computes the pending amount from the spin rows at each draw (bounded to 24h) rather than holding it as a column; no shortfall in 7 days. Making it a column is the structural form; the `SPIN_TIERS` rebalance (`|E[m] - 3 x 0.92| < 1e-4`, today 2.7638 vs 2.760, effective rake 7.874% against 8%) is a payout-structure change and stays Dan's (CLAUDE.md 10.9).
- 5.3 satellite tickets as a liability waits on Dan's ruling on unregister and cancel.
- Holding an event in COMPLETING until its banks are zero is an engine change (the close trigger reports today).
- `prize_pool` / `bounty_pool` / `total_rake` stay as counters that every page reads; the shadow reports their gaps. Making them views is a later cut once nothing writes them.
