-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721180346 "sync_tournament_chips_bulk_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 076d37a0d78d39957fd0770ef563737f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Bulk tournament-chip sync: the elimination checker ran one UPDATE per seat per
-- table every 5s (N+1, flooding Postgres). This applies all (user_id -> chips)
-- updates for a tournament in ONE statement via jsonb_to_recordset. chips is
-- floored (tournament_players.chips is INTEGER; a fractional numeric stack would
-- fail the cast and flood the logs). Only 'playing' rows are touched.
CREATE OR REPLACE FUNCTION public.fn_sync_tournament_chips(
  p_tournament_id uuid,
  p_updates jsonb
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF p_tournament_id IS NULL OR p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' THEN
    RETURN 0;
  END IF;

  UPDATE public.tournament_players tp
     SET chips = floor(GREATEST(u.chips, 0))::integer
  FROM jsonb_to_recordset(p_updates) AS u(user_id uuid, chips numeric)
  WHERE tp.tournament_id = p_tournament_id
    AND tp.user_id = u.user_id
    AND tp.status = 'playing';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

DO $$
DECLARE r integer;
BEGIN
  SELECT fn_sync_tournament_chips(NULL, NULL) INTO r;
  IF r <> 0 THEN RAISE EXCEPTION 'null guard failed: %', r; END IF;
END $$;
