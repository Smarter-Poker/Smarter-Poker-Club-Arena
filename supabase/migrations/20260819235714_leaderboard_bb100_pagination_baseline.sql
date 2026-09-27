-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819235714 "leaderboard_bb100_pagination_baseline"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 81239d244aff4adc7778f0323654d8ab of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- LEADERBOARD: bb/100 metric, pagination, honest window, gap detection
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. New metric 'bb100' = 100 * (win - loss) / SUM(big_blind over hands dealt).
--    Stake-normalised win rate; chip profit alone ranks a 15/30 loser above a
--    1/2 winner. Same 20-hand qualifier as ROI.
-- 2. Pagination: p_offset, plus total_ranked so the client can say "50 of 575"
--    and page without re-deriving the population.
-- 3. baseline_date returned so the UI can label the window truthfully. The
--    snapshot job has already missed a day (2026-08-09 failed, verified in
--    cron.job_run_details), and on a miss these functions silently fall back to
--    an older snapshot - "This Week" quietly becomes 8 days. Returning the date
--    makes that visible instead of invisible.
-- 4. fn_leaderboard_snapshot_gaps() reports missing snapshot days so the
--    condition is detectable at all.
--
-- ROLLBACK: restore the two functions from 20260819j/20260819k and
--           DROP FUNCTION fn_leaderboard_snapshot_gaps().

