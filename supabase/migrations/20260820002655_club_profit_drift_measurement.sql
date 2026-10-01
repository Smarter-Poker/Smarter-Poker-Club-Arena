-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820002655 "club_profit_drift_measurement"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 409afa4b8431c454a7d2423b666591ab of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- CLUB DASHBOARD PROFIT — exact figures + drift measurement (READ ONLY)
-- ═══════════════════════════════════════════════════════════════════════════
-- Diagnosis, not repair. club_member_daily_stats.profit is owned by the club
-- dashboard feature and is being actively developed, so nothing here writes to
-- it; these functions make the defect measurable and supply the correct number
-- so the owning change can be made deliberately.
--
-- THE DEFECT. That column is a stack delta (stack - last_stack) counted only
-- when an "attributable" heuristic passes; when it fails the row is DROPPED. A
-- rebuy looks like a gain, so failures skew toward dropped LOSSES and the
-- aggregate drifts positive. Measured against the feature's OWN club_hand_daily
-- rake rollup, where the sum of all players' profit for a day must equal
-- -(rake + bbj):
--     2026-08-18   players -15,133.76   house 154,815.40   drift +139,681.64
--     2026-08-19   players +27,726.85   house  96,029.71   drift +123,756.56
-- and it correlates with the leaderboard's per-player profit at r = 0.0036
-- (459 of 461 players disagree by >1 chip). Players collectively cannot be UP
-- while paying rake.
--
-- THE CORRECT NUMBER. The leaderboard ledger is exact by construction: winnings
-- from hand_history.winners, losses from the engine's own per-player
-- contributions, so profit = SUM(won - invested) and Σlosses - Σwinnings
-- reconciles to rake + bbj (measured 100.05% / 99.9999%).
-- fn_club_member_daily_profit_exact(club, date) returns it per user from the
-- daily snapshots, which is what a repair should assign.
--
-- Exact only for dates on/after 2026-08-20: before then the snapshots'
-- winnings/losses were backfilled from RAKED hands only, so a delta across
-- those dates carries the same partial basis.
--
-- ROLLBACK: DROP FUNCTION fn_club_member_daily_profit_exact(uuid, date);
--           DROP FUNCTION fn_club_profit_drift(uuid, date);

CREATE OR REPLACE FUNCTION fn_club_member_daily_profit_exact(p_club_id uuid, p_date date)
RETURNS TABLE(user_id uuid, exact_profit numeric, basis text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.user_id,
         (a.total_winnings - b.total_winnings) - (a.total_losses - b.total_losses),
         CASE WHEN p_date >= DATE '2026-08-20' THEN 'exact'
              ELSE 'partial_raked_hands_only' END
    FROM player_stats_snapshots b
    JOIN player_stats_snapshots a
      ON a.user_id = b.user_id AND a.club_id = b.club_id AND a.snapshot_date = p_date + 1
   WHERE b.snapshot_date = p_date AND b.club_id = p_club_id;
$$;

CREATE OR REPLACE FUNCTION fn_club_profit_drift(p_club_id uuid, p_date date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH dash AS (
    SELECT COALESCE(round(SUM(profit)::numeric, 2), 0) AS s
      FROM club_member_daily_stats WHERE club_id = p_club_id AND stat_date = p_date
  ), house AS (
    SELECT COALESCE(round((rake + bbj)::numeric, 2), 0) AS s
      FROM club_hand_daily WHERE club_id = p_club_id AND stat_date = p_date
  ), exact AS (
    SELECT COALESCE(round(SUM(exact_profit)::numeric, 2), 0) AS s
      FROM fn_club_member_daily_profit_exact(p_club_id, p_date)
  )
  SELECT jsonb_build_object(
    'club_id', p_club_id,
    'stat_date', p_date,
    'dashboard_player_profit', (SELECT s FROM dash),
    'exact_player_profit',     (SELECT s FROM exact),
    'house_cut',               (SELECT s FROM house),
    -- Both must satisfy: player profit + house cut = 0.
    'dashboard_drift', (SELECT s FROM dash)  + (SELECT s FROM house),
    'exact_drift',     (SELECT s FROM exact) + (SELECT s FROM house)
  );
$$;

GRANT EXECUTE ON FUNCTION fn_club_member_daily_profit_exact(uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_club_profit_drift(uuid, date) TO authenticated, service_role;
