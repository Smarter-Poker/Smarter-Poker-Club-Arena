-- ═══════════════════════════════════════════════════════════════════════════
--  THE CRON FLEET IS ON A GAUGE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY (measured 2026-09-04)
--
-- `infra/monitoring/alert-rules.yml` has had a group called `cron-health`
-- since it was written. It contains NO RULES. A heading that alerts on
-- nothing, and it reads exactly like coverage.
--
-- Meanwhile, on the same afternoon:
--
--   * FOUR Open Claw jobs were stale, the worst SILENT FOR 18.3 DAYS -
--     /cron/player-stats-refresh, /cron/venue-tournaments,
--     /cron/video-library-reels, /cron/video-library-scraper;
--   * TWELVE pg_cron jobs failed simultaneously at 17:46 with
--     "job startup timeout", including sp_prune_hand_state_snapshots_2m,
--     daily-missions-outbox-minute and ca-auto-reconcile-tick.
--
-- `v_openclaw_job_staleness` already existed, already computed `is_stale`, and
-- NOTHING HAS EVER READ IT. The database knew a job had been silent for
-- eighteen days and had no way to say it out loud. That is the same shape as
-- the settlement outage and the financial_alerts backlog found earlier today,
-- for the third time, in a third place.
--
-- The estate's own history says this is the failure that matters most: the
-- World Hub CLAUDE.md records the CRON_SECRET rotation where all 85 Open Claw
-- jobs returned 401 and nothing noticed, because a 401 is refused before
-- anything records it - "the log does not fill with errors, it STOPS". Silence
-- is the only observable, so silence is what this measures.
--
-- WHAT IT MEASURES, AND WHAT IT DELIBERATELY DOES NOT
--
-- Failures and silence, both of which are unambiguous.
--
-- It does NOT report "jobs that have never run", though that was the first
-- thing I reached for. `cron.job` does not record when a job was created, so a
-- NULL last_run means either "never fired" or "not yet due" and there is no
-- way to tell them apart. Seven jobs currently read NULL and five of them are
-- simply newer than their first window. A gauge that cannot distinguish a dead
-- job from a young one would page every time somebody scheduled anything - and
-- an alert that cries wolf is how you end up with 1,345 unread alerts.
--
-- That ambiguity is itself worth recording: it is exactly why
-- `fn_uncollected_entry_check` could sit in financial_alerts saying "has never
-- run. It is expected every 60 minutes, and until it does its silence means
-- nothing." Nobody could tell.
--
-- COST. Two aggregates over cron.job_run_details (which pg_cron keeps small)
-- and one view read, once every 60 seconds, from one engine.
--
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.fn_cron_fleet_health(integer);
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_cron_fleet_health(p_window_minutes integer DEFAULT 60)
RETURNS TABLE (
  pg_cron_jobs            bigint,
  pg_cron_active          bigint,
  pg_cron_runs            bigint,
  pg_cron_failures        bigint,
  openclaw_jobs           bigint,
  openclaw_stale          bigint,
  openclaw_worst_silence_minutes numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, cron, pg_temp
AS $$
  SELECT
    (SELECT count(*) FROM cron.job),
    (SELECT count(*) FROM cron.job WHERE active),
    (SELECT count(*) FROM cron.job_run_details
      WHERE start_time > now() - make_interval(mins => greatest(p_window_minutes, 1))),
    (SELECT count(*) FROM cron.job_run_details
      WHERE start_time > now() - make_interval(mins => greatest(p_window_minutes, 1))
        AND status <> 'succeeded'),
    (SELECT count(*) FROM public.v_openclaw_job_staleness),
    (SELECT count(*) FROM public.v_openclaw_job_staleness WHERE is_stale),
    (SELECT round(max(silent_minutes), 1) FROM public.v_openclaw_job_staleness)
$$;

COMMENT ON FUNCTION public.fn_cron_fleet_health(integer) IS
  'pg_cron and Open Claw fleet health for the engine Prometheus gauges. Measures FAILURES and SILENCE, both unambiguous. Deliberately does not report "never run": cron.job records no creation time, so a NULL last_run is indistinguishable between a dead job and one not yet due - which is precisely why fn_uncollected_entry_check could sit in financial_alerts saying its own silence means nothing. On 2026-09-04 four Open Claw jobs were stale, the worst silent for 18.3 days, and v_openclaw_job_staleness had computed that all along with nothing reading it.';

REVOKE ALL ON FUNCTION public.fn_cron_fleet_health(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_cron_fleet_health(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_cron_fleet_health(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cron_fleet_health(integer) TO service_role;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fn_cron_fleet_health(60);

  IF r IS NULL OR r.pg_cron_jobs IS NULL THEN
    RAISE EXCEPTION 'post-condition failed: fn_cron_fleet_health returned no row';
  END IF;

  -- This database runs 125 pg_cron jobs. A count near zero means the function
  -- cannot see cron.job, and a gauge reading zero jobs would look like a quiet
  -- platform rather than a blind collector.
  IF r.pg_cron_jobs < 50 THEN
    RAISE EXCEPTION
      'post-condition failed: only % pg_cron jobs visible; 125 were live when this was written. The function cannot see cron.job.',
      r.pg_cron_jobs;
  END IF;

  IF r.openclaw_jobs < 10 THEN
    RAISE EXCEPTION
      'post-condition failed: only % Open Claw jobs visible from v_openclaw_job_staleness; 69 were live when this was written.',
      r.openclaw_jobs;
  END IF;

  RAISE NOTICE 'cron fleet: % pg_cron jobs (% active), % runs/% failures in 60m; % Open Claw jobs, % stale, worst silence % min.',
    r.pg_cron_jobs, r.pg_cron_active, r.pg_cron_runs, r.pg_cron_failures,
    r.openclaw_jobs, r.openclaw_stale, r.openclaw_worst_silence_minutes;
END $$;
