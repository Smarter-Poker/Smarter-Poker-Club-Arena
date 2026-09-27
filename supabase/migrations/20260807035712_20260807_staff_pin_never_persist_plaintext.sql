-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260807035712 "20260807_staff_pin_never_persist_plaintext"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1409a7dd1406d44f0f7c41b9b1cb8288 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Stop persisting plaintext staff PINs.
-- Hashing only pays off once the plaintext column is empty: until now every PIN
-- was still readable in commander_staff.pin_code, so a table leak exposed them
-- all. All readers of that column are gone (auth uses fn_verify_staff_pin;
-- duplicate checks use fn_staff_pin_taken), so the trigger now consumes the
-- submitted PIN and writes ONLY the hash, blanking the plaintext in the same
-- statement. Callers keep writing `pin_code` exactly as before.
--
-- IMPORTANT semantics change: a NULL pin_code no longer clears pin_hash.
-- Because plaintext is blanked after hashing, OLD.pin_code is always NULL, so
-- treating "NULL means clear" would wipe a staff member's hash on any later
-- write that happened to include the column — locking them out. To clear a PIN,
-- set pin_hash = NULL explicitly.
--
-- ROLLBACK: restore the trigger body from 20260807_staff_pin_autohash_trigger.
--   (The plaintext PINs are NOT recoverable after this migration — by design.)

CREATE OR REPLACE FUNCTION public.fn_commander_staff_hash_pin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF NEW.pin_code IS NOT NULL THEN
    NEW.pin_hash := extensions.crypt(NEW.pin_code, extensions.gen_salt('bf', 6));
    NEW.pin_code := NULL;   -- never persist plaintext
  END IF;
  RETURN NEW;
END;
$$;

-- Blank the plaintext that is already stored (hashes were backfilled earlier).
UPDATE public.commander_staff
   SET pin_code = NULL
 WHERE pin_code IS NOT NULL;
