-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831114423; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- See supabase/migrations/20260831_index_evidence_that_can_actually_accumulate.sql
-- The 2026-08-26 snapshot mechanism required two captures sharing one
-- postmaster_start. Snapshots are daily and this server restarts daily, so all
-- 6 captures sat in 6 distinct epochs with 0.000 days of uninterrupted history
-- each: fn_truly_unused_indexes could never reach a verdict for any n > 0.
-- Fix: sum per-epoch deltas (a restart resets the counter, so deltas add rather
-- than subtract), and snapshot faster than the server restarts. Plus a prune,
-- because two-hourly capture of 3,076 indexes is 448 MB in sixty days.

CREATE OR REPLACE FUNCTION public.fn_prune_index_usage_snapshots(p_keep_days integer DEFAULT 60)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_deleted integer := 0;
  v_aged    integer := 0;
BEGIN
  WITH bounds AS (
    SELECT postmaster_start, min(taken_at) AS lo, max(taken_at) AS hi
      FROM public.index_usage_snapshots
     WHERE postmaster_start <> (SELECT max(postmaster_start) FROM public.index_usage_snapshots)
     GROUP BY postmaster_start
  )
  DELETE FROM public.index_usage_snapshots s
   USING bounds b
   WHERE s.postmaster_start = b.postmaster_start
     AND s.taken_at <> b.lo
     AND s.taken_at <> b.hi;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  DELETE FROM public.index_usage_snapshots
   WHERE taken_at < now() - make_interval(days => p_keep_days);
  GET DIAGNOSTICS v_aged = ROW_COUNT;

  RETURN v_deleted + v_aged;
END;
$function$;

COMMENT ON FUNCTION public.fn_prune_index_usage_snapshots(integer) IS
  'Collapses each FINISHED postmaster epoch to its first and last capture (all a delta needs) and drops captures older than p_keep_days.';

DROP FUNCTION IF EXISTS public.fn_truly_unused_indexes(integer);

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
           max(p.bytes)                  AS bytes,
           sum(p.scans)                  AS total_scans,
           sum(p.span_seconds) / 86400.0 AS observed_days,
           count(*)::integer             AS epochs
      FROM per_epoch p
     GROUP BY p.tbl, p.idx
  )
  SELECT t.tbl, t.idx, t.bytes, pg_size_pretty(t.bytes),
         t.total_scans, round(t.observed_days, 2), t.epochs
    FROM totalled t
   WHERE t.total_scans = 0
     AND t.observed_days >= p_min_days
   ORDER BY t.bytes DESC;
END;
$function$;

COMMENT ON FUNCTION public.fn_truly_unused_indexes(integer) IS
  'Indexes with ZERO scans across every observed postmaster epoch, where observed time totals at least p_min_days. Sums per-epoch deltas because a restart resets idx_scan.';

-- Snapshot faster than the server restarts, and prune daily.
SELECT cron.alter_job(140, schedule => '41 */2 * * *');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'index-usage-snapshot-prune-daily') THEN
    PERFORM cron.schedule('index-usage-snapshot-prune-daily', '17 5 * * *',
                          'SELECT public.fn_prune_index_usage_snapshots(60);');
  END IF;
END $$;

DO $$
DECLARE v_sched text;
BEGIN
  SELECT schedule INTO v_sched FROM cron.job WHERE jobid = 140;
  IF v_sched <> '41 */2 * * *' THEN
    RAISE EXCEPTION 'snapshot cadence not changed: %', v_sched;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'index-usage-snapshot-prune-daily' AND active) THEN
    RAISE EXCEPTION 'prune job not scheduled';
  END IF;
END $$;
