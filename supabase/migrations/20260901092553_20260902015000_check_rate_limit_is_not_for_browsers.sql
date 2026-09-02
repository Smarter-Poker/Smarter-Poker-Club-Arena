-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901092553; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Closing a hole I opened an hour ago.
--
-- 20260831_club_join_needs_the_rate_limits_table_that_never_shipped restored
-- public.rate_limits verbatim from the 2026-03 file that created it, and that
-- file predates this repo's definer-authorization rule. It brought back
-- check_rate_limit(uuid, text, integer) with EXECUTE still granted to
-- `authenticated`.
--
-- That function is SECURITY DEFINER, it WRITES, and it takes the actor as a
-- PARAMETER. A caller-supplied id is a caller-supplied answer: any signed-in
-- user could spend another user's rate-limit budget by passing their uuid, or
-- keep their own budget clear by passing somebody else's. The repo's
-- check-definer-authorization guard caught it on push, which is exactly what
-- that guard is for.
--
-- Nobody in a browser should call this. It is an internal limiter with ZERO
-- callers - verified in src/, server/src/ and every plpgsql body in the
-- database. fn_join_club_atomic does not use it; it inlines its own counting
-- against the same table.
--
-- cleanup_rate_limits was already closed by
-- 20260901015506_rate_limit_cleanup_is_not_for_browsers. This is its sibling,
-- and PUBLIC is named alongside the roles because revoking a role while PUBLIC
-- still holds EXECUTE reads as a fix and does nothing.

REVOKE ALL ON FUNCTION public.check_rate_limit(uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(uuid, text, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.cleanup_rate_limits()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_rate_limits()
  TO service_role;

DO $verify$
DECLARE v_acl text;
BEGIN
  SELECT array_to_string(proacl, ' | ') INTO v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_rate_limit'
     AND pg_get_function_identity_arguments(p.oid) = 'p_user_id uuid, p_action text, p_max_per_minute integer';

  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'POST-APPLY: check_rate_limit(uuid,text,integer) not found';
  END IF;
  IF position('authenticated=' in v_acl) > 0 OR position('anon=' in v_acl) > 0 THEN
    RAISE EXCEPTION 'POST-APPLY: a browser role still holds EXECUTE: %', v_acl;
  END IF;
  IF position('service_role=' in v_acl) = 0 THEN
    RAISE EXCEPTION 'POST-APPLY: service_role lost EXECUTE: %', v_acl;
  END IF;
END $verify$;

