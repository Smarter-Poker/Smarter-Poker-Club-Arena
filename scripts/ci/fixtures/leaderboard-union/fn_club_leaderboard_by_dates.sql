CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_by_dates(p_club_id uuid, p_metric text DEFAULT 'profit'::text, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_limit integer DEFAULT 10, p_offset integer DEFAULT 0)
 RETURNS TABLE(user_id uuid, hands_played numeric, total_winnings numeric, total_losses numeric, tournaments_won numeric, total_rake numeric, sum_big_blind numeric, rank_change integer, qualified boolean, rank integer, total_ranked integer, baseline_date date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today date := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date;
  v_start date := COALESCE(p_start_date, v_today - 7);
  v_end date := COALESCE(p_end_date, v_today);
  v_span integer;
  v_baseline date;
  v_end_snap date;
  v_prev_start date;
  v_use_live boolean;
  v_min_hands integer := 20;
  v_period text;
  v_basis jsonb;
  v_previous jsonb;
  v_previous_start date;
BEGIN
  -- Only closed canonical product rounds can select prospective V2.
  IF v_end <= v_today AND EXTRACT(DOW FROM v_start)=0 AND v_end=v_start+7 THEN
    v_period:='weekly';
  ELSIF v_end <= v_today AND EXTRACT(DAY FROM v_start)=1 AND v_end=(v_start+interval '1 month')::date THEN
    v_period:='monthly';
  END IF;
  IF v_period IS NOT NULL THEN
    v_basis:=public.fn_leaderboard_complete_round_basis(p_club_id,v_period,v_start,v_end);
    IF v_basis->>'basis_version'='complete_capture_v2' AND v_basis->'complete'='true'::jsonb THEN
      v_previous_start:=CASE v_period WHEN 'weekly' THEN v_start-7 ELSE (v_start-interval '1 month')::date END;
      BEGIN
        v_previous:=public.fn_leaderboard_complete_round_basis(p_club_id,v_period,v_previous_start,v_start);
        IF v_previous->>'basis_version'<>'complete_capture_v2' OR v_previous->'complete'<>'true'::jsonb THEN v_previous:=NULL; END IF;
      EXCEPTION WHEN SQLSTATE '55000' THEN
        -- Only genuinely unavailable previous complete capture means unknown.
        IF SQLERRM='LEADERBOARD_CAPTURE_UNAVAILABLE' THEN v_previous:=NULL; ELSE RAISE; END IF;
      END;
      RETURN QUERY
      WITH inputs AS (
        SELECT false AS previous,d.* FROM jsonb_to_recordset(v_basis->'rows') AS d(
          user_id uuid,hands_played numeric,total_winnings numeric,total_losses numeric,
          tournaments_won numeric,total_rake numeric,sum_big_blind numeric)
        UNION ALL
        SELECT true AS previous,d.* FROM jsonb_to_recordset(COALESCE(v_previous->'rows','[]'::jsonb)) AS d(
          user_id uuid,hands_played numeric,total_winnings numeric,total_losses numeric,
          tournaments_won numeric,total_rake numeric,sum_big_blind numeric)
      ), scored AS (
        SELECT d.*,CASE p_metric
          WHEN 'hands_played' THEN d.hands_played
          WHEN 'tournaments_won' THEN d.tournaments_won
          WHEN 'roi' THEN CASE WHEN d.total_losses>0 AND d.hands_played>=v_min_hands THEN (d.total_winnings-d.total_losses)/d.total_losses END
          WHEN 'bb100' THEN CASE WHEN d.sum_big_blind>0 AND d.hands_played>=v_min_hands THEN 100*(d.total_winnings-d.total_losses)/d.sum_big_blind END
          ELSE d.total_winnings-d.total_losses END AS score
        FROM inputs d
      ), ranked AS (
        SELECT s.*,rank() OVER(PARTITION BY s.previous ORDER BY s.score DESC NULLS LAST)::integer AS position,
          row_number() OVER(PARTITION BY s.previous ORDER BY s.score DESC NULLS LAST,s.user_id) AS ordinal,
          count(*) OVER(PARTITION BY s.previous)::integer AS total
        FROM scored s WHERE NOT EXISTS (SELECT 1 FROM public.profiles dp WHERE dp.id = s.user_id AND dp.status = 'deleted') AND (s.hands_played>0 OR s.tournaments_won>0 OR s.total_winnings<>0 OR s.total_losses<>0)
      )
      SELECT r.user_id,r.hands_played,r.total_winnings,r.total_losses,r.tournaments_won,r.total_rake,r.sum_big_blind,
        CASE WHEN v_previous IS NULL OR old.score IS NULL THEN NULL ELSE old.position-r.position END,
        (p_metric NOT IN('roi','bb100') OR (r.hands_played>=v_min_hands AND
          (CASE WHEN p_metric='roi' THEN r.total_losses ELSE r.sum_big_blind END)>0)),
        r.position,r.total,v_start
      FROM ranked r LEFT JOIN ranked old ON old.previous AND old.user_id=r.user_id
      WHERE NOT r.previous ORDER BY r.ordinal LIMIT p_limit OFFSET GREATEST(COALESCE(p_offset,0),0);
      RETURN;
    ELSIF v_basis->>'basis_version' IS DISTINCT FROM 'legacy_v1' THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='LEADERBOARD_COMPLETE_BASIS_REQUIRED';
    END IF;
  END IF;
  IF v_end < v_start THEN
    RAISE EXCEPTION 'end date % precedes start date %', v_end, v_start
      USING ERRCODE = '22023';
  END IF;
  v_span := GREATEST(v_end - v_start, 1);

  SELECT max(snapshot_date) INTO v_baseline
    FROM public.player_stats_snapshots
   WHERE club_id = p_club_id AND snapshot_date <= v_start;

  -- end_date is exclusive. A window ending today closed at 00:00 UTC and must
  -- not consume today's mutable totals.
  v_use_live := (v_end > v_today);
  IF NOT v_use_live THEN
    SELECT max(snapshot_date) INTO v_end_snap
      FROM public.player_stats_snapshots
     WHERE club_id = p_club_id AND snapshot_date <= v_end;
    IF v_end_snap IS NULL OR (v_baseline IS NOT NULL AND v_end_snap <= v_baseline) THEN
      RETURN;
    END IF;
  END IF;

  SELECT max(snapshot_date) INTO v_prev_start
    FROM public.player_stats_snapshots
   WHERE club_id = p_club_id AND snapshot_date <= v_start - v_span;

  RETURN QUERY
  WITH end_s AS (
    SELECT ps.user_id AS uid, ps.hands_dealt::numeric AS h,
           ps.total_winnings AS w, ps.total_losses AS l,
           ps.tournaments_won::numeric AS t, ps.total_rake AS rk,
           ps.sum_big_blind AS bb
      FROM public.player_stats ps
     WHERE v_use_live AND ps.club_id = p_club_id
    UNION ALL
    SELECT s.user_id, s.hands_dealt::numeric, s.total_winnings, s.total_losses,
           s.tournaments_won::numeric, s.total_rake, s.sum_big_blind
      FROM public.player_stats_snapshots s
     WHERE NOT v_use_live AND s.club_id = p_club_id AND s.snapshot_date = v_end_snap
  ),
  base_s AS (
    SELECT s.user_id AS uid, s.hands_dealt::numeric AS h,
           s.total_winnings AS w, s.total_losses AS l,
           s.tournaments_won::numeric AS t, s.total_rake AS rk,
           s.sum_big_blind AS bb
      FROM public.player_stats_snapshots s
     WHERE s.club_id = p_club_id
       AND v_baseline IS NOT NULL
       AND s.snapshot_date = v_baseline
  ),
  prev_s AS (
    SELECT s.user_id AS uid, s.hands_dealt::numeric AS h,
           s.total_winnings AS w, s.total_losses AS l,
           s.tournaments_won::numeric AS t, s.sum_big_blind AS bb
      FROM public.player_stats_snapshots s
     WHERE s.club_id = p_club_id
       AND v_prev_start IS NOT NULL
       AND s.snapshot_date = v_prev_start
  ),
  cur AS (
    SELECT e.uid,
           GREATEST(e.h - COALESCE(b.h, 0), 0) AS d_hands,
           e.w - COALESCE(b.w, 0) AS d_win,
           e.l - COALESCE(b.l, 0) AS d_loss,
           GREATEST(e.t - COALESCE(b.t, 0), 0) AS d_twon,
           GREATEST(e.rk - COALESCE(b.rk, 0), 0) AS d_rake,
           GREATEST(e.bb - COALESCE(b.bb, 0), 0) AS d_bb,
           CASE WHEN b.uid IS NULL THEN NULL ELSE GREATEST(b.h - COALESCE(p.h, 0), 0) END AS p_hands,
           CASE WHEN b.uid IS NULL THEN NULL ELSE b.w - COALESCE(p.w, 0) END AS p_win,
           CASE WHEN b.uid IS NULL THEN NULL ELSE b.l - COALESCE(p.l, 0) END AS p_loss,
           CASE WHEN b.uid IS NULL THEN NULL ELSE GREATEST(b.t - COALESCE(p.t, 0), 0) END AS p_twon,
           CASE WHEN b.uid IS NULL THEN NULL ELSE GREATEST(b.bb - COALESCE(p.bb, 0), 0) END AS p_bb
      FROM end_s e
      LEFT JOIN base_s b ON b.uid = e.uid
      LEFT JOIN prev_s p ON p.uid = e.uid
  ),
  scored AS (
    SELECT c.*,
           CASE p_metric
             WHEN 'hands_played' THEN c.d_hands
             WHEN 'tournaments_won' THEN c.d_twon
             WHEN 'roi' THEN CASE WHEN c.d_loss > 0 AND c.d_hands >= v_min_hands
                                  THEN (c.d_win-c.d_loss)/c.d_loss END
             WHEN 'bb100' THEN CASE WHEN c.d_bb > 0 AND c.d_hands >= v_min_hands
                                    THEN 100*(c.d_win-c.d_loss)/c.d_bb END
             ELSE c.d_win-c.d_loss
           END AS score,
           CASE p_metric
             WHEN 'hands_played' THEN c.p_hands
             WHEN 'tournaments_won' THEN c.p_twon
             WHEN 'roi' THEN CASE WHEN c.p_loss > 0 AND c.p_hands >= v_min_hands
                                  THEN (c.p_win-c.p_loss)/c.p_loss END
             WHEN 'bb100' THEN CASE WHEN c.p_bb > 0 AND c.p_hands >= v_min_hands
                                    THEN 100*(c.p_win-c.p_loss)/c.p_bb END
             ELSE c.p_win-c.p_loss
           END AS prev_score
      FROM cur c
  ),
  ranked AS (
    SELECT s.*,
           row_number() OVER (ORDER BY s.score DESC NULLS LAST, s.uid) AS rn_now,
           rank() OVER (ORDER BY s.score DESC NULLS LAST) AS rk_now,
           count(*) OVER () AS total_active,
           CASE WHEN s.prev_score IS NULL THEN NULL
                ELSE rank() OVER (ORDER BY s.prev_score DESC NULLS LAST) END AS rk_old
      FROM scored s
     WHERE NOT EXISTS (SELECT 1 FROM public.profiles dp WHERE dp.id = s.uid AND dp.status = 'deleted')
       AND (s.d_hands > 0 OR s.d_twon > 0 OR s.d_win <> 0 OR s.d_loss <> 0)
  )
  SELECT r.uid, r.d_hands, r.d_win, r.d_loss, r.d_twon, r.d_rake, r.d_bb,
         COALESCE((r.rk_old - r.rk_now)::integer, 0),
         (p_metric NOT IN ('roi','bb100') OR
          (r.d_hands >= v_min_hands AND
           (CASE WHEN p_metric='roi' THEN r.d_loss ELSE r.d_bb END) > 0)),
         r.rk_now::integer, r.total_active::integer, v_baseline
    FROM ranked r
   ORDER BY r.rn_now
   LIMIT p_limit OFFSET GREATEST(COALESCE(p_offset,0),0);
END;
$function$
