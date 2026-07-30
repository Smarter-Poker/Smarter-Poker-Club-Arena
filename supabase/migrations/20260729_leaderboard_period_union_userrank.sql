-- Extend delta-based leaderboard periods (club version live) to the union
-- leaderboard (aggregate per-user deltas across all member clubs) and to a user's
-- own rank. Reuses player_stats_snapshots. Applied via Supabase MCP 2026-07-29.

CREATE OR REPLACE FUNCTION public.fn_union_leaderboard_period(
  p_union_id uuid, p_metric text DEFAULT 'profit',
  p_period text DEFAULT 'weekly', p_limit integer DEFAULT 20
) RETURNS TABLE(
  user_id uuid, hands_played numeric, total_winnings numeric,
  total_losses numeric, tournaments_won numeric, total_rake numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_days integer; v_target date;
BEGIN
  v_days := CASE p_period WHEN 'daily' THEN 1 WHEN 'weekly' THEN 7 WHEN 'monthly' THEN 30 ELSE 0 END;
  IF v_days = 0 THEN
    RETURN QUERY
      SELECT ps.user_id, sum(ps.hands_played)::numeric, sum(ps.total_winnings)::numeric,
             sum(ps.total_losses)::numeric, sum(ps.tournaments_won)::numeric, sum(ps.total_rake)::numeric
      FROM player_stats ps
      WHERE ps.club_id IN (SELECT club_id FROM union_clubs WHERE union_id = p_union_id)
      GROUP BY ps.user_id
      ORDER BY (CASE p_metric WHEN 'hands_played' THEN sum(ps.hands_played)
                              WHEN 'tournaments_won' THEN sum(ps.tournaments_won)
                              ELSE sum(ps.total_winnings - ps.total_losses) END) DESC
      LIMIT p_limit;
    RETURN;
  END IF;
  v_target := CURRENT_DATE - v_days;
  RETURN QUERY
    WITH club_ids AS (SELECT club_id FROM union_clubs WHERE union_id = p_union_id),
    baselines AS (
      SELECT ci.club_id,
             COALESCE(
               (SELECT max(s.snapshot_date) FROM player_stats_snapshots s WHERE s.club_id = ci.club_id AND s.snapshot_date <= v_target),
               (SELECT min(s.snapshot_date) FROM player_stats_snapshots s WHERE s.club_id = ci.club_id)
             ) AS baseline_date
      FROM club_ids ci
    ),
    deltas AS (
      SELECT ps.user_id,
             GREATEST(ps.hands_played - COALESCE(sn.hands_played,0),0) AS d_hands,
             (ps.total_winnings - COALESCE(sn.total_winnings,0)) AS d_win,
             (ps.total_losses - COALESCE(sn.total_losses,0)) AS d_loss,
             GREATEST(ps.tournaments_won - COALESCE(sn.tournaments_won,0),0) AS d_tw,
             GREATEST(ps.total_rake - COALESCE(sn.total_rake,0),0) AS d_rake
      FROM player_stats ps
      JOIN baselines b ON b.club_id = ps.club_id
      LEFT JOIN player_stats_snapshots sn
        ON sn.user_id = ps.user_id AND sn.club_id = ps.club_id AND sn.snapshot_date = b.baseline_date
      WHERE ps.club_id IN (SELECT club_id FROM club_ids)
    )
    SELECT d.user_id, sum(d.d_hands)::numeric, sum(d.d_win)::numeric, sum(d.d_loss)::numeric,
           sum(d.d_tw)::numeric, sum(d.d_rake)::numeric
    FROM deltas d GROUP BY d.user_id
    ORDER BY (CASE p_metric WHEN 'hands_played' THEN sum(d.d_hands)
                            WHEN 'tournaments_won' THEN sum(d.d_tw)
                            ELSE sum(d.d_win - d.d_loss) END) DESC
    LIMIT p_limit;
END; $$;

CREATE OR REPLACE FUNCTION public.fn_user_rank_period(
  p_user_id uuid, p_club_id uuid, p_metric text DEFAULT 'profit', p_period text DEFAULT 'weekly'
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_days integer; v_target date; v_baseline date;
        v_rank integer; v_total integer; v_user_val numeric;
BEGIN
  v_days := CASE p_period WHEN 'daily' THEN 1 WHEN 'weekly' THEN 7 WHEN 'monthly' THEN 30 ELSE 0 END;
  IF v_days > 0 THEN
    v_target := CURRENT_DATE - v_days;
    SELECT max(snapshot_date) INTO v_baseline FROM player_stats_snapshots
     WHERE club_id = p_club_id AND snapshot_date <= v_target;
    IF v_baseline IS NULL THEN
      SELECT min(snapshot_date) INTO v_baseline FROM player_stats_snapshots WHERE club_id = p_club_id;
    END IF;
  END IF;
  WITH vals AS (
    SELECT ps.user_id,
      (CASE
        WHEN v_days = 0 THEN
          (CASE p_metric WHEN 'hands_played' THEN ps.hands_played::numeric
                         WHEN 'tournaments_won' THEN ps.tournaments_won::numeric
                         ELSE (ps.total_winnings - ps.total_losses) END)
        ELSE
          (CASE p_metric
            WHEN 'hands_played' THEN GREATEST(ps.hands_played - COALESCE(s.hands_played,0),0)::numeric
            WHEN 'tournaments_won' THEN GREATEST(ps.tournaments_won - COALESCE(s.tournaments_won,0),0)::numeric
            ELSE ((ps.total_winnings - COALESCE(s.total_winnings,0)) - (ps.total_losses - COALESCE(s.total_losses,0))) END)
      END) AS val
    FROM player_stats ps
    LEFT JOIN player_stats_snapshots s
      ON v_days > 0 AND s.user_id = ps.user_id AND s.club_id = ps.club_id AND s.snapshot_date = v_baseline
    WHERE ps.club_id = p_club_id
  )
  SELECT (SELECT count(*) FROM vals WHERE val > (SELECT val FROM vals WHERE user_id = p_user_id)) + 1,
         (SELECT count(*) FROM vals),
         (SELECT val FROM vals WHERE user_id = p_user_id)
  INTO v_rank, v_total, v_user_val;
  IF v_user_val IS NULL THEN RETURN jsonb_build_object('found', false); END IF;
  RETURN jsonb_build_object('found', true, 'rank', v_rank, 'total', v_total, 'value', v_user_val);
END; $$;

GRANT EXECUTE ON FUNCTION public.fn_union_leaderboard_period(uuid, text, text, integer) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.fn_user_rank_period(uuid, uuid, text, text) TO authenticated, service_role, anon;
