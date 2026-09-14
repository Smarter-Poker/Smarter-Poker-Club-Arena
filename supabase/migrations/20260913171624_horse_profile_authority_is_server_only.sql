-- 20260913171624_horse_profile_authority_is_server_only.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '45s';

-- Ordinary accounts currently have UPDATE grants on all three server-owned
-- horse fields and a table-wide INSERT grant. Owner RLS does not distinguish
-- human-profile edits from assigning that account an automated identity.
-- Refuse drift in the existing JWT-aware server-authority predicate.
DO $preflight$
BEGIN
  IF md5(pg_get_functiondef('public.fn_is_service_context()'::regprocedure))
      IS DISTINCT FROM '182174b0de81460b135f1002062f3764' THEN
    RAISE EXCEPTION 'Horse profile authority prerequisite changed';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_guard_horse_profile_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- SET ROLE survives nested SECURITY DEFINER calls; current_user does not.
  -- Retain the originating browser role when an older RPC loses/clears its
  -- JWT context. The shared helper alone falls back to the definer's owner.
  IF coalesce(current_setting('role', true), 'none') NOT IN ('anon', 'authenticated')
     AND public.fn_is_service_context() IS TRUE THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Preserve normal owner signup, including the nullable legacy defaults.
    IF coalesce(NEW.is_horse, false) IS NOT FALSE
       OR coalesce(NEW.horse_profile, '{}'::jsonb) IS DISTINCT FROM '{}'::jsonb
       OR coalesce(NEW.horse_status, 'available') IS DISTINCT FROM 'available' THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'Horse profile authority is server only';
    END IF;
  ELSIF NEW.is_horse IS DISTINCT FROM OLD.is_horse
     OR NEW.horse_profile IS DISTINCT FROM OLD.horse_profile
     OR NEW.horse_status IS DISTINCT FROM OLD.horse_status THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Horse profile authority is server only';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_guard_horse_profile_authority()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_guard_horse_profile_authority() TO service_role;

-- Check the final row after existing BEFORE guards; BEFORE INSERT is required
-- because retaining ordinary signup means retaining the table INSERT grant.
DROP TRIGGER IF EXISTS zzzz_guard_horse_profile_authority ON public.profiles;
CREATE TRIGGER zzzz_guard_horse_profile_authority
BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_horse_profile_authority();

REVOKE UPDATE (is_horse, horse_profile, horse_status) ON public.profiles
  FROM PUBLIC, anon, authenticated;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['is_horse', 'horse_profile', 'horse_status']) AS col
    WHERE has_column_privilege('authenticated', 'public.profiles', col, 'UPDATE')
       OR has_column_privilege('anon', 'public.profiles', col, 'UPDATE')
       OR NOT has_column_privilege('service_role', 'public.profiles', col, 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'Horse profile authority grants did not close';
  END IF;
END;
$verify$;
COMMIT;
