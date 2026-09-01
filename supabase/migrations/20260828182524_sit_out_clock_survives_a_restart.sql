-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828182524; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- THE SIT-OUT CLOCK HAS TO SURVIVE A RESTART, OR IT NEVER RUNS OUT.
-- Full reasoning: supabase/migrations/20260828210000_sit_out_clock_survives_a_restart.sql
-- Root cause: DisconnectEngine.sitOutSince lived only in process memory, so every
-- engine restart re-stamped it to now() and the 5-minute cash eviction never matured.

ALTER TABLE public.table_seats
  ADD COLUMN IF NOT EXISTS sit_out_at timestamptz;

COMMENT ON COLUMN public.table_seats.sit_out_at IS
  'When this seat entered the sitting-out state. Stamped and cleared by trg_stamp_sit_out_at; never written by hand. NULL whenever is_sitting_out is false. The cash-game 5-minute eviction clock reads THIS, not process memory, so that it survives an engine restart (2026-08-28).';

CREATE OR REPLACE FUNCTION public.fn_stamp_sit_out_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.sit_out_at := CASE WHEN COALESCE(NEW.is_sitting_out, false)
                           THEN COALESCE(NEW.sit_out_at, now())
                           ELSE NULL END;
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.is_sitting_out, false) AND NOT COALESCE(OLD.is_sitting_out, false) THEN
    NEW.sit_out_at := now();
  ELSIF NOT COALESCE(NEW.is_sitting_out, false) THEN
    NEW.sit_out_at := NULL;
  ELSE
    NEW.sit_out_at := COALESCE(OLD.sit_out_at, NEW.sit_out_at, now());
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_stamp_sit_out_at ON public.table_seats;
CREATE TRIGGER trg_stamp_sit_out_at
  BEFORE INSERT OR UPDATE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_sit_out_at();

CREATE OR REPLACE FUNCTION public.fn_clear_sitout_on_turnover()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF NEW.left_at IS NOT NULL AND OLD.left_at IS NULL THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  ELSIF NEW.left_at IS NULL AND OLD.left_at IS NOT NULL
        AND NEW.is_sitting_out IS NOT DISTINCT FROM OLD.is_sitting_out THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_new_seat_clear_sitout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  NEW.is_sitting_out := false;
  NEW.sit_out_at := NULL;
  RETURN NEW;
END;
$function$;

UPDATE public.table_seats
   SET sit_out_at = now()
 WHERE left_at IS NULL
   AND COALESCE(is_sitting_out, false) = true
   AND sit_out_at IS NULL;

DO $$
DECLARE
  v_seat_id  uuid;
  v_table_id uuid;
  v_stamp1   timestamptz;
  v_stamp2   timestamptz;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='table_seats' AND column_name='sit_out_at'
  ) THEN
    RAISE EXCEPTION 'sit_out_at was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='trg_stamp_sit_out_at' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_stamp_sit_out_at was not created';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.table_seats
     WHERE left_at IS NULL
       AND COALESCE(is_sitting_out, false) = true
       AND sit_out_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a live sitting-out seat still has a null sit_out_at';
  END IF;

  -- Probe a DEPARTED seat only. Every other trigger on this table short-circuits
  -- on left_at IS NOT NULL, so this cannot refuse a seat or move a chip.
  SELECT id, table_id INTO v_seat_id, v_table_id
    FROM public.table_seats
   WHERE left_at IS NOT NULL
   ORDER BY left_at DESC
   LIMIT 1;

  IF v_seat_id IS NOT NULL THEN
    BEGIN
      UPDATE public.table_seats SET is_sitting_out = true WHERE id = v_seat_id;
      SELECT sit_out_at INTO v_stamp1 FROM public.table_seats WHERE id = v_seat_id;
      IF v_stamp1 IS NULL THEN
        RAISE EXCEPTION 'entering sit-out did not stamp sit_out_at';
      END IF;

      PERFORM pg_sleep(0.05);
      UPDATE public.table_seats SET status = status WHERE id = v_seat_id;
      SELECT sit_out_at INTO v_stamp2 FROM public.table_seats WHERE id = v_seat_id;
      IF v_stamp2 IS DISTINCT FROM v_stamp1 THEN
        RAISE EXCEPTION 'an unrelated UPDATE restarted the sit-out clock (% -> %)', v_stamp1, v_stamp2;
      END IF;

      UPDATE public.table_seats SET is_sitting_out = false WHERE id = v_seat_id;
      SELECT sit_out_at INTO v_stamp2 FROM public.table_seats WHERE id = v_seat_id;
      IF v_stamp2 IS NOT NULL THEN
        RAISE EXCEPTION 'sitting back in did not clear sit_out_at';
      END IF;

      RAISE EXCEPTION 'rollback_probe';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'rollback_probe' THEN
        RAISE;
      END IF;
    END;
  END IF;
END $$;
