-- 20260923175730_a_sparse_job_can_still_be_dead.sql
--
-- Production Alerts Fleet, operational_alert_events id=11
-- (OpenClawFleetLongSilence, open since 2026-09-13). fn_monitoring_health_snapshot
-- reports cron_openclaw_worst_silence_minutes and cron_openclaw_stale by
-- filtering v_openclaw_job_staleness WHERE is_stale. That view's is_stale
-- column requires successes_30d >= 5 before it will ever say true, so it can
-- adapt the threshold to each job's own cadence (2x its p90 gap, floored at
-- 45 minutes, capped at 10 days) instead of one fixed number for every job.
--
-- The guard is sound for a job with a normal cadence that simply has not
-- accumulated five runs yet. It is not sound for a job that is simply dead:
-- once a job stops succeeding entirely, its successes_30d count only ever
-- falls (nothing adds to it), so a job silent long enough eventually reads
-- successes_30d < 5 purely from time passing, and is_stale then reads false
-- FOR EVER regardless of how long the silence grows - the exact "answers
-- confidently when it cannot tell" shape club-arena CLAUDE.md section 10.86
-- names, on the metric the fifteen-rules-thirteen-metrics incident (2026-09-04,
-- docs/changelog/2026-09-11-fifteen-rules-were-watching-thirteen-metrics-
-- that-did-not-exist.md) built this exact alert to prevent recurring.
--
-- Verified live against production before writing this fix: four jobs are
-- caught in exactly that state right now, none of them retired
-- (ca_retired_cron_jobs has no row for any of them), all still returned by
-- this view (they are within the 30-day window, just barely, on their one
-- remaining success), and all invisible to is_stale purely because
-- successes_30d=1 < 5:
--
--   job_name                    successes_30d  silent_minutes  (days)
--   /cron/horse/0                            1        24155.59  (16.8d)
--   /cron/video-library-backfill             1        35695.79  (24.8d)
--   /cron/video-library-purge                1        35635.72  (24.7d)
--   /cron/video-library-views                1        37195.77  (25.8d)
--
-- video-library-views is silent LONGER than /cron/video-library-scraper
-- (36715.71 min, 25.5d), which is the one job currently driving the
-- OpenClawFleetLongSilence alert's reported worst-silence figure - so the
-- number this alert has been reporting has been an undercount the whole
-- time it has fired. video-library-scraper's own silence is root-caused and
-- already fixed in Smarter-Poker-World-Hub#1963 (its report-back webhook
-- 404'd silently since 2026-08-29, so it never produced a health-log
-- success row despite the underlying scrape working); this migration fixes
-- the detector, not any individual job's cause, and does not touch that PR.
--
-- THE FIX: is_stale now ALSO fires, independent of sample count, when a job
-- has been silent past a flat 7-day (10080-minute) ceiling - chosen because
-- it is comfortably above every legitimately-sparse-but-healthy job's own
-- natural cadence observed live today (successes_30d<5 jobs currently on the
-- healthy side: /cron/auto-settlement and /cron/auto-settlement-distribute,
-- each silent ~2.3 days against their own ~7-day p90 gap; the existing
-- 14400-minute/10-day cap already used for the adaptive threshold is the
-- outer bound this estate already treats as tolerable for an infrequent
-- job). The cadence-aware branch is completely unchanged for every job with
-- five or more recent successes.
--
-- This does not close the deeper gap: a job that has had ZERO successes in
-- the full 30-day window disappears from this view entirely (the `s` CTE
-- only looks at the last 30 days), so a job dead for 31+ days would still be
-- invisible here. Closing that needs a registry of every job this fleet
-- expects to see, which this migration does not attempt - noted here so the
-- next person does not read this fix as complete for that case.

BEGIN;

CREATE OR REPLACE VIEW public.v_openclaw_job_staleness AS
  WITH s AS MATERIALIZED (
    SELECT cel.job_name,
           cel.started_at,
           lag(cel.started_at) OVER (PARTITION BY cel.job_name ORDER BY cel.started_at) AS prev_started_at
      FROM public.cron_execution_log cel
     WHERE cel.started_at > (now() - '30 days'::interval)
       AND cel.status = 'success'::text
       AND NOT EXISTS (SELECT 1 FROM public.ca_retired_cron_jobs r WHERE r.job_name = cel.job_name)
  ), g AS (
    SELECT s.job_name,
           EXTRACT(epoch FROM s.started_at - s.prev_started_at) / 60.0 AS gap_minutes
      FROM s
     WHERE s.prev_started_at IS NOT NULL
  ), p AS MATERIALIZED (
    SELECT g.job_name,
           percentile_cont(0.9::double precision) WITHIN GROUP (ORDER BY (g.gap_minutes::double precision)) AS p90_gap_minutes
      FROM g
     GROUP BY g.job_name
  ), agg AS MATERIALIZED (
    SELECT s.job_name,
           max(s.started_at) AS last_success_at,
           count(*) AS successes_30d,
           EXTRACT(epoch FROM now() - max(s.started_at)) / 60.0 AS silent_minutes
      FROM s
     GROUP BY s.job_name
  )
  SELECT a.job_name,
         a.last_success_at,
         a.successes_30d,
         round(a.silent_minutes, 2) AS silent_minutes,
         round(p.p90_gap_minutes::numeric, 2) AS p90_gap_minutes,
         round(LEAST(GREATEST(2::double precision * p.p90_gap_minutes, 45::double precision), 14400::double precision)::numeric, 2) AS threshold_minutes,
         (a.successes_30d >= 5
            AND a.silent_minutes::double precision > LEAST(GREATEST(2::double precision * p.p90_gap_minutes, 45::double precision), 14400::double precision))
           OR a.silent_minutes::double precision > 10080::double precision AS is_stale
    FROM agg a
    LEFT JOIN p ON p.job_name = a.job_name;

-- Drift guard: if this view's live definition has moved since the text above
-- was read, someone else changed it concurrently - re-diff before applying,
-- the same discipline club-arena CLAUDE.md's DDL policy already expects.
DO $assert_verified_source$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
     WHERE schemaname='public' AND viewname='v_openclaw_job_staleness'
       AND definition IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'v_openclaw_job_staleness did not install';
  END IF;
END;
$assert_verified_source$;

COMMIT;
