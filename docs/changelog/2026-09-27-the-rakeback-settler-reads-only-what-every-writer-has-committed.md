# The rakeback settler reads only what every writer has committed

2026-09-27. Migration `20260927144455`. Law
`tests/the-rakeback-settler-reads-only-what-every-writer-has-committed.law.test.ts`.
Runtime regression in `server/src/services/rakebackWatermark.test.ts`
("the settler reads only what every writer has committed"). Native proof with
real concurrent transactions in
`scripts/ci/test-rakeback-settler-read-horizon-postgres.py` (CI accounting
job, shard 4).

## What was wrong

Fifty-one positive cash `rake_records` sit below the rakeback settler's durable
cursor (`daemon_state.rakeback_settler`, 2026-09-27 14:53:53) with no accrual
batch, no earning source, no source receipt and no retry work. The settler
never submitted them. They were stamped from 2026-09-26 13:38:12 to 2026-09-27
13:18:14, in clusters. Eleven belong to the union's cash tables and forty to a
club outside any union. In the same window 75,470 of the 75,521 cash rake
records of those two clubs were accrued normally.

Only the union's rows were ever noticed, and only indirectly:
`fn_union_rake_basis_refresh` has bounded its snapshot by the settler cursor
since `20260926042119`, so the certified plan refused the open union week with
`union_cash_sources_do_not_match_bank:2` (2026-09-26 21:35) and then `:11`. The
forty non-union rows raised nothing at all.

`RakebackSettlerService` pages `rake_records` by the keyset `(created_at, id)`
and saves the last row it read. `rake_records.created_at` defaults to `now()`,
the writer's transaction START. A hand whose transaction starts at T and
commits at T+6s is invisible to a page read in between; that page reads
later-stamped rows that already committed and moves the cursor past T. When
the hand commits it is below the cursor and no later page can reach it.

Proved on one row: rake_record `4648f9a0` is stamped 04:46:01.270691 with xmin
617358720, and postgres_logs show another backend waiting on transaction
617358720 until 04:46:07.379, so its writer committed about six seconds after
its stamp, inside a lock queue during which four more of the stranded rows
were written.

It began when the settler caught up with the head (2026-09-26 13:19). While it
read days behind, nothing committed late enough to be passed. The first
stranded row is stamped nineteen minutes later.

## What changed

- `public.fn_rakeback_settler_read_horizon()` returns
  `LEAST(now(), start of the oldest open transaction in this database)` minus a
  60 second margin, from `pg_stat_activity`. Any row stamped below it belongs
  to a transaction that has already finished. The margin covers the moment
  between a transaction taking its start stamp and publishing it in
  `pg_stat_activity`; only backends connected to this database count, because
  only they can write `rake_records`. It names no horizon while a prepared
  transaction is open, and the migration refuses to install if
  `max_prepared_transactions` is not 0, if the owner cannot read every
  backend's `xact_start`, or if `rake_records.created_at` is no longer `now()`.
  Read-only, `SECURITY DEFINER`, `service_role` only. The answer names the
  backend that holds it.
- The settler asks for it before each page, adds `created_at < horizon` to the
  one query builder every page uses, and returns `halted` (cursor held) when it
  cannot get one.
- `public.fn_rakeback_settler_stranded_source_check()`, hourly at :28, records
  every positive cash rake record in the four hours below the cursor that has
  none of the four kinds of source evidence into `operational_alert_events`
  (`rakeback-settler-stranded-sources`, one event per rake record, fleet
  `target_task_id`), whatever club it belongs to, and records a horizon held
  for more than 20 minutes (`rakeback-settler-read-horizon`). It writes alerts
  only. On production it would have reported all fifty-one within the hour.

A long-running transaction now makes the settler wait for it instead of
skipping past its rows. An ordinary statement of a few minutes costs nothing
visible; a session left idle inside a transaction is named by the net after
20 minutes and by `fn_settler_lag_check` after 45.

## Not done here

The fifty-one rake records already below the cursor still have no accrued
earning source, and the union week 2026-09-21 will keep refusing until its
eleven do. Submitting them through the settler's own source authority
(`fn_credit_agent_commissions_batch`, idempotent per source) writes
commissions, player stats and period recomputes, so it is settled separately.
