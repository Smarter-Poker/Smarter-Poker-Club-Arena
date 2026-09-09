CREATE OR REPLACE FUNCTION public.fn_evict_sitting_out_cash_players()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN;
  END IF;

  -- A. Boot players sitting out for more than 5 minutes
  FOR r IN
    SELECT ts.table_id, ts.user_id
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    WHERE t.game_type = 'cash'
      AND ts.left_at IS NULL
      AND ts.sit_out_at < (now() - interval '5 minutes')
  LOOP
    PERFORM public.player_leave_table(r.table_id, r.user_id);
  END LOOP;

  -- B. Boot players with exactly 0 chips who are sitting out
  FOR r IN
    SELECT ts.table_id, ts.user_id
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    WHERE t.game_type = 'cash'
      AND ts.left_at IS NULL
      AND ts.stack = 0
      AND ts.is_sitting_out = true
  LOOP
    PERFORM public.player_leave_table(r.table_id, r.user_id);
  END LOOP;

  -- C. Remove 0-chip players in Tournaments who are marked as eliminated
  FOR r IN
    SELECT ts.table_id, ts.user_id
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    JOIN tournament_players tp ON tp.tournament_id = t.tournament_id AND tp.user_id = ts.user_id
    WHERE ts.left_at IS NULL
      AND tp.status = 'eliminated'
  LOOP
    PERFORM public.player_leave_table(r.table_id, r.user_id);
  END LOOP;
END;
$function$
