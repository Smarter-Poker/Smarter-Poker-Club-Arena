-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506130326 "extend_protect_trigger_to_insert"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 07d787b44353b557046e116b435699c5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Extend the protective trigger to ALSO cover INSERT, closing the orphan-rescue
-- INSERT vector (rare: requires handle_new_user to have failed, but possible).
-- TG_OP differentiates INSERT (where OLD is unassigned) from UPDATE.

CREATE OR REPLACE FUNCTION public.fn_protect_profile_username_and_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- Trusted callers bypass entirely
  IF current_user IN ('postgres','service_role','supabase_admin','supabase_auth_admin') THEN
    RETURN NEW;
  END IF;

  -- Username validation: fires on INSERT (any non-empty username) or UPDATE
  -- when the username changed. Validates against lowercase form so case-mixed
  -- inputs are checked correctly.
  IF TG_OP = 'INSERT' OR NEW.username IS DISTINCT FROM OLD.username THEN
    IF NEW.username IS NOT NULL AND btrim(NEW.username) <> '' THEN
      IF lower(NEW.username) !~ '^[a-z0-9][a-z0-9_.]{2,19}$' THEN
        RAISE EXCEPTION 'Username must be 3–20 characters using letters, numbers, underscores, or periods (no spaces or special characters).'
          USING ERRCODE = '22023';
      END IF;
      IF public.is_reserved_username(NEW.username) THEN
        RAISE EXCEPTION 'That username is reserved. Pick a different one.'
          USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;

  -- Gate transition guard: false→true (or INSERT-with-true) requires all fields
  IF NEW.social_profile_completed = true 
     AND (TG_OP = 'INSERT' OR coalesce(OLD.social_profile_completed, false) = false) THEN
    IF coalesce(btrim(NEW.full_name), '') = '' THEN
      RAISE EXCEPTION 'Cannot mark profile complete without a full name.'
        USING ERRCODE = '22023';
    END IF;
    IF coalesce(btrim(NEW.username), '') = '' THEN
      RAISE EXCEPTION 'Cannot mark profile complete without a username.'
        USING ERRCODE = '22023';
    END IF;
    IF length(regexp_replace(coalesce(NEW.phone, ''), '[^0-9]', '', 'g')) NOT BETWEEN 7 AND 15 THEN
      RAISE EXCEPTION 'Cannot mark profile complete without a valid phone number (7–15 digits).'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_username_and_gate ON public.profiles;
CREATE TRIGGER trg_protect_profile_username_and_gate
BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.fn_protect_profile_username_and_gate();
