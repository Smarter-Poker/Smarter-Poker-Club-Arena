# 2026-10-03 - the database keeps memory headroom

## What happened

Production Postgres (kuklfnapbkmacvwxktbh, PG17, 2XL: 32 GB RAM, 1 GB swap,
`huge_pages_status = off`) stopped three times on 2026-10-03:

| Stop (UTC) | Back (UTC) | What the logs show |
|---|---|---|
| 16:34:31 | 16:36:57 | Postgres logs stop at 16:34:50 with no error, no OOM, no PANIC. Supavisor sees `Authentication timeout after 15000ms` from 16:34:52 (TCP accepted, a backend could not finish starting), then "not accepting connections" (crash recovery) |
| 19:50:00 | 19:50:48 | Logs stop again with no error. Postgres restarts from scratch: `database system was interrupted; last known up at 19:46:48`. A one-off agent `DO` block (pg_cron job 475, a week-quality probe) had been running for 45 minutes and died here |
| 20:18:30 | 21:02:11 | The whole VM stops answering: TCP to :5432 times out, ping fails, WAL is flat, and `/health` reports db UNHEALTHY while the project status still reads ACTIVE_HEALTHY. It did not recover by itself. It came back only after `POST /v1/projects/{ref}/restart` at 20:55:24, which rebooted the VM |

Ruled out: disk (654 GB volume with 212 GB free on /data), lock pile-ups (the
lock waits in the minutes before each stop are at their usual level, and a
lock wait does not stop the host), and connection-limit refusals (Supavisor
saw timeouts, not "too many clients").

## Most probable cause: the VM runs out of memory

Every stop stalls the whole host at once (the log shipper too), and none
leaves a Postgres error, so this is memory exhaustion on the VM rather than
a Postgres fault. The first two stops ended with a process killed and
Postgres recovering. The third thrashed until the VM was rebooted. With
1 GB of swap, Linux can reclaim only page cache, so the host thrashes before
anything is killed.

The measured budget, one minute after the reboot with about 100 backends:
Shmem 8.9 GB (shared_buffers), AnonPages 8.2-10.6 GB, PageTables 1.1 GB,
MemAvailable 11.7-14 GB. Without huge pages, every backend that touches the
8 GB buffer pool can carry up to 16 MB of page tables (max_connections = 380).
On top of that, the configuration allowed:

* `max_parallel_workers_per_gather = 4`. A Parallel Hash's budget is
  work_mem x hash_mem_multiplier (2) x participants. The functions that
  `SET work_mem = '256MB'` (the inventory-seal readers, which also turn
  index scans off) could take about 2.5 GB per hash node.
* `maintenance_work_mem = 2GB`, inherited by `autovacuum_work_mem = -1`:
  3 autovacuum workers, the cron `VACUUM public.hand_history` and every index
  build could each take up to 2 GB.

Supabase keeps no host-memory history that the Management API can reach,
so the exact query that crossed the line on each stop cannot be named after
the fact. The logs show a pile of 60-130 s analytic cron jobs and the
`ca_refresh_hand_player_index` RPC (about 90 s) running together before
16:34 and before 20:18.

## What changed (Management API, `PUT /v1/projects/{ref}/config/database/postgres`, no restart, 21:05:46 UTC)

| setting | before | after |
|---|---|---|
| max_parallel_workers_per_gather | 4 | 2 |
| maintenance_work_mem (and with it autovacuum_work_mem) | 2GB | 1GB |
| log_temp_files | -1 (off) | 256MB (so the next spill names its query) |

Read the overrides back with `GET /v1/projects/{ref}/config/database/postgres`.
To revert, PUT the old values.

The alert `DatabaseNotAnswering` (infra/monitoring/alert-rules.yml) fires once
the engine has not managed one database read for three minutes outside the
break. On 20:18 nothing named the database for 20 minutes, and
`PagerDeliveryFailing` was firing at the same time.

## If it happens again

1. `GET /v1/projects/kuklfnapbkmacvwxktbh/health?services=db`. If it reports
   UNHEALTHY with `Failed to connect` for more than 5 minutes, send
   `POST /v1/projects/kuklfnapbkmacvwxktbh/restart`. A hung VM does not
   restart itself.
2. Read `cron.job_run_details` for runs with `return_message = 'server
   restarted'`. Those are the jobs that were running at the moment it died.
3. Search the Postgres logs for `temporary file` from before the stop.
