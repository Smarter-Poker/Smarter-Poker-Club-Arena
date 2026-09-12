-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905172225; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905172225   (the stamp IS the apply time, UTC: 2026-09-05 17:22:25)
--   name        fix_cron_health_window_consistency_v2
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1230 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905172225 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     VIEW           ops.cron_health
--     DROP           VIEW ops.cron_health
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
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

drop view if exists ops.cron_health;

-- Previous version mixed windows: counts were 24h but last_error/last_failure
-- were all-time, so a job could show 0 recent failures beside an old error.
create view ops.cron_health as
with recent as (
  select d.jobid, d.status, d.start_time, d.return_message
  from cron.job_run_details d
  where d.start_time > now() - interval '24 hours'
)
select
  j.jobname, j.schedule, j.active,
  count(*) filter (where r.status='failed')            as failed_24h,
  count(r.jobid)                                       as runs_24h,
  round(100.0 * count(*) filter (where r.status='failed')
        / nullif(count(r.jobid),0), 2)                 as fail_pct_24h,
  max(r.start_time) filter (where r.status='failed')   as last_failure_24h,
  left(regexp_replace(
    (array_agg(r.return_message order by r.start_time desc)
       filter (where r.status='failed'))[1], '\s+',' ','g'), 160) as last_error_24h
from cron.job j
left join recent r on r.jobid = j.jobid
group by j.jobname, j.schedule, j.active;

comment on view ops.cron_health is
  'Cron job health over a consistent 24h window. Every column uses the same window.';

revoke all on all tables in schema ops from public, anon, authenticated;
