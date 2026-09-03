-- ═══════════════════════════════════════════════════════════════════════════
--  THE UNUSED-INDEX EVIDENCE COULD NEVER ARRIVE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260826_index_usage_snapshots_so_unused_can_be_proven.sql got the hard part
-- right. It refused to name an index unused from `idx_scan` alone, because that
-- counter resets on restart, and it built a snapshot table so the claim could
-- be evidenced instead of guessed. Its rule:
--
--   "fn_truly_unused_indexes returns NOTHING until it holds two snapshots
--    spanning the requested days with NO postmaster restart between them."
--
-- That rule is correct and it is also, in this environment, unsatisfiable.
-- Measured 2026-08-31, five days after it shipped:
--
--     captures ................ 6
--     distinct server epochs ... 6      <- one capture per epoch, every time
--     uninterrupted history .... 0.000 days in EVERY epoch
--
-- The snapshot runs daily (pg_cron job 140, `41 4 * * *`). This server also
-- RESTARTS about daily - 01:15, 02:15, 04:32, 04:33 on consecutive days - so
-- every 04:41 capture lands in a fresh epoch and the next restart arrives before
-- the following one. Two snapshots have never once shared a postmaster_start,
-- so `fn_truly_unused_indexes(n)` returns nothing for ANY n > 0 and always will.
-- It is not broken; it is fail-safe machinery that can never reach a verdict.
--
-- The live advisor still reports ~1,129 unused indexes holding about 1.4 GB,
-- concentrated on the ledger tables that take a write on every hand -
-- vip_points_ledger (415 MB), solved_spots_gold (298 MB), wallet_transactions
-- (166 MB). That is a real prize. It stays unclaimed until it is earned.
--
-- TWO CHANGES, AND NOT ONE DROPPED INDEX
--
--   1. SNAPSHOT FASTER THAN THE SERVER RESTARTS. Every two hours, so a ~21-hour
--      epoch holds ~10 captures and yields a real within-epoch delta. Daily
--      cadence against daily restarts yields nothing, forever.
--
--   2. MEASURE ACROSS EPOCHS, NOT WITHIN ONE. A restart resets the counter, so
--      readings cannot be subtracted across it - but the DELTAS either side can
--      be ADDED. Usage is the sum of per-epoch deltas; the evidence window is
--      the sum of per-epoch spans. Waiting for seven uninterrupted days on a
--      box that reboots nightly is waiting forever.
--
-- Storage is the reason for the prune below: 3,076 indexes x 12 captures a day
-- is 448 MB in sixty days, which is not a price a diagnostic gets to charge on
-- a database already carrying 3.6 GB of hand history. Only the first and last
-- capture of each epoch carry information for a delta, so the rest are dropped
-- the next day: ~2 rows per index per epoch, about 45 MB at sixty days.

BEGIN;

-- ── 1. Keep only what a delta needs ────────────────────────────────────────
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
  -- Within a finished epoch only the earliest and latest capture matter: the
  -- delta is last minus first. Intermediate captures are kept for the CURRENT
  -- epoch, where the latest is still moving.
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
  'Collapses each FINISHED postmaster epoch to its first and last capture (all a delta needs) and drops captures older than p_keep_days. Without it, two-hourly capture of 3,076 indexes costs ~448 MB in sixty days. Maintenance only: no browser role holds EXECUTE.';

-- A SECURITY DEFINER FUNCTION THAT DELETES MUST NOT BE REACHABLE FROM A BROWSER.
-- Postgres grants EXECUTE to PUBLIC by default and Supabase publishes every
-- public function as an RPC, so this would otherwise have shipped as an
-- unauthenticated DELETE over the evidence this whole migration exists to
-- protect - somebody could erase the history and the drop list would quietly
-- reset to "no evidence" forever.
--
-- It cannot ask auth.uid() instead: pg_cron runs it with no JWT at all, so the
-- honest answer is that no browser role should hold it. Caught by
-- scripts/ci/check-definer-authorization.mjs in the pre-push hook, which is
-- exactly the rule extended on 2026-08-31 one phase earlier.
REVOKE ALL ON FUNCTION public.fn_prune_index_usage_snapshots(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_prune_index_usage_snapshots(integer) TO service_role;

-- ── 2. Sum the deltas across epochs, because the counter resets between them ─
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
    -- idx_scan only ever climbs WITHIN an epoch, so last-minus-first is that
    -- epoch's usage. Across a restart the counter falls back to zero, which is
    -- exactly why these are summed rather than subtracted end to end.
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
           max(p.bytes)                              AS bytes,
           sum(p.scans)                              AS total_scans,
           sum(p.span_seconds) / 86400.0             AS observed_days,
           count(*)::integer                         AS epochs
      FROM per_epoch p
     GROUP BY p.tbl, p.idx
  )
  SELECT t.tbl,
         t.idx,
         t.bytes,
         pg_size_pretty(t.bytes),
         t.total_scans,
         round(t.observed_days, 2),
         t.epochs
    FROM totalled t
   -- FAIL CLOSED, exactly as the original did. An index is only reported when
   -- it has been WATCHED for long enough, so a newly created index cannot be
   -- mistaken for a dead one just because it has no history yet.
   WHERE t.total_scans = 0
     AND t.observed_days >= p_min_days
   ORDER BY t.bytes DESC;
END;
$function$;

COMMENT ON FUNCTION public.fn_truly_unused_indexes(integer) IS
  'Indexes with ZERO scans across every observed postmaster epoch, where the observed time totals at least p_min_days. Sums per-epoch deltas because a restart resets idx_scan - the previous single-epoch version could never reach a verdict on a server that restarts nightly.';

COMMIT;
