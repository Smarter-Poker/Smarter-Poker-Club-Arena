-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825180218; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_guard_one_live_tournament_seat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament_id uuid;
  v_other_table   uuid;
  v_other_seat    integer;
BEGIN
  IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.tournament_id INTO v_tournament_id
  FROM public.tables t
  WHERE t.id = NEW.table_id;

  IF v_tournament_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ts.table_id, ts.seat_number
    INTO v_other_table, v_other_seat
  FROM public.table_seats ts
  JOIN public.tables t2 ON t2.id = ts.table_id
  WHERE ts.left_at IS NULL
    AND ts.user_id = NEW.user_id
    AND t2.tournament_id = v_tournament_id
    AND ts.id IS DISTINCT FROM NEW.id
  LIMIT 1;

  IF v_other_table IS NOT NULL THEN
    RAISE EXCEPTION
      'player % already holds a live seat in tournament % (table %, seat %) - one live seat per tournament',
      NEW.user_id, v_tournament_id, v_other_table, v_other_seat
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_one_live_seat_per_tournament ON public.table_seats;

CREATE TRIGGER trg_one_live_seat_per_tournament
BEFORE INSERT OR UPDATE OF user_id, left_at, table_id ON public.table_seats
FOR EACH ROW
WHEN (NEW.left_at IS NULL)
EXECUTE FUNCTION public.fn_guard_one_live_tournament_seat();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.table_seats'::regclass
      AND tgname = 'trg_one_live_seat_per_tournament'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_one_live_seat_per_tournament was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_guard_one_live_tournament_seat'
  ) THEN
    RAISE EXCEPTION 'fn_guard_one_live_tournament_seat was not created';
  END IF;
END $$;
