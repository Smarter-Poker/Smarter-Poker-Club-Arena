# A closed table closes its sessions

2026-09-10. The last root under the cash-session collisions.

`cash_player_session` is opened when a player sits and closed when they leave.
Both paths are correct. **Table teardown is the leak**: a cash table closes, its
seats are removed, its status becomes `closed` - and nothing closes the
sessions scoped to it.

Measured 01:05 UTC: **40 open sessions for players holding no seat on that
table**, 38 of them on tables already `closed`, 29 with no seat rows at all.
Over six hours 657 opened and 497 closed. They accumulate for as long as the
platform runs, and they are exactly what a seat move collides with.

A trigger on `tables` now closes every session scoped to a table on its
transition into `closed` or `deleted`, as `table_closed`, in the same
transaction. No teardown path can forget because the teardown is the trigger.
It fires only on the transition, so a no-op status write does nothing; a seat
move never touches `tables.status`, so it cannot fire; tournament tables never
have a cash session, so there is nothing for it to close there. `table_closed`
is deliberately not routed through the leave path - a player whose game ended
under them did not leave and gets no rejoin bar.

The 40 already orphaned were closed once, with the same reason, shipped with
the cause. Orphans **40 -> 0**, post-condition enforced.

Hardened by `tests/a-session-cannot-outlive-its-seat.law.test.ts`, which pins
the trigger, its transition guard, its index, and both re-point guards from the
earlier fix.
