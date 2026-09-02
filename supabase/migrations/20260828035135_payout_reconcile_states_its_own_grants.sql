-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828035135; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- fn_tournament_payout_reconcile pays chips when p_apply is true. Production
-- has never granted it to a browser role, but the migration that defines it
-- said nothing about grants at all - and silence is not safety: a rebuild from
-- this repository would create it with the Postgres default of EXECUTE to
-- PUBLIC, which every browser role inherits.
--
-- check-definer-authorization caught exactly this, on the very migration that
-- was fixing the short-field residual, which is the best evidence the gate is
-- doing its job. Stating the grants makes the file match production and makes
-- the rebuild safe.

REVOKE ALL ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  TO service_role;

DO $$
BEGIN
  IF has_function_privilege('authenticated',
       'public.fn_tournament_payout_reconcile(uuid, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_tournament_payout_reconcile(uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'grants did not take on fn_tournament_payout_reconcile';
  END IF;
END $$;

