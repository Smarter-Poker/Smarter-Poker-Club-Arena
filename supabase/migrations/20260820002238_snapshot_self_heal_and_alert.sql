-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820002238 "snapshot_self_heal_and_alert"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 048aea23018a591e6aaccf6d67698662 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- SNAPSHOT SELF-HEAL                                               2026-08-19
-- ═══════════════════════════════════════════════════════════════════════════
-- Every period leaderboard is a delta against player_stats_snapshots. The
-- capture job (pg_cron 'snapshot-player-stats', 00:05 UTC) has 21 runs and 1
-- failure: 2026-08-09, which is exactly the day missing from the table. On a
-- miss the leaderboard RPCs fall back to an older snapshot and "This Week"
-- silently becomes a longer window.
--
-- A missed day cannot be reconstructed after the fact - a snapshot is a
-- point-in-time capture of cumulative counters, and those counters have moved
-- on. So the mitigation is to make the miss (a) far less likely and (b) loud.
--
-- fn_snapshot_player_stats_if_missing() captures TODAY only when today has no
-- rows at all. That makes the job safely re-runnable: a retry later in the day
-- fills a gap left by a failed 00:05 run (a few hours of drift on one boundary,
-- versus losing the day entirely), and a retry after a SUCCESSFUL run is a
-- no-op rather than overwriting the morning baseline with midday values -
-- which is what calling the plain function again would do.
--
-- Scheduled via Open Claw per CLAUDE.md section 11 (new scheduled work does not
-- go to pg_cron). Handler: pages/api/cron/snapshot-player-stats-heal.js
--
-- ROLLBACK:
--   DROP FUNCTION fn_snapshot_player_stats_if_missing();
--   DROP FUNCTION fn_snapshot_health();

CREATE OR REPLACE FUNCTION fn_snapshot_player_stats_if_missing()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_exists boolean; v_res jsonb;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM player_stats_snapshots WHERE snapshot_date = CURRENT_DATE
  ) INTO v_exists;

  IF v_exists THEN
    RETURN jsonb_build_object(
      'healed', false, 'reason', 'snapshot_already_present', 'date', CURRENT_DATE);
  END IF;

  v_res := fn_snapshot_player_stats();
  RETURN jsonb_build_object(
    'healed', true, 'date', CURRENT_DATE, 'capture', v_res);
END; $$;

-- Health probe: what the alert reads. Returns the gap list plus whether TODAY
-- has been captured yet, so a monitor can distinguish "not captured yet, it is
-- 00:03" from "the job failed and we are now missing a day".
CREATE OR REPLACE FUNCTION fn_snapshot_health(p_days integer DEFAULT 35)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'today', CURRENT_DATE,
    'today_captured', EXISTS (SELECT 1 FROM player_stats_snapshots WHERE snapshot_date = CURRENT_DATE),
    'latest_snapshot', (SELECT max(snapshot_date) FROM player_stats_snapshots),
    'missing_days', COALESCE(
      (SELECT jsonb_agg(missing_date ORDER BY missing_date)
         FROM fn_leaderboard_snapshot_gaps(p_days)), '[]'::jsonb),
    'missing_count', (SELECT count(*) FROM fn_leaderboard_snapshot_gaps(p_days))
  );
$$;

GRANT EXECUTE ON FUNCTION fn_snapshot_player_stats_if_missing() TO service_role;
GRANT EXECUTE ON FUNCTION fn_snapshot_health(integer) TO authenticated, service_role;

DO $$
DECLARE v jsonb;
BEGIN
  -- Must be a no-op today: today's snapshot already exists.
  v := fn_snapshot_player_stats_if_missing();
  IF (v->>'healed')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'self-heal should have been a no-op today, got %', v;
  END IF;
END $$;
