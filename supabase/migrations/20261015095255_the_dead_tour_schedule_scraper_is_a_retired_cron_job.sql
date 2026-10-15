-- 20261015095255_the_dead_tour_schedule_scraper_is_a_retired_cron_job.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE DEAD TOUR SCHEDULE SCRAPER IS A RETIRED CRON JOB (2026-10-15)
--
-- ScraperCritical ("[tour-schedule-scraper] Scraper produced no output -
-- possible config error. Tours: 0/0 updated, Events: 0") has paged on every
-- run of /cron/tour-schedule-scraper, every third day at 04:00 UTC, from
-- 2026-09-16 to 2026-10-13 (10 pages), and on every run before the operational
-- inbox existed. Read from production 2026-10-15:
--
--   * the workers route reads its tours from public.tour_schedule_sources and
--     public.tour_schedule_registry (the Supabase replacement for the old
--     on-disk JSONs, World Hub dispatcher note "2B.2(j)", tables created
--     2026-04-26). Both tables have 0 rows and pg_stat_user_tables shows
--     n_tup_ins = 0 for each: nothing has ever been written to them, so every
--     run since the port has had zero tours, scraped nothing and paged;
--   * public.tour_event_details, its output table, was last written
--     2026-04-08 (WSOP and MSPT, before the port);
--   * the live tour pipeline is the local tours runtime
--     (scripts/tour_stealth_scraper.py under scripts/local_scraper_runtime.py,
--     component "tours"): it reads public.tour_source_registry (26 tours) and
--     writes public.tour_stop_events (789 rows, last write 2026-10-13 11:54).
--
-- The detector is right: a scraper with no configuration IS a configuration
-- error. The cause is a scheduled job whose work moved elsewhere and was never
-- unscheduled. The companion World Hub pull request removes
-- /api/cron/tour-schedule-scraper from the OpenClaw dispatcher's ALL_CRONS and
-- its workers route map. This migration records the retirement where both
-- silence readers look (v_openclaw_job_staleness and
-- fn_monitoring_health_snapshot exclude ca_retired_cron_jobs), so the job
-- stopping does not page OpenClawJobsHaveGoneSilent six days later (its p90
-- gap is 4,320 minutes, threshold 8,640).
--
-- Data only: one registry row, no DDL, no money, no player row.
--
-- Regression: scripts/ci/test-the-dead-tour-scraper-is-retired.py (native
-- PostgreSQL, the live view captured 2026-10-15 md5 4d54670a...), run by
-- .github/workflows/the-dead-tour-scraper-is-retired.yml.
--
-- @live-proof: (SELECT count(*) FROM public.ca_retired_cron_jobs WHERE job_name = '/cron/tour-schedule-scraper' AND replaced_by LIKE 'local tours runtime%') = 1

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $retire$
BEGIN
  IF to_regclass('public.ca_retired_cron_jobs') IS NULL THEN
    RAISE EXCEPTION 'ca_retired_cron_jobs is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_retired_cron_jobs WHERE job_name = '/cron/tour-schedule-scraper') THEN
    RAISE EXCEPTION '/cron/tour-schedule-scraper is already registered: this migration has run';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tour_schedule_sources) OR EXISTS (SELECT 1 FROM public.tour_schedule_registry) THEN
    RAISE EXCEPTION 'tour_schedule_sources or tour_schedule_registry now holds rows: the scraper has a configuration again, do not retire it';
  END IF;
END
$retire$;

INSERT INTO public.ca_retired_cron_jobs (job_name, retired_at, reason, replaced_by)
VALUES
  ('/cron/tour-schedule-scraper', '2026-10-13 04:00:01.976+00'::timestamptz,
   'Removed from the World Hub OpenClaw dispatcher on 2026-10-15. Its configuration tables tour_schedule_sources and tour_schedule_registry have never held a row (created 2026-04-26 to replace the on-disk JSONs, which were never migrated), so every run scraped zero tours and paged ScraperCritical "produced no output - possible config error"; its output table tour_event_details was last written 2026-04-08. Tour stops are scraped by the local tours runtime from tour_source_registry into tour_stop_events. Last run 2026-10-13 04:00 UTC.',
   'local tours runtime (scripts/tour_stealth_scraper.py: tour_source_registry -> tour_stop_events)');

DO $proof$
BEGIN
  IF (SELECT count(*) FROM public.ca_retired_cron_jobs
       WHERE job_name = '/cron/tour-schedule-scraper' AND replaced_by LIKE 'local tours runtime%') <> 1 THEN
    RAISE EXCEPTION 'retirement row not recorded';
  END IF;
END
$proof$;

COMMIT;
