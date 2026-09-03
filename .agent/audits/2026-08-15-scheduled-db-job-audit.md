# 2026-08-15 — Audit of every scheduled database job

Follow-on from finding that the GTO refresh cron was taking the platform down.
If one scheduled job could do that, the rest needed checking.

Method: `cron.job` joined to `cron.job_run_details` over 24h, ranked by TOTAL
database time consumed rather than by frequency — the metric that actually
predicts starvation.

## The ranking is extremely lopsided

| job                             | schedule | ok  | failed | avg   | max   | **total 24h** |
| ------------------------------- | -------- | --- | ------ | ----- | ----- | ------------- |
| **sp_refresh_pending_families** | \*/10    | 74  | **69** | 79.8s | 128s  | **11,409s**   |
| training_leaderboard_refresh    | \*/5     | 267 | 21     | 2.3s  | 44.0s | 653s          |
| home-trending-refresh           | \*/15    | 83  | 13     | 5.5s  | 44.0s | 526s          |
| pnm-locations-refresh           | \*/30    | 43  | 5      | 6.6s  | 44.0s | 317s          |
| home-game-reminders-6h-1h       | \*/15    | 87  | 9      | 2.4s  | 43.9s | 232s          |
| resolve-friend-challenges       | \*/15    | 84  | 12     | 1.9s  | 44.0s | 179s          |
| _(everything else combined)_    |          |     |        |       |       | <45s          |

**3.2 hours of database time in a single day**, from one job — 17x the next
worst and more than everything else on the platform put together.

## The 44-second tell

Five unrelated jobs all peak at exactly ~44.0s. That is not a coincidence and
not their own work — it is the shared symptom of being blocked behind the same
saturation event.

Correlating failure timestamps against the GTO job's run windows:

```
job                            failures   during a GTO run   % explained
pnm-locations-refresh              5              4              80%
mlb-hr-cache-refresh               1              1             100%
cleanup-hole-cards                 1              1             100%
training_leaderboard_refresh      21              7              33%
home-trending-refresh             13              4              31%
resolve-friend-challenges         12              4              33%
home-game-reminders-6h-1h          9              3              33%
```

24 of 63 failures (38%) landed inside GTO run windows, which occupied only ~13%
of wall-clock time — a **3x over-representation**. One job was failing runs
across six unrelated subsystems, including `cleanup-hole-cards`, which is
poker-critical.

## Failure messages — three distinct problems

```
71  "job startup timeout"                        (8 distinct jobs)
58  statement timeout on the GTO temp table      (job 39 itself)
 1  function public.archive_old_arena_logs() does not exist
```

1. **"job startup timeout" x71** — pg_cron could not start a worker in time.
   This is the saturation symptom, not a bug in those jobs. Should resolve now
   that the GTO job runs hourly.
2. **58 statement timeouts** — the GTO scan exceeding the statement timeout,
   i.e. the job failing at its own work roughly half the time. It was burning
   2 minutes of database capacity to accomplish nothing.
3. **`arena-log-archival-nightly` (jobid 1) has NEVER worked.** It calls
   `public.archive_old_arena_logs()`, which does not exist in any schema. It has
   errored every night since creation. The arena log tables turned out to be
   tiny (136 kB / 32 kB) so nothing grew unbounded — but a permanently-failing
   job is worse than no job: it trains everyone to ignore cron failures, which
   is precisely how 69 real failures a day went unnoticed.

## Applied live

```sql
select cron.alter_job(39, schedule => '17 * * * *');  -- hourly, was */10
select cron.alter_job(1,  active   => false);         -- broken since creation
```

Verified after the change — the 21:17 run **succeeded** in 92.6s, where the
preceding five 10-minute runs had mostly failed at 98-125s.

## Still open

**The GTO index remains the real fix.** Even hourly, that job holds the database
for ~93 seconds. The correct partial index is documented in World Hub PR #602
and must be built with `psql` outside a transaction (the Supabase MCP and SQL
editor both wrap statements and roll the build back at their 60s timeout).

**Missing time indexes on two large write-heavy tables:**

| table                  | size              | indexes                                   |
| ---------------------- | ----------------- | ----------------------------------------- |
| `data_audit_log`       | 948 MB, 362k rows | primary key ONLY                          |
| `hand_state_snapshots` | 4.8 GB, 1.2M rows | pkey, table_updated, one-active-per-table |

Neither has an index on `created_at`. A simple `min(created_at), max(created_at)`
on `hand_state_snapshots` ran for 70 seconds before I cancelled it. That means
any retention or pruning job against these tables is a full scan — the exact
shape of the problem that caused today's outage. If retention is ever added,
add the time index first.

**Table size ranking**, for context on where the risk lives:

```
solved_spots_gold      62 GB    8.1M rows   <- any full scan is a platform event
hand_history          9.8 GB    5.7M rows
hand_state_snapshots  4.8 GB    1.2M rows
data_audit_log        948 MB    362k rows
```

`solved_spots_gold` is 6x the next largest object. It deserves a standing rule:
nothing may sequentially scan it on a schedule. It is also hit by the
`authenticator` role (user-facing GTO requests were running 7s queries against
it during the incident), so it is not only a background concern.
