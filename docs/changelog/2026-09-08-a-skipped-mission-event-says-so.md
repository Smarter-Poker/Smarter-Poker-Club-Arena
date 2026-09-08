# 2026-09-08 - the drainer gets headroom, and a skipped event says so

Two follow-ons found by watching production after `20260908030000`, both the
same shape: the pipeline was working and still not telling the truth.

## `20260908031500` - headroom

With the index fixed, each shard cleared ~500-600 events per run at ~25 ms
each, so four shards cleared ~2,000-2,400 a minute against ~2,500 arriving.
Depth held at ~2,400 and the oldest row sat 3-5 minutes back. The 20 s
budget, not the work, was the ceiling. `pg_cron` runs as `postgres`
(statement_timeout 2 min), so the budget is now 45 s - roughly double the
capacity, with ample margin. A run that outlives its minute cannot overlap
itself: the next one fails `pg_try_advisory_xact_lock` and returns 0.

## `20260908032500` - a skipped event says so, and eventually wins

The 250 ms `lock_timeout` from `20260908030000` stops the drainer waiting on a
player who is being seated. The skip it produced was **silent**: the row was
left untouched - same `attempts`, same `next_attempt_at` - so every run
retried it, lost again, and nothing in the table showed it. That is the
failure CLAUDE.md 10.86 names: a signal that answers when it does not know.

Measured 03:12 UTC, four minutes after that migration: one horse
(`2928e6a1` "onyxravenscroft") had **seven events queued since 03:09:05**,
skipped on every run, while a five-minute PostgREST money sweep
(`p_days`/`p_apply`/`p_limit`) held an advisory lock for its whole
transaction. Everything else drained; that player's mission progress simply
stopped, and only a hand-written query found it.

Now a skip increments `attempts`, records the contention in `last_error`, and
pushes `next_attempt_at` by 10 s per attempt (capped at a minute), so
`attempts > 0` is the honest signal it always should have been. And patience
escalates: 250 ms for the first attempts, 3 s from the fourth - longer than
any ordinary holder of that lock - so a row cannot be starved indefinitely.

Live 03:15 UTC. Within one run the starved player's seven events were booked;
at 03:16:48 nothing in the outbox was older than two minutes, depth 1,658
(one minute of arrivals), 25 skips **recorded** with max attempts 1. The
booking path, shard bounds and lock order are unchanged.
