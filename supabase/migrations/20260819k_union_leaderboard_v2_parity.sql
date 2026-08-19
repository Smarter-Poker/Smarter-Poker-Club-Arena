-- Union leaderboard brought to parity with fn_club_leaderboard_period_v2.
--
-- fn_union_leaderboard_period (v1) still carried the two defects fixed for the
-- club and global boards in 20260819j:
--   * the ROI board was ordered by PROFIT, not ROI - its ORDER BY had no 'roi'
--     case, so it fell through to (winnings - losses)
--   * the hands metric read player_stats.hands_played, which is ~13% of reality
--     because RakebackSettlerService owns that column and only walks raked hands
-- and it exposed neither rank_change nor a volume qualifier.
--
-- The union path is currently unreferenced by the client (LeaderboardService
-- exported getUnionLeaderboard but nothing called it), so this is pre-emptive:
-- a correct function now means the first real caller does not inherit a bug
-- that was already fixed everywhere else.
--
-- Semantics are identical to the club v2, scoped to the union's member clubs:
--   * hands from hands_dealt (per seat, every cash hand)
--   * ROI = (win-loss)/loss with a 20-hand qualifier; unqualified players sort
--     last via NULLS LAST instead of being dropped
--   * rank_change vs the same-length window ending yesterday
--
-- Verified on apply: club / global / union ROI boards all return strictly
-- descending ROI with real hand counts.
--
-- ROLLBACK: DROP FUNCTION fn_union_leaderboard_period_v2(uuid,text,text,integer);
--           v1 fn_union_leaderboard_period is left untouched.

