-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260807033907 "20260807_staff_pin_autohash_trigger"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 86593bd538957980a1320a7cd8ed4c03 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Auto-hash staff PINs on write.
-- PINs are set/changed from several places (registration, admin PIN setup, staff
-- management). Rather than chase every write path in application code, hash at
-- the database boundary: any INSERT or UPDATE that sets pin_code now derives
-- pin_hash automatically, so no code path can reintroduce an unhashed PIN.
-- Cost 6 matches the tuned backfill (see 20260807_staff_pin_hash_cost_tuning).
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_commander_staff_hash_pin ON public.commander_staff;
--   DROP FUNCTION IF EXISTS public.fn_commander_staff_hash_pin();

CREATE OR REPLACE FUNCTION public.fn_commander_staff_hash_pin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF NEW.pin_code IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW.pin_code IS DISTINCT FROM OLD.pin_code
          OR NEW.pin_hash IS NULL) THEN
    NEW.pin_hash := extensions.crypt(NEW.pin_code, extensions.gen_salt('bf', 6));
  END IF;

  IF NEW.pin_code IS NULL THEN
    NEW.pin_hash := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commander_staff_hash_pin ON public.commander_staff;
CREATE TRIGGER trg_commander_staff_hash_pin
  BEFORE INSERT OR UPDATE OF pin_code, pin_hash ON public.commander_staff
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_commander_staff_hash_pin();
