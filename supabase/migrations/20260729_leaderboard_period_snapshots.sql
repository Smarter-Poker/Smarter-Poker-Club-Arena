-- Leaderboard period filters: player_stats holds only cumulative all-time totals,
-- so daily/weekly/monthly tabs all showed identical data. Daily snapshots +
-- delta-based period leaderboard. Periods = current cumulative minus the snapshot
-- at the period start (accurate going forward as snapshots accumulate).
-- Applied to production via Supabase MCP on 2026-07-29 (incl. baseline snapshot +
-- pg_cron daily schedule 'snapshot-player-stats' at 00:05 UTC).

CREATE TABLE IF NOT EXISTS public.player_stats_snapshots (
  user_id            uuid NOT NULL,
  club_id            uuid NOT NULL,
  snapshot_date      date NOT NULL DEFAULT CURRENT_DATE,
  hands_played       bigint DEFAULT 0,
  total_winnings     numeric DEFAULT 0,
  total_losses       numeric DEFAULT 0,
  total_rake         numeric DEFAULT 0,
  tournaments_played bigint DEFAULT 0,
  tournaments_won    bigint DEFAULT 0,
  PRIMARY KEY (user_id, club_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_pss_club_date ON public.player_stats_snapshots(club_id, snapshot_date);

CREATE OR REPLACE FUNCTION public.fn_snapshot_player_stats()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count integer;
BEGIN
  INSERT INTO player_stats_snapshots
    (user_id, club_id, snapshot_date, hands_played, total_winnings, total_losses,
     total_rake, tournaments_played, tournaments_won)
  SELECT user_id, club_id, CURRENT_DATE,
         COALESCE(hands_played,0), COALESCE(total_winnings,0), COALESCE(total_losses,0),
         COALESCE(total_rake,0), COALESCE(tournaments_played,0), COALESCE(tournaments_won,0)
  FROM player_stats WHERE club_id IS NOT NULL
  ON CONFLICT (user_id, club_id, snapshot_date) DO UPDATE SET
    hands_played=EXCLUDED.hands_played, total_winnings=EXCLUDED.total_winnings,
    total_losses=EXCLUDED.total_losses, total_rake=EXCLUDED.total_rake,
    tournaments_played=EXCLUDED.tournaments_played, tournaments_won=EXCLUDED.tournaments_won;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'rows', v_count, 'date', CURRENT_DATE);
END; $$;

CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_period(
  p_club_id uuid, p_metric text DEFAULT 'profit',
  p_period text DEFAULT 'weekly', p_limit integer DEFAULT 10
) RETURNS TABLE(
  user_id uuid, hands_played numeric, total_winnings numeric,
  total_losses numeric, tournaments_won numeric, total_rake numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_days integer; v_target date; v_baseline date;
BEGIN
  v_days := CASE p_period WHEN 'daily' THEN 1 WHEN 'weekly' THEN 7 WHEN 'monthly' THEN 30 ELSE 0 END;
  IF v_days = 0 THEN
    RETURN QUERY
      SELECT ps.user_id, ps.hands_played::numeric, ps.total_winnings::numeric,
             ps.total_losses::numeric, ps.tournaments_won::numeric, ps.total_rake::numeric
      FROM player_stats ps WHERE ps.club_id = p_club_id
      ORDER BY (CASE p_metric WHEN 'hands_played' THEN ps.hands_played::numeric
                              WHEN 'tournaments_won' THEN ps.tournaments_won::numeric
                              ELSE (ps.total_winnings - ps.total_losses) END) DESC
      LIMIT p_limit;
    RETURN;
  END IF;
  v_target := CURRENT_DATE - v_days;
  SELECT max(snapshot_date) INTO v_baseline FROM player_stats_snapshots
   WHERE club_id = p_club_id AND snapshot_date <= v_target;
  IF v_baseline IS NULL THEN
    SELECT min(snapshot_date) INTO v_baseline FROM player_stats_snapshots WHERE club_id = p_club_id;
  END IF;
  RETURN QUERY
    SELECT ps.user_id,
           GREATEST(ps.hands_played - COALESCE(s.hands_played,0),0)::numeric,
           (ps.total_winnings - COALESCE(s.total_winnings,0))::numeric,
           (ps.total_losses - COALESCE(s.total_losses,0))::numeric,
           GREATEST(ps.tournaments_won - COALESCE(s.tournaments_won,0),0)::numeric,
           GREATEST(ps.total_rake - COALESCE(s.total_rake,0),0)::numeric
    FROM player_stats ps
    LEFT JOIN player_stats_snapshots s
      ON s.user_id = ps.user_id AND s.club_id = ps.club_id AND s.snapshot_date = v_baseline
    WHERE ps.club_id = p_club_id
    ORDER BY (CASE p_metric
      WHEN 'hands_played' THEN GREATEST(ps.hands_played - COALESCE(s.hands_played,0),0)
      WHEN 'tournaments_won' THEN GREATEST(ps.tournaments_won - COALESCE(s.tournaments_won,0),0)
      ELSE ((ps.total_winnings - COALESCE(s.total_winnings,0)) - (ps.total_losses - COALESCE(s.total_losses,0)))
    END) DESC
    LIMIT p_limit;
END; $$;

GRANT EXECUTE ON FUNCTION public.fn_snapshot_player_stats() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_leaderboard_period(uuid, text, text, integer) TO authenticated, service_role, anon;
