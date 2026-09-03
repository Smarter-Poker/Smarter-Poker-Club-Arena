-- ═══════════════════════════════════════════════════════════════════════════
-- LEADERBOARD CORRECTNESS PASS                                     2026-08-19
-- ═══════════════════════════════════════════════════════════════════════════
-- Applied to production 2026-08-19 21:58:38 UTC (migration
-- 20260819215838_leaderboard_correctness_hands_dealt_roi_rankchange).
-- Function bodies below are dumped from the live catalog so this file cannot
-- drift from production.
--
-- Fixes four defects found auditing the 20260819g pipeline:
--
--   D1  ROI board was ordered by PROFIT, not ROI. Measured before the fix,
--       displayed positions 1..10 had ROI 25.94, 18.87, 17.88, 21.49, 18.06,
--       10.01, 14.78, 24.04, 9.33, 7.88 - not descending. Now ordered by real
--       ROI with a 20-hand volume qualifier. Unqualified players sort last via
--       NULLS LAST rather than being excluded, so a small club is never shown
--       an empty board. Verified after fix: 25.94, 24.04, 21.49, 21.04, 18.87,
--       18.06, 17.88, 15.96 - strictly descending.
--
--   D2  hands_played was ~13% of reality. Measured on 2026-08-18: 1,083,942
--       true seat-hands dealt vs 144,956 booked. Cause: RakebackSettlerService
--       owns hands_played and only walks raked hands. New column
--       player_stats.hands_dealt is incremented by the hand_history trigger for
--       every seated player of every cash hand, and the leaderboard hands
--       metric now reads it. Verified after backfill: 1,083,930 / 1,083,942 =
--       100.0%. The settler column is left untouched - rakeback still owns it.
--
--   D3  rank_change was noise for the daily period: avg |change| of 287
--       positions vs 28 for monthly. Cause: the baseline snapshot and the
--       comparison snapshot were the SAME date, so every previous value
--       collapsed to 0 and the "previous" ranking was an arbitrary uid
--       tiebreak. Previous standings are now the same-length window ending
--       yesterday (daily -> yesterday full day; weekly -> the 7 days ending
--       yesterday; all_time -> all-time as of yesterday). Verified: 527
--       distinct previous values across 575 players, 0 nulls.
--
--   D4  Winner folding was a single multi-row INSERT, so one winner id missing
--       from profiles would abort the whole hand. Folded into the same
--       statement as hands_dealt and filtered to ids present in profiles, so a
--       bad id costs only that row. Latent - 0 bad ids observed.
--
-- Backfill: hands_dealt seeded from hand_history for every cash hand before the
-- trigger cutover; staged 9,027,837 vs 9,027,793 true seat-hands (0.0005%).
-- Snapshots recomputed per date so period deltas stay correct.
--
-- ROLLBACK: restore the four functions from
-- 20260819g_leaderboard_real_profit_pipeline.sql, then
--   ALTER TABLE player_stats DROP COLUMN hands_dealt;
--   ALTER TABLE player_stats_snapshots DROP COLUMN hands_dealt;
--   DROP INDEX IF EXISTS idx_pss_date;
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE player_stats           ADD COLUMN IF NOT EXISTS hands_dealt bigint NOT NULL DEFAULT 0;
ALTER TABLE player_stats_snapshots ADD COLUMN IF NOT EXISTS hands_dealt bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_pss_date ON player_stats_snapshots (snapshot_date);

DROP FUNCTION IF EXISTS fn_club_leaderboard_period_v2(uuid, text, text, integer);
DROP FUNCTION IF EXISTS fn_global_leaderboard_period(text, text, integer);

CREATE OR REPLACE FUNCTION public.fn_fold_hand_winnings()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_club uuid;
BEGIN
  IF NEW.tournament_id IS NOT NULL
     OR NEW.players IS NULL
     OR jsonb_typeof(NEW.players) <> 'array'
     OR jsonb_array_length(NEW.players) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT t.club_id INTO v_club FROM tables t WHERE t.id = NEW.table_id;
  IF v_club IS NULL THEN RETURN NEW; END IF;

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
  INSERT INTO player_stats (id, user_id, club_id, hands_dealt, total_winnings, updated_at)
  SELECT gen_random_uuid(), s.uid::uuid, v_club, 1, COALESCE(wo.amt, 0), now()
    FROM seated s
    LEFT JOIN won wo ON wo.uid = s.uid
   WHERE EXISTS (SELECT 1 FROM profiles p WHERE p.id = s.uid::uuid)
  ON CONFLICT (user_id, club_id) DO UPDATE
     SET hands_dealt    = player_stats.hands_dealt    + EXCLUDED.hands_dealt,
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
    (user_id, club_id, snapshot_date, hands_played, hands_dealt, total_winnings, total_losses,
     total_rake, tournaments_played, tournaments_won)
  SELECT user_id, club_id, CURRENT_DATE,
         COALESCE(hands_played,0), COALESCE(hands_dealt,0), COALESCE(total_winnings,0),
         COALESCE(total_losses,0),
         COALESCE(total_rake,0), COALESCE(tournaments_played,0), COALESCE(tournaments_won,0)
  FROM player_stats WHERE club_id IS NOT NULL
  ON CONFLICT (user_id, club_id, snapshot_date) DO UPDATE SET
    hands_played=EXCLUDED.hands_played, hands_dealt=EXCLUDED.hands_dealt,
    total_winnings=EXCLUDED.total_winnings,
    total_losses=EXCLUDED.total_losses, total_rake=EXCLUDED.total_rake,
    tournaments_played=EXCLUDED.tournaments_played, tournaments_won=EXCLUDED.tournaments_won;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'rows', v_count, 'date', CURRENT_DATE);
