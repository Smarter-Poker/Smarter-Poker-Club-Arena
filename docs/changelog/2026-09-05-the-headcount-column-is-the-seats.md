# The headcount column is the seats

2026-09-05

Migration `20260905202112_the_headcount_column_is_the_seats` (applied 15:08).

22 open tables with a seated player painted `current_players = 0`. The engine
writes that column only when it loads seats in order to deal, and a table with
one player has no dealer, so the column was never written and the table read as
empty on every per-table surface.

RECONCILE inside `fn_cash_cluster_tick` now sets `current_players` to the live
seat count for the game's open tables wherever the two differ, so the column
follows the seats every tick instead of only when a hand starts.

The game card was already correct - `cluster_players` counts seats rather than
reading this column - which is why the discrepancy was visible on a table row
and not on the card above it.

## Why this is its own file

The paragraph above was first written into
`docs/changelog/2026-09-05-the-break-counts-orbits-not-only-minutes.md`, whose
earlier sections had already shipped in #3172. Appending to a file that is
already on `main` gave the Silent Revert Guard an append-only patch it could
not prove had survived, and it reported the branch as reverting #3172 - the
conservative tier-3 case the guard's own header describes. The content of the
older file is left exactly as `main` holds it. Two files written independently
cannot conflict, which is the same reason section 10 rule 9 of CLAUDE.md asks
for one changelog file per piece of work.
