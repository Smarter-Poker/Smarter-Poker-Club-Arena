# 2026-09-07 - the balancer does not move players during the break

`freeze_conserved` kept flipping false a few hours a day (07:00 -454,724;
15:00 +191,292; 18:00 +70,000 chips) on breaks that otherwise froze perfectly:
zero hands, zero buy-ins, zero registrations. Member wallets were identical
at both marks every time; the drift was all on the felt. Reading the 17:55
window: 26 seats created in four running MTTs (571k chips), no seat exits,
no new registrations - the tournament elimination sweep's table-balance step
was moving players between PARKED tables inside the freeze, and a move
caught halfway by the :00 mark counts a stack twice or not at all.

That is a promise broken ("everything just freezes"), a screen that changes
under a player watching a break countdown, and the entire remaining source
of conservation drift. `checkTableBalance()` and `checkDynamicTableExpansion()`
now run only when `isMaintenanceFrozen()` is false; the sweep's next pass
after the thaw balances exactly as this one would have. Pinned in
`theFreezeIsTotal.law.test.ts` (fails on main). 737 tournament tests pass;
`tsc` clean.

Acceptance: `ca_break_scorecards.freeze_conserved = true` on every break with
zero hands, from the first restart carrying this.
