# tests/a-hand-that-ended-preflop-has-no-board.law.test.ts

`fn_rake_law_violations` decides a cash hand's board is MISSING, which makes the
hand's rake unverifiable (`allowed` is NULL, so it is excluded from `over_spec`
and `under_spec` too). Until 2026-09-21 it decided that with
`board_n = 0 AND (has_showdown OR agg >= 4)`, where `agg` counts every call,
raise, bet and all-in. That second disjunct is a proxy for "a flop must have
been dealt" and it is not one: an ordinary multiway preflop pot clears four
aggressive actions without a card on the table. Measured over all 61 hands the
finding ever filed, 0 took rake, 0 took a BBJ drop, 0 reached a showdown and 0
had any action on a street after preflop - a 100% false-positive rate, which
reached the board's 25-incident storm cap and gave a genuine over-rake from the
same source somewhere to hide. Every action the engine writes already carries
its street, so `20260921023500` replaces the head-count with the record:
`played_past_preflop` reads `stage`/`street` off the actions, `has_showdown` is
kept because no variant shows down on an empty board, and `streets_unreadable`
is added so a record whose streets cannot be read is reported as the evidence
gap rather than passed as "ended preflop" (law 10.86 rule 1: absence of a stage
is not absence of a flop). The forward guard is that no later migration may
reinstate a count of aggressive actions as the test for a missing board, and
that the two genuine detections must survive, because the change that makes the
warnings stop is deleting the finding and the change that fixes it is reading
the street.
