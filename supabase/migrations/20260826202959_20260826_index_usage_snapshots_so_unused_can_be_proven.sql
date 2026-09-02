-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826202959; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- TIER 2. New table + two functions. Nothing existing is altered.
--
-- WHY THIS EXISTS INSTEAD OF A PILE OF DROP INDEX STATEMENTS
--
-- The performance advisor reports 1,338 unused indexes holding 895 MB, 783 MB
-- of it in ten indexes. Dropping them is the single biggest optimisation
-- available on this database -- every one is also maintained on every insert to
-- tables taking millions of writes.
--
-- It was NOT done, because the evidence does not support it. pg_stat_user_indexes
-- .idx_scan is cumulative since the last statistics reset, and:
--
--     pg_postmaster_start_time() ... 2026-08-26 16:27:36Z   (~4 hours ago)
--     hand_history live rows ....... 1,595,679
--     hand_history n_tup_ins ....... 76,233
--
-- 76k recorded inserts against 1.6M rows means the counters were reset at that
-- restart. `idx_scan = 0` therefore means "not used in the last four hours" and
-- nothing more. Every index serving a nightly, weekly or monthly job reads as
-- unused. Dropping on that basis would silently break reporting paths and the
-- damage would surface days later, far from the cause.
--
-- So: capture the evidence instead of guessing at it. Snapshot the counters
-- now, snapshot them again later, and compare only across a window that
-- contains no restart.
--
-- HOW TO USE IT
--   SELECT public.fn_snapshot_index_usage();       -- now, and daily thereafter
--   SELECT * FROM public.fn_truly_unused_indexes(7);   -- after a week
--
-- fn_truly_unused_indexes returns NOTHING until it has two snapshots spanning
-- the requested number of days with NO postmaster restart between them. It
-- refuses to answer rather than answering from reset counters. That refusal is
-- the whole point of the table.

CREATE TABLE IF NOT EXISTS public.index_usage_snapshots (
  taken_at            timestamptz NOT NULL DEFAULT now(),
  postmaster_start    timestamptz NOT NULL,
  schemaname          text        NOT NULL,
  relname             text        NOT NULL,
  indexrelname        text        NOT NULL,
  idx_scan            bigint      NOT NULL,
  index_bytes         bigint      NOT NULL,
  PRIMARY KEY (taken_at, schemaname, indexrelname)
);

COMMENT ON TABLE public.index_usage_snapshots IS
  'Point-in-time pg_stat_user_indexes.idx_scan captures. Exists because idx_scan is meaningless on its own after a restart resets it. Populate with fn_snapshot_index_usage(); read with fn_truly_unused_indexes(days).';

ALTER TABLE public.index_usage_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.index_usage_snapshots FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_snapshot_index_usage()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_n integer;
BEGIN
  INSERT INTO public.index_usage_snapshots
    (taken_at, postmaster_start, schemaname, relname, indexrelname, idx_scan, index_bytes)
  SELECT now(), pg_postmaster_start_time(), s.schemaname, s.relname, s.indexrelname,
         s.idx_scan, pg_relation_size(s.indexrelid)
    FROM pg_stat_user_indexes s
    JOIN pg_index i ON i.indexrelid = s.indexrelid
   WHERE s.schemaname = 'public'
     AND NOT i.indisunique      -- a unique index is a constraint, not a lookup aid
     AND NOT i.indisprimary
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_truly_unused_indexes(p_min_days integer DEFAULT 7)
RETURNS TABLE(
  relname text, indexrelname text, index_bytes bigint, pretty_size text,
  scans_in_window bigint, window_days numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_latest   timestamptz;
  v_earliest timestamptz;
  v_pm       timestamptz;
BEGIN
  SELECT max(taken_at) INTO v_latest FROM public.index_usage_snapshots;
  IF v_latest IS NULL THEN
    RAISE NOTICE 'no snapshots yet -- run SELECT fn_snapshot_index_usage() and come back in % days', p_min_days;
    RETURN;
  END IF;

  SELECT postmaster_start INTO v_pm
    FROM public.index_usage_snapshots WHERE taken_at = v_latest LIMIT 1;

  -- The oldest snapshot that shares the CURRENT postmaster start. Anything
  -- older sits on the far side of a restart and its counters cannot be compared.
  SELECT min(taken_at) INTO v_earliest
    FROM public.index_usage_snapshots
   WHERE postmaster_start = v_pm;

  IF v_earliest IS NULL OR v_latest - v_earliest < make_interval(days => p_min_days) THEN
    RAISE NOTICE 'not enough uninterrupted history: % of % days since the last restart at % -- refusing to report',
      round(EXTRACT(epoch FROM (v_latest - COALESCE(v_earliest, v_latest)))/86400.0, 2), p_min_days, v_pm;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT a.relname, a.indexrelname, b.index_bytes,
         pg_size_pretty(b.index_bytes),
         (b.idx_scan - a.idx_scan) AS scans_in_window,
         round(EXTRACT(epoch FROM (v_latest - v_earliest))/86400.0, 2)
    FROM public.index_usage_snapshots a
    JOIN public.index_usage_snapshots b
      ON b.indexrelname = a.indexrelname AND b.schemaname = a.schemaname
   WHERE a.taken_at = v_earliest
     AND b.taken_at = v_latest
     AND (b.idx_scan - a.idx_scan) = 0
   ORDER BY b.index_bytes DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_snapshot_index_usage()      FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_truly_unused_indexes(integer) FROM anon, authenticated;

-- Take the first snapshot now so the clock starts.
DO $$
DECLARE v_rows integer; v_snaps integer;
BEGIN
  SELECT public.fn_snapshot_index_usage() INTO v_rows;
  SELECT count(DISTINCT taken_at) INTO v_snaps FROM public.index_usage_snapshots;

  IF v_rows < 100 THEN
    RAISE EXCEPTION 'assertion failed: first snapshot captured only % index rows', v_rows;
  END IF;

  -- With a single snapshot the reader must refuse, not guess.
  IF EXISTS (SELECT 1 FROM public.fn_truly_unused_indexes(7)) THEN
    RAISE EXCEPTION 'assertion failed: fn_truly_unused_indexes returned rows from one snapshot';
  END IF;

  RAISE NOTICE 'baseline snapshot: % indexes captured, % snapshot(s) on file; reader correctly refuses until 7 uninterrupted days exist', v_rows, v_snaps;
END $$;
