-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820021814 "union_leaderboard_shape_alignment"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 76702afe388c3c367e30804421241eda of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Union board brought fully in line with club/global.               2026-08-20
--
-- fn_union_leaderboard_period_v2 predated the pagination work, so it returned
-- neither `rank`, `total_ranked`, `baseline_date` nor `sum_big_blind`, had no
-- p_offset, no bb100 metric, and (before 20260820b) ranked with row_number().
-- It is unreferenced by the client today, which is exactly why it kept drifting
-- from the two functions people actually look at.
--
-- It now matches them exactly: same columns, same argument list, tie-aware
-- rank(), bb100, the activity filter, and total_ranked as a window count over
-- the ranked set.
--
-- ROLLBACK: DROP FUNCTION fn_union_leaderboard_period_v2(uuid,text,text,integer,integer);
--           and restore the 4-arg version from 20260819k.

DROP FUNCTION IF EXISTS fn_union_leaderboard_period_v2(uuid, text, text, integer);

CREATE FUNCTION fn_union_leaderboard_period_v2(
  p_union_id uuid,
  p_metric   text    DEFAULT 'profit',
  p_period   text    DEFAULT 'weekly',
  p_limit    integer DEFAULT 20,
  p_offset   integer DEFAULT 0
)
RETURNS TABLE(user_id uuid, hands_played numeric, total_winnings numeric,
              total_losses numeric, tournaments_won numeric, total_rake numeric,
              sum_big_blind numeric, rank_change integer, qualified boolean,
              rank integer, total_ranked integer, baseline_date date)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
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
  WITH club_ids AS (SELECT uc.club_id FROM union_clubs uc WHERE uc.union_id = p_union_id),
  cur_ps AS (
    SELECT ps.user_id AS uid, SUM(ps.hands_dealt)::numeric AS s_hands,
           SUM(ps.total_winnings) AS s_win, SUM(ps.total_losses) AS s_loss,
           SUM(ps.tournaments_won)::numeric AS s_twon, SUM(ps.total_rake) AS s_rake,
           SUM(ps.sum_big_blind) AS s_bb
      FROM player_stats ps
     WHERE ps.club_id IN (SELECT club_id FROM club_ids)
     GROUP BY ps.user_id
  ),
  snap AS (
    SELECT s.user_id AS uid, s.snapshot_date AS d,
           SUM(s.hands_dealt)::numeric AS s_hands, SUM(s.total_winnings) AS s_win,
           SUM(s.total_losses) AS s_loss, SUM(s.tournaments_won)::numeric AS s_twon,
           SUM(s.sum_big_blind) AS s_bb
      FROM player_stats_snapshots s
     WHERE s.club_id IN (SELECT club_id FROM club_ids)
       AND s.snapshot_date IN (v_baseline, v_prev_end, v_prev_start)
     GROUP BY s.user_id, s.snapshot_date
  ),
  cur AS (
    SELECT c.uid,
           (CASE WHEN v_days=0 THEN c.s_hands ELSE GREATEST(c.s_hands-COALESCE(b.s_hands,0),0) END) AS d_hands,
           (CASE WHEN v_days=0 THEN c.s_win   ELSE (c.s_win -COALESCE(b.s_win,0))  END) AS d_win,
           (CASE WHEN v_days=0 THEN c.s_loss  ELSE (c.s_loss-COALESCE(b.s_loss,0)) END) AS d_loss,
           (CASE WHEN v_days=0 THEN c.s_twon  ELSE GREATEST(c.s_twon-COALESCE(b.s_twon,0),0) END) AS d_twon,
           c.s_rake AS d_rake,
           (CASE WHEN v_days=0 THEN c.s_bb    ELSE GREATEST(c.s_bb-COALESCE(b.s_bb,0),0) END) AS d_bb,
           (CASE WHEN pe.uid IS NULL THEN NULL ELSE GREATEST(pe.s_hands-COALESCE(pv.s_hands,0),0) END) AS p_hands,
           (CASE WHEN pe.uid IS NULL THEN NULL ELSE (pe.s_win -COALESCE(pv.s_win,0))  END) AS p_win,
           (CASE WHEN pe.uid IS NULL THEN NULL ELSE (pe.s_loss-COALESCE(pv.s_loss,0)) END) AS p_loss,
           (CASE WHEN pe.uid IS NULL THEN NULL ELSE GREATEST(pe.s_twon-COALESCE(pv.s_twon,0),0) END) AS p_twon,
           (CASE WHEN pe.uid IS NULL THEN NULL ELSE GREATEST(pe.s_bb-COALESCE(pv.s_bb,0),0) END) AS p_bb
      FROM cur_ps c
      LEFT JOIN snap b  ON v_days>0 AND b.uid=c.uid AND b.d=v_baseline
      LEFT JOIN snap pe ON pe.uid=c.uid AND pe.d=v_prev_end
      LEFT JOIN snap pv ON v_days>0 AND pv.uid=c.uid AND pv.d=v_prev_start
  ),
  scored AS (
    SELECT c.*,
           (CASE p_metric
              WHEN 'hands_played'    THEN c.d_hands
              WHEN 'tournaments_won' THEN c.d_twon
              WHEN 'roi'   THEN CASE WHEN c.d_loss>0 AND c.d_hands>=v_min_hands THEN (c.d_win-c.d_loss)/c.d_loss END
              WHEN 'bb100' THEN CASE WHEN c.d_bb  >0 AND c.d_hands>=v_min_hands THEN 100*(c.d_win-c.d_loss)/c.d_bb END
              ELSE (c.d_win-c.d_loss) END) AS score,
           (CASE p_metric
              WHEN 'hands_played'    THEN c.p_hands
              WHEN 'tournaments_won' THEN c.p_twon
              WHEN 'roi'   THEN CASE WHEN c.p_loss>0 AND c.p_hands>=v_min_hands THEN (c.p_win-c.p_loss)/c.p_loss END
              WHEN 'bb100' THEN CASE WHEN c.p_bb  >0 AND c.p_hands>=v_min_hands THEN 100*(c.p_win-c.p_loss)/c.p_bb END
              ELSE (c.p_win-c.p_loss) END) AS prev_score
      FROM cur c
  ),
  ranked AS (
    SELECT s.*,
           row_number() OVER (ORDER BY s.score DESC NULLS LAST, s.uid) AS rn_now,
           rank()       OVER (ORDER BY s.score DESC NULLS LAST)        AS rk_now,
           count(*)     OVER ()                                        AS total_active,
           CASE WHEN s.prev_score IS NULL THEN NULL
                ELSE rank() OVER (ORDER BY s.prev_score DESC NULLS LAST) END AS rk_old
      FROM scored s
     WHERE (s.d_hands > 0 OR s.d_twon > 0 OR s.d_win <> 0 OR s.d_loss <> 0)
  )
  SELECT r.uid, r.d_hands, r.d_win, r.d_loss, r.d_twon, r.d_rake, r.d_bb,
         COALESCE((r.rk_old - r.rk_now)::integer, 0),
         (p_metric NOT IN ('roi','bb100')
          OR (r.d_hands >= v_min_hands AND (CASE WHEN p_metric='roi' THEN r.d_loss ELSE r.d_bb END) > 0)),
         r.rk_now::integer, r.total_active::integer, v_baseline
    FROM ranked r
   ORDER BY r.rn_now
   LIMIT p_limit OFFSET GREATEST(COALESCE(p_offset,0),0);
END; $$;

GRANT EXECUTE ON FUNCTION fn_union_leaderboard_period_v2(uuid, text, text, integer, integer)
  TO authenticated, service_role;
