-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506155723 "protect_trigger_friendly_collision_message"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a94ea025acbd156209f7043efecaa4e9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- UX bug found by audit: when a user changes their username via profile-edit
-- (direct PostgREST UPDATE, not the gate's RPC), a collision raises raw
-- SQLSTATE 23505 'duplicate key value violates unique constraint
-- "profiles_username_lower_key"' — opaque to users.
--
-- Fix: pre-empt the unique-index violation inside the trigger and raise a
-- clean SQLSTATE 22023 with a user-readable message, matching the format
-- and reserved-word error styles. Now ALL username errors over ANY path
-- surface as the same friendly shape.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_protect_profile_username_and_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_existing_id uuid;
BEGIN
  -- Trusted callers bypass entirely
  IF current_user IN ('postgres','service_role','supabase_admin','supabase_auth_admin') THEN
    RETURN NEW;
  END IF;

  -- Username validation: fires on INSERT (any non-empty username) or UPDATE
  -- when the username changed. All checks operate on the lowercase form so
  -- case-mixed inputs are validated correctly.
  IF TG_OP = 'INSERT' OR NEW.username IS DISTINCT FROM OLD.username THEN
    IF NEW.username IS NOT NULL AND btrim(NEW.username) <> '' THEN
      -- (1) Format
      IF lower(NEW.username) !~ '^[a-z0-9][a-z0-9_.]{2,19}$' THEN
        RAISE EXCEPTION 'Username must be 3–20 characters using letters, numbers, underscores, or periods (no spaces or special characters).'
          USING ERRCODE = '22023';
      END IF;
      -- (2) Reserved words
      IF public.is_reserved_username(NEW.username) THEN
        RAISE EXCEPTION 'That username is reserved. Pick a different one.'
          USING ERRCODE = '22023';
      END IF;
      -- (3) Case-insensitive uniqueness — friendly message before the
      --     unique index can fire its raw 23505 error. Excludes self so a
      --     user resaving their own row (e.g. case-only change to OLD value)
      --     doesn't get rejected.
      SELECT id INTO v_existing_id FROM public.profiles
       WHERE lower(username) = lower(NEW.username)
         AND id <> NEW.id
       LIMIT 1;
      IF v_existing_id IS NOT NULL THEN
        RAISE EXCEPTION 'That username is already taken. Pick a different one.'
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
