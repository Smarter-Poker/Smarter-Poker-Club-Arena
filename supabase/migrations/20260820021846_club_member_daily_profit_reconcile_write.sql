-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820021846 "club_member_daily_profit_reconcile_write"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 47c6de1d295bb5b0d9c2052ad4cf3216 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Reconcile club_member_daily_stats.profit for COMPLETED days   2026-08-20
-- ═══════════════════════════════════════════════════════════════════════════
-- That column is a stack delta counted only when an "attributable" heuristic
-- passes; when it fails the row is DROPPED. A rebuy looks like a gain, so the
-- failures skew toward dropped LOSSES and the aggregate drifts positive.
--
-- Invariant: for a club-day, SUM(player profit) + (rake + bbj) = 0. Players
-- collectively cannot be up while paying rake. Measured against that feature's
-- own club_hand_daily rollup on 2026-08-18:
--     Club JAQK      dashboard drift  +83,345.86    exact drift    13.34
--     SHARK CLUB     dashboard drift  +90,667.66    exact drift    14.75
--     Midway (08-19) dashboard drift +567,769.70    exact drift 2,611.25
--
-- The exact figure comes from the leaderboard ledger, which is exact by
-- construction: winnings from hand_history.winners, losses from the engine's
-- own per-player contributions. It is applied here from the daily snapshots.
--
-- Deferred earlier because that table was being bulk-rewritten (80,193 rows in
-- one hour). That rebuild has since settled to ~729/hour, i.e. ordinary live
-- trigger traffic on TODAY only, which this never touches.
--
-- SAFETY:
--   * completed days only, never today - the live trigger owns today
--   * only dates >= 2026-08-20, the first full day on the exact ledger. Before
--     that the snapshots' winnings/losses were backfilled from RAKED hands
--     only, so reconciling would move one approximation onto another
--   * requires snapshots on both boundaries; returns a reason rather than
--     guessing if either is missing
--   * idempotent - recomputes from source, never accumulates, so re-running
--     after the owning feature rebuilds a day simply re-corrects it
--   * per-user totals become exact; the split across that user's per-table rows
--     is proportional to hands. Safe because both consumers of this column
--     (ca_club_top_players, ca_club_members) aggregate profit per USER -
--     ca_club_top_players never references table_id - so the split is not read
--
-- ROLLBACK: DROP FUNCTION fn_reconcile_club_member_daily_profit(date);
--           re-running the owning feature's ca_rebuild_club_member_stats_table
--           restores its own estimate.

CREATE OR REPLACE FUNCTION fn_reconcile_club_member_daily_profit(p_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutover date := DATE '2026-08-20';
  v_rows    integer := 0;
BEGIN
  IF p_date IS NULL OR p_date >= CURRENT_DATE THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'day_not_complete', 'date', p_date);
  END IF;
  IF p_date < v_cutover THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'before_exact_ledger_cutover',
                              'date', p_date, 'cutover', v_cutover);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM player_stats_snapshots WHERE snapshot_date = p_date)
     OR NOT EXISTS (SELECT 1 FROM player_stats_snapshots WHERE snapshot_date = p_date + 1) THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'missing_boundary_snapshot', 'date', p_date);
  END IF;

  WITH exact AS (
    SELECT b.user_id, b.club_id,
           (a.total_winnings - b.total_winnings) - (a.total_losses - b.total_losses) AS profit
      FROM player_stats_snapshots b
      JOIN player_stats_snapshots a
        ON a.user_id = b.user_id AND a.club_id = b.club_id AND a.snapshot_date = p_date + 1
     WHERE b.snapshot_date = p_date
  ),
  shares AS (
    SELECT s.club_id, s.user_id, s.table_id, e.profit AS exact_profit,
           GREATEST(COALESCE(s.hands_played,0),0) AS w,
           SUM(GREATEST(COALESCE(s.hands_played,0),0)) OVER (PARTITION BY s.club_id, s.user_id) AS w_total,
           COUNT(*)     OVER (PARTITION BY s.club_id, s.user_id) AS n_rows,
           ROW_NUMBER() OVER (PARTITION BY s.club_id, s.user_id ORDER BY s.table_id) AS rn
      FROM club_member_daily_stats s
      JOIN exact e ON e.user_id = s.user_id AND e.club_id = s.club_id
     WHERE s.stat_date = p_date
  ),
  alloc AS (
    SELECT club_id, user_id, table_id, exact_profit, rn, n_rows,
           CASE WHEN w_total > 0 THEN round(exact_profit * w / w_total, 2)
                ELSE round(exact_profit / n_rows, 2) END AS share
      FROM shares
  ),
  fixed AS (
    -- last row absorbs the rounding remainder so the per-user total is exact
    SELECT a.*, a.exact_profit - SUM(a.share) OVER (PARTITION BY a.club_id, a.user_id) AS remainder
      FROM alloc a
  )
  UPDATE club_member_daily_stats s
     SET profit = f.share + CASE WHEN f.rn = f.n_rows THEN f.remainder ELSE 0 END,
         updated_at = now()
    FROM fixed f
   WHERE s.stat_date = p_date
     AND s.club_id = f.club_id AND s.user_id = f.user_id
     AND s.table_id IS NOT DISTINCT FROM f.table_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('reconciled', true, 'date', p_date, 'rows_updated', v_rows);
END; $$;

GRANT EXECUTE ON FUNCTION fn_reconcile_club_member_daily_profit(date) TO service_role;
