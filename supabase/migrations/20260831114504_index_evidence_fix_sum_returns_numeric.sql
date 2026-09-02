-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831114504; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- sum(bigint) returns NUMERIC in Postgres, and the RETURNS TABLE column is
-- declared bigint, so the previous revision raised
--   "Returned type numeric does not match expected type bigint in column 5"
-- on EVERY call. Caught by calling it rather than by reading it. Cast at the
-- point of the sum so the declared shape and the produced shape agree.

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

COMMENT ON FUNCTION public.fn_truly_unused_indexes(integer) IS
  'Indexes with ZERO scans across every observed postmaster epoch, where observed time totals at least p_min_days. Sums per-epoch deltas because a restart resets idx_scan.';

DO $$
DECLARE v_n integer;
BEGIN
  -- It must RUN. The previous revision type-errored on every call.
  SELECT count(*) INTO v_n FROM public.fn_truly_unused_indexes(9999);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'a 9999-day evidence window returned % rows; the fail-closed guard is broken', v_n;
  END IF;
END $$;
