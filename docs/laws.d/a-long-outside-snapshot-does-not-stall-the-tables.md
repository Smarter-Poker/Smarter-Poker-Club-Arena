# tests/a-long-outside-snapshot-does-not-stall-the-tables.law.test.ts

No outside session holds the database's snapshot horizon long enough to stall
the tables. On 2026-10-06 a full data export logged in as `postgres` held one
snapshot for 32 minutes; with the xmin horizon pinned, hand settlement on two
~350-player tournaments slowed past the 8 s statement timeout (1,010 timeouts
inside settlement, no lock waits inside it), the tournament lanes queued behind
the slow holders, and the jam ended the minute the export was cancelled.
`public.fn_ca_bound_outside_snapshots`, run every minute, cancels a running (or
terminates an idle-in-transaction) non-superuser postgres-member or
`supabase_read_only_user` session holding a snapshot past five minutes, spares
pg_cron and the migration appliers (mgmt-api, apply-recorded-migration,
antigravity-sql-push:\*), and logs each action in
`smarter_private.ca_long_snapshot_cancellations`. The law pins every filter
clause, the default bound and its range, cancel versus terminate, the log,
privileges, the schedule and its stated reason, and the disposable-cluster proof
that a pinned horizon keeps every dead version and the bound releases it.
