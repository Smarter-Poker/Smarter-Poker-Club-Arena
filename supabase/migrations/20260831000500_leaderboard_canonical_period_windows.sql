-- Canonical leaderboard calendar windows.                                  2026-08-30
--
-- Before this migration the current board used rolling 1/7/30-day deltas,
-- historical boards used calendar dates calculated in each browser's local
-- timezone, and payout lookups repeated that browser calculation. A single
-- leaderboard could therefore show different competitors and prize periods.
--
-- This migration is forward-only and moves no money. It introduces one UTC,
-- Sunday-start calendar contract and makes club, global and union current
-- boards derive their baseline from it. Historical clients read the exact same
-- contract through PostgREST before calling the existing date-range RPCs.
--
-- Period boundaries are [start_at, end_at): start inclusive, end exclusive.
-- Sunday remains the week boundary because that was the product's existing
-- calendar-week intent before the rolling-window regression.
--
-- Rollback: ship a new forward migration restoring the previous function
-- bodies. Do not edit this migration after production apply.

CREATE OR REPLACE FUNCTION public.fn_leaderboard_period_window(
  p_period text,
  p_period_offset integer DEFAULT 0,
  p_reference timestamptz DEFAULT now()
)
RETURNS TABLE(
  period text,
  period_offset integer,
  timezone text,
  start_date date,
  end_date date,
  start_at timestamptz,
  end_at timestamptz,
  is_current boolean,
  label text
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_timezone constant text := 'UTC';
  v_offset integer := COALESCE(p_period_offset, 0);
  v_today date := (COALESCE(p_reference, now()) AT TIME ZONE v_timezone)::date;
  v_current_start date;
  v_start date;
  v_end date;
BEGIN
  IF p_period NOT IN ('daily', 'weekly', 'monthly', 'all_time') THEN
    RAISE EXCEPTION 'Unsupported Leaderboard Period' USING ERRCODE = '22023';
  END IF;
  IF v_offset > 0 THEN
    RAISE EXCEPTION 'Future Leaderboard Periods Are Not Available' USING ERRCODE = '22023';
  END IF;
  IF p_period = 'all_time' AND v_offset <> 0 THEN
    RAISE EXCEPTION 'All-Time Leaderboards Do Not Have Period Offsets' USING ERRCODE = '22023';
  END IF;

  v_current_start := CASE p_period
    WHEN 'daily' THEN v_today
    WHEN 'weekly' THEN v_today - EXTRACT(DOW FROM v_today)::integer
    WHEN 'monthly' THEN date_trunc('month', v_today)::date
    ELSE DATE '1970-01-01'
  END;

  v_start := CASE p_period
    WHEN 'daily' THEN v_current_start + v_offset
    WHEN 'weekly' THEN v_current_start + (v_offset * 7)
    WHEN 'monthly' THEN (v_current_start + make_interval(months => v_offset))::date
    ELSE v_current_start
  END;
  v_end := CASE p_period
    WHEN 'daily' THEN v_start + 1
    WHEN 'weekly' THEN v_start + 7
    WHEN 'monthly' THEN (v_start + interval '1 month')::date
    ELSE v_today + 1
  END;

  RETURN QUERY SELECT
    p_period,
    v_offset,
    v_timezone,
    v_start,
    v_end,
    v_start::timestamp AT TIME ZONE v_timezone,
    v_end::timestamp AT TIME ZONE v_timezone,
    v_offset = 0,
    CASE
      WHEN p_period = 'all_time' THEN 'All Time'
      WHEN p_period = 'daily' THEN to_char(v_start, 'Mon FMDD, YYYY')
      ELSE to_char(v_start, 'Mon FMDD') || ' - ' || to_char(v_end - 1, 'Mon FMDD, YYYY')
    END;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_leaderboard_period_window(text, integer, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_leaderboard_period_window(text, integer, timestamptz) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_leaderboard_period_window(text, integer, timestamptz)
  IS 'Canonical UTC leaderboard window. Boundaries are start-inclusive and end-exclusive; weeks begin Sunday.';

CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_period_v2(
  p_club_id uuid,
  p_metric text DEFAULT 'profit'::text,
  p_period text DEFAULT 'weekly'::text,
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
  v_period_start date;
  v_baseline date;
  v_prev_end date;
  v_min_hands integer := 20;
  v_is_all_time boolean := p_period = 'all_time';
BEGIN
  SELECT bounds.start_date INTO v_period_start
    FROM public.fn_leaderboard_period_window(p_period, 0) bounds;

  IF NOT v_is_all_time THEN
    SELECT max(snapshot_date) INTO v_baseline
      FROM public.player_stats_snapshots
     WHERE club_id = p_club_id AND snapshot_date <= v_period_start;
    IF v_baseline IS NULL THEN
      SELECT min(snapshot_date) INTO v_baseline
        FROM public.player_stats_snapshots WHERE club_id = p_club_id;
    END IF;
  END IF;

  SELECT max(snapshot_date) INTO v_prev_end
    FROM public.player_stats_snapshots
   WHERE club_id = p_club_id AND snapshot_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 1;

  RETURN QUERY
  WITH cur AS (
    SELECT ps.user_id AS uid,
           (CASE WHEN v_is_all_time THEN ps.hands_dealt::numeric ELSE GREATEST(ps.hands_dealt-COALESCE(b.hands_dealt,0),0)::numeric END) AS d_hands,
           (CASE WHEN v_is_all_time THEN ps.total_winnings ELSE (ps.total_winnings-COALESCE(b.total_winnings,0)) END) AS d_win,
           (CASE WHEN v_is_all_time THEN ps.total_losses ELSE (ps.total_losses-COALESCE(b.total_losses,0)) END) AS d_loss,
           (CASE WHEN v_is_all_time THEN ps.tournaments_won::numeric ELSE GREATEST(ps.tournaments_won-COALESCE(b.tournaments_won,0),0)::numeric END) AS d_twon,
           (CASE WHEN v_is_all_time THEN ps.total_rake ELSE GREATEST(ps.total_rake-COALESCE(b.total_rake,0),0) END) AS d_rake,
           (CASE WHEN v_is_all_time THEN ps.sum_big_blind ELSE GREATEST(ps.sum_big_blind-COALESCE(b.sum_big_blind,0),0) END) AS d_bb,
           (CASE WHEN pe.user_id IS NULL OR (NOT v_is_all_time AND v_prev_end <= v_baseline) THEN NULL ELSE GREATEST(pe.hands_dealt-COALESCE(pv.hands_dealt,0),0)::numeric END) AS p_hands,
           (CASE WHEN pe.user_id IS NULL OR (NOT v_is_all_time AND v_prev_end <= v_baseline) THEN NULL ELSE (pe.total_winnings-COALESCE(pv.total_winnings,0)) END) AS p_win,
           (CASE WHEN pe.user_id IS NULL OR (NOT v_is_all_time AND v_prev_end <= v_baseline) THEN NULL ELSE (pe.total_losses-COALESCE(pv.total_losses,0)) END) AS p_loss,
           (CASE WHEN pe.user_id IS NULL OR (NOT v_is_all_time AND v_prev_end <= v_baseline) THEN NULL ELSE GREATEST(pe.tournaments_won-COALESCE(pv.tournaments_won,0),0)::numeric END) AS p_twon,
           (CASE WHEN pe.user_id IS NULL OR (NOT v_is_all_time AND v_prev_end <= v_baseline) THEN NULL ELSE GREATEST(pe.sum_big_blind-COALESCE(pv.sum_big_blind,0),0) END) AS p_bb
      FROM public.player_stats ps
      LEFT JOIN public.player_stats_snapshots b
        ON NOT v_is_all_time AND b.user_id=ps.user_id AND b.club_id=ps.club_id AND b.snapshot_date=v_baseline
      LEFT JOIN public.player_stats_snapshots pe
        ON pe.user_id=ps.user_id AND pe.club_id=ps.club_id AND pe.snapshot_date=v_prev_end
      LEFT JOIN public.player_stats_snapshots pv
        ON NOT v_is_all_time AND pv.user_id=ps.user_id AND pv.club_id=ps.club_id AND pv.snapshot_date=v_baseline
     WHERE ps.club_id = p_club_id
  ),
  scored AS (
    SELECT c.*,
           (CASE p_metric
              WHEN 'hands_played' THEN c.d_hands
              WHEN 'tournaments_won' THEN c.d_twon
              WHEN 'roi' THEN CASE WHEN c.d_loss>0 AND c.d_hands>=v_min_hands THEN (c.d_win-c.d_loss)/c.d_loss END
              WHEN 'bb100' THEN CASE WHEN c.d_bb>0 AND c.d_hands>=v_min_hands THEN 100*(c.d_win-c.d_loss)/c.d_bb END
              ELSE (c.d_win-c.d_loss) END) AS score,
           (CASE p_metric
              WHEN 'hands_played' THEN c.p_hands
              WHEN 'tournaments_won' THEN c.p_twon
              WHEN 'roi' THEN CASE WHEN c.p_loss>0 AND c.p_hands>=v_min_hands THEN (c.p_win-c.p_loss)/c.p_loss END
              WHEN 'bb100' THEN CASE WHEN c.p_bb>0 AND c.p_hands>=v_min_hands THEN 100*(c.p_win-c.p_loss)/c.p_bb END
              ELSE (c.p_win-c.p_loss) END) AS prev_score
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
         COALESCE((r.rk_old-r.rk_now)::integer,0),
         (p_metric NOT IN ('roi','bb100') OR
          (r.d_hands>=v_min_hands AND (CASE WHEN p_metric='roi' THEN r.d_loss ELSE r.d_bb END)>0)),
         r.rk_now::integer, r.total_active::integer, v_baseline
    FROM ranked r
   ORDER BY r.rn_now
   LIMIT p_limit OFFSET GREATEST(COALESCE(p_offset,0),0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_global_leaderboard_period(
  p_metric text DEFAULT 'profit'::text,
  p_period text DEFAULT 'weekly'::text,
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
  v_period_start date;
  v_baseline date;
  v_prev_end date;
  v_min_hands integer := 20;
  v_is_all_time boolean := p_period = 'all_time';
BEGIN
  SELECT bounds.start_date INTO v_period_start
    FROM public.fn_leaderboard_period_window(p_period, 0) bounds;

  IF NOT v_is_all_time THEN
    SELECT max(snapshot_date) INTO v_baseline
      FROM public.player_stats_snapshots WHERE snapshot_date <= v_period_start;
    IF v_baseline IS NULL THEN
      SELECT min(snapshot_date) INTO v_baseline FROM public.player_stats_snapshots;
    END IF;
  END IF;
  SELECT max(snapshot_date) INTO v_prev_end
    FROM public.player_stats_snapshots
   WHERE snapshot_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 1;
  RETURN QUERY
  WITH cur_ps AS (
    SELECT ps.user_id AS uid, SUM(ps.hands_dealt)::numeric AS s_hands,
           SUM(ps.total_winnings) AS s_win, SUM(ps.total_losses) AS s_loss,
           SUM(ps.tournaments_won)::numeric AS s_twon, SUM(ps.total_rake) AS s_rake,
           SUM(ps.sum_big_blind) AS s_bb
      FROM public.player_stats ps GROUP BY ps.user_id
  ),
  snap AS (
    SELECT s.user_id AS uid, s.snapshot_date AS d, SUM(s.hands_dealt)::numeric AS s_hands,
           SUM(s.total_winnings) AS s_win, SUM(s.total_losses) AS s_loss,
           SUM(s.tournaments_won)::numeric AS s_twon, SUM(s.total_rake) AS s_rake,
           SUM(s.sum_big_blind) AS s_bb
      FROM public.player_stats_snapshots s
     WHERE s.snapshot_date IN (v_baseline, v_prev_end)
     GROUP BY s.user_id, s.snapshot_date
  ),
  cur AS (
    SELECT c.uid,
           (CASE WHEN v_is_all_time THEN c.s_hands ELSE GREATEST(c.s_hands-COALESCE(b.s_hands,0),0) END) AS d_hands,
           (CASE WHEN v_is_all_time THEN c.s_win ELSE c.s_win-COALESCE(b.s_win,0) END) AS d_win,
           (CASE WHEN v_is_all_time THEN c.s_loss ELSE c.s_loss-COALESCE(b.s_loss,0) END) AS d_loss,
           (CASE WHEN v_is_all_time THEN c.s_twon ELSE GREATEST(c.s_twon-COALESCE(b.s_twon,0),0) END) AS d_twon,
           (CASE WHEN v_is_all_time THEN c.s_rake ELSE GREATEST(c.s_rake-COALESCE(b.s_rake,0),0) END) AS d_rake,
           (CASE WHEN v_is_all_time THEN c.s_bb ELSE GREATEST(c.s_bb-COALESCE(b.s_bb,0),0) END) AS d_bb,
           (CASE WHEN pe.uid IS NULL OR (NOT v_is_all_time AND v_prev_end<=v_baseline) THEN NULL ELSE GREATEST(pe.s_hands-COALESCE(b.s_hands,0),0) END) AS p_hands,
           (CASE WHEN pe.uid IS NULL OR (NOT v_is_all_time AND v_prev_end<=v_baseline) THEN NULL ELSE pe.s_win-COALESCE(b.s_win,0) END) AS p_win,
           (CASE WHEN pe.uid IS NULL OR (NOT v_is_all_time AND v_prev_end<=v_baseline) THEN NULL ELSE pe.s_loss-COALESCE(b.s_loss,0) END) AS p_loss,
           (CASE WHEN pe.uid IS NULL OR (NOT v_is_all_time AND v_prev_end<=v_baseline) THEN NULL ELSE GREATEST(pe.s_twon-COALESCE(b.s_twon,0),0) END) AS p_twon,
           (CASE WHEN pe.uid IS NULL OR (NOT v_is_all_time AND v_prev_end<=v_baseline) THEN NULL ELSE GREATEST(pe.s_bb-COALESCE(b.s_bb,0),0) END) AS p_bb
      FROM cur_ps c
      LEFT JOIN snap b ON NOT v_is_all_time AND b.uid=c.uid AND b.d=v_baseline
      LEFT JOIN snap pe ON pe.uid=c.uid AND pe.d=v_prev_end
  ),
  scored AS (
    SELECT c.*,
           (CASE p_metric
              WHEN 'hands_played' THEN c.d_hands
              WHEN 'tournaments_won' THEN c.d_twon
              WHEN 'roi' THEN CASE WHEN c.d_loss>0 AND c.d_hands>=v_min_hands THEN (c.d_win-c.d_loss)/c.d_loss END
              WHEN 'bb100' THEN CASE WHEN c.d_bb>0 AND c.d_hands>=v_min_hands THEN 100*(c.d_win-c.d_loss)/c.d_bb END
              ELSE c.d_win-c.d_loss END) AS score,
           (CASE p_metric
              WHEN 'hands_played' THEN c.p_hands
              WHEN 'tournaments_won' THEN c.p_twon
              WHEN 'roi' THEN CASE WHEN c.p_loss>0 AND c.p_hands>=v_min_hands THEN (c.p_win-c.p_loss)/c.p_loss END
              WHEN 'bb100' THEN CASE WHEN c.p_bb>0 AND c.p_hands>=v_min_hands THEN 100*(c.p_win-c.p_loss)/c.p_bb END
              ELSE c.p_win-c.p_loss END) AS prev_score
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
         COALESCE((r.rk_old-r.rk_now)::integer,0),
         (p_metric NOT IN ('roi','bb100') OR
          (r.d_hands>=v_min_hands AND (CASE WHEN p_metric='roi' THEN r.d_loss ELSE r.d_bb END)>0)),
         r.rk_now::integer, r.total_active::integer, v_baseline
    FROM ranked r
   ORDER BY r.rn_now
   LIMIT p_limit OFFSET GREATEST(COALESCE(p_offset,0),0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_leaderboard_period_v2(
  p_union_id uuid,
  p_metric text DEFAULT 'profit'::text,
  p_period text DEFAULT 'weekly'::text,
  p_limit integer DEFAULT 20,
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
  v_period_start date;
  v_baseline date;
  v_prev_end date;
  v_min_hands integer := 20;
  v_is_all_time boolean := p_period = 'all_time';
BEGIN
  SELECT bounds.start_date INTO v_period_start
    FROM public.fn_leaderboard_period_window(p_period, 0) bounds;
  IF NOT v_is_all_time THEN
    SELECT max(snapshot_date) INTO v_baseline
      FROM public.player_stats_snapshots WHERE snapshot_date <= v_period_start;
    IF v_baseline IS NULL THEN
      SELECT min(snapshot_date) INTO v_baseline FROM public.player_stats_snapshots;
    END IF;
  END IF;
  SELECT max(snapshot_date) INTO v_prev_end
    FROM public.player_stats_snapshots
   WHERE snapshot_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 1;

  RETURN QUERY
  WITH club_ids AS (
    SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=p_union_id
  ),
  cur_ps AS (
    SELECT ps.user_id AS uid, SUM(ps.hands_dealt)::numeric AS s_hands,
           SUM(ps.total_winnings) AS s_win, SUM(ps.total_losses) AS s_loss,
           SUM(ps.tournaments_won)::numeric AS s_twon, SUM(ps.total_rake) AS s_rake,
           SUM(ps.sum_big_blind) AS s_bb
      FROM public.player_stats ps
     WHERE ps.club_id IN (SELECT club_id FROM club_ids)
     GROUP BY ps.user_id
  ),
  snap AS (
    SELECT s.user_id AS uid, s.snapshot_date AS d, SUM(s.hands_dealt)::numeric AS s_hands,
           SUM(s.total_winnings) AS s_win, SUM(s.total_losses) AS s_loss,
           SUM(s.tournaments_won)::numeric AS s_twon, SUM(s.total_rake) AS s_rake,
           SUM(s.sum_big_blind) AS s_bb
      FROM public.player_stats_snapshots s
     WHERE s.club_id IN (SELECT club_id FROM club_ids)
       AND s.snapshot_date IN (v_baseline,v_prev_end)
     GROUP BY s.user_id,s.snapshot_date
  ),
  cur AS (
    SELECT c.uid,
           (CASE WHEN v_is_all_time THEN c.s_hands ELSE GREATEST(c.s_hands-COALESCE(b.s_hands,0),0) END) AS d_hands,
           (CASE WHEN v_is_all_time THEN c.s_win ELSE c.s_win-COALESCE(b.s_win,0) END) AS d_win,
           (CASE WHEN v_is_all_time THEN c.s_loss ELSE c.s_loss-COALESCE(b.s_loss,0) END) AS d_loss,
           (CASE WHEN v_is_all_time THEN c.s_twon ELSE GREATEST(c.s_twon-COALESCE(b.s_twon,0),0) END) AS d_twon,
           (CASE WHEN v_is_all_time THEN c.s_rake ELSE GREATEST(c.s_rake-COALESCE(b.s_rake,0),0) END) AS d_rake,
           (CASE WHEN v_is_all_time THEN c.s_bb ELSE GREATEST(c.s_bb-COALESCE(b.s_bb,0),0) END) AS d_bb,
           (CASE WHEN pe.uid IS NULL OR (NOT v_is_all_time AND v_prev_end<=v_baseline) THEN NULL ELSE GREATEST(pe.s_hands-COALESCE(b.s_hands,0),0) END) AS p_hands,
           (CASE WHEN pe.uid IS NULL OR (NOT v_is_all_time AND v_prev_end<=v_baseline) THEN NULL ELSE pe.s_win-COALESCE(b.s_win,0) END) AS p_win,
           (CASE WHEN pe.uid IS NULL OR (NOT v_is_all_time AND v_prev_end<=v_baseline) THEN NULL ELSE pe.s_loss-COALESCE(b.s_loss,0) END) AS p_loss,
           (CASE WHEN pe.uid IS NULL OR (NOT v_is_all_time AND v_prev_end<=v_baseline) THEN NULL ELSE GREATEST(pe.s_twon-COALESCE(b.s_twon,0),0) END) AS p_twon,
           (CASE WHEN pe.uid IS NULL OR (NOT v_is_all_time AND v_prev_end<=v_baseline) THEN NULL ELSE GREATEST(pe.s_bb-COALESCE(b.s_bb,0),0) END) AS p_bb
      FROM cur_ps c
      LEFT JOIN snap b ON NOT v_is_all_time AND b.uid=c.uid AND b.d=v_baseline
      LEFT JOIN snap pe ON pe.uid=c.uid AND pe.d=v_prev_end
  ),
  scored AS (
    SELECT c.*,
           (CASE p_metric
              WHEN 'hands_played' THEN c.d_hands
              WHEN 'tournaments_won' THEN c.d_twon
              WHEN 'roi' THEN CASE WHEN c.d_loss>0 AND c.d_hands>=v_min_hands THEN (c.d_win-c.d_loss)/c.d_loss END
              WHEN 'bb100' THEN CASE WHEN c.d_bb>0 AND c.d_hands>=v_min_hands THEN 100*(c.d_win-c.d_loss)/c.d_bb END
              ELSE c.d_win-c.d_loss END) AS score,
           (CASE p_metric
              WHEN 'hands_played' THEN c.p_hands
              WHEN 'tournaments_won' THEN c.p_twon
              WHEN 'roi' THEN CASE WHEN c.p_loss>0 AND c.p_hands>=v_min_hands THEN (c.p_win-c.p_loss)/c.p_loss END
              WHEN 'bb100' THEN CASE WHEN c.p_bb>0 AND c.p_hands>=v_min_hands THEN 100*(c.p_win-c.p_loss)/c.p_bb END
              ELSE c.p_win-c.p_loss END) AS prev_score
      FROM cur c
  ),
  ranked AS (
    SELECT s.*,
           row_number() OVER (ORDER BY s.score DESC NULLS LAST,s.uid) AS rn_now,
           rank() OVER (ORDER BY s.score DESC NULLS LAST) AS rk_now,
           count(*) OVER () AS total_active,
           CASE WHEN s.prev_score IS NULL THEN NULL
                ELSE rank() OVER (ORDER BY s.prev_score DESC NULLS LAST) END AS rk_old
      FROM scored s
     WHERE (s.d_hands > 0 OR s.d_twon > 0 OR s.d_win <> 0 OR s.d_loss <> 0)
  )
  SELECT r.uid,r.d_hands,r.d_win,r.d_loss,r.d_twon,r.d_rake,r.d_bb,
         COALESCE((r.rk_old-r.rk_now)::integer,0),
         (p_metric NOT IN ('roi','bb100') OR
          (r.d_hands>=v_min_hands AND (CASE WHEN p_metric='roi' THEN r.d_loss ELSE r.d_bb END)>0)),
         r.rk_now::integer,r.total_active::integer,v_baseline
    FROM ranked r
   ORDER BY r.rn_now
   LIMIT p_limit OFFSET GREATEST(COALESCE(p_offset,0),0);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_club_leaderboard_period_v2(uuid,text,text,integer,integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_global_leaderboard_period(text,text,integer,integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_leaderboard_period_v2(uuid,text,text,integer,integer) TO authenticated, service_role;

-- Compile the replaced function bodies and assert representative UTC edges
-- inside this transaction. Any mismatch aborts the migration before commit.
DO $verify$
DECLARE
  v_window record;
BEGIN
  SELECT * INTO v_window
    FROM public.fn_leaderboard_period_window('daily', 0, '2026-01-01 23:30:00-08'::timestamptz);
  IF v_window.start_date <> DATE '2026-01-02' OR v_window.end_date <> DATE '2026-01-03' THEN
    RAISE EXCEPTION 'Daily UTC Boundary Self-Check Failed';
  END IF;

  SELECT * INTO v_window
    FROM public.fn_leaderboard_period_window('weekly', -1, '2026-08-30 20:00:00+00'::timestamptz);
  IF v_window.start_date <> DATE '2026-08-23' OR v_window.end_date <> DATE '2026-08-30' THEN
    RAISE EXCEPTION 'Sunday Weekly Boundary Self-Check Failed';
  END IF;

  SELECT * INTO v_window
    FROM public.fn_leaderboard_period_window('monthly', -1, '2024-03-15 12:00:00+00'::timestamptz);
  IF v_window.start_date <> DATE '2024-02-01' OR v_window.end_date <> DATE '2024-03-01' THEN
    RAISE EXCEPTION 'Leap-Year Monthly Boundary Self-Check Failed';
  END IF;

  PERFORM user_id FROM public.fn_club_leaderboard_period_v2(
    '00000000-0000-0000-0000-000000000000'::uuid, 'profit', 'weekly', 1, 0
  );
  PERFORM user_id FROM public.fn_global_leaderboard_period('profit', 'daily', 1, 0);
  PERFORM user_id FROM public.fn_union_leaderboard_period_v2(
    '00000000-0000-0000-0000-000000000000'::uuid, 'bb100', 'monthly', 1, 0
  );
END;
$verify$;