END; $function$
;

CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_period_v2(p_club_id uuid, p_metric text DEFAULT 'profit'::text, p_period text DEFAULT 'weekly'::text, p_limit integer DEFAULT 10)
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

  RETURN QUERY
  WITH cur AS (
    SELECT ps.user_id AS uid,
           (CASE WHEN v_days = 0 THEN ps.hands_dealt::numeric
                 ELSE GREATEST(ps.hands_dealt - COALESCE(b.hands_dealt, 0), 0)::numeric END) AS d_hands,
           (CASE WHEN v_days = 0 THEN ps.total_winnings
                 ELSE (ps.total_winnings - COALESCE(b.total_winnings, 0)) END) AS d_win,
           (CASE WHEN v_days = 0 THEN ps.total_losses
                 ELSE (ps.total_losses - COALESCE(b.total_losses, 0)) END) AS d_loss,
           (CASE WHEN v_days = 0 THEN ps.tournaments_won::numeric
                 ELSE GREATEST(ps.tournaments_won - COALESCE(b.tournaments_won, 0), 0)::numeric END) AS d_twon,
           (CASE WHEN v_days = 0 THEN ps.total_rake
                 ELSE GREATEST(ps.total_rake - COALESCE(b.total_rake, 0), 0) END) AS d_rake,
           (CASE WHEN pe.user_id IS NULL THEN NULL
                 ELSE GREATEST(pe.hands_dealt - COALESCE(pv.hands_dealt, 0), 0)::numeric END) AS p_hands,
           (CASE WHEN pe.user_id IS NULL THEN NULL
                 ELSE (pe.total_winnings - COALESCE(pv.total_winnings, 0)) END) AS p_win,
           (CASE WHEN pe.user_id IS NULL THEN NULL
                 ELSE (pe.total_losses - COALESCE(pv.total_losses, 0)) END) AS p_loss,
           (CASE WHEN pe.user_id IS NULL THEN NULL
                 ELSE GREATEST(pe.tournaments_won - COALESCE(pv.tournaments_won, 0), 0)::numeric END) AS p_twon
      FROM player_stats ps
      LEFT JOIN player_stats_snapshots b
        ON v_days > 0 AND b.user_id = ps.user_id AND b.club_id = ps.club_id AND b.snapshot_date = v_baseline
      LEFT JOIN player_stats_snapshots pe
        ON pe.user_id = ps.user_id AND pe.club_id = ps.club_id AND pe.snapshot_date = v_prev_end
      LEFT JOIN player_stats_snapshots pv
        ON v_days > 0 AND pv.user_id = ps.user_id AND pv.club_id = ps.club_id AND pv.snapshot_date = v_prev_start
     WHERE ps.club_id = p_club_id
  ),
  scored AS (
    SELECT c.*,
           (CASE p_metric
              WHEN 'hands_played'    THEN c.d_hands
              WHEN 'tournaments_won' THEN c.d_twon
              WHEN 'roi'             THEN CASE WHEN c.d_loss > 0 AND c.d_hands >= v_min_hands
                                               THEN (c.d_win - c.d_loss) / c.d_loss END
              ELSE (c.d_win - c.d_loss) END) AS score,
           (CASE p_metric
              WHEN 'hands_played'    THEN c.p_hands
              WHEN 'tournaments_won' THEN c.p_twon
              WHEN 'roi'             THEN CASE WHEN c.p_loss > 0 AND c.p_hands >= v_min_hands
                                               THEN (c.p_win - c.p_loss) / c.p_loss END
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

CREATE OR REPLACE FUNCTION public.fn_global_leaderboard_period(p_metric text DEFAULT 'profit'::text, p_period text DEFAULT 'weekly'::text, p_limit integer DEFAULT 50)
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
  WITH cur_ps AS (
    SELECT ps.user_id AS uid, SUM(ps.hands_dealt)::numeric AS s_hands,
           SUM(ps.total_winnings) AS s_win, SUM(ps.total_losses) AS s_loss,
           SUM(ps.tournaments_won)::numeric AS s_twon, SUM(ps.total_rake) AS s_rake
      FROM player_stats ps GROUP BY ps.user_id
  ),
  snap AS (
    SELECT s.user_id AS uid, s.snapshot_date AS d,
           SUM(s.hands_dealt)::numeric AS s_hands, SUM(s.total_winnings) AS s_win,
           SUM(s.total_losses) AS s_loss, SUM(s.tournaments_won)::numeric AS s_twon
      FROM player_stats_snapshots s
     WHERE s.snapshot_date IN (v_baseline, v_prev_end, v_prev_start)
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

GRANT EXECUTE ON FUNCTION fn_club_leaderboard_period_v2(uuid, text, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_global_leaderboard_period(text, text, integer) TO authenticated, service_role;
