-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823050627 "get_club_home_revoke_anon_execute"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cc7ba549d39366f6923f38ed1fa11c60 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on every new public
-- function to anon, authenticated and service_role. `REVOKE ALL FROM PUBLIC`
-- in the creating migration does NOT remove that explicit anon grant - the
-- ACL still read {postgres=X, anon=X, authenticated=X, service_role=X}.
--
-- No data was exposed: get_club_home is SECURITY INVOKER, so an anon caller
-- sees only what anon's RLS policies already allow. This is least privilege,
-- not an incident - the club lobby requires a session, so anon has no reason
-- to hold EXECUTE at all. Same shape as the CREATE-TABLE-inherits-grants
-- hazard recorded on 2026-08-22.
REVOKE EXECUTE ON FUNCTION public.get_club_home(text) FROM anon;

DO $$
DECLARE v_anon boolean; v_auth boolean; v_secdef boolean;
BEGIN
  SELECT has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         p.prosecdef
    INTO v_anon, v_auth, v_secdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_club_home';

  IF v_anon THEN
    RAISE EXCEPTION 'get_club_home is still executable by anon';
  END IF;
  IF NOT v_auth THEN
    RAISE EXCEPTION 'get_club_home must stay executable by authenticated';
  END IF;
  IF v_secdef THEN
    RAISE EXCEPTION 'get_club_home must be SECURITY INVOKER so RLS still applies';
  END IF;
END $$;
