# A Waiting Tournament Table Is Not A Zombie

Production was rebuilding tournament tables which were healthy but had only
one dealable player. The global reaper obtains cash seat counts from a
cash-only discovery RPC. Its tournament fallback was therefore the ownership
bit itself: every manager-owned table was classified as “should be dealing,”
regardless of whether a legal hand could start.

That makes a one-player heads-up, Sit & Go, Spin, or broken MTT table repeat the
same cycle forever: wait for a second player, cross the 180-second no-progress
threshold, emit `tournament_table_zombie`, tear down the live engine and its
socket room, reconnect, and wait again. On 2026-09-08 the production engine
emitted 85 of those kills in five minutes while `/health` identified the rows
as `start_wait_for_players` with one dealable seat.

The reaper now uses the engine's own `dealableCount() >= dealThreshold()`
predicate for every format. This is the same live-seat generation and threshold
used by the dealing loop and liveness endpoint. Ownership still determines who
may replace a genuinely stalled tournament table; it no longer pretends that a
table has enough players to deal.

The regression law rejects any return to an ownership-bit fallback and pins the
single live-seat predicate at the reaper boundary.
