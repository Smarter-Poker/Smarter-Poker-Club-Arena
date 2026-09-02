-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828182606; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_no_live_seat_on_finished_game()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_status text;
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.status INTO v_status
    FROM public.tables tb
    JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE tb.id = NEW.table_id;

  IF v_status IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_status IN ('COMPLETED', 'CANCELLED') THEN
    NEW.left_at := now();
    NEW.is_sitting_out := false;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_no_live_seat_on_finished_game ON public.table_seats;
CREATE TRIGGER trg_no_live_seat_on_finished_game
  BEFORE INSERT OR UPDATE ON public.table_seats
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_no_live_seat_on_finished_game();

UPDATE public.table_seats s
   SET left_at = COALESCE(t.ended_at, now()),
       is_sitting_out = false
  FROM public.tables tb
  JOIN public.tournaments t ON t.id = tb.tournament_id
 WHERE s.table_id = tb.id
   AND s.left_at IS NULL
   AND t.status IN ('COMPLETED', 'CANCELLED');

DO $$
DECLARE
  v_left integer;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.tournaments t
    JOIN public.tables tb ON tb.tournament_id = t.id
    JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
   WHERE t.status IN ('COMPLETED', 'CANCELLED');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'backfill left % live seat(s) on finished games', v_left;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_no_live_seat_on_finished_game'
       AND tgrelid = 'public.table_seats'::regclass
  ) THEN
    RAISE EXCEPTION 'trigger trg_no_live_seat_on_finished_game did not attach';
  END IF;

  IF (SELECT count(*)
        FROM public.tournaments t
        JOIN public.tables tb ON tb.tournament_id = t.id
        JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
       WHERE t.status = 'RUNNING') = 0 THEN
    RAISE EXCEPTION 'no seated players remain on any RUNNING tournament - the predicate is too wide';
  END IF;
END $$;
