# 2026-08-15 — The GTO refresh cron was taking the platform down every 10 minutes

Found while building fault injection to drill the freeze watchdog. The engine
started reporting `liveness: dead` with 0 tables and `supabase_timeout` errors —
and the cause turned out to be neither the engine nor my changes.

## What was happening

`sp_refresh_pending_families()` (pg_cron job 39, schedule `*/10 * * * *`)
full-scans `solved_spots_gold` — **62 GB, 8.1M rows** — to count rows where
`strategy_matrix_v2 IS NULL`, grouped by `(game_type, stack_depth)`, caching the
result into `sp_pending_family_cache`. It is a "how many GTO spots still need
solving" dashboard metric. Nothing about it needs to be real-time.

Measured over 24h from `cron.job_run_details`:

```
144 runs (every 10 min)   avg 53.1s   max 128.0s
 69 of them FAILED (48%)
```

While it ran, the database was starved. Measured from the engine host mid-episode:

```
select id from tables limit 1   ->  25.0s (timeout), 19.6s, 12.7s
connect time: 0.002-0.006s      ->  server-side latency, not network
```

The engine's dealing loop hit the 15s Supabase timeout added earlier today,
discovery stalled past 60s, `/health` flipped to `liveness: dead`, and dealing
stopped platform-wide:

**Zero hands recorded anywhere from 20:55 to 21:01 UTC.**

Cancelling the two running backends (`pg_cancel_backend`) restored REST latency
to 0.5s immediately; the engine went from 0 to 38 active tables within a minute.

## Why this matters for the freeze work

A 1–2 minute severe degradation every 10 minutes is roughly **20% of
wall-clock time** with the database under strain. That is very likely a major
driver of the "random freezes" — and it is the exact mechanism the earlier
freeze audit predicted without being able to name:

> "Ten tables dropping out inside a 48-second window is the signature of a
> degrading shared transport, not ten independent logic bugs."

The engine defects fixed today were real and independently worth fixing. This
was the environmental trigger firing them repeatedly.

It also validates two things shipped this morning: the 15s Supabase abort
(which converted an invisible hang into a reported, retryable error) and the
`liveness` field (which is what made the degradation visible at all).

## Fixed live

```sql
select cron.alter_job(39, schedule => '17 * * * *');   -- hourly, was */10
```

Immediate 6× reduction in exposure. Verified: platform recovered and held —
28–69 hands/min across 24–37 tables, DB latency sub-second, host load 0.17.

## The permanent fix — needs a maintenance window

There is already a partial index covering the same predicate:

```
idx_ssg_v2_pending ON (street, game_type) WHERE strategy_matrix_v2 IS NULL
```

but it **leads with `street`**, so it cannot serve `GROUP BY (game_type,
stack_depth)`. The planner falls back to a sequential scan every single run.
Someone attempted this fix and got the column order wrong for the aggregate.

The correct index:

```sql
create index concurrently if not exists idx_ssg_pending_family
  on public.solved_spots_gold (game_type, stack_depth)
  where strategy_matrix_v2 is null;
```

**It must be run via `psql` against the direct connection string.** I attempted
it through the Supabase MCP twice: both `execute_sql` and `apply_migration` wrap
statements in a transaction and time out at 60s, which rolls the build back. The
first attempt also got retried by the MCP, producing two concurrent builds that
collided and left an INVALID 0-byte index stub (dropped). On a 62 GB table this
build takes several minutes; `CONCURRENTLY` does not block reads or writes.

Full instructions, verification queries and stub cleanup are in
`Smarter-Poker-World-Hub/supabase/migrations/20260815_gto_refresh_dos_fix.sql`
(PR #602). Once the refresh is fast, the schedule can safely return to `*/10`.

## Also worth noting

`solved_spots_gold` at 62 GB with 6 indexes is the largest object in the
database by a wide margin. Any full scan of it is a platform-wide event. It is
worth auditing what else touches it — the `authenticator` role was also running
7-second queries against it during the incident, which means user-facing GTO
requests hit the same table.
