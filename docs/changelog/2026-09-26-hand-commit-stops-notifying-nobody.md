# 2026-09-26 - A hand commit stops notifying nobody

## What the brownouts were

The morning's fleet quarantines (04:45, 07:10-07:13, 07:34-07:36, 07:45,
08:05, 08:40 UTC) share one shape, read from Postgres, PostgREST and edge logs:

1. **Spark: IO stalls.** Checkpoints write ~1 GB of WAL-driven dirty pages every
   five minutes. The 07:11:32 checkpoint reports `sync=26.5 s` (longest file
   3.0 s), the 07:16:24 one `sync=20.5 s`. While the volume is saturated a WAL
   flush takes hundreds of milliseconds instead of a few.
2. **Amplifier: two platform-wide serialization points held across a commit.**
   - The **NOTIFY lock**. `z9_notify_hand_projection_outbox` (20260910052523)
     called `pg_notify` from every hand's outbox insert. Postgres takes one
     cluster-wide lock for any committing transaction with a queued
     notification and holds it through the WAL flush, so every hand commit in
     the fleet committed one at a time. 04:00-09:00: **2,754 PostgREST
     `COMMIT`s waited > 1 s** for it (`log_lock_waits`, deadlock_timeout 1 s),
     p95 up to 5.2 s, max 5.6 s; 720 of them in 07:45-07:50 alone.
   - The **global hand-number advisory lock**
     `hashtextextended('f06:global-hand-number-allocation',0)` in
     `smarter_private.f06_allocate_number_above`, taken by every
     `fn_f06_allocate_hand_number` / `fn_next_hand_number` call. 864 waits > 1 s
     in 07:20-07:35 alone; the waits cap at ~2 s. It spikes in exactly the same
     buckets as the NOTIFY lock (07:25: 420 vs 386; 07:45: 727 vs 720).
3. **Victim: the shared PostgREST pool.** Every waiter holds a PostgREST
   connection. Statement timeouts (57014) run 100-600 per five minutes, led by
   `fn_ca_resume_hand_submission` (378 in 07:00-08:10) and
   `fn_ca_process_hand_post_commit_obligations` (311). Lease heartbeats ride the
   same pool because `ENGINE_PG_LISTEN_URL` is not set, so the heartbeat waits
   behind hand commits, the proof lapses, and the managers are fenced.

PostgREST schema reloads from sibling migrations (07:04, 07:21, 07:33, 08:10,
08:17, 08:33; 3-10 s schema queries each) land on top of this; 07:33:44 is the
reload immediately before the 07:34:50 brownout.

## Who listens on `hand_projection_outbox`

Nobody. The only intended consumer is the engine's LISTEN session
(`server/src/services/supabase/handOutboxListener.ts`), which opens only when
`ENGINE_PG_LISTEN_URL` is set. Measured 09:04 UTC:
`poker_hand_outbox_listener_enabled 0`, `_connects_total 0`,
`poker_hand_projection_wakes_total{source="listen"} 0` (poll 67, startup 1),
and `pg_stat_activity` held exactly one `LISTEN` in the database, PostgREST's
own `"pgrst"`. The trigger's payload was documented as "never consumed". Its
migration said a notification with no listener is "dropped at commit for
free"; in Postgres the lock is taken regardless, and PostgREST's `pgrst`
listener means the entry is queued too.

## The fix

`20260926090827_hand_commit_stops_notifying_nobody` detaches the trigger in one
transaction with `lock_timeout 3s`, refusing if any session is `LISTEN`ing on
the channel or the trigger's definition differs from the one measured. The
function stays (its md5 is pinned by 20260918092329 and a CI probe). The
projection worker keeps its in-process commit wake, 5 s poll and resync wake,
and always re-reads the outbox ordered by `hand_number`. No engine release is
needed.

Law: `tests/a-hand-commit-never-takes-the-notify-lock.law.test.ts` replays the
migrations and refuses any notifying trigger left on the table; with the
migration removed it fails (4 of 5), and it catches both a re-attach and a new
notifying trigger.

## Named, not changed here

- **Global hand-number lock.** Serializes every hand start platform-wide and is
  held until commit. Owned by F06 hand numbering; the fix is to release the
  lock as soon as `setval` is done (sequence operations are non-transactional)
  or to take it only when `nextval` falls below the floor.
- **Longest PostgREST holders** (pg_stat_statements since 2026-09-10):
  the club rakeback period RPC (`p_club_id`, mean 5.3 s, max 220.8 s - it sets
  its own timeout; the rakeback sibling owns it), `atomic_table_buyin` (mean
  2.06 s), `fn_eliminate_tournament_player_atomic` (mean 1.68 s, 283,093 s
  total), `fn_horse_committed_observation_snapshot` (mean 1.48 s),
  `fn_ca_commit_hand_settlement` (670,086 s total, max 31.9 s).
- **IO pressure behind the checkpoints**: four `daily-missions-outbox-minute`
  shards every minute (mean 5-6 s each), `sp_prune_hand_history_10m` (mean
  34 s), and the hourly checks that run into their 120 s timeouts.
