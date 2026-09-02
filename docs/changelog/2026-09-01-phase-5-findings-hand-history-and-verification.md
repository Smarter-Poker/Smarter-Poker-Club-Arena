# Phase 5 closing report: what hand_history costs, and what is verified live

2026-09-01. Two things this records: an investigation that ends in a decision for
Dan rather than a change, and the post-deploy verification of everything Phases 4
and 5 shipped.

## `hand_history` INSERT: 9% of all database time, and 86% of it is triggers

252,141 inserts at **150 ms mean**, 37,893 seconds of database time. I measured
where that goes with `EXPLAIN (ANALYZE)` on a real insert inside a transaction I
rolled back (CLAUDE.md 11.5):

```
Insert on hand_history (actual time=5.684..5.685)
Trigger hand_history_club_member_stats:   time=19.191
Trigger trg_enqueue_hand_daily_missions:  time=14.823
Trigger hand_history_position_stats:      time=2.155
Trigger hand_history_fold_stats:          time=0.244
Execution Time: 42.202 ms
```

**The insert itself is 5.7 ms. The triggers are 36.4 ms - 86% of the cost**, and
two of them are 34 ms of that.

**A correction to my own earlier note:** I reported "6 triggers on the dealing hot
path". Only **four** fire on INSERT. `trg_ca_capture_hand_facts` and
`trg_log_jackpot_hand_deleted` are BEFORE DELETE and never run when a hand is
written.

### Why I changed nothing here

I looked for the usual culprit and did not find it. **Every lookup these triggers
make is already indexed**, including the per-player `NOT EXISTS` probe back into
`hand_history` (`idx_hand_history_table_handnum`, 133,219 lifetime scans) and all
three upsert targets:

| target                    | index                                          | scans   |
| ------------------------- | ---------------------------------------------- | ------- |
| `club_member_table_state` | pkey `(table_id, user_id)`                     | 267,512 |
| `club_member_daily_stats` | pkey `(club_id, table_id, user_id, stat_date)` | 134,207 |
| `club_hand_daily_shard`   | pkey `(club_id, stat_date, shard)`             | 43,463  |

`trg_hand_history_club_member_stats` is genuinely well built - it upserts rather
than read-modify-writes, and it shards the club counter by `pg_backend_pid() % 16`
specifically to avoid a hot-row. There is no missing index to add and no dead
weight to remove. It is doing necessary work.

### The one thing that is questionable, and it is Dan's call

`fn_enqueue_hand_daily_missions` loops over the hand's players and calls
`enqueue_daily_challenge_event`, which does this **per player, per hand**:

```sql
INSERT INTO daily_challenge_event_outbox (...) ON CONFLICT DO NOTHING;
BEGIN
  PERFORM record_daily_challenge_event(...);   -- the actual work, synchronously
  DELETE FROM daily_challenge_event_outbox WHERE ...;
EXCEPTION WHEN OTHERS THEN ... END;
```

It is an outbox that is written, worked, and deleted inline. The row only
survives if the work throws. Measured today: **135,415 inserts and 135,415
deletes, 0 live rows, 100% dead tuples, 240 autovacuum runs**. Each player also
costs two nested subtransactions (one in the trigger loop, one here).

That is a deliberate durability design - the outbox is what makes a failed
mission event recoverable - so it is not an agent's call to remove. Recorded, not
changed. If the enqueue were genuinely asynchronous (write the outbox, let a
worker drain it) the 14.8 ms would leave the dealing path entirely.

## Verified live, 2026-09-01

| check                                      | result                           |
| ------------------------------------------ | -------------------------------- |
| RLS policies calling `auth.*` bare         | **0** (was 15)                   |
| redundant dead indexes                     | **5** (was 130, all 130 dropped) |
| drop ledger rows / recoverable             | **130 / 130**                    |
| `idx_client_shell_telemetry_user_id` valid | yes                              |
| indexes in `public`                        | 2,909 (was 3,032)                |
| `anon` can execute either guard            | **false**                        |
| `anon` can read the drop ledger            | **false**                        |

### The guard earned its keep within hours

`fn_redundant_dead_indexes()` read **0** immediately after the sweep and reads
**5** now: `idx_trivia_questions_category`, `idx_messenger_conv_labels_user`,
`idx_messenger_blocked_blocker`, `idx_messenger_favorites_user`,
`idx_trivia_user_items_user`. All tiny, all on cold tables, none urgent.

That is the whole argument for a guard over a sweep, and it is the second time
today the estate made it: the Phase 3 definer guard caught a browser-readable
function 49 minutes after shipping.

**A limitation worth stating plainly:** Postgres records no index creation time,
so the guard cannot distinguish "never used" from "created ten minutes ago and
not yet used". A young index will read as dead. This is why the function reports
and never drops - a false positive costs a reviewer ten seconds, not an outage.
The five above were checked against the last twelve hours of applied migrations
and none came from one.

## Still open, both needing a decision rather than a patch

1. **Realtime WAL decode is 13% of all database time** (50,739 s). It is
   dominated by `agent_commissions`, a per-hand ledger with 1.88M writes sitting
   in the `supabase_realtime` publication. Debouncing the client (shipped) does
   not touch it - Realtime decodes and RLS-checks every published record whatever
   anyone is listening to. The levers are removing the table from the publication
   (four subscriptions stop updating live) or rolling the ledger up (a money-path
   change). Neither is an agent's call.
2. **The daily-missions outbox above.**
