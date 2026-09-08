# 2026-09-08 - the outbox drainer uses its index, and never waits on a lock

Two defects in `20260908025000`, both found by watching production for six
minutes after applying it: the outbox depth grew (2,476 -> 3,921), the oldest
row stopped advancing, and every run still reported success.

1. **The shard predicate could not use its index.** The filter was
   `(hashtext(user_id::text) & 2147483647) % p_shards = p_shard` with
   `p_shards` a plpgsql variable; the index is on `... % 4`. An expression
   index only matches a syntactically identical expression, so every run
   sequentially scanned the outbox. The bounds are now inlined through
   `EXECUTE format(...)` (with `p_shards` validated against an allowlist
   first, so nothing user-supplied reaches the SQL text). Measured: seq scan
   -> `Index Scan using idx_daily_challenge_event_outbox_shard_due`, 7.4 ms.

2. **A run could wait minutes on one player's lock.** The drainer takes
   `fn_lock_daily_mission_user` before booking, and so do horse seating
   (`fn_seat_horse_in_seat_first_game`, per `20260906152850`) and the
   tournament-registration trigger, which run constantly. An advisory
   transaction lock has no timeout, and the 20s budget is only checked
   between events - so the 02:52 runs took **1m44s**. The drainer now sets a
   250 ms `lock_timeout` for its own transaction; a contended player's event
   is skipped by the existing per-event subtransaction and booked on the next
   run. The lock ORDER is unchanged, so `20260906152850`'s guarantee holds.

Live since 02:56 UTC. The 3,900-event backlog cleared to **0** within two
minutes; runs finish in under a second at rest. Through the 02:55 maintenance
break - the worst case, when the whole fleet resumes at once - depth peaked at
1,150 and drained to 521 in the next run, with runs at 9-16 s inside the 20 s
budget. Conservation over five minutes across the break: hands emitted 7,535
events, 6,650 receipts were booked and ~712 were still queued. Nothing
dropped, 0 retries, 0 dead-lettered.
