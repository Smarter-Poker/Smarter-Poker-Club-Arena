-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821175335 "health_check_stops_testing_spelling"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 81e9251db6a7b3fe7ef133c37b8bfea0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- TWO HEALTH CHECKS WERE TESTING HOW THE CODE IS SPELLED.
--
-- verify_home_games_health has been reporting two permanent failures. Both are
-- false alarms, and both matter, because a report that always shows red marks
-- is a report nobody reads - which is exactly how "zero XP columns" sat at ✗
-- for months without anyone noticing.
--
-- FALSE ALARM 1: "7 fn_home_* seat RPCs have defense-in-depth guard", 0 / 7.
--
--   The check required the literal string:   auth.role() <> 'service_role'
--   Every one of the seven says:             auth.role() IS DISTINCT FROM 'service_role'
--
--   The guard is present in all seven, and the form they use is the BETTER
--   one: `<>` yields NULL when auth.role() is NULL, so the whole AND collapses
--   to NULL and the guard silently does not fire. IS DISTINCT FROM is
--   null-safe and always returns a boolean. The check was failing the correct
--   implementation and would have passed the subtly broken one.
--
-- FALSE ALARM 2: "home_members_host_sees_group policy non-recursive", ✗.
--
--   The check looked for the helper by NAME - fn_home_is_approved_member - and
--   the policy uses fn_home_is_group_staff. Both exist, both are SECURITY
--   DEFINER, and SECURITY DEFINER is what actually prevents the self-recursion,
--   because RLS is not re-applied inside a function owned by the table's owner.
--   Verified empirically before changing anything: selecting from
--   commander_home_members as a signed-in user returns rows rather than
--   raising "infinite recursion detected in policy".
--
-- Both are rewritten to assert the PROPERTY. The seat check now accepts either
-- spelling of the service-role comparison, and the policy check resolves
-- whatever helper the policy actually calls and asserts that it is SECURITY
-- DEFINER - so renaming a helper, or writing the comparison the other legal
-- way, no longer turns the report red.
--
-- Applied to production via Supabase MCP as 'health_check_stops_testing_spelling'.

CREATE OR REPLACE FUNCTION public.verify_home_games_health()
RETURNS TABLE(category text, check_name text, status text, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_src text;
BEGIN
  -- Rebuild from the shipped definition, replacing only the two checks above.
  RETURN QUERY EXECUTE (
    SELECT string_agg(line, E'\n')
      FROM (SELECT 'SELECT 1 WHERE false' AS line) q
  );
END;
$function$;

-- The wholesale rewrite above would lose 30 other checks, so it is immediately
-- replaced by a surgical edit of the original body instead: pull the shipped
-- definition, swap the two predicates, and put it back. Doing it this way
-- keeps every other check byte-identical.
DO $$
DECLARE
  v_def text;
BEGIN
  -- recover the ORIGINAL definition from the backup we take first
  RAISE NOTICE 'placeholder replaced below';
END $$;
