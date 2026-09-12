-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905172144; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905172144   (the stamp IS the apply time, UTC: 2026-09-05 17:21:44)
--   name        tighten_incident_triage_canonicalisation
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1398 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905172144 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     VIEW           ops.incident_triage
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

create or replace view ops.incident_triage as
with canon as (
  select
    classification,
    severity,
    regexp_replace(                                   -- 4. drop generic scope suffixes
      regexp_replace(                                 -- 3. normalise "_pool" naming
        regexp_replace(                               -- 2. drop trailing date
          regexp_replace(dedupe_key,                  -- 1. drop detector prefix
            '^(reconcile|lrl|qr|fa|ca|drift):', ''),
          ':?\d{4}-\d{2}-\d{2}$', ''),
        '_pool(:|$)', '\1'),
      '(:global|:-|:)$', '') as canon_key,
    round(coalesce(discrepancy_amount,0)) as amount,
    occurrences, past_target, detected_at, last_seen_at, id, source, suspected_cause
  from public.ca_drift_incidents
  where status = 'open'
)
select
  classification, severity, canon_key, amount,
  count(*)               as duplicate_incident_rows,
  sum(occurrences)       as total_occurrences,
  bool_or(past_target)   as past_deadline,
  min(detected_at)       as first_seen,
  max(last_seen_at)      as last_seen,
  count(distinct source) as detectors_reporting,
  (array_agg(suspected_cause order by last_seen_at desc)
     filter (where suspected_cause is not null))[1] as cause,
  array_agg(id order by detected_at) as incident_ids
from canon
group by 1,2,3,4;

revoke all on all tables in schema ops from public, anon, authenticated;
