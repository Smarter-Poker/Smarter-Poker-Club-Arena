# 2026-09-08 - Phase 8, part 2: a hand is recorded in milliseconds

`INSERT INTO hand_history` measured 502 ms (EXPLAIN ANALYZE of a real cash
hand row, rolled back, 02:40 UTC). The row and its eleven indexes cost 7 ms.
The triggers cost 495 ms:

| trigger                           | before     | after       |
| --------------------------------- | ---------- | ----------- |
| `trg_enqueue_hand_daily_missions` | 280 ms     | **2.5 ms**  |
| `trg_ca_stats_live_from_hand`     | 125 ms     | 27 ms       |
| `hand_history_club_member_stats`  | 82 ms      | 6 ms        |
| fold / position stats             | 9 ms       | 14 ms       |
| **total insert**                  | **502 ms** | **51.7 ms** |

At ~530,000 hands/day this chain was more than one of the database's two
cores, permanently - the saturation under the hourly crons timing out, the
8s PostgREST cap and the daily deadlocks. `hand_history` INSERTs were the
second-largest consumer in `pg_stat_statements` since 09-02 (~8,850 minutes).

The missions trigger called `enqueue_daily_challenge_event` synchronously for
every player: their Daily Missions advisory lock (which also locks the
profiles row), an outbox insert, two `SELECT ... FOR UPDATE`, a receipt insert
into a 4 GB / 12.3 M-row table, the challenge bumps, and the outbox delete -
40-360 ms per player on cold pages. It is also why a hand insert deadlocked
against horse seating 12 times a day until `20260906152850` re-ordered the
seating function around it.

Now the trigger writes the outbox row and returns.
`fn_drain_daily_challenge_event_outbox` - the consumer that has run every
minute since the pipeline was built, for retries - books every event through
the same `enqueue_daily_challenge_event`, so the idempotency contract
(receipt per event key, payload equality, 35-day horizon, dead-lettering) is
untouched. It gains a 20s budget, four hash shards by user (a user's events
always land in one shard, in order, so per-user progress stays serial), an
index for the shard predicate, and a per-event subtransaction so one
contended lock skips one event to the next minute instead of aborting the
shard's run.

Live since 02:47 UTC: the 2,699-event backlog drained to 1,144 in 30 seconds;
each shard finishes its minute in 7-11 s; 0 dead-lettered, 1 retry.
A player sees mission progress within about a minute of the hand instead of
at the instant it ends. Horses and humans are booked identically (10.5). Not
a repair job (10.12): the outbox and its consumer are the pipeline's own
design; this moves the primary path onto them.

Next: `trg_ca_stats_live_from_hand` and `hand_history_club_member_stats`.
