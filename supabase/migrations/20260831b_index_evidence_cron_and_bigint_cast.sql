-- ═══════════════════════════════════════════════════════════════════════════
--  THE SAME CHANGE, FINISHED: the cron cadence and a type that did not compile
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Companion to 20260831_index_evidence_that_can_actually_accumulate.sql. Two
-- things belong here rather than in that file, because both were learned by
-- RUNNING it against production rather than by reading it.
--
-- 1. THE FUNCTION DID NOT COMPILE ON CALL. `sum(bigint)` returns NUMERIC in
--    Postgres, and the RETURNS TABLE column is declared bigint, so the first
--    revision raised
--
--        Returned type numeric does not match expected type bigint in column 5
--
--    on EVERY invocation. plpgsql does not check a RETURN QUERY's shape until
--    the query actually runs, so nothing complained at CREATE time. It was
--    caught by calling the function, which is the only thing that could have
--    caught it.
--
-- 2. THE CRON CADENCE IS THE ACTUAL FIX. The reader can now sum across epochs,
--    but it still needs two captures INSIDE one epoch to have a delta to sum.
--    Daily capture against daily restart gave exactly one, six times running.
--    Two-hourly gives about ten per epoch.
--
-- The prune is scheduled here for the same reason it exists: 3,076 indexes at
-- twelve captures a day is ~448 MB in sixty days, which a diagnostic table does
-- not get to spend on a database already carrying 3.6 GB of hand history.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_truly_unused_indexes(p_min_days integer DEFAULT 7)
RETURNS TABLE(
  relname text,
  indexrelname text,
  index_bytes bigint,
  pretty_size text,
  scans_in_window bigint,
  window_days numeric,
  epochs_observed integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  RETURN QUERY
  WITH per_epoch AS (
    SELECT s.schemaname,
           s.relname       AS tbl,
           s.indexrelname  AS idx,
           s.postmaster_start,
           max(s.idx_scan) - min(s.idx_scan)                       AS scans,
           extract(epoch FROM (max(s.taken_at) - min(s.taken_at))) AS span_seconds,
           max(s.index_bytes)                                      AS bytes
      FROM public.index_usage_snapshots s
     GROUP BY s.schemaname, s.relname, s.indexrelname, s.postmaster_start
  ),
  totalled AS (
    SELECT p.tbl,
           p.idx,
           max(p.bytes)::bigint          AS bytes,
           sum(p.scans)::bigint          AS total_scans,
           sum(p.span_seconds) / 86400.0 AS observed_days,
           count(*)::integer             AS epochs
      FROM per_epoch p
     GROUP BY p.tbl, p.idx
  )
  SELECT t.tbl, t.idx, t.bytes, pg_size_pretty(t.bytes),
         t.total_scans, round(t.observed_days, 2)::numeric, t.epochs
    FROM totalled t
   WHERE t.total_scans = 0
     AND t.observed_days >= p_min_days
   ORDER BY t.bytes DESC;
END;
$function$;

-- Capture faster than the server resets the counters, and prune daily.
SELECT cron.alter_job(140, schedule => '41 */2 * * *');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'index-usage-snapshot-prune-daily') THEN
    PERFORM cron.schedule('index-usage-snapshot-prune-daily', '17 5 * * *',
                          'SELECT public.fn_prune_index_usage_snapshots(60);');
  END IF;
END $$;

DO $$
DECLARE v_sched text; v_n integer;
BEGIN
  SELECT schedule INTO v_sched FROM cron.job WHERE jobid = 140;
  IF v_sched <> '41 */2 * * *' THEN
    RAISE EXCEPTION 'snapshot cadence not changed: %', v_sched;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'index-usage-snapshot-prune-daily' AND active) THEN
    RAISE EXCEPTION 'prune job not scheduled';
  END IF;
  -- It must RUN, not merely be creatable: the previous revision type-errored
  -- on every call and CREATE FUNCTION accepted it happily.
  SELECT count(*) INTO v_n FROM public.fn_truly_unused_indexes(9999);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'a 9999-day window returned % rows; the fail-closed guard is broken', v_n;
  END IF;
END $$;

COMMIT;
