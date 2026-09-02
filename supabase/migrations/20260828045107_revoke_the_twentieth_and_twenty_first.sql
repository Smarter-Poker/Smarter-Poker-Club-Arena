-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828045107; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
--  THE TWENTIETH AND TWENTY-FIRST, FOUND BY THE AUDITOR ON ITS FIRST RUN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_definer_exposure_audit() was written to repeat, every day, the hand query
-- that found nineteen unauthenticated SECURITY DEFINER writers on 2026-08-27.
-- Its FIRST run, four hours later, returned two functions that did not exist
-- when that sweep ran:
--
--   fn_backpay_spin_unpaid_winners(boolean, integer)
--   fn_requeue_unbanked_fees(boolean, integer)
--
-- Both SECURITY DEFINER, both holding EXECUTE for `authenticated`, both write,
-- and neither references auth.uid(), auth.role() or auth.jwt() anywhere. Both
-- are repair passes over money: one back-pays Spin winners, the other requeues
-- unbanked fees. Neither has a caller in any of the seven repositories.
--
-- This is the argument for the auditor, made by the auditor, on day one. The CI
-- gate stops a new one arriving through a migration in the repository; it cannot
-- see a function applied straight to production through the MCP, which is how
-- this estate normally ships schema and how all three of the last three
-- arrived. A gate on the repo and no eye on production leaves the door open.
--
-- Revoked from every browser role and granted to service_role, the same as the
-- eighteen before them. PUBLIC is named as well as the roles, because a grant to
-- PUBLIC lets `authenticated` straight back in and revoking one role would read
-- as a fix and do nothing.

DO $$
DECLARE
  sig text;
  sigs text[] := ARRAY[
    'public.fn_backpay_spin_unpaid_winners(boolean, integer)',
    'public.fn_requeue_unbanked_fees(boolean, integer)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END LOOP;
END $$;

-- Proof, in the migration, that the revoke took and the engine kept its access.
DO $$
DECLARE r record; bad text := '';
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS browser,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS engine
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_backpay_spin_unpaid_winners','fn_requeue_unbanked_fees')
  LOOP
    IF r.browser OR NOT r.engine THEN
      bad := bad || format('%s browser=%s engine=%s; ', r.sig, r.browser, r.engine);
    END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'revoke did not take: %', bad; END IF;
END $$;