CREATE OR REPLACE FUNCTION public.fn_union_leaderboard_period_v2(p_union_id uuid, p_metric text DEFAULT 'profit'::text, p_period text DEFAULT 'weekly'::text, p_limit integer DEFAULT 20)
 RETURNS TABLE(user_id uuid, hands_played numeric, total_winnings numeric, total_losses numeric, tournaments_won numeric, total_rake numeric, rank_change integer, qualified boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_days integer; v_baseline date; v_prev_end date; v_prev_start date;
        v_min_hands integer := 20;
BEGIN
  v_days := CASE p_period WHEN 'daily' THEN 1 WHEN 'weekly' THEN 7 WHEN 'monthly' THEN 30 ELSE 0 END;

  IF v_days > 0 THEN
    SELECT max(snapshot_date) INTO v_baseline FROM player_stats_snapshots
     WHERE snapshot_date <= CURRENT_DATE - v_days;
    IF v_baseline IS NULL THEN SELECT min(snapshot_date) INTO v_baseline FROM player_stats_snapshots; END IF;
  END IF;

  SELECT max(snapshot_date) INTO v_prev_end FROM player_stats_snapshots
   WHERE snapshot_date <= CURRENT_DATE - 1;
  IF v_days > 0 THEN
    SELECT max(snapshot_date) INTO v_prev_start FROM player_stats_snapshots
     WHERE snapshot_date <= CURRENT_DATE - 1 - v_days;
  END IF;

  RETURN QUERY
  WITH club_ids AS (
    SELECT uc.club_id FROM union_clubs uc WHERE uc.union_id = p_union_id
  ),
  cur_ps AS (
    SELECT ps.user_id AS uid, SUM(ps.hands_dealt)::numeric AS s_hands,
           SUM(ps.total_winnings) AS s_win, SUM(ps.total_losses) AS s_loss,
           SUM(ps.tournaments_won)::numeric AS s_twon, SUM(ps.total_rake) AS s_rake
      FROM player_stats ps
     WHERE ps.club_id IN (SELECT club_id FROM club_ids)
     GROUP BY ps.user_id
  ),
  snap AS (
    SELECT s.user_id AS uid, s.snapshot_date AS d,
           SUM(s.hands_dealt)::numeric AS s_hands, SUM(s.total_winnings) AS s_win,
           SUM(s.total_losses) AS s_loss, SUM(s.tournaments_won)::numeric AS s_twon
      FROM player_stats_snapshots s
     WHERE s.club_id IN (SELECT club_id FROM club_ids)
       AND s.snapshot_date IN (v_baseline, v_prev_end, v_prev_start)
     GROUP BY s.user_id, s.snapshot_date
  ),
  cur AS (
    SELECT c.uid,
           (CASE WHEN v_days = 0 THEN c.s_hands ELSE GREATEST(c.s_hands - COALESCE(b.s_hands,0),0) END) AS d_hands,
           (CASE WHEN v_days = 0 THEN c.s_win   ELSE (c.s_win  - COALESCE(b.s_win,0))  END) AS d_win,
           (CASE WHEN v_days = 0 THEN c.s_loss  ELSE (c.s_loss - COALESCE(b.s_loss,0)) END) AS d_loss,
           (CASE WHEN v_days = 0 THEN c.s_twon  ELSE GREATEST(c.s_twon - COALESCE(b.s_twon,0),0) END) AS d_twon,
           c.s_rake AS d_rake,
           (CASE WHEN pe.uid IS NULL THEN NULL ELSE GREATEST(pe.s_hands - COALESCE(pv.s_hands,0),0) END) AS p_hands,
           (CASE WHEN pe.uid IS NULL THEN NULL ELSE (pe.s_win  - COALESCE(pv.s_win,0))  END) AS p_win,
           (CASE WHEN pe.uid IS NULL THEN NULL ELSE (pe.s_loss - COALESCE(pv.s_loss,0)) END) AS p_loss,
           (CASE WHEN pe.uid IS NULL THEN NULL ELSE GREATEST(pe.s_twon - COALESCE(pv.s_twon,0),0) END) AS p_twon
      FROM cur_ps c
      LEFT JOIN snap b  ON v_days > 0 AND b.uid  = c.uid AND b.d  = v_baseline
      LEFT JOIN snap pe ON pe.uid = c.uid AND pe.d = v_prev_end
      LEFT JOIN snap pv ON v_days > 0 AND pv.uid = c.uid AND pv.d = v_prev_start
  ),
  scored AS (
    SELECT c.*,
           (CASE p_metric
              WHEN 'hands_played'    THEN c.d_hands
              WHEN 'tournaments_won' THEN c.d_twon
              WHEN 'roi'             THEN CASE WHEN c.d_loss > 0 AND c.d_hands >= v_min_hands
                                               THEN (c.d_win - c.d_loss)/c.d_loss END
              ELSE (c.d_win - c.d_loss) END) AS score,
           (CASE p_metric
              WHEN 'hands_played'    THEN c.p_hands
              WHEN 'tournaments_won' THEN c.p_twon
              WHEN 'roi'             THEN CASE WHEN c.p_loss > 0 AND c.p_hands >= v_min_hands
                                               THEN (c.p_win - c.p_loss)/c.p_loss END
              ELSE (c.p_win - c.p_loss) END) AS prev_score
      FROM cur c
  ),
  ranked AS (
    SELECT s.*,
           row_number() OVER (ORDER BY s.score DESC NULLS LAST, s.uid) AS rn_now,
           CASE WHEN s.prev_score IS NULL THEN NULL
                ELSE row_number() OVER (ORDER BY s.prev_score DESC NULLS LAST, s.uid) END AS rn_old
      FROM scored s
  )
  SELECT r.uid, r.d_hands, r.d_win, r.d_loss, r.d_twon, r.d_rake,
         COALESCE((r.rn_old - r.rn_now)::integer, 0),
         (p_metric <> 'roi' OR (r.d_loss > 0 AND r.d_hands >= v_min_hands))
    FROM ranked r
   ORDER BY r.rn_now
   LIMIT p_limit;
END; $function$
;

GRANT EXECUTE ON FUNCTION fn_union_leaderboard_period_v2(uuid, text, text, integer)
  TO authenticated, service_role;
