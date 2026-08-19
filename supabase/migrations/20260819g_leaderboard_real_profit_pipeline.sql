-- ═══════════════════════════════════════════════════════════════════════════
-- LEADERBOARD REAL-PROFIT PIPELINE                                 2026-08-19
-- ═══════════════════════════════════════════════════════════════════════════
-- Tier 3 migration. Root cause being fixed: NOTHING ever wrote
-- player_stats.total_winnings / total_losses. update_player_hand_stats is a
-- stub (bumps profiles.total_hands_played only) and RakebackSettlerService
-- only increments hands_played / total_rake. Result: every profit / ROI
-- leaderboard has shown 0.00 for all 1,398 players.
--
-- Fix (no engine deploy required):
--   WINNINGS: AFTER INSERT trigger on hand_history folds NEW.winners into
--     player_stats.total_winnings (cash hands only; club from tables.club_id).
--     hand_history INSERT is service_role-only (RLS verified 2026-08-19).
--   LOSSES: promo_apply_playthrough is ALREADY called by the deployed engine
--     once per contributing player per cash hand with the player's exact
--     chip contribution (ServerTableEngineSettlement STEP 12b). It now also
--     accumulates that contribution into player_stats.total_losses, gated to
--     service_role callers so an authenticated client cannot spoof stats.
--   Profit = total_winnings - total_losses = SUM(won - invested) = exact net.
--   ROI    = (W - L) / L, matching the existing frontend formula.
--
-- Also adds:
--   fn_club_leaderboard_period_v2  (adds real rank_change vs yesterday)
--   fn_global_leaderboard_period   (cross-club leaderboard incl. all_time)
--   fn_user_rank_global_period     (user rank in global scope)
--
-- Zeroes the stale July-backfill winnings/losses so the incremental
-- rake_records backfill that follows this migration starts from a clean,
-- uniform definition (same-hand-set winnings AND losses).
--
-- ROLLBACK (Tier 3):
--   DROP TRIGGER IF EXISTS hand_history_fold_stats ON hand_history;
--   DROP FUNCTION IF EXISTS fn_fold_hand_winnings();
--   DROP FUNCTION IF EXISTS fn_club_leaderboard_period_v2(uuid,text,text,integer);
--   DROP FUNCTION IF EXISTS fn_global_leaderboard_period(text,text,integer);
--   DROP FUNCTION IF EXISTS fn_user_rank_global_period(uuid,text,text);
--   -- restore promo_apply_playthrough to its previous definition (captured
--   -- in .agent/audits/2026-08-19-leaderboard-real-profit-pipeline.md and in
--   -- git history of this migration file).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Pre-flight assertions ───────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'player_stats'::regclass
                   AND conname = 'player_stats_user_id_club_id_key') THEN
    RAISE EXCEPTION 'player_stats UNIQUE(user_id, club_id) missing - upserts would fail';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'tables' AND column_name = 'club_id') THEN
    RAISE EXCEPTION 'tables.club_id missing - winner folding cannot resolve club';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'promo_apply_playthrough') THEN
    RAISE EXCEPTION 'promo_apply_playthrough missing - loss accumulation has no delivery vehicle';
  END IF;
END $$;

-- ── 1. Zero stale winnings/losses (old, non-uniform July backfill) ──────────
UPDATE player_stats
   SET total_winnings = 0, total_losses = 0, updated_at = now()
 WHERE total_winnings <> 0 OR total_losses <> 0;

