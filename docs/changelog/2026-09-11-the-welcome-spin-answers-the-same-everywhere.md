# The welcome spin answers the same everywhere

**2026-09-11. Dan: "Before you move onto phase 3 of 6, you need to do a deep
dive and verify that everything you've built in the previous phase is 100% fully
built, coded, wired in and tested."**

Three ways the welcome spin disagreed with itself. Two are mine from phase 2.
One has been there since the feature was built, and phase 2 walked past it.

## The entry read asked a different question from the door

`fn_diamond_games_entry` said the welcome spin was ready whenever

    welcome_budget_chips > the welcome spend in the window

while `fn_wheel_spin_core` and `fn_wheel_welcome_state` require

    spend + the biggest prize on the table <= welcome_budget_chips

because a welcome spin is the whole wheel or it is not offered.

A probe on production made the gap concrete. With a top prize of 50 chips and a
budget of 49.99, the entry read answered `welcome_spin_ready = true` while the
page said `pot_empty` and the door refused with "The Welcome Spins Here Are Gone
For Now". `DiamondsToChipsButton` reads that entry, so the club lobby, the
wallet, the cash buy-in and the tournament sign-up were all showing a player a
welcome spin that the fifth surface would not honour.

Three copies of one rule is what caused it, so there is one copy now.
`fn_wheel_welcome_room` returns the spend, the top prize and whether the window
is open, and the core, the page and the entry read all call it. The top-prize
arithmetic was written out twice in the phase 2 migration alone; it is written
once.

## The operator console could not see its own switch

`fn_wheel_state`'s config payload never carried `welcome_spin_enabled`. Not
since phase 2 renamed it, and not before that under its old name either. The
operations page reads `cfg.welcome_spin_enabled`, so it read `undefined`: the
pill said Off whatever the switch was actually set to, and "Turn It Off" posted
`enabled = NOT false = true`, so the welcome spin could never be turned off from
the console at all.

## And it could not see the window, which was worse than cosmetic

`welcome_budget_period_days` was not in the payload either, so the Budget Window
field added in phase 2 always showed the 30 day default. The console posts the
budget and the window together, so an operator who had set 7 days, came back,
and saved a budget change would have silently put their window back to 30. A
blank field is a gap; a field that writes a value the operator never chose is a
defect.

## Verified

The bug probe ran against production before anything changed and reproduced all
three. The fix probe runs on both host shapes and asserts, at three budget
levels each (unfunded, room but not for the top prize, comfortably open), that
the entry read, the page, the helper and the door give the same answer, and that
the door's outcome matches what the four player surfaces were promising. It also
asserts the console reads the switch both ways and reads a window of 7 as 7, and
that exactly one function in the database still writes out the top-prize
arithmetic.

Re-run afterwards, the bug probe reports `welcome_spin_ready = false` in
agreement with the page and the door, and both config keys present.
