# One visibility rule for every wallet ledger, and the opening baseline pinned

2026-09-01. Branch feat/role-scoped-trade-ledger.

Dan's orders, in his words: the cashier and the club-bank wallet must show
the same record; visibility is decided by role (owners, co-owners, admins
and super agents see everything; agents their own downlines; players their
own rows including an upline moving their chips); the entire funding flow
must exist as a timestamped ledger; and the opening baseline is bank
2,479,000 / spins 20,000 / BBJ seeded 1,000 / backup 0.

Shipped:

1. fn_club_trade_ledger (20260901170424) -- the one server-side answer to
   "which transactions may this viewer see", per the matrix above.
   CashierTradePage now calls it instead of its hardcoded from/to=viewer
   query (the reason a club OWNER saw two rows while the club-bank modal
   showed all 448). Rows where the viewer is neither party render both
   names ("From -> To"), carry no +/- sign, and stay out of the viewer's
   personal IN/OUT totals.

2. The opening baseline (20260901170638): bank exactly 2,479,000, spin pool
   exactly its 20,000 seed, BBJ main seeded 1,000, backup and promo 0 --
   2,500,000 - 20,000 - 1,000 = 2,479,000, pinned in one transaction while
   the floor was already live (249 spins and 66 hands within minutes of the
   green light -- every number on screen was moving with real play).

3. Recorded Deep Stack data migrations from the same session:
   20260901145900 spins+BBJ clean slate, 20260901150816 round two (the
   15:00 settlement sweep had repainted the slate; club_wallets was the
   missing surface), 20260901165657 fee/rake residue wipe (agent counters,
   clubs.total_rake, 558 rake_records, 112 tournament settlements --
   reporting-repair trigger disabled around the delete and the rollup
   rebuilt once), 20260901165751 the green light (all 416 horses released
   through the bench latch).

The complete 448-transaction funding record (owner -> super agents ->
agents -> sub agents -> players, plus 32 self-stakes) is published as a
timestamped ledger page and lives in chip_transactions, readable in-app
through the club bank modal and, with this change, the cashier.
