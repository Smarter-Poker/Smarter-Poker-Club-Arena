-- ═══════════════════════════════════════════════════════════════════════════
--  A RETIRED CRON JOB STOPS BEING STALE FOREVER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY (2026-09-04)
--
-- `v_openclaw_job_staleness` reports a job as stale when it has stopped
-- succeeding. It has no idea a job can be DELIBERATELY RETIRED, so a job that
-- was correctly removed goes on reading `is_stale = true` for the rest of
-- time. Yesterday that cost nothing, because nothing read the view at all.
-- Today the engine puts it on a gauge and `OpenClawJobsHaveGoneSilent` pages
-- on it, so a permanent false positive is now a permanent page - and an alarm
-- that is always on is an alarm nobody reads. That is precisely how
-- financial_alerts reached 1,345 unread rows.
--
-- THE JOB THIS IS ABOUT
--
-- `/cron/player-stats-refresh` was removed from
-- `scripts/openclaw-cron-dispatcher.py` on 2026-09-03, with a full
-- explanation in the file. It could never have worked: the handler asks
-- `fn_refresh_player_stats` for a 26-hour window, roughly 130 seconds of
-- hand_history jsonb work, against PostgREST's 8-second service_role
-- statement timeout. Twenty-four fires a day, twenty-four timeouts.
--
-- The statistics were never stale, because pg_cron job
-- `refresh-player-stats-hourly` (jobid 76, '17 * * * *', 90-minute window,
-- advisory-locked) has been doing the same work INSIDE Postgres, where no
-- PostgREST timeout applies, succeeding 24 times out of 24. Two schedulers for
-- one job, one of them structurally unable to finish. The right one was kept.
--
-- So the job is fine. THE MONITOR IS WRONG, and this fixes the monitor.
--
-- WHAT IS NOT RETIRED HERE, DELIBERATELY
--
-- The other three stale jobs stay stale and will keep paging, because they are
-- broken rather than retired:
--
--   /cron/video-library-scraper   last success 2026-08-29 06:00
--   /cron/video-library-reels     last success 2026-08-29 07:00
--   /cron/venue-tournaments       last success 2026-09-02 04:00
--
-- The two video-library jobs stopped the day `_resolve_script()` landed
-- (dispatcher, "Host-portability (2026-08-29)"): they run a local Python
-- script, and resolution falls back to a path under Dan's Documents folder
-- when the scripts are not deployed beside the dispatcher on Hetzner.
-- `/cron/venue-tournaments` has no handler at
-- `pages/api/cron/venue-tournaments.js` in the World Hub at all and is routed
-- to the workers host. Both need a deploy and a person, not a database change,
-- and silencing them here would be hiding exactly what this whole day has been
-- about.
--
-- ROLLBACK
--   Restore the previous view body (it is in this file's git history), then:
--   DROP TABLE IF EXISTS public.ca_retired_cron_jobs;
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ca_retired_cron_jobs (
  job_name    text PRIMARY KEY,
  retired_at  timestamptz NOT NULL DEFAULT now(),
  reason      text NOT NULL,
  replaced_by text
);

COMMENT ON TABLE public.ca_retired_cron_jobs IS
  'Cron jobs deliberately withdrawn. v_openclaw_job_staleness excludes them, so a job that was correctly removed stops reporting is_stale forever. A row here needs a REASON: retiring a job to silence its alarm, rather than because the work moved or ended, is the failure this table must not become. Broken jobs do not belong here - they belong fixed.';

ALTER TABLE public.ca_retired_cron_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_retired_cron_jobs FROM PUBLIC;
REVOKE ALL ON TABLE public.ca_retired_cron_jobs FROM anon;
REVOKE ALL ON TABLE public.ca_retired_cron_jobs FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ca_retired_cron_jobs TO service_role;

INSERT INTO public.ca_retired_cron_jobs (job_name, retired_at, reason, replaced_by)
VALUES (
  '/cron/player-stats-refresh',
  '2026-09-03 00:00:00+00',
  'Removed from openclaw-cron-dispatcher.py 2026-09-03. It could never run: the handler asks fn_refresh_player_stats for a 26-hour window (~130s of hand_history jsonb work) against PostgREST''s 8s service_role statement timeout - 24 fires, 24 timeouts, every day. The work was already being done correctly inside Postgres.',
  'pg_cron job refresh-player-stats-hourly (jobid 76, ''17 * * * *'', 90-minute window, advisory-locked, 24/24 succeeded)'
)
ON CONFLICT (job_name) DO NOTHING;

-- Same body as before, plus the retirement filter. Column list is unchanged,
-- so CREATE OR REPLACE is safe and nothing downstream needs to know.
CREATE OR REPLACE VIEW public.v_openclaw_job_staleness AS
 WITH s AS (
         SELECT cron_execution_log.job_name,
            cron_execution_log.started_at,
            lag(cron_execution_log.started_at) OVER (PARTITION BY cron_execution_log.job_name ORDER BY cron_execution_log.started_at) AS prev_started_at
           FROM cron_execution_log
          WHERE cron_execution_log.started_at > (now() - '30 days'::interval)
            AND cron_execution_log.status = 'success'::text
            AND NOT EXISTS (
                  SELECT 1 FROM public.ca_retired_cron_jobs r
                   WHERE r.job_name = cron_execution_log.job_name)
        ), g AS (
         SELECT s.job_name,
            EXTRACT(epoch FROM s.started_at - s.prev_started_at) / 60.0 AS gap_minutes
           FROM s
          WHERE s.prev_started_at IS NOT NULL
        ), agg AS (
         SELECT s.job_name,
            max(s.started_at) AS last_success_at,
            count(*) AS successes_30d,
            EXTRACT(epoch FROM now() - max(s.started_at)) / 60.0 AS silent_minutes,
            ( SELECT percentile_cont(0.9::double precision) WITHIN GROUP (ORDER BY (g.gap_minutes::double precision)) AS percentile_cont
                   FROM g
                  WHERE g.job_name = s.job_name) AS p90_gap_minutes
           FROM s
          GROUP BY s.job_name
        )
 SELECT job_name,
    last_success_at,
    successes_30d,
    round(silent_minutes, 2) AS silent_minutes,
    round(p90_gap_minutes::numeric, 2) AS p90_gap_minutes,
    round(LEAST(GREATEST(2::double precision * p90_gap_minutes, 45::double precision), 14400::double precision)::numeric, 2) AS threshold_minutes,
    successes_30d >= 5 AND silent_minutes::double precision > LEAST(GREATEST(2::double precision * p90_gap_minutes, 45::double precision), 14400::double precision) AS is_stale
   FROM agg a;

COMMENT ON VIEW public.v_openclaw_job_staleness IS
  'Open Claw job silence. Excludes anything listed in ca_retired_cron_jobs, so a deliberately withdrawn job stops reporting stale forever - which matters from 2026-09-04, when the engine began putting is_stale on a Prometheus gauge that pages. Read by fn_cron_fleet_health.';

DO $$
DECLARE
  v_retired_present int;
  v_still_stale     int;
  v_names           text;
BEGIN
  SELECT count(*) INTO v_retired_present
  FROM public.v_openclaw_job_staleness
  WHERE job_name = '/cron/player-stats-refresh';

  IF v_retired_present <> 0 THEN
    RAISE EXCEPTION
      'post-condition failed: /cron/player-stats-refresh is still in v_openclaw_job_staleness after being retired.';
  END IF;

  SELECT count(*), string_agg(job_name, ', ')
    INTO v_still_stale, v_names
  FROM public.v_openclaw_job_staleness WHERE is_stale;

  -- The three genuinely broken jobs MUST still be reported. If this retirement
  -- silenced them too, the filter is wrong and the alarm is now useless.
  IF v_still_stale < 3 THEN
    RAISE EXCEPTION
      'post-condition failed: only % stale job(s) remain (%). Three broken jobs were expected to keep reporting - this change must silence the retired one and nothing else.',
      v_still_stale, coalesce(v_names, 'none');
  END IF;

  RAISE NOTICE 'retired /cron/player-stats-refresh; % genuinely stale job(s) still reporting: %', v_still_stale, v_names;
END $$;
