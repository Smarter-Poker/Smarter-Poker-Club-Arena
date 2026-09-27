-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420220059 "phase41_bughunt_follow_group_id_immutable"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b2ae2555a836ca5c5850fac52717f1ce of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Phase 41 bug-hunt pass 35c: commander_home_group_follows group_id
-- immutability.
--
-- BUG (verified):
--   AM — user can UPDATE their own follow row to change group_id,
--        migrating the follow to a different group. Privacy concern:
--        the follow row could be relocated to a private group the
--        user is not permitted to follow (the private-group check
--        fires only on INSERT, not on UPDATE of group_id).
--
--   Note: user_id immutability was already enforced (AN blocked);
--         this pass locks the remaining mutable FK.
--
-- FIX:
--   BEFORE UPDATE trigger blocking group_id change. Simple, layered
--   on top of existing RLS + protect_home_identity_fields triggers
--   per the "layer new constraints as new triggers" lesson from pass 17.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.fn_enforce_home_group_follow_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    RAISE EXCEPTION 'FOLLOW_GROUP_IMMUTABLE'
          USING HINT = 'unfollow and re-follow the target group instead';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'FOLLOW_USER_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_home_group_follow_immutability
  ON public.commander_home_group_follows;

CREATE TRIGGER trg_enforce_home_group_follow_immutability
BEFORE UPDATE ON public.commander_home_group_follows
FOR EACH ROW
EXECUTE FUNCTION public.fn_enforce_home_group_follow_immutability();
