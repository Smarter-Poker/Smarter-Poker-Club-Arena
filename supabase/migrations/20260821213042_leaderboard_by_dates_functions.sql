-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260821213042 as "leaderboard_by_dates_functions"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- The four *_by_dates leaderboard functions LeaderboardService has been calling
-- since the leaderboard work landed. None of them existed, so every call was a
-- PostgREST 42883 and the UI fell back to an all-time query or an empty list.
--
-- Why they exist at all: the _period siblings can only diff the LIVE
-- player_stats against a baseline derived from "N days before today". That
-- makes a PAST period unrepresentable - which is exactly what the leaderboard
-- page needs when periodOffset < 0, and what a payout has to read, since you
-- only ever finalise a period that has closed.
--
-- Same ranking model as fn_club_leaderboard_period_v2, deliberately: diff
-- player_stats_snapshots at the window's open against its state at the close,
-- same metric scoring, same 20-hand qualification floor for ratio metrics,
-- same 12-column return shape. If the two disagreed, the badge on the page and
-- the money paid out would disagree too.
--
-- The one addition is that the close of the window can be a SNAPSHOT rather
-- than live stats: for a window ending today there is no snapshot yet, so it
-- reads player_stats; for a window that has closed it reads the last snapshot
-- inside it. That is what makes a finalised period stable - re-running a payout
-- for last week reads the same numbers in a month's time.

CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_by_dates(
  p_club_id uuid,
  p_metric text DEFAULT 'profit',
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL,
  p_limit integer DEFAULT 10,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(user_id uuid, hands_played numeric, total_winnings numeric, total_losses numeric,
              tournaments_won numeric, total_rake numeric, sum_big_blind numeric,
              rank_change integer, qualified boolean, rank integer, total_ranked integer,
              baseline_date date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_start date := COALESCE(p_start_date, CURRENT_DATE - 7);
  v_end   date := COALESCE(p_end_date, CURRENT_DATE);
  v_span  integer;
  v_baseline date; v_end_snap date; v_prev_start date;
  v_use_live boolean;
  v_min_hands integer := 20;
BEGIN
  IF v_end < v_start THEN
    RAISE EXCEPTION 'end date % precedes start date %', v_end, v_start;
  END IF;
  v_span := GREATEST(v_end - v_start, 1);

  -- State at the window's OPEN.
  SELECT max(snapshot_date) INTO v_baseline FROM player_stats_snapshots
   WHERE club_id = p_club_id AND snapshot_date <= v_start;

  -- State at the window's CLOSE. A window running to today has no snapshot yet.
  v_use_live := (v_end >= CURRENT_DATE);
  IF NOT v_use_live THEN
    SELECT max(snapshot_date) INTO v_end_snap FROM player_stats_snapshots
     WHERE club_id = p_club_id AND snapshot_date <= v_end;
    -- No snapshot inside a closed window means nothing to report, rather than
    -- silently reporting today's numbers for a period that ended long ago.
    IF v_end_snap IS NULL OR (v_baseline IS NOT NULL AND v_end_snap <= v_baseline) THEN
      RETURN;
    END IF;
  END IF;

  -- The equivalent window immediately before, for rank movement.
  SELECT max(snapshot_date) INTO v_prev_start FROM player_stats_snapshots
   WHERE club_id = p_club_id AND snapshot_date <= v_start - v_span;

  RETURN QUERY
  WITH end_s AS (
    SELECT ps.user_id AS uid, ps.hands_dealt::numeric AS h, ps.total_winnings AS w,
           ps.total_losses AS l, ps.tournaments_won::numeric AS t,
           ps.total_rake AS rk, ps.sum_big_blind AS bb
      FROM player_stats ps
     WHERE v_use_live AND ps.club_id = p_club_id
    UNION ALL
    SELECT s.user_id, s.hands_dealt::numeric, s.total_winnings, s.total_losses,
           s.tournaments_won::numeric, s.total_rake, s.sum_big_blind
      FROM player_stats_snapshots s
     WHERE NOT v_use_live AND s.club_id = p_club_id AND s.snapshot_date = v_end_snap
  ),
  base_s AS (
    SELECT s.user_id AS uid, s.hands_dealt::numeric AS h, s.total_winnings AS w,
           s.total_losses AS l, s.tournaments_won::numeric AS t,
           s.total_rake AS rk, s.sum_big_blind AS bb
      FROM player_stats_snapshots s
     WHERE s.club_id = p_club_id AND v_baseline IS NOT NULL AND s.snapshot_date = v_baseline
  ),
  prev_s AS (
    SELECT s.user_id AS uid, s.hands_dealt::numeric AS h, s.total_winnings AS w,
           s.total_losses AS l, s.tournaments_won::numeric AS t, s.sum_big_blind AS bb
      FROM player_stats_snapshots s
     WHERE s.club_id = p_club_id AND v_prev_start IS NOT NULL AND s.snapshot_date = v_prev_start
  ),
  cur AS (
    SELECT e.uid,
           GREATEST(e.h  - COALESCE(b.h, 0), 0)  AS d_hands,
           (e.w - COALESCE(b.w, 0))              AS d_win,
           (e.l - COALESCE(b.l, 0))              AS d_loss,
           GREATEST(e.t  - COALESCE(b.t, 0), 0)  AS d_twon,
           GREATEST(e.rk - COALESCE(b.rk, 0), 0) AS d_rake,
           GREATEST(e.bb - COALESCE(b.bb, 0), 0) AS d_bb,
           -- The prior window runs prev_start -> baseline. Without a baseline
           -- there is no prior window, so movement is unknown rather than zero.
           (CASE WHEN b.uid IS NULL THEN NULL ELSE GREATEST(b.h - COALESCE(p.h, 0), 0) END) AS p_hands,
           (CASE WHEN b.uid IS NULL THEN NULL ELSE (b.w - COALESCE(p.w, 0)) END)            AS p_win,
           (CASE WHEN b.uid IS NULL THEN NULL ELSE (b.l - COALESCE(p.l, 0)) END)            AS p_loss,
           (CASE WHEN b.uid IS NULL THEN NULL ELSE GREATEST(b.t - COALESCE(p.t, 0), 0) END) AS p_twon,
           (CASE WHEN b.uid IS NULL THEN NULL ELSE GREATEST(b.bb - COALESCE(p.bb, 0), 0) END) AS p_bb
      FROM end_s e
      LEFT JOIN base_s b ON b.uid = e.uid
      LEFT JOIN prev_s p ON p.uid = e.uid
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
           rank()   OVER (ORDER BY s.score DESC NULLS LAST) AS rk_now,
           count(*) OVER ()                                 AS total_active,
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
END; $function$;

CREATE OR REPLACE FUNCTION public.fn_global_leaderboard_by_dates(
  p_metric text DEFAULT 'profit',
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(user_id uuid, hands_played numeric, total_winnings numeric, total_losses numeric,
              tournaments_won numeric, total_rake numeric, sum_big_blind numeric,
              rank_change integer, qualified boolean, rank integer, total_ranked integer,
              baseline_date date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_start date := COALESCE(p_start_date, CURRENT_DATE - 7);
  v_end   date := COALESCE(p_end_date, CURRENT_DATE);
  v_span  integer;
  v_baseline date; v_end_snap date; v_prev_start date;
  v_use_live boolean;
  v_min_hands integer := 20;
BEGIN
  IF v_end < v_start THEN
    RAISE EXCEPTION 'end date % precedes start date %', v_end, v_start;
  END IF;
  v_span := GREATEST(v_end - v_start, 1);

  SELECT max(snapshot_date) INTO v_baseline FROM player_stats_snapshots WHERE snapshot_date <= v_start;
  v_use_live := (v_end >= CURRENT_DATE);
  IF NOT v_use_live THEN
    SELECT max(snapshot_date) INTO v_end_snap FROM player_stats_snapshots WHERE snapshot_date <= v_end;
    IF v_end_snap IS NULL OR (v_baseline IS NOT NULL AND v_end_snap <= v_baseline) THEN
      RETURN;
    END IF;
  END IF;
  SELECT max(snapshot_date) INTO v_prev_start FROM player_stats_snapshots WHERE snapshot_date <= v_start - v_span;

  RETURN QUERY
  WITH end_s AS (
    SELECT ps.user_id AS uid, SUM(ps.hands_dealt)::numeric AS h, SUM(ps.total_winnings) AS w,
           SUM(ps.total_losses) AS l, SUM(ps.tournaments_won)::numeric AS t,
           SUM(ps.total_rake) AS rk, SUM(ps.sum_big_blind) AS bb
      FROM player_stats ps WHERE v_use_live GROUP BY ps.user_id
    UNION ALL
    SELECT s.user_id, SUM(s.hands_dealt)::numeric, SUM(s.total_winnings), SUM(s.total_losses),
           SUM(s.tournaments_won)::numeric, SUM(s.total_rake), SUM(s.sum_big_blind)
      FROM player_stats_snapshots s
     WHERE NOT v_use_live AND s.snapshot_date = v_end_snap GROUP BY s.user_id
  ),
  base_s AS (
    SELECT s.user_id AS uid, SUM(s.hands_dealt)::numeric AS h, SUM(s.total_winnings) AS w,
           SUM(s.total_losses) AS l, SUM(s.tournaments_won)::numeric AS t,
           SUM(s.total_rake) AS rk, SUM(s.sum_big_blind) AS bb
      FROM player_stats_snapshots s
     WHERE v_baseline IS NOT NULL AND s.snapshot_date = v_baseline GROUP BY s.user_id
  ),
  prev_s AS (
    SELECT s.user_id AS uid, SUM(s.hands_dealt)::numeric AS h, SUM(s.total_winnings) AS w,
           SUM(s.total_losses) AS l, SUM(s.tournaments_won)::numeric AS t,
           SUM(s.sum_big_blind) AS bb
      FROM player_stats_snapshots s
     WHERE v_prev_start IS NOT NULL AND s.snapshot_date = v_prev_start GROUP BY s.user_id
  ),
  cur AS (
    SELECT e.uid,
           GREATEST(e.h  - COALESCE(b.h, 0), 0)  AS d_hands,
           (e.w - COALESCE(b.w, 0))              AS d_win,
           (e.l - COALESCE(b.l, 0))              AS d_loss,
           GREATEST(e.t  - COALESCE(b.t, 0), 0)  AS d_twon,
           GREATEST(e.rk - COALESCE(b.rk, 0), 0) AS d_rake,
           GREATEST(e.bb - COALESCE(b.bb, 0), 0) AS d_bb,
           (CASE WHEN b.uid IS NULL THEN NULL ELSE GREATEST(b.h - COALESCE(p.h, 0), 0) END) AS p_hands,
           (CASE WHEN b.uid IS NULL THEN NULL ELSE (b.w - COALESCE(p.w, 0)) END)            AS p_win,
           (CASE WHEN b.uid IS NULL THEN NULL ELSE (b.l - COALESCE(p.l, 0)) END)            AS p_loss,
           (CASE WHEN b.uid IS NULL THEN NULL ELSE GREATEST(b.t - COALESCE(p.t, 0), 0) END) AS p_twon,
           (CASE WHEN b.uid IS NULL THEN NULL ELSE GREATEST(b.bb - COALESCE(p.bb, 0), 0) END) AS p_bb
      FROM end_s e
      LEFT JOIN base_s b ON b.uid = e.uid
      LEFT JOIN prev_s p ON p.uid = e.uid
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
           rank()   OVER (ORDER BY s.score DESC NULLS LAST) AS rk_now,
           count(*) OVER ()                                 AS total_active,
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
END; $function$;

-- Both rank helpers delegate, exactly as fn_user_rank_period delegates to
-- fn_club_leaderboard_period_v2. One ranking implementation, so a player's
-- "you are 4th of 61" can never drift from the table they are looking at.

CREATE OR REPLACE FUNCTION public.fn_user_rank_by_dates(
  p_user_id uuid, p_club_id uuid, p_metric text DEFAULT 'profit',
  p_start_date date DEFAULT NULL, p_end_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r record;
BEGIN
  SELECT b.rank, b.total_ranked, b.qualified, b.total_winnings, b.total_losses,
         b.hands_played, b.tournaments_won, b.sum_big_blind
    INTO r
    FROM fn_club_leaderboard_by_dates(p_club_id, p_metric, p_start_date, p_end_date, 1000000, 0) b
   WHERE b.user_id = p_user_id;

  IF r IS NULL THEN RETURN jsonb_build_object('found', false); END IF;

  RETURN jsonb_build_object(
    'found', true, 'rank', r.rank, 'total', r.total_ranked, 'qualified', r.qualified,
    'value', CASE p_metric
      WHEN 'hands_played'    THEN r.hands_played
      WHEN 'tournaments_won' THEN r.tournaments_won
      WHEN 'roi'   THEN CASE WHEN r.total_losses  > 0
                             THEN round(((r.total_winnings - r.total_losses) / r.total_losses) * 100, 2) ELSE 0 END
      WHEN 'bb100' THEN CASE WHEN r.sum_big_blind > 0
                             THEN round((100 * (r.total_winnings - r.total_losses)) / r.sum_big_blind, 2) ELSE 0 END
      ELSE round(r.total_winnings - r.total_losses, 2)
    END);
END; $function$;

CREATE OR REPLACE FUNCTION public.fn_user_rank_global_by_dates(
  p_user_id uuid, p_metric text DEFAULT 'profit',
  p_start_date date DEFAULT NULL, p_end_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r record;
BEGIN
  SELECT b.rank, b.total_ranked, b.qualified, b.total_winnings, b.total_losses,
         b.hands_played, b.tournaments_won, b.sum_big_blind
    INTO r
    FROM fn_global_leaderboard_by_dates(p_metric, p_start_date, p_end_date, 1000000, 0) b
   WHERE b.user_id = p_user_id;

  IF r IS NULL THEN RETURN jsonb_build_object('found', false); END IF;

  RETURN jsonb_build_object(
    'found', true, 'rank', r.rank, 'total', r.total_ranked, 'qualified', r.qualified,
    'value', CASE p_metric
      WHEN 'hands_played'    THEN r.hands_played
      WHEN 'tournaments_won' THEN r.tournaments_won
      WHEN 'roi'   THEN CASE WHEN r.total_losses  > 0
                             THEN round(((r.total_winnings - r.total_losses) / r.total_losses) * 100, 2) ELSE 0 END
      WHEN 'bb100' THEN CASE WHEN r.sum_big_blind > 0
                             THEN round((100 * (r.total_winnings - r.total_losses)) / r.sum_big_blind, 2) ELSE 0 END
      ELSE round(r.total_winnings - r.total_losses, 2)
    END);
END; $function$;

GRANT EXECUTE ON FUNCTION public.fn_club_leaderboard_by_dates(uuid, text, date, date, integer, integer) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fn_global_leaderboard_by_dates(text, date, date, integer, integer) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fn_user_rank_by_dates(uuid, uuid, text, date, date) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fn_user_rank_global_by_dates(uuid, text, date, date) TO authenticated, anon, service_role;

DO $$
DECLARE v_missing text[];
BEGIN
  SELECT array_agg(x) INTO v_missing FROM unnest(ARRAY[
    'fn_club_leaderboard_by_dates','fn_global_leaderboard_by_dates',
    'fn_user_rank_by_dates','fn_user_rank_global_by_dates']) AS x
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                      WHERE n.nspname='public' AND p.proname = x);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'not created: %', v_missing; END IF;
END $$;