CREATE OR REPLACE FUNCTION fn_leaderboard_snapshot_gaps(p_days integer DEFAULT 35)
RETURNS TABLE(missing_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d::date
  FROM generate_series(
         GREATEST((SELECT min(snapshot_date) FROM player_stats_snapshots),
                  CURRENT_DATE - p_days),
         CURRENT_DATE - 1, interval '1 day') d
  WHERE NOT EXISTS (
    SELECT 1 FROM player_stats_snapshots s WHERE s.snapshot_date = d::date
  );
$$;
GRANT EXECUTE ON FUNCTION fn_leaderboard_snapshot_gaps(integer) TO authenticated, service_role;

DROP FUNCTION IF EXISTS fn_club_leaderboard_period_v2(uuid, text, text, integer);
DROP FUNCTION IF EXISTS fn_global_leaderboard_period(text, text, integer);

CREATE FUNCTION fn_club_leaderboard_period_v2(
  p_club_id uuid,
  p_metric  text    DEFAULT 'profit',
  p_period  text    DEFAULT 'weekly',
  p_limit   integer DEFAULT 10,
  p_offset  integer DEFAULT 0
)
RETURNS TABLE(user_id uuid, hands_played numeric, total_winnings numeric,
              total_losses numeric, tournaments_won numeric, total_rake numeric,
              sum_big_blind numeric, rank_change integer, qualified boolean,
              rank integer, total_ranked integer, baseline_date date)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_days integer; v_baseline date; v_prev_end date; v_prev_start date;
        v_min_hands integer := 20; v_total integer;
BEGIN
  v_days := CASE p_period WHEN 'daily' THEN 1 WHEN 'weekly' THEN 7 WHEN 'monthly' THEN 30 ELSE 0 END;

  IF v_days > 0 THEN
    SELECT max(snapshot_date) INTO v_baseline FROM player_stats_snapshots
     WHERE club_id = p_club_id AND snapshot_date <= CURRENT_DATE - v_days;
    IF v_baseline IS NULL THEN
      SELECT min(snapshot_date) INTO v_baseline FROM player_stats_snapshots WHERE club_id = p_club_id;
    END IF;
  END IF;

  SELECT max(snapshot_date) INTO v_prev_end FROM player_stats_snapshots
   WHERE club_id = p_club_id AND snapshot_date <= CURRENT_DATE - 1;
  IF v_days > 0 THEN
    SELECT max(snapshot_date) INTO v_prev_start FROM player_stats_snapshots
     WHERE club_id = p_club_id AND snapshot_date <= CURRENT_DATE - 1 - v_days;
  END IF;

  SELECT count(*) INTO v_total FROM player_stats ps WHERE ps.club_id = p_club_id;

  RETURN QUERY
  WITH cur AS (
    SELECT ps.user_id AS uid,
           (CASE WHEN v_days=0 THEN ps.hands_dealt::numeric ELSE GREATEST(ps.hands_dealt-COALESCE(b.hands_dealt,0),0)::numeric END) AS d_hands,
           (CASE WHEN v_days=0 THEN ps.total_winnings ELSE (ps.total_winnings-COALESCE(b.total_winnings,0)) END) AS d_win,
           (CASE WHEN v_days=0 THEN ps.total_losses  ELSE (ps.total_losses -COALESCE(b.total_losses,0))  END) AS d_loss,
           (CASE WHEN v_days=0 THEN ps.tournaments_won::numeric ELSE GREATEST(ps.tournaments_won-COALESCE(b.tournaments_won,0),0)::numeric END) AS d_twon,
           (CASE WHEN v_days=0 THEN ps.total_rake ELSE GREATEST(ps.total_rake-COALESCE(b.total_rake,0),0) END) AS d_rake,
           (CASE WHEN v_days=0 THEN ps.sum_big_blind ELSE GREATEST(ps.sum_big_blind-COALESCE(b.sum_big_blind,0),0) END) AS d_bb,
           (CASE WHEN pe.user_id IS NULL THEN NULL ELSE GREATEST(pe.hands_dealt-COALESCE(pv.hands_dealt,0),0)::numeric END) AS p_hands,
           (CASE WHEN pe.user_id IS NULL THEN NULL ELSE (pe.total_winnings-COALESCE(pv.total_winnings,0)) END) AS p_win,
           (CASE WHEN pe.user_id IS NULL THEN NULL ELSE (pe.total_losses -COALESCE(pv.total_losses,0)) END) AS p_loss,
           (CASE WHEN pe.user_id IS NULL THEN NULL ELSE GREATEST(pe.tournaments_won-COALESCE(pv.tournaments_won,0),0)::numeric END) AS p_twon,
           (CASE WHEN pe.user_id IS NULL THEN NULL ELSE GREATEST(pe.sum_big_blind-COALESCE(pv.sum_big_blind,0),0) END) AS p_bb
      FROM player_stats ps
      LEFT JOIN player_stats_snapshots b  ON v_days>0 AND b.user_id=ps.user_id AND b.club_id=ps.club_id AND b.snapshot_date=v_baseline
      LEFT JOIN player_stats_snapshots pe ON pe.user_id=ps.user_id AND pe.club_id=ps.club_id AND pe.snapshot_date=v_prev_end
      LEFT JOIN player_stats_snapshots pv ON v_days>0 AND pv.user_id=ps.user_id AND pv.club_id=ps.club_id AND pv.snapshot_date=v_prev_start
     WHERE ps.club_id = p_club_id
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
    SELECT s.*, row_number() OVER (ORDER BY s.score DESC NULLS LAST, s.uid) AS rn_now,
           CASE WHEN s.prev_score IS NULL THEN NULL
                ELSE row_number() OVER (ORDER BY s.prev_score DESC NULLS LAST, s.uid) END AS rn_old
      FROM scored s
  )
  SELECT r.uid, r.d_hands, r.d_win, r.d_loss, r.d_twon, r.d_rake, r.d_bb,
         COALESCE((r.rn_old - r.rn_now)::integer, 0),
         (p_metric NOT IN ('roi','bb100')
          OR (r.d_hands >= v_min_hands AND (CASE WHEN p_metric='roi' THEN r.d_loss ELSE r.d_bb END) > 0)),
         r.rn_now::integer, v_total, v_baseline
    FROM ranked r
   ORDER BY r.rn_now
   LIMIT p_limit OFFSET GREATEST(COALESCE(p_offset,0),0);
END; $$;

CREATE FUNCTION fn_global_leaderboard_period(
  p_metric text    DEFAULT 'profit',
  p_period text    DEFAULT 'weekly',
  p_limit  integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(user_id uuid, hands_played numeric, total_winnings numeric,
              total_losses numeric, tournaments_won numeric, total_rake numeric,
              sum_big_blind numeric, rank_change integer, qualified boolean,
              rank integer, total_ranked integer, baseline_date date)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_days integer; v_baseline date; v_prev_end date; v_prev_start date;
        v_min_hands integer := 20; v_total integer;
BEGIN
  v_days := CASE p_period WHEN 'daily' THEN 1 WHEN 'weekly' THEN 7 WHEN 'monthly' THEN 30 ELSE 0 END;

  IF v_days > 0 THEN
    SELECT max(snapshot_date) INTO v_baseline FROM player_stats_snapshots WHERE snapshot_date <= CURRENT_DATE - v_days;
    IF v_baseline IS NULL THEN SELECT min(snapshot_date) INTO v_baseline FROM player_stats_snapshots; END IF;
  END IF;
  SELECT max(snapshot_date) INTO v_prev_end FROM player_stats_snapshots WHERE snapshot_date <= CURRENT_DATE - 1;
  IF v_days > 0 THEN
    SELECT max(snapshot_date) INTO v_prev_start FROM player_stats_snapshots WHERE snapshot_date <= CURRENT_DATE - 1 - v_days;
  END IF;

  SELECT count(DISTINCT ps.user_id) INTO v_total FROM player_stats ps;

  RETURN QUERY
  WITH cur_ps AS (
    SELECT ps.user_id AS uid, SUM(ps.hands_dealt)::numeric AS s_hands, SUM(ps.total_winnings) AS s_win,
           SUM(ps.total_losses) AS s_loss, SUM(ps.tournaments_won)::numeric AS s_twon,
           SUM(ps.total_rake) AS s_rake, SUM(ps.sum_big_blind) AS s_bb
      FROM player_stats ps GROUP BY ps.user_id
  ),
  snap AS (
    SELECT s.user_id AS uid, s.snapshot_date AS d, SUM(s.hands_dealt)::numeric AS s_hands,
           SUM(s.total_winnings) AS s_win, SUM(s.total_losses) AS s_loss,
           SUM(s.tournaments_won)::numeric AS s_twon, SUM(s.sum_big_blind) AS s_bb
      FROM player_stats_snapshots s
     WHERE s.snapshot_date IN (v_baseline, v_prev_end, v_prev_start)
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
    SELECT s.*, row_number() OVER (ORDER BY s.score DESC NULLS LAST, s.uid) AS rn_now,
           CASE WHEN s.prev_score IS NULL THEN NULL
                ELSE row_number() OVER (ORDER BY s.prev_score DESC NULLS LAST, s.uid) END AS rn_old
      FROM scored s
  )
  SELECT r.uid, r.d_hands, r.d_win, r.d_loss, r.d_twon, r.d_rake, r.d_bb,
         COALESCE((r.rn_old - r.rn_now)::integer, 0),
         (p_metric NOT IN ('roi','bb100')
          OR (r.d_hands >= v_min_hands AND (CASE WHEN p_metric='roi' THEN r.d_loss ELSE r.d_bb END) > 0)),
         r.rn_now::integer, v_total, v_baseline
    FROM ranked r
   ORDER BY r.rn_now
   LIMIT p_limit OFFSET GREATEST(COALESCE(p_offset,0),0);
END; $$;

GRANT EXECUTE ON FUNCTION fn_club_leaderboard_period_v2(uuid, text, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_global_leaderboard_period(text, text, integer, integer) TO authenticated, service_role;