-- ── 2. Winner folding trigger ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_fold_hand_winnings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_club uuid;
BEGIN
  -- Cash hands only: tournament chip swings are not bankroll profit.
  IF NEW.tournament_id IS NOT NULL
     OR NEW.winners IS NULL
     OR jsonb_typeof(NEW.winners) <> 'array'
     OR jsonb_array_length(NEW.winners) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT t.club_id INTO v_club FROM tables t WHERE t.id = NEW.table_id;
  IF v_club IS NULL THEN RETURN NEW; END IF;

  INSERT INTO player_stats (id, user_id, club_id, total_winnings, updated_at)
  SELECT gen_random_uuid(), (w->>'userId')::uuid, v_club,
         SUM((w->>'amount')::numeric), now()
    FROM jsonb_array_elements(NEW.winners) w
   WHERE (w->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND COALESCE((w->>'amount')::numeric, 0) > 0
   GROUP BY (w->>'userId')::uuid
  ON CONFLICT (user_id, club_id) DO UPDATE
     SET total_winnings = player_stats.total_winnings + EXCLUDED.total_winnings,
         updated_at     = now();

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never break the money-critical hand_history insert over a stats fold.
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS hand_history_fold_stats ON hand_history;
CREATE TRIGGER hand_history_fold_stats
  AFTER INSERT ON hand_history
  FOR EACH ROW EXECUTE FUNCTION fn_fold_hand_winnings();

-- ── 3. promo_apply_playthrough: add loss accumulation (behavior-preserving) ──
-- The engine calls this once per contributing player per cash hand with the
-- player's exact contribution (p_wagered). Existing promo logic is unchanged;
-- the ONLY addition is the service_role-gated player_stats.total_losses
-- accumulation at the top. authenticated retains EXECUTE (pre-existing), but
-- the stats branch is unreachable for it.
CREATE OR REPLACE FUNCTION public.promo_apply_playthrough(p_club_id uuid, p_user_id uuid, p_wagered numeric)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_promo    numeric;
  v_required numeric;
  v_wagered  numeric;
  v_released numeric := 0;
BEGIN
  IF p_wagered IS NULL OR p_wagered <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_wager');
  END IF;

  -- ── Leaderboard loss accumulation (2026-08-19) ──
  -- Engine-only (service_role or direct postgres). Exception-safe: a stats
  -- failure must never affect the promo money path.
  IF COALESCE(auth.role(), '') = 'service_role' OR session_user = 'postgres' THEN
    BEGIN
      INSERT INTO player_stats (id, user_id, club_id, total_losses, updated_at)
      VALUES (gen_random_uuid(), p_user_id, p_club_id, p_wagered, now())
      ON CONFLICT (user_id, club_id) DO UPDATE
         SET total_losses = player_stats.total_losses + EXCLUDED.total_losses,
             updated_at   = now();
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  SELECT COALESCE(promo_balance, 0), COALESCE(promo_playthrough_required, 0), COALESCE(promo_wagered, 0)
    INTO v_promo, v_required, v_wagered
    FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id
   FOR UPDATE;

  -- Nothing outstanding to unlock.
  IF v_promo IS NULL OR v_promo <= 0 OR v_required <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_outstanding_promo');
  END IF;

  v_wagered := v_wagered + p_wagered;

  IF v_wagered >= v_required THEN
    -- Playthrough met: release the bonus to cashable chip_balance. Zero the promo
    -- fields so it can never release twice.
    v_released := v_promo;
    UPDATE club_members
       SET chip_balance               = COALESCE(chip_balance, 0) + v_promo::integer,
           promo_balance              = 0,
           promo_playthrough_required = 0,
           promo_wagered              = 0,
           updated_at                 = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;

    INSERT INTO chip_transactions (id, club_id, to_user_id, amount, transaction_type, notes, created_at)
    VALUES (gen_random_uuid(), p_club_id, p_user_id, v_released, 'promo_released',
            'Promo bonus released to cashable balance after playthrough met', NOW());
  ELSE
    UPDATE club_members
       SET promo_wagered = v_wagered, updated_at = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object('applied', true, 'released', v_released,
                            'wagered', v_wagered, 'required', v_required);
END;
$function$;

-- ── 4. Club leaderboard v2 (adds rank_change, handles all_time) ─────────────
CREATE OR REPLACE FUNCTION fn_club_leaderboard_period_v2(
  p_club_id uuid,
  p_metric  text    DEFAULT 'profit',
  p_period  text    DEFAULT 'weekly',
  p_limit   integer DEFAULT 10
)
RETURNS TABLE(user_id uuid, hands_played numeric, total_winnings numeric,
              total_losses numeric, tournaments_won numeric, total_rake numeric,
              rank_change integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_days integer; v_target date; v_baseline date; v_yesterday date;
BEGIN
  v_days := CASE p_period WHEN 'daily' THEN 1 WHEN 'weekly' THEN 7 WHEN 'monthly' THEN 30 ELSE 0 END;

  IF v_days > 0 THEN
    v_target := CURRENT_DATE - v_days;
    SELECT max(snapshot_date) INTO v_baseline FROM player_stats_snapshots
     WHERE club_id = p_club_id AND snapshot_date <= v_target;
    IF v_baseline IS NULL THEN
      SELECT min(snapshot_date) INTO v_baseline FROM player_stats_snapshots WHERE club_id = p_club_id;
    END IF;
  END IF;

  SELECT max(snapshot_date) INTO v_yesterday FROM player_stats_snapshots
   WHERE club_id = p_club_id AND snapshot_date <= CURRENT_DATE - 1
     AND (v_baseline IS NULL OR snapshot_date >= v_baseline);

  RETURN QUERY
  WITH cur AS (
    SELECT ps.user_id AS uid,
           (CASE WHEN v_days = 0 THEN ps.hands_played::numeric
                 ELSE GREATEST(ps.hands_played - COALESCE(b.hands_played, 0), 0)::numeric END) AS d_hands,
           (CASE WHEN v_days = 0 THEN ps.total_winnings::numeric
                 ELSE (ps.total_winnings - COALESCE(b.total_winnings, 0))::numeric END) AS d_win,
           (CASE WHEN v_days = 0 THEN ps.total_losses::numeric
                 ELSE (ps.total_losses - COALESCE(b.total_losses, 0))::numeric END) AS d_loss,
           (CASE WHEN v_days = 0 THEN ps.tournaments_won::numeric
                 ELSE GREATEST(ps.tournaments_won - COALESCE(b.tournaments_won, 0), 0)::numeric END) AS d_twon,
           (CASE WHEN v_days = 0 THEN ps.total_rake::numeric
                 ELSE GREATEST(ps.total_rake - COALESCE(b.total_rake, 0), 0)::numeric END) AS d_rake,
           (CASE WHEN v_yesterday IS NULL THEN NULL
                 WHEN v_days = 0 THEN
                   (CASE p_metric WHEN 'hands_played' THEN COALESCE(y.hands_played, 0)::numeric
                                  WHEN 'tournaments_won' THEN COALESCE(y.tournaments_won, 0)::numeric
                                  ELSE (COALESCE(y.total_winnings, 0) - COALESCE(y.total_losses, 0)) END)
                 ELSE
                   (CASE p_metric
                      WHEN 'hands_played' THEN GREATEST(COALESCE(y.hands_played, 0) - COALESCE(b.hands_played, 0), 0)::numeric
                      WHEN 'tournaments_won' THEN GREATEST(COALESCE(y.tournaments_won, 0) - COALESCE(b.tournaments_won, 0), 0)::numeric
                      ELSE ((COALESCE(y.total_winnings, 0) - COALESCE(b.total_winnings, 0))
                          - (COALESCE(y.total_losses, 0) - COALESCE(b.total_losses, 0))) END)
            END) AS old_val
      FROM player_stats ps
      LEFT JOIN player_stats_snapshots b
        ON v_days > 0 AND b.user_id = ps.user_id AND b.club_id = ps.club_id AND b.snapshot_date = v_baseline
      LEFT JOIN player_stats_snapshots y
        ON v_yesterday IS NOT NULL AND y.user_id = ps.user_id AND y.club_id = ps.club_id AND y.snapshot_date = v_yesterday
     WHERE ps.club_id = p_club_id
  ),
  ranked AS (
    SELECT cur.uid, cur.d_hands, cur.d_win, cur.d_loss, cur.d_twon, cur.d_rake,
           row_number() OVER (ORDER BY
             (CASE p_metric WHEN 'hands_played' THEN cur.d_hands
                            WHEN 'tournaments_won' THEN cur.d_twon
                            ELSE (cur.d_win - cur.d_loss) END) DESC, cur.uid) AS rn_now,
           (CASE WHEN cur.old_val IS NULL THEN NULL
                 ELSE row_number() OVER (ORDER BY cur.old_val DESC NULLS LAST, cur.uid) END) AS rn_old
      FROM cur
  )
  SELECT r.uid, r.d_hands, r.d_win, r.d_loss, r.d_twon, r.d_rake,
         COALESCE((r.rn_old - r.rn_now)::integer, 0)
    FROM ranked r
   ORDER BY r.rn_now
   LIMIT p_limit;
END; $$;

-- ── 5. Global leaderboard (cross-club, incl. all_time) ──────────────────────
CREATE OR REPLACE FUNCTION fn_global_leaderboard_period(
  p_metric text    DEFAULT 'profit',
  p_period text    DEFAULT 'weekly',
  p_limit  integer DEFAULT 50
)
RETURNS TABLE(user_id uuid, hands_played numeric, total_winnings numeric,
              total_losses numeric, tournaments_won numeric, total_rake numeric,
              rank_change integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_days integer; v_target date; v_baseline date; v_yesterday date;
BEGIN
  v_days := CASE p_period WHEN 'daily' THEN 1 WHEN 'weekly' THEN 7 WHEN 'monthly' THEN 30 ELSE 0 END;

  IF v_days > 0 THEN
    v_target := CURRENT_DATE - v_days;
    SELECT max(snapshot_date) INTO v_baseline FROM player_stats_snapshots WHERE snapshot_date <= v_target;
    IF v_baseline IS NULL THEN
      SELECT min(snapshot_date) INTO v_baseline FROM player_stats_snapshots;
    END IF;
  END IF;

  SELECT max(snapshot_date) INTO v_yesterday FROM player_stats_snapshots
   WHERE snapshot_date <= CURRENT_DATE - 1
     AND (v_baseline IS NULL OR snapshot_date >= v_baseline);

  RETURN QUERY
  WITH cur_ps AS (
    SELECT ps.user_id AS uid,
           SUM(ps.hands_played)::numeric    AS s_hands,
           SUM(ps.total_winnings)::numeric  AS s_win,
           SUM(ps.total_losses)::numeric    AS s_loss,
           SUM(ps.tournaments_won)::numeric AS s_twon,
           SUM(ps.total_rake)::numeric      AS s_rake
      FROM player_stats ps
     GROUP BY ps.user_id
  ),
  base AS (
    SELECT s.user_id AS uid,
           SUM(s.hands_played)::numeric    AS s_hands,
           SUM(s.total_winnings)::numeric  AS s_win,
           SUM(s.total_losses)::numeric    AS s_loss,
           SUM(s.tournaments_won)::numeric AS s_twon,
           SUM(s.total_rake)::numeric      AS s_rake
      FROM player_stats_snapshots s
     WHERE v_days > 0 AND s.snapshot_date = v_baseline
     GROUP BY s.user_id
  ),
  yest AS (
    SELECT s.user_id AS uid,
           SUM(s.hands_played)::numeric    AS s_hands,
           SUM(s.total_winnings)::numeric  AS s_win,
           SUM(s.total_losses)::numeric    AS s_loss,
           SUM(s.tournaments_won)::numeric AS s_twon
      FROM player_stats_snapshots s
     WHERE v_yesterday IS NOT NULL AND s.snapshot_date = v_yesterday
     GROUP BY s.user_id
  ),
  cur AS (
    SELECT c.uid,
           (CASE WHEN v_days = 0 THEN c.s_hands ELSE GREATEST(c.s_hands - COALESCE(b.s_hands, 0), 0) END) AS d_hands,
           (CASE WHEN v_days = 0 THEN c.s_win   ELSE (c.s_win  - COALESCE(b.s_win, 0))  END) AS d_win,
           (CASE WHEN v_days = 0 THEN c.s_loss  ELSE (c.s_loss - COALESCE(b.s_loss, 0)) END) AS d_loss,
           (CASE WHEN v_days = 0 THEN c.s_twon  ELSE GREATEST(c.s_twon - COALESCE(b.s_twon, 0), 0) END) AS d_twon,
           (CASE WHEN v_days = 0 THEN c.s_rake  ELSE GREATEST(c.s_rake - COALESCE(b.s_rake, 0), 0) END) AS d_rake,
           (CASE WHEN v_yesterday IS NULL THEN NULL
                 WHEN v_days = 0 THEN
                   (CASE p_metric WHEN 'hands_played' THEN COALESCE(y.s_hands, 0)
                                  WHEN 'tournaments_won' THEN COALESCE(y.s_twon, 0)
                                  ELSE (COALESCE(y.s_win, 0) - COALESCE(y.s_loss, 0)) END)
                 ELSE
                   (CASE p_metric
                      WHEN 'hands_played' THEN GREATEST(COALESCE(y.s_hands, 0) - COALESCE(b.s_hands, 0), 0)
                      WHEN 'tournaments_won' THEN GREATEST(COALESCE(y.s_twon, 0) - COALESCE(b.s_twon, 0), 0)
                      ELSE ((COALESCE(y.s_win, 0) - COALESCE(b.s_win, 0))
                          - (COALESCE(y.s_loss, 0) - COALESCE(b.s_loss, 0))) END)
            END) AS old_val
      FROM cur_ps c
      LEFT JOIN base b ON b.uid = c.uid
      LEFT JOIN yest y ON y.uid = c.uid
  ),
  ranked AS (
    SELECT cur.uid, cur.d_hands, cur.d_win, cur.d_loss, cur.d_twon, cur.d_rake,
           row_number() OVER (ORDER BY
             (CASE p_metric WHEN 'hands_played' THEN cur.d_hands
                            WHEN 'tournaments_won' THEN cur.d_twon
                            ELSE (cur.d_win - cur.d_loss) END) DESC, cur.uid) AS rn_now,
           (CASE WHEN cur.old_val IS NULL THEN NULL
                 ELSE row_number() OVER (ORDER BY cur.old_val DESC NULLS LAST, cur.uid) END) AS rn_old
      FROM cur
  )
  SELECT r.uid, r.d_hands, r.d_win, r.d_loss, r.d_twon, r.d_rake,
         COALESCE((r.rn_old - r.rn_now)::integer, 0)
    FROM ranked r
   ORDER BY r.rn_now
   LIMIT p_limit;
END; $$;

-- ── 6. Global user rank ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_user_rank_global_period(
  p_user_id uuid,
  p_metric  text DEFAULT 'profit',
  p_period  text DEFAULT 'weekly'
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_days integer; v_target date; v_baseline date;
        v_rank integer; v_total integer; v_user_val numeric;
BEGIN
  v_days := CASE p_period WHEN 'daily' THEN 1 WHEN 'weekly' THEN 7 WHEN 'monthly' THEN 30 ELSE 0 END;
  IF v_days > 0 THEN
    v_target := CURRENT_DATE - v_days;
    SELECT max(snapshot_date) INTO v_baseline FROM player_stats_snapshots WHERE snapshot_date <= v_target;
    IF v_baseline IS NULL THEN
      SELECT min(snapshot_date) INTO v_baseline FROM player_stats_snapshots;
    END IF;
  END IF;

  WITH cur_ps AS (
    SELECT ps.user_id AS uid,
           SUM(ps.hands_played)::numeric    AS s_hands,
           SUM(ps.total_winnings)::numeric  AS s_win,
           SUM(ps.total_losses)::numeric    AS s_loss,
           SUM(ps.tournaments_won)::numeric AS s_twon
      FROM player_stats ps GROUP BY ps.user_id
  ),
  base AS (
    SELECT s.user_id AS uid,
           SUM(s.hands_played)::numeric    AS s_hands,
           SUM(s.total_winnings)::numeric  AS s_win,
           SUM(s.total_losses)::numeric    AS s_loss,
           SUM(s.tournaments_won)::numeric AS s_twon
      FROM player_stats_snapshots s
     WHERE v_days > 0 AND s.snapshot_date = v_baseline
     GROUP BY s.user_id
  ),
  vals AS (
    SELECT c.uid,
           (CASE WHEN v_days = 0 THEN
              (CASE p_metric WHEN 'hands_played' THEN c.s_hands
                             WHEN 'tournaments_won' THEN c.s_twon
                             ELSE (c.s_win - c.s_loss) END)
            ELSE
              (CASE p_metric
                 WHEN 'hands_played' THEN GREATEST(c.s_hands - COALESCE(b.s_hands, 0), 0)
                 WHEN 'tournaments_won' THEN GREATEST(c.s_twon - COALESCE(b.s_twon, 0), 0)
                 ELSE ((c.s_win - COALESCE(b.s_win, 0)) - (c.s_loss - COALESCE(b.s_loss, 0))) END)
            END) AS val
      FROM cur_ps c LEFT JOIN base b ON b.uid = c.uid
  )
  SELECT (SELECT count(*) FROM vals WHERE val > (SELECT val FROM vals WHERE uid = p_user_id)) + 1,
         (SELECT count(*) FROM vals),
         (SELECT val FROM vals WHERE uid = p_user_id)
    INTO v_rank, v_total, v_user_val;

  IF v_user_val IS NULL THEN RETURN jsonb_build_object('found', false); END IF;
  RETURN jsonb_build_object('found', true, 'rank', v_rank, 'total', v_total, 'value', v_user_val);
END; $$;

-- ── 7. Grants ────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION fn_club_leaderboard_period_v2(uuid, text, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_global_leaderboard_period(text, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_user_rank_global_period(uuid, text, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION fn_fold_hand_winnings() FROM PUBLIC;

-- ── Post-apply assertions ────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'hand_history_fold_stats') THEN
    RAISE EXCEPTION 'trigger hand_history_fold_stats did not land';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('fn_club_leaderboard_period_v2', 'fn_global_leaderboard_period',
                           'fn_user_rank_global_period')) <> 3 THEN
    RAISE EXCEPTION 'leaderboard RPCs did not all land';
  END IF;
  IF EXISTS (SELECT 1 FROM player_stats WHERE total_winnings <> 0 AND updated_at < now() - interval '5 minutes') THEN
    RAISE EXCEPTION 'stale winnings zero-out did not take effect';
  END IF;
END $$;
