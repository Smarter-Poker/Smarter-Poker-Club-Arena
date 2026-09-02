-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826202004; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- TIER 2 (additive: one GRANT)
--
-- WHY:
--   /horses/hg-moderation has never worked in production. Its four tabs are
--   backed by seven RPCs and five of them open with:
--
--       IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
--         RAISE EXCEPTION 'UNAUTHORIZED';
--
--   The API routes called every one of them with the module-level SERVICE-ROLE
--   client, where auth.uid() is NULL, so all five raised UNAUTHORIZED on every
--   request and the routes turned that into a 500. Reports never listed,
--   appeals never listed, nothing could be resolved, and the GDPR erase path
--   could not run.
--
--   The route-side fix forwards the caller's JWT so auth.uid() resolves. That
--   is sufficient for six of the seven. The seventh,
--   fn_get_home_games_onboarding_status_admin, has no EXECUTE grant for
--   `authenticated` at all, so calling it as the user fails with 42501
--   instead. Verified 2026-08-26:
--
--     proname                                    prosecdef  auth_can_execute
--     fn_anonymize_hg_user_content                  t             t
--     fn_get_home_games_onboarding_status_admin     t            [f]
--     get_home_content_report_detail                t             t
--     list_home_content_reports                     t             t
--     resolve_home_content_report                   t             t
--     review_home_ban_appeal                        t             t
--     list_home_ban_appeals_admin                   f             t
--
-- SAFETY:
--   SECURITY DEFINER, and its first two statements are an auth.uid() identity
--   check followed by a profiles.role check against
--   ('admin','superadmin','god'). Granting EXECUTE does not widen who can
--   obtain the data -- a non-admin caller gets FORBIDDEN from inside the
--   function. It changes the failure mode for admins from "permission denied
--   on the function" to "it runs".
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE v_count int; v_secdef boolean; v_src text;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_get_home_games_onboarding_status_admin';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRE-FLIGHT: expected exactly 1 fn_get_home_games_onboarding_status_admin, found %.', v_count;
  END IF;

  SELECT p.prosecdef, p.prosrc INTO v_secdef, v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_get_home_games_onboarding_status_admin';

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'PRE-FLIGHT: function is no longer SECURITY DEFINER. The safety argument does not hold.';
  END IF;
  IF v_src NOT LIKE '%auth.uid()%' THEN
    RAISE EXCEPTION 'PRE-FLIGHT: function no longer checks auth.uid(). Refusing to grant.';
  END IF;
  IF v_src NOT LIKE '%superadmin%' THEN
    RAISE EXCEPTION 'PRE-FLIGHT: function no longer checks an admin role list. Refusing to grant.';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION
  public.fn_get_home_games_onboarding_status_admin(uuid, uuid) TO authenticated;

DO $$
DECLARE v_ok boolean;
BEGIN
  SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') INTO v_ok
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='fn_get_home_games_onboarding_status_admin';
  IF NOT v_ok THEN RAISE EXCEPTION 'POST-APPLY: grant did not take.'; END IF;
  RAISE NOTICE 'POST-APPLY OK.';
END $$;

COMMIT;

-- ROLLBACK:
--   BEGIN;
--   REVOKE EXECUTE ON FUNCTION
--     public.fn_get_home_games_onboarding_status_admin(uuid, uuid) FROM authenticated;
--   COMMIT;
