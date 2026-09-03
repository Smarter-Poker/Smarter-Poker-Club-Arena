-- Create historical leaderboard RPCs

CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_by_dates(p_club_id uuid, p_metric text, p_start_date date, p_end_date date, p_limit integer DEFAULT 10, p_offset integer DEFAULT 0)
 RETURNS TABLE(user_id uuid, hands_played numeric, total_winnings numeric, total_losses numeric, tournaments_won numeric, total_rake numeric, sum_big_blind numeric, rank_change integer, qualified boolean, rank integer, total_ranked integer, baseline_date date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_total integer;
BEGIN
  SELECT count(*) INTO v_total FROM player_stats_snapshots WHERE club_id = p_club_id AND snapshot_date = p_end_date;

  RETURN QUERY
  WITH cur AS (
    SELECT pe.user_id AS uid,
           GREATEST(pe.hands_dealt-COALESCE(b.hands_dealt,0),0)::numeric AS d_hands,
           (pe.total_winnings-COALESCE(b.total_winnings,0)) AS d_win,
           (pe.total_losses -COALESCE(b.total_losses,0)) AS d_loss,
           GREATEST(pe.tournaments_won-COALESCE(b.tournaments_won,0),0)::numeric AS d_twon,
           GREATEST(pe.total_rake-COALESCE(b.total_rake,0),0) AS d_rake,
           GREATEST(pe.sum_big_blind-COALESCE(b.sum_big_blind,0),0) AS d_bb,
           NULL::numeric AS p_hands, NULL::numeric AS p_win, NULL::numeric AS p_loss, NULL::numeric AS p_twon, NULL::numeric AS p_bb
      FROM player_stats_snapshots pe
      LEFT JOIN player_stats_snapshots b ON b.user_id=pe.user_id AND b.club_id=pe.club_id AND b.snapshot_date=p_start_date
     WHERE pe.club_id = p_club_id AND pe.snapshot_date = p_end_date
  ),
  scored AS (
    SELECT c.*,
           (CASE p_metric
              WHEN 'hands_played'    THEN c.d_hands
              WHEN 'tournaments_won' THEN c.d_twon
              WHEN 'roi'   THEN CASE WHEN c.d_loss>0 AND c.d_hands>=20 THEN (c.d_win-c.d_loss)/c.d_loss END
              ELSE (c.d_win - c.d_loss)
            END) AS score,
           (CASE p_metric
              WHEN 'roi'   THEN (c.d_loss>0 AND c.d_hands>=20)
              ELSE true
            END) AS q
      FROM cur c
  ),
  ranked AS (
    SELECT s.uid, s.d_hands, s.d_win, s.d_loss, s.d_twon, s.d_rake, s.d_bb,
           s.q, s.score,
           dense_rank() OVER (ORDER BY (CASE WHEN s.q THEN s.score ELSE -999999999 END) DESC, s.d_hands DESC, s.uid) AS rnk
      FROM scored s
  )
  SELECT r.uid, r.d_hands, r.d_win, r.d_loss, r.d_twon, r.d_rake, r.d_bb,
         0 AS rank_change, r.q, r.rnk::integer, v_total, p_start_date AS baseline_date
    FROM ranked r
   ORDER BY r.rnk, r.uid
   LIMIT p_limit OFFSET p_offset;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_user_rank_by_dates(p_user_id uuid, p_club_id uuid, p_metric text, p_start_date date, p_end_date date)
 RETURNS TABLE(rank integer, total integer, value numeric, found boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT r.rank, r.total_ranked, r.score::numeric, true
    FROM fn_club_leaderboard_by_dates(p_club_id, p_metric, p_start_date, p_end_date, 1000000, 0) r
   WHERE r.user_id = p_user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_global_leaderboard_by_dates(p_metric text, p_start_date date, p_end_date date, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(user_id uuid, hands_played numeric, total_winnings numeric, total_losses numeric, tournaments_won numeric, total_rake numeric, sum_big_blind numeric, rank_change integer, qualified boolean, rank integer, total_ranked integer, baseline_date date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_total integer;
BEGIN
  SELECT count(DISTINCT user_id) INTO v_total FROM player_stats_snapshots WHERE snapshot_date = p_end_date;

  RETURN QUERY
  WITH pe_agg AS (
    SELECT pe.user_id, SUM(pe.hands_dealt) AS h, SUM(pe.total_winnings) AS w, SUM(pe.total_losses) AS l, SUM(pe.tournaments_won) AS tw, SUM(pe.total_rake) AS r, SUM(pe.sum_big_blind) AS bb
      FROM player_stats_snapshots pe WHERE pe.snapshot_date = p_end_date GROUP BY pe.user_id
  ),
  b_agg AS (
    SELECT b.user_id, SUM(b.hands_dealt) AS h, SUM(b.total_winnings) AS w, SUM(b.total_losses) AS l, SUM(b.tournaments_won) AS tw, SUM(b.total_rake) AS r, SUM(b.sum_big_blind) AS bb
      FROM player_stats_snapshots b WHERE b.snapshot_date = p_start_date GROUP BY b.user_id
  ),
  cur AS (
    SELECT pe.user_id AS uid,
           GREATEST(pe.h-COALESCE(b.h,0),0)::numeric AS d_hands,
           (pe.w-COALESCE(b.w,0)) AS d_win,
           (pe.l-COALESCE(b.l,0)) AS d_loss,
           GREATEST(pe.tw-COALESCE(b.tw,0),0)::numeric AS d_twon,
           GREATEST(pe.r-COALESCE(b.r,0),0) AS d_rake,
           GREATEST(pe.bb-COALESCE(b.bb,0),0) AS d_bb,
           NULL::numeric AS p_hands, NULL::numeric AS p_win, NULL::numeric AS p_loss, NULL::numeric AS p_twon, NULL::numeric AS p_bb
      FROM pe_agg pe
      LEFT JOIN b_agg b ON b.user_id=pe.user_id
  ),
  scored AS (
    SELECT c.*,
           (CASE p_metric
              WHEN 'hands_played'    THEN c.d_hands
              WHEN 'tournaments_won' THEN c.d_twon
              WHEN 'roi'   THEN CASE WHEN c.d_loss>0 AND c.d_hands>=20 THEN (c.d_win-c.d_loss)/c.d_loss END
              ELSE (c.d_win - c.d_loss)
            END) AS score,
           (CASE p_metric
              WHEN 'roi'   THEN (c.d_loss>0 AND c.d_hands>=20)
              ELSE true
            END) AS q
      FROM cur c
  ),
  ranked AS (
    SELECT s.uid, s.d_hands, s.d_win, s.d_loss, s.d_twon, s.d_rake, s.d_bb,
           s.q, s.score,
           dense_rank() OVER (ORDER BY (CASE WHEN s.q THEN s.score ELSE -999999999 END) DESC, s.d_hands DESC, s.uid) AS rnk
      FROM scored s
  )
  SELECT r.uid, r.d_hands, r.d_win, r.d_loss, r.d_twon, r.d_rake, r.d_bb,
         0 AS rank_change, r.q, r.rnk::integer, v_total, p_start_date AS baseline_date
    FROM ranked r
   ORDER BY r.rnk, r.uid
   LIMIT p_limit OFFSET p_offset;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_user_rank_global_by_dates(p_user_id uuid, p_metric text, p_start_date date, p_end_date date)
 RETURNS TABLE(rank integer, total integer, value numeric, found boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT r.rank, r.total_ranked, r.score::numeric, true
    FROM fn_global_leaderboard_by_dates(p_metric, p_start_date, p_end_date, 1000000, 0) r
   WHERE r.user_id = p_user_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION fn_club_leaderboard_by_dates(uuid, text, date, date, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_user_rank_by_dates(uuid, uuid, text, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_global_leaderboard_by_dates(text, date, date, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_user_rank_global_by_dates(uuid, text, date, date) TO authenticated, service_role;

