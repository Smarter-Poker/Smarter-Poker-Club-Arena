-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819232739 "leaderboard_bb100_accumulator"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 34ea8e54022df101b60f8b33253d0b77 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- bb/100 WIN RATE — the metric poker players actually rank each other by
-- ═══════════════════════════════════════════════════════════════════════════
-- Profit in chips is not comparable across stakes: a winning 1/2 grinder and a
-- losing 15/30 player can appear in the same order on a chip-profit board.
-- bb/100 (big blinds won per 100 hands) normalises for stake and is the
-- standard poker win-rate unit.
--
-- Definition used:
--     bb/100 = 100 * (winnings - losses) / SUM(big_blind over hands dealt in)
--
-- This is exactly Σ(net_i / bb_i) / hands * 100 when a player plays a single
-- stake, and a stake-weighted aggregate when they mix - which is the desired
-- behaviour (a hand at 15/30 should carry more weight than one at 1/2).
-- Computing it per-hand instead would need per-hand net, which the trigger
-- cannot see (winnings arrive here, contributions arrive via the engine's
-- promo_apply_playthrough call), so the accumulator form is both correct and
-- the only one available.
--
-- player_stats.sum_big_blind accumulates one big_blind per seated player per
-- cash hand, in the same statement that already counts hands_dealt - no extra
-- trigger cost.
--
-- ROLLBACK:
--   ALTER TABLE player_stats           DROP COLUMN sum_big_blind;
--   ALTER TABLE player_stats_snapshots DROP COLUMN sum_big_blind;
--   -- restore fn_fold_hand_winnings + fn_snapshot_player_stats from 20260819j
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE player_stats           ADD COLUMN IF NOT EXISTS sum_big_blind numeric NOT NULL DEFAULT 0;
ALTER TABLE player_stats_snapshots ADD COLUMN IF NOT EXISTS sum_big_blind numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION fn_fold_hand_winnings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
END; $$;

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
END; $function$;

CREATE TABLE IF NOT EXISTS _lb_bb_daily (
  user_id uuid    NOT NULL,
  club_id uuid    NOT NULL,
  day     date    NOT NULL,
  sum_bb  numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, club_id, day)
);
ALTER TABLE _lb_bb_daily ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='player_stats' AND column_name='sum_big_blind') THEN
    RAISE EXCEPTION 'sum_big_blind did not land';
  END IF;
END $$;
