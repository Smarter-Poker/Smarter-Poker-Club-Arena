-- ═══════════════════════════════════════════════════════════════════════════════
-- 20260821b: is_sitting_out must not survive seat turnover
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- The engine now persists sit-out state to table_seats.is_sitting_out
-- (2026-08-21, sit-out visibility fix). table_seats keeps ONE ROW PER
-- (table_id, seat_number) and seats are reused by UPDATE — so a player who
-- left while sat out would bequeath is_sitting_out=true to the NEXT player
-- seated in that row (late-reg seating and balancer moves both reuse rows).
--
-- Rule, enforced for every writer (engine, API routes, RPCs):
--   * leaving a seat (left_at: null -> set) clears the flag
--   * reactivating a seat (left_at: set -> null) clears the flag, unless the
--     writer explicitly set it in the same update
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_clear_sitout_on_turnover ON public.table_seats;
--   DROP FUNCTION IF EXISTS public.fn_clear_sitout_on_turnover();

CREATE OR REPLACE FUNCTION public.fn_clear_sitout_on_turnover()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Leaving: the sit-out belonged to the departing occupant.
  IF NEW.left_at IS NOT NULL AND OLD.left_at IS NULL THEN
    NEW.is_sitting_out := false;
  -- Reactivating a previously-left row: fresh occupant, fresh state —
  -- unless this very update explicitly set the flag.
  ELSIF NEW.left_at IS NULL AND OLD.left_at IS NOT NULL
        AND NEW.is_sitting_out IS NOT DISTINCT FROM OLD.is_sitting_out THEN
    NEW.is_sitting_out := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clear_sitout_on_turnover ON public.table_seats;
CREATE TRIGGER trg_clear_sitout_on_turnover
  BEFORE UPDATE ON public.table_seats
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_clear_sitout_on_turnover();

-- One-time hygiene: no vacated row keeps the flag.
UPDATE public.table_seats SET is_sitting_out = false
WHERE left_at IS NOT NULL AND is_sitting_out = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.table_seats'::regclass
      AND tgname = 'trg_clear_sitout_on_turnover'
  ) THEN
    RAISE EXCEPTION 'trg_clear_sitout_on_turnover missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.table_seats
    WHERE left_at IS NOT NULL AND is_sitting_out = true
  ) THEN
    RAISE EXCEPTION 'vacated rows still flagged sitting-out';
  END IF;
END $$;
