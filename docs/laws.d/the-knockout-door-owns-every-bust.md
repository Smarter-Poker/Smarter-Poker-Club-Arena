# tests/the-knockout-door-owns-every-bust.law.test.ts

A bust an accepted hand took belongs to the engine's knockout door, which
assigns the finishing place in the same transaction as the status. No sweep may
write that roster row: both retired bust sweeps refuse any player whose latest
knockout candidate is not `rebought`, and an eliminated row with no finishing
place cannot be written into a RUNNING, COMPLETING or COMPLETED tournament at
all - the constraint trigger is DEFERRED so the finish normalizer's
clear-then-assign and a cancellation's flip to CANCELLED still pass inside
their own transaction. The two sweeps keep an INACTIVE cron row rather than no
row, because the unapplied retirement chain 20260910000850 captures exactly two
and would abort on none. The engine keeps gating its bust stage on the reprice
proof, and reports a refused proof with its mismatch count, because that is
what made the stall visible.

The check itself is DEFERRED, and a deferred constraint trigger is handed the
tuple its firing statement produced - not the row as it commits. It therefore
RE-READS the row it is judging; judging NEW refused five satellites whose
settlement writes the status first and the finishing place second, on rows that
were about to be correct.
