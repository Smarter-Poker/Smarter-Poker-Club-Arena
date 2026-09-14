# tests/the-diamond-tournament-door-has-a-switch.law.test.ts

fn_poker_diamond_reserve moves real Diamonds out of a real wallet into custody,
and it has two branches. The cash_seat branch was always admitted through
ca_arena_settings.cash_games_enabled, checked inside the same fail-closed
lookup that finds the table. The tournament_entry branch checked nothing at
all: it found the tournament, priced the entry, and reserved.

That was harmless only because nothing called it. No Diamond tournament exists
and poker_diamond_custody holds no rows, so no money ever moved through the
open door. The danger was never the past. It was that the first server code to
call this for a tournament would be admitted, with no switch anywhere to refuse
it, and no way for whoever wrote that caller to notice that nothing was
guarding them. A door that is merely unused is not a door that is shut, and the
switch has to exist before the caller does.

Migration 20260912112311 adds tournaments_enabled, NOT NULL and defaulting to
false, and gates the tournament branch on it in the same lookup that finds the
row, so a chip club, a union-owned tournament, a missing settings row and a
closed switch all arrive as NOT FOUND rather than as four separate checks
somebody can reorder or forget. The price check stays a separate failure,
because "this arena is not open" and "you offered the wrong amount" are
different answers and a caller that cannot tell them apart will retry the one
it cannot fix.

The law reads the migration with its comments stripped, because the header
discusses every string the assertions look for and reading prose as if it were
the rule is the mistake that made three earlier anchors match their own
explanatory comments.

Beyond the presence of the gate, the law pins two things a future migration
could get quietly wrong: that this migration does not flip the switch on in the
same breath as installing it, and that it does not touch the cash switch.
