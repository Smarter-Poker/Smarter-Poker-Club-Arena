-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260904192858; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260904192858   (the stamp IS the apply time, UTC: 2026-09-04 19:28:58)
--   name        retire_venue_tournaments
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1967 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260904192858 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
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

-- /cron/venue-tournaments was formally retired from the dispatcher on
-- 2026-09-04 (removed from SCHEDULED_JOBS and WORKERS_PREFERRED and deployed).
-- It was still reporting is_stale, because retirement lives in this table and
-- the dispatcher edit alone cannot reach it - so the alarm would have gone on
-- firing for a job that no longer exists, which is the exact failure mode
-- ca_retired_cron_jobs was created to prevent.

INSERT INTO public.ca_retired_cron_jobs (job_name, retired_at, reason, replaced_by)
VALUES (
  '/cron/venue-tournaments',
  '2026-09-04 19:00:00+00',
  'Retired from the workers host 2026-09-04, four reasons: (1) iterating 50+ venues at 2000ms delay with a 20s fetch timeout exceeds 100s of runtime and the connection aborted nightly at 04:00 UTC with RemoteDisconnected; (2) the upsert targeted a legacy 4-column constraint (venue_id, day_of_week, start_time, buy_in) that had been replaced by a 7-column one and omitted the NOT NULL provenance columns scrape_html_hash and scrape_timestamp, so every upsert failed with 42P10 and it wrote ZERO rows even when it did run; (3) scraping venue sites from datacenter IPs triggers Cloudflare bot challenges; (4) no data loss - active charity schedules are already covered by scrape-charity-schedules at 03:00 UTC.',
  'scripts/venue_scraper_scrapling.py - a browser-based scraper on the Open Claw VM'
)
ON CONFLICT (job_name) DO NOTHING;

DO $$
DECLARE v_stale int; v_names text;
BEGIN
  SELECT count(*), string_agg(job_name, ', ') INTO v_stale, v_names
  FROM public.v_openclaw_job_staleness WHERE is_stale;

  IF EXISTS (SELECT 1 FROM public.v_openclaw_job_staleness
              WHERE is_stale AND job_name = '/cron/venue-tournaments') THEN
    RAISE EXCEPTION 'post-condition failed: /cron/venue-tournaments is still reported stale after retirement.';
  END IF;

  RAISE NOTICE 'venue-tournaments retired. % job(s) still genuinely stale: %', v_stale, coalesce(v_names,'none');
END $$;
