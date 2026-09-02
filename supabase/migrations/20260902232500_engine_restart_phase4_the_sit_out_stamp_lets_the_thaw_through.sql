-- ============================================================================
--  PHASE 4 OF 9 (part 1) - THE SIT-OUT STAMP LETS THE THAW THROUGH
--
--  fn_thaw_platform shifts table_seats.sit_out_at forward by the frozen
--  duration so a player who sat out at :53 still owns the five minutes at
--  :00. It has reported "sit_out_at: N" on every thaw since 21:00 UTC and
--  moved NOTHING, because trg_stamp_sit_out_at (a BEFORE UPDATE trigger from
--  20260828210000) fires on the same row and, for a seat that is still
--  sitting out, does exactly what it was built to do:
--
--      NEW.sit_out_at := COALESCE(OLD.sit_out_at, NEW.sit_out_at, now());
--
--  i.e. it holds the ORIGINAL stamp against any writer, so that an unrelated
--  stack or time-bank UPDATE cannot restart the five minutes. That rule is
--  right and stays. The thaw is the one writer that is entitled to move the
--  stamp, and it already announces itself: it runs under
--  SET LOCAL app.freeze_bypass = 'on', the same GUC the freeze guard honours,
--  and nothing else on the platform sets it (grep: 20260902090000 defines
--  it, 20260902091000 is its only caller).
--
--  So: while sitting out, the stamp is held UNLESS the transaction is the
--  thaw and the thaw supplied a new, non-null value. Every other path is
--  byte-for-byte the previous behaviour. Probe (rolled back, 2026-09-02):
--  before this change shifted_by = 00:00:00 on a sitting-out seat under
--  freeze_bypass; after it, shifted_by = 00:05:00, and the same UPDATE
--  without the GUC still holds the original stamp.
-- ============================================================================
BEGIN;

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
    -- Entering sit-out: start the clock.
    NEW.sit_out_at := now();
  ELSIF NOT COALESCE(NEW.is_sitting_out, false) THEN
    -- Not sitting out, by any route (sat back in, seat turned over, evicted).
    NEW.sit_out_at := NULL;
  ELSIF public.fn_freeze_bypass_active()
        AND NEW.sit_out_at IS NOT NULL
        AND NEW.sit_out_at IS DISTINCT FROM OLD.sit_out_at THEN
    -- Still sitting out, and the writer is the THAW (the only transaction
    -- that runs under app.freeze_bypass). It is giving this clock back the
    -- minutes the freeze took; honour the value it supplied.
    NULL;
  ELSE
    -- Still sitting out. HOLD THE ORIGINAL STAMP. An unrelated UPDATE to the
    -- row (a stack change, a time-bank decrement, a status write) must NOT
    -- restart the five minutes.
    NEW.sit_out_at := COALESCE(OLD.sit_out_at, NEW.sit_out_at, now());
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_stamp_sit_out_at() IS
  'BEFORE INSERT OR UPDATE on table_seats: stamps sit_out_at on the transition into sitting out, clears it on the way out, and holds the original stamp while sitting out - except for the thaw (app.freeze_bypass), which is entitled to shift it by the frozen duration.';

-- Assertions: the trigger is still attached, and the function reads the GUC.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.table_seats'::regclass
       AND t.tgname = 'trg_stamp_sit_out_at'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_stamp_sit_out_at is not attached to table_seats';
  END IF;
  IF position('fn_freeze_bypass_active' IN pg_get_functiondef('public.fn_stamp_sit_out_at()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'fn_stamp_sit_out_at does not consult fn_freeze_bypass_active';
  END IF;
END $$;

COMMIT;
