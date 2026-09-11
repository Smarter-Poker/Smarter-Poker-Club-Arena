# tests/a-tournament-chip-grant-cannot-mint.law.test.ts

A tournament may never hold more chips on the felt than its roster has bought.
Chips enter a tournament in exactly two ways: a live seat appears holding them,
or an existing seat's stack is raised. The first is forced through a canonical
RPC by `a0_tournament_live_seat_root_guard` and both such RPCs conserve. The
second was ungoverned - that trigger never fires on `UPDATE OF stack` - so
`fn_ca_process_tournament_chip_purchase_money_v1`, the money core behind every
rebuy, re-entry and add-on, raised seat stacks with no conservation check at
all. It now calls `fn_ca_assert_tournament_chip_grant`, which refuses a grant
that would push the live felt past `fn_ca_tournament_chip_supply`, tolerating
an overage it inherited and refusing only growth. The re-entry branch, which
REPLACES the seat stack while the roster gains `rebuys + 1`, is also refused
while the entry still holds chips. `fn_tournament_chip_conservation_check` now
reads the same supply function the guard enforces, so the checker and the
invariant cannot disagree, and `p_tolerance_per_player` is pinned at 1 so that
widening it to quiet an alarm fails CI. Written for `ca_drift_incidents`
8b8fe26c, where two RUNNING tournaments held +10,000 and +2,500 chips that
nobody bought.
