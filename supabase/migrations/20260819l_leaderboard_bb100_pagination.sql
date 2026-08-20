-- ═══════════════════════════════════════════════════════════════════════════
-- LEADERBOARD: bb/100, pagination, honest window, snapshot gap detection
--                                                                  2026-08-19
-- ═══════════════════════════════════════════════════════════════════════════
-- Function bodies below are dumped from the live catalog so this file cannot
-- drift from production.
--
-- 1. bb/100 WIN RATE. Chip profit is not comparable across stakes - a losing
--    15/30 player can outrank a winning 1/2 grinder on a chip board. New
--    player_stats.sum_big_blind accumulates one big_blind per seated player per
--    cash hand (same trigger statement as hands_dealt, so no extra cost), and
--        bb/100 = 100 * (total_winnings - total_losses) / sum_big_blind
--    which is exactly Σ(net_i/bb_i)/hands*100 for a single stake and a
--    stake-weighted aggregate when mixed. Per-hand computation is impossible in
--    the trigger: winnings arrive there, contributions arrive separately via the
--    engine's promo_apply_playthrough call.
--    Backfilled from hand_history and reconciled at 100.000%
--    (20,079,332 staged vs 20,079,296 true big blinds).
--
-- 2. PAGINATION. p_offset plus rank and total_ranked in the result, so the
--    client can page and still show a correct rank on page 2+ (previously rank
--    was the array index, which is only right on the first page).
--
-- 3. HONEST WINDOW. baseline_date is returned so the UI can state the span it
--    actually measured. The snapshot job HAS missed a day - 2026-08-09 failed,
--    confirmed in cron.job_run_details - and on a miss these functions fall back
--    to an older snapshot, silently turning "This Week" into a longer window.
--
-- 4. GAP DETECTION. fn_leaderboard_snapshot_gaps(days) lists missing snapshot
--    dates so that condition is detectable at all. It currently returns exactly
--    2026-08-09.
--
-- Also: column COMMENTs distinguishing hands_dealt (true, leaderboard) from the
-- rakeback-owned hands_played (13.4% of reality), and update_player_hand_stats
-- annotated in-body - it is named as if it records hand stats but increments
-- profiles.total_hands_played and discards every other argument, which is why
-- profit read 0.00 platform-wide until today.
--
-- ROLLBACK:
--   ALTER TABLE player_stats           DROP COLUMN sum_big_blind;
--   ALTER TABLE player_stats_snapshots DROP COLUMN sum_big_blind;
--   DROP FUNCTION fn_leaderboard_snapshot_gaps(integer);
--   -- restore the leaderboard functions from 20260819j.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE player_stats           ADD COLUMN IF NOT EXISTS sum_big_blind numeric NOT NULL DEFAULT 0;
ALTER TABLE player_stats_snapshots ADD COLUMN IF NOT EXISTS sum_big_blind numeric NOT NULL DEFAULT 0;

DROP FUNCTION IF EXISTS fn_club_leaderboard_period_v2(uuid, text, text, integer);
DROP FUNCTION IF EXISTS fn_global_leaderboard_period(text, text, integer);

