-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831110447; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- reconcile_ledger_nightly is a SWEEP. It is SECURITY DEFINER, it writes
-- (ledger_reconcile_log), and nobody in a browser has any business running it.
-- Production already had exactly this ACL; these statements make the migration
-- that DECLARES the function say so too, so the intent survives a re-install
-- of the function by any future migration. PUBLIC is named as well as the
-- roles: revoking a role while PUBLIC still holds EXECUTE reads as a fix and
-- does nothing. Idempotent.
REVOKE ALL ON FUNCTION public.reconcile_ledger_nightly() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_ledger_nightly() TO service_role;

DO $postapply$
DECLARE a text;
BEGIN
  SELECT COALESCE(proacl::text,'') INTO a FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='reconcile_ledger_nightly';
  IF a LIKE '%=X/%' AND (a LIKE '%anon=%' OR a LIKE '%authenticated=%') THEN
    RAISE EXCEPTION 'POST-APPLY: a browser role still holds EXECUTE on reconcile_ledger_nightly: %', a;
  END IF;
  IF a NOT LIKE '%service_role=X%' THEN
    RAISE EXCEPTION 'POST-APPLY: service_role lost EXECUTE on reconcile_ledger_nightly: %', a;
  END IF;
  RAISE NOTICE 'POST-APPLY OK: reconcile_ledger_nightly acl = %', a;
END;
$postapply$;
