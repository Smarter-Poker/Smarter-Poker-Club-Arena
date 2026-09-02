-- Historical leaderboard windows must be reproducible and UTC-exact.       2026-08-31
--
-- Production already contained improved date-range ranking bodies that were
-- never committed to migration history. A clean replay therefore rebuilt the
-- older functions, whose personal-rank wrappers selected a nonexistent score
-- column and whose tie breaker made equal scores receive different ranks.
--
-- The live date-range functions also treated a window ending today as live.
-- Because end_date is exclusive, that leaks today's play into the period that
-- closed at 00:00 UTC on a Sunday/month/day boundary. Closed windows now always
-- read their closing snapshot; only a genuinely future close can use live state.
--
-- This forward-only migration changes function definitions and privileges only.
-- It moves no chips and writes no leaderboard, wallet, club or membership rows.
-- Rollback: ship another forward migration restoring the preceding definitions.

CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_by_dates(
  p_club_id uuid,
  p_metric text DEFAULT 'profit'::text,
  p_start_date date DEFAULT NULL::date,
  p_end_date date DEFAULT NULL::date,
  p_limit integer DEFAULT 10,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  user_id uuid, hands_played numeric, total_winnings numeric, total_losses numeric,
  tournaments_won numeric, total_rake numeric, sum_big_blind numeric,
  rank_change integer, qualified boolean, rank integer, total_ranked integer,
  baseline_date date
)
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
BEGIN
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
     WHERE (s.d_hands > 0 OR s.d_twon > 0 OR s.d_win <> 0 OR s.d_loss <> 0)
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_global_leaderboard_by_dates(
  p_metric text DEFAULT 'profit'::text,
  p_start_date date DEFAULT NULL::date,
  p_end_date date DEFAULT NULL::date,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  user_id uuid, hands_played numeric, total_winnings numeric, total_losses numeric,
  tournaments_won numeric, total_rake numeric, sum_big_blind numeric,
  rank_change integer, qualified boolean, rank integer, total_ranked integer,
  baseline_date date
)
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
BEGIN
  IF v_end < v_start THEN
    RAISE EXCEPTION 'end date % precedes start date %', v_end, v_start
      USING ERRCODE = '22023';
  END IF;
  v_span := GREATEST(v_end - v_start, 1);

  SELECT max(snapshot_date) INTO v_baseline
    FROM public.player_stats_snapshots
   WHERE snapshot_date <= v_start;

  v_use_live := (v_end > v_today);
  IF NOT v_use_live THEN
    SELECT max(snapshot_date) INTO v_end_snap
      FROM public.player_stats_snapshots
     WHERE snapshot_date <= v_end;
    IF v_end_snap IS NULL OR (v_baseline IS NOT NULL AND v_end_snap <= v_baseline) THEN
      RETURN;
    END IF;
  END IF;

  SELECT max(snapshot_date) INTO v_prev_start
    FROM public.player_stats_snapshots
   WHERE snapshot_date <= v_start - v_span;

  RETURN QUERY
  WITH end_s AS (
    SELECT ps.user_id AS uid, SUM(ps.hands_dealt)::numeric AS h,
           SUM(ps.total_winnings) AS w, SUM(ps.total_losses) AS l,
           SUM(ps.tournaments_won)::numeric AS t, SUM(ps.total_rake) AS rk,
           SUM(ps.sum_big_blind) AS bb
      FROM public.player_stats ps
     WHERE v_use_live
     GROUP BY ps.user_id
    UNION ALL
    SELECT s.user_id, SUM(s.hands_dealt)::numeric, SUM(s.total_winnings),
           SUM(s.total_losses), SUM(s.tournaments_won)::numeric,
           SUM(s.total_rake), SUM(s.sum_big_blind)
      FROM public.player_stats_snapshots s
     WHERE NOT v_use_live AND s.snapshot_date = v_end_snap
     GROUP BY s.user_id
  ),
  base_s AS (
    SELECT s.user_id AS uid, SUM(s.hands_dealt)::numeric AS h,
           SUM(s.total_winnings) AS w, SUM(s.total_losses) AS l,
           SUM(s.tournaments_won)::numeric AS t, SUM(s.total_rake) AS rk,
           SUM(s.sum_big_blind) AS bb
      FROM public.player_stats_snapshots s
     WHERE v_baseline IS NOT NULL AND s.snapshot_date = v_baseline
     GROUP BY s.user_id
  ),
  prev_s AS (
    SELECT s.user_id AS uid, SUM(s.hands_dealt)::numeric AS h,
           SUM(s.total_winnings) AS w, SUM(s.total_losses) AS l,
           SUM(s.tournaments_won)::numeric AS t, SUM(s.sum_big_blind) AS bb
      FROM public.player_stats_snapshots s
     WHERE v_prev_start IS NOT NULL AND s.snapshot_date = v_prev_start
     GROUP BY s.user_id
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
     WHERE (s.d_hands > 0 OR s.d_twon > 0 OR s.d_win <> 0 OR s.d_loss <> 0)
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
$function$;

-- The historical repository shape returned TABLE(rank,total,value,found), while
-- production correctly returns one JSON object. DROP is required so both drifted
-- production and a clean replay converge on the same signature.
DROP FUNCTION IF EXISTS public.fn_user_rank_by_dates(uuid, uuid, text, date, date);
CREATE FUNCTION public.fn_user_rank_by_dates(
  p_user_id uuid,
  p_club_id uuid,
  p_metric text DEFAULT 'profit'::text,
  p_start_date date DEFAULT NULL::date,
  p_end_date date DEFAULT NULL::date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
BEGIN
  SELECT b.rank, b.total_ranked, b.qualified, b.total_winnings, b.total_losses,
         b.hands_played, b.tournaments_won, b.sum_big_blind
    INTO r
    FROM public.fn_club_leaderboard_by_dates(
      p_club_id, p_metric, p_start_date, p_end_date, 1000000, 0
    ) b
   WHERE b.user_id = p_user_id;

  IF r IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object(
    'found', true, 'rank', r.rank, 'total', r.total_ranked, 'qualified', r.qualified,
    'value', CASE p_metric
      WHEN 'hands_played'    THEN r.hands_played
      WHEN 'tournaments_won' THEN r.tournaments_won
      WHEN 'roi' THEN CASE WHEN r.total_losses > 0
                           THEN round(((r.total_winnings-r.total_losses)/r.total_losses)*100, 2)
                           ELSE 0 END
      WHEN 'bb100' THEN CASE WHEN r.sum_big_blind > 0
                             THEN round((100*(r.total_winnings-r.total_losses))/r.sum_big_blind, 2)
                             ELSE 0 END
      ELSE round(r.total_winnings-r.total_losses, 2)
    END
  );
END;
$function$;

DROP FUNCTION IF EXISTS public.fn_user_rank_global_by_dates(uuid, text, date, date);
CREATE FUNCTION public.fn_user_rank_global_by_dates(
  p_user_id uuid,
  p_metric text DEFAULT 'profit'::text,
  p_start_date date DEFAULT NULL::date,
  p_end_date date DEFAULT NULL::date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
BEGIN
  SELECT b.rank, b.total_ranked, b.qualified, b.total_winnings, b.total_losses,
         b.hands_played, b.tournaments_won, b.sum_big_blind
    INTO r
    FROM public.fn_global_leaderboard_by_dates(
      p_metric, p_start_date, p_end_date, 1000000, 0
    ) b
   WHERE b.user_id = p_user_id;

  IF r IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object(
    'found', true, 'rank', r.rank, 'total', r.total_ranked, 'qualified', r.qualified,
    'value', CASE p_metric
      WHEN 'hands_played'    THEN r.hands_played
      WHEN 'tournaments_won' THEN r.tournaments_won
      WHEN 'roi' THEN CASE WHEN r.total_losses > 0
                           THEN round(((r.total_winnings-r.total_losses)/r.total_losses)*100, 2)
                           ELSE 0 END
      WHEN 'bb100' THEN CASE WHEN r.sum_big_blind > 0
                             THEN round((100*(r.total_winnings-r.total_losses))/r.sum_big_blind, 2)
                             ELSE 0 END
      ELSE round(r.total_winnings-r.total_losses, 2)
    END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_club_leaderboard_by_dates(uuid,text,date,date,integer,integer)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_global_leaderboard_by_dates(text,date,date,integer,integer)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_user_rank_by_dates(uuid,uuid,text,date,date)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_user_rank_global_by_dates(uuid,text,date,date)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_club_leaderboard_by_dates(uuid,text,date,date,integer,integer)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_global_leaderboard_by_dates(text,date,date,integer,integer)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_user_rank_by_dates(uuid,uuid,text,date,date)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_user_rank_global_by_dates(uuid,text,date,date)
  TO authenticated, service_role;

DO $verify$
DECLARE
  v_definition text;
  v_rank jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_club_leaderboard_by_dates';
  IF v_definition NOT LIKE '%v_end > v_today%'
     OR v_definition NOT LIKE '%rank() OVER (ORDER BY s.score DESC NULLS LAST)%' THEN
    RAISE EXCEPTION 'Historical Club Leaderboard Contract Self-Check Failed';
  END IF;

  IF has_function_privilege('anon',
       'public.fn_club_leaderboard_by_dates(uuid,text,date,date,integer,integer)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_global_leaderboard_by_dates(text,date,date,integer,integer)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_user_rank_by_dates(uuid,uuid,text,date,date)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_user_rank_global_by_dates(uuid,text,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous Historical Leaderboard Execution Is Still Open';
  END IF;

  PERFORM user_id FROM public.fn_club_leaderboard_by_dates(
    '00000000-0000-0000-0000-000000000000'::uuid,
    'profit', DATE '2026-08-23', DATE '2026-08-30', 1, 0
  );
  PERFORM user_id FROM public.fn_global_leaderboard_by_dates(
    'profit', DATE '2026-08-23', DATE '2026-08-30', 1, 0
  );
  v_rank := public.fn_user_rank_by_dates(
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'profit', DATE '2026-08-23', DATE '2026-08-30'
  );
  IF COALESCE((v_rank->>'found')::boolean, true) THEN
    RAISE EXCEPTION 'Historical Personal Rank Empty-State Self-Check Failed';
  END IF;
END;
$verify$;
