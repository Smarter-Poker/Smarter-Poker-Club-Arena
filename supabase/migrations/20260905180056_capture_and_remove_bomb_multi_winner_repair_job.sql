-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905180056; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905180056   (the stamp IS the apply time, UTC: 2026-09-05 18:00:56)
--   name        capture_and_remove_bomb_multi_winner_repair_job
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1006 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905180056 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TABLE          ops_rollback.removed_cron_jobs_20260905
--
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

create table if not exists ops_rollback.removed_cron_jobs_20260905 (
  id bigserial primary key,
  jobname text, schedule text, command text, database text,
  username text, active boolean, removed_at timestamptz, reason text,
  restore_sql text
);

insert into ops_rollback.removed_cron_jobs_20260905
  (jobname, schedule, command, database, username, active, removed_at, reason, restore_sql)
select j.jobname, j.schedule, j.command, j.database, j.username, j.active, now(),
  'Backfill complete: 0 of 12,571 multi-winner bomb hands lacked award units. '
  'Live settlement path writes units 0.15-2.8s after the hand. Job scanned 22,635 '
  'bomb hands hourly to find nothing and timed out on 12.5% of runs. '
  'Removed on Dan''s instruction 2026-09-05. Function fn_backfill_bomb_multi_winner_units '
  'is retained for manual use if a gap ever appears.',
  format('select cron.schedule(%L, %L, %L);', j.jobname, j.schedule, j.command)
from cron.job j
where j.jobname = 'bomb-multi-winner-repair-hourly';
