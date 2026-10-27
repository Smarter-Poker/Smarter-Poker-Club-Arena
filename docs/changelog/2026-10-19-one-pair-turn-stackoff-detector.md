# 2026-10-19 - one_pair_turn_stackoff detector

The 2026-10-18 horse audit left 16,832 big losses untagged. A repeated shape
among them was one pair (an overpair or a good-kicker hit) going in on the
TURN, which the existing `one_pair_river_stackoff` (river commit only) did not
name. `one_pair_turn_stackoff` is the same test with a turn commit.

Measurement only, like its river twin: it is in no stack-off tag list, so no
dial or brain load reads it until a league matchup says it should.
