-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260904185338; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260904185338   (the stamp IS the apply time, UTC: 2026-09-04 18:53:38)
--   name        a_retired_cron_job_stops_being_stale_forever
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 4646 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260904185338 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     VIEW           public.v_openclaw_job_staleness
--     TABLE          public.ca_retired_cron_jobs
--     RLS-ENABLE     
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
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
  'Removed from openclaw-cron-dispatcher.py 2026-09-03. It could never run: the handler asks fn_refresh_player_stats for a 26-hour window (~130s of hand_history jsonb work) against PostgREST 8s service_role statement timeout - 24 fires, 24 timeouts, every day. The work was already being done correctly inside Postgres.',
  'pg_cron job refresh-player-stats-hourly (jobid 76, 17 * * * *, 90-minute window, advisory-locked, 24/24 succeeded)'
)
ON CONFLICT (job_name) DO NOTHING;

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

  IF v_still_stale < 3 THEN
    RAISE EXCEPTION
      'post-condition failed: only % stale job(s) remain (%). Three broken jobs were expected to keep reporting.',
      v_still_stale, coalesce(v_names, 'none');
  END IF;

  RAISE NOTICE 'retired /cron/player-stats-refresh; % genuinely stale job(s) still reporting: %', v_still_stale, v_names;
END $$;
