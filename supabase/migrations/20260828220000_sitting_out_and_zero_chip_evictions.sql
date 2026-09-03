-- ═══════════════════════════════════════════════════════════════════════════════
-- SITTING OUT & 0-CHIP EVICTIONS (Cash Games)
-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Boot Cash Game players who have been sitting out > 5 minutes
-- 2. Boot Cash Game players with zero chips (who are sitting out)
-- 3. Runs every minute via pg_cron

CREATE OR REPLACE FUNCTION public.fn_evict_sitting_out_cash_players()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
BEGIN
  -- A. Boot players sitting out for more than 5 minutes
  FOR r IN 
    SELECT ts.table_id, ts.user_id
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    WHERE t.game_type = 'cash'
      AND ts.left_at IS NULL
      AND ts.sit_out_at < (now() - interval '5 minutes')
  LOOP
    -- Safely removes them and refunds any remaining chips to wallet
    PERFORM public.player_leave_table(r.table_id, r.user_id);
  END LOOP;

  -- B. Boot players with exactly 0 chips who are sitting out
  -- (If they are at 0 chips during a hand, is_sitting_out is false until the hand ends)
  FOR r IN 
    SELECT ts.table_id, ts.user_id
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    WHERE t.game_type = 'cash'
      AND ts.left_at IS NULL
      AND ts.stack = 0
      AND ts.is_sitting_out = true
  LOOP
    -- Safely removes them
    PERFORM public.player_leave_table(r.table_id, r.user_id);
  END LOOP;

  -- C. Remove 0-chip players in Tournaments who are marked as eliminated
  -- This ensures they don't linger on the table as a zombie seat
  FOR r IN
    SELECT ts.table_id, ts.user_id
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    JOIN tournament_players tp ON tp.tournament_id = t.tournament_id AND tp.user_id = ts.user_id
    WHERE ts.left_at IS NULL
      AND tp.status = 'eliminated'
  LOOP
    -- Removing a tournament player using player_leave_table just soft-deletes the seat,
    -- it does NOT refund chips because they are in a tournament (v_tournament_id IS NOT NULL).
    PERFORM public.player_leave_table(r.table_id, r.user_id);
  END LOOP;
END;
$$;

-- Schedule the cleanup job to run every minute
SELECT cron.schedule(
  'sp_evict_sitting_out_cash_players',
  '* * * * *',
  'SELECT public.fn_evict_sitting_out_cash_players();'
);