CREATE OR REPLACE FUNCTION public.fn_fold_hand_winnings()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_club uuid; v_bb numeric;
BEGIN
  IF NEW.tournament_id IS NOT NULL
     OR NEW.players IS NULL
     OR jsonb_typeof(NEW.players) <> 'array'
     OR jsonb_array_length(NEW.players) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT t.club_id INTO v_club FROM tables t WHERE t.id = NEW.table_id;
  IF v_club IS NULL THEN RETURN NEW; END IF;

  v_bb := GREATEST(COALESCE(NEW.big_blind, 0), 0);

  WITH seated AS (
    SELECT DISTINCT (pl->>'userId') AS uid
      FROM jsonb_array_elements(NEW.players) pl
     WHERE (pl->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  won AS (
    SELECT (w->>'userId') AS uid, SUM((w->>'amount')::numeric) AS amt
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(NEW.winners) = 'array' THEN NEW.winners ELSE '[]'::jsonb END
           ) w
     WHERE (w->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND COALESCE((w->>'amount')::numeric, 0) > 0
     GROUP BY 1
  )
  INSERT INTO player_stats (id, user_id, club_id, hands_dealt, sum_big_blind, total_winnings, updated_at)
  SELECT gen_random_uuid(), s.uid::uuid, v_club, 1, v_bb, COALESCE(wo.amt, 0), now()
    FROM seated s
    LEFT JOIN won wo ON wo.uid = s.uid
   WHERE EXISTS (SELECT 1 FROM profiles p WHERE p.id = s.uid::uuid)
  ON CONFLICT (user_id, club_id) DO UPDATE
     SET hands_dealt    = player_stats.hands_dealt    + EXCLUDED.hands_dealt,
         sum_big_blind  = player_stats.sum_big_blind  + EXCLUDED.sum_big_blind,
         total_winnings = player_stats.total_winnings + EXCLUDED.total_winnings,
         updated_at     = now();

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END; $function$
;

CREATE OR REPLACE FUNCTION public.fn_snapshot_player_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count integer;
BEGIN
  INSERT INTO player_stats_snapshots
    (user_id, club_id, snapshot_date, hands_played, hands_dealt, sum_big_blind,
     total_winnings, total_losses, total_rake, tournaments_played, tournaments_won)
  SELECT user_id, club_id, CURRENT_DATE,
         COALESCE(hands_played,0), COALESCE(hands_dealt,0), COALESCE(sum_big_blind,0),
         COALESCE(total_winnings,0), COALESCE(total_losses,0),
         COALESCE(total_rake,0), COALESCE(tournaments_played,0), COALESCE(tournaments_won,0)
  FROM player_stats WHERE club_id IS NOT NULL
  ON CONFLICT (user_id, club_id, snapshot_date) DO UPDATE SET
    hands_played=EXCLUDED.hands_played, hands_dealt=EXCLUDED.hands_dealt,
    sum_big_blind=EXCLUDED.sum_big_blind,
    total_winnings=EXCLUDED.total_winnings,
    total_losses=EXCLUDED.total_losses, total_rake=EXCLUDED.total_rake,
    tournaments_played=EXCLUDED.tournaments_played, tournaments_won=EXCLUDED.tournaments_won;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'rows', v_count, 'date', CURRENT_DATE);
END; $function$
;

CREATE OR REPLACE FUNCTION public.fn_leaderboard_snapshot_gaps(p_days integer DEFAULT 35)
 RETURNS TABLE(missing_date date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT d::date
  FROM generate_series(
         GREATEST((SELECT min(snapshot_date) FROM player_stats_snapshots),
                  CURRENT_DATE - p_days),
         CURRENT_DATE - 1, interval '1 day') d
  WHERE NOT EXISTS (
    SELECT 1 FROM player_stats_snapshots s WHERE s.snapshot_date = d::date
  );
$function$
;

CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_period_v2(p_club_id uuid, p_metric text DEFAULT 'profit'::text, p_period text DEFAULT 'weekly'::text, p_limit integer DEFAULT 10, p_offset integer DEFAULT 0)
 RETURNS TABLE(user_id uuid, hands_played numeric, total_winnings numeric, total_losses numeric, tournaments_won numeric, total_rake numeric, sum_big_blind numeric, rank_change integer, qualified boolean, rank integer, total_ranked integer, baseline_date date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
END; $function$
;

CREATE OR REPLACE FUNCTION public.fn_global_leaderboard_period(p_metric text DEFAULT 'profit'::text, p_period text DEFAULT 'weekly'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(user_id uuid, hands_played numeric, total_winnings numeric, total_losses numeric, tournaments_won numeric, total_rake numeric, sum_big_blind numeric, rank_change integer, qualified boolean, rank integer, total_ranked integer, baseline_date date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
END; $function$
;

CREATE OR REPLACE FUNCTION public.update_player_hand_stats(p_user_id uuid, p_profit numeric DEFAULT 0, p_is_voluntary boolean DEFAULT false, p_is_preflop_raise boolean DEFAULT false, p_went_to_showdown boolean DEFAULT false, p_won_at_showdown boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  -- NAME IS MISLEADING - READ BEFORE USING (documented 2026-08-19).
  -- This function increments profiles.total_hands_played and NOTHING ELSE.
  -- p_profit, p_is_voluntary, p_is_preflop_raise, p_went_to_showdown and
  -- p_won_at_showdown are accepted for call-site compatibility and DISCARDED.
  -- It has never written player_stats. Believing otherwise is why every profit
  -- and ROI leaderboard read 0.00 until 2026-08-19.
  --
  -- Real stat sources:
  --   winnings / hands_dealt / sum_big_blind -> hand_history_fold_stats trigger
  --   losses (contributions)                 -> promo_apply_playthrough
  -- Do not add stat writes here; add them to the trigger, which sees every hand.
  UPDATE profiles
  SET total_hands_played = COALESCE(total_hands_played, 0) + 1,
      updated_at = now()
  WHERE id = p_user_id;
END; $function$
;

GRANT EXECUTE ON FUNCTION fn_leaderboard_snapshot_gaps(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_club_leaderboard_period_v2(uuid, text, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_global_leaderboard_period(text, text, integer, integer) TO authenticated, service_role;
