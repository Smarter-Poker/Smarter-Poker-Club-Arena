-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905172107; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905172107   (the stamp IS the apply time, UTC: 2026-09-05 17:21:07)
--   name        create_ops_incident_triage_views
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 3138 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905172107 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     VIEW           ops.incident_triage, ops.incident_worklist, ops.cron_health
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

create schema if not exists ops;
comment on schema ops is
  'Read-only operational views. Added 2026-09-05. Nothing here writes; these exist so the existing alerting can be read by a human without changing how alerts are raised.';

-- Collapses the same underlying fact reported by multiple detectors
-- (reconcile:/lrl:/qr:/fa: prefixes) and by date-rotating keys into one row.
-- Read-side only: does NOT change fn_ca_raise_drift_incident, so it cannot
-- suppress or merge anything at detection time.
create or replace view ops.incident_triage as
with canon as (
  select
    classification,
    severity,
    regexp_replace(
      regexp_replace(
        regexp_replace(dedupe_key, '^(reconcile|lrl|qr|fa|ca|drift):', ''),
        ':?\d{4}-\d{2}-\d{2}$', ''),
      ':$','') as canon_key,
    round(coalesce(discrepancy_amount,0)) as amount,
    occurrences, past_target, detected_at, last_seen_at, id, source, suspected_cause
  from public.ca_drift_incidents
  where status = 'open'
)
select
  classification,
  severity,
  canon_key,
  amount,
  count(*)                       as duplicate_incident_rows,
  sum(occurrences)               as total_occurrences,
  bool_or(past_target)           as past_deadline,
  min(detected_at)               as first_seen,
  max(last_seen_at)              as last_seen,
  count(distinct source)         as detectors_reporting,
  (array_agg(suspected_cause order by last_seen_at desc)
     filter (where suspected_cause is not null))[1] as cause,
  array_agg(id order by detected_at)                as incident_ids
from canon
group by 1,2,3,4;

-- Ranked worklist: what a person should look at, biggest first.
create or replace view ops.incident_worklist as
select
  row_number() over (
    order by (severity='critical') desc, abs(amount) desc, total_occurrences desc
  ) as rank,
  classification, severity, canon_key, amount,
  duplicate_incident_rows, total_occurrences, past_deadline,
  first_seen::date as since, last_seen, cause
from ops.incident_triage
where severity in ('critical','warning')
order by rank;

-- The cron outage of Aug 29-31 went unnoticed for a week. This makes it visible.
create or replace view ops.cron_health as
select
  j.jobname, j.schedule, j.active,
  count(*) filter (where d.status='failed'
                     and d.start_time > now()-interval '24 hours') as failed_24h,
  count(*) filter (where d.start_time > now()-interval '24 hours')  as runs_24h,
  round(100.0 * count(*) filter (where d.status='failed'
                     and d.start_time > now()-interval '24 hours')
        / nullif(count(*) filter (where d.start_time > now()-interval '24 hours'),0), 2) as fail_pct_24h,
  max(d.start_time) filter (where d.status='failed') as last_failure,
  left(regexp_replace(
    (array_agg(d.return_message order by d.start_time desc)
       filter (where d.status='failed'))[1], '\s+',' ','g'), 160) as last_error
from cron.job j
left join cron.job_run_details d on d.jobid = j.jobid
group by j.jobname, j.schedule, j.active;

revoke all on schema ops from public, anon, authenticated;
revoke all on all tables in schema ops from public, anon, authenticated;
