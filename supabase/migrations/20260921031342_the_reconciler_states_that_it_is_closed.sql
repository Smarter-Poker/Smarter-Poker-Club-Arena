-- the_reconciler_states_that_it_is_closed
--
-- reconcile_ledger_nightly is SECURITY DEFINER, it writes, and it never asks
-- who is calling. Its live ACL has been {postgres, service_role} throughout -
-- verified on production at 03:07 and again at 03:12 UTC - because every
-- migration that has ever touched it used CREATE OR REPLACE, which PRESERVES
-- the ACL. So nothing about it is open, and nothing here changes what any role
-- can do.
--
-- What this migration changes is that the branch now SAYS so.
--
-- 20260921023309 and 20260921024924 both CREATE OR REPLACE this function, to
-- repoint its treasury block at fn_ca_treasury_positions().
-- scripts/ci/check-definer-authorization reads migration text, not the live
-- catalogue, and it cannot distinguish a REPLACE of an already-closed function
-- from a fresh CREATE - and it is right not to try: CREATE OR REPLACE on a
-- function that does NOT already exist behaves exactly like CREATE, and picks
-- up this database's default EXECUTE grants to anon and authenticated. A
-- checker that assumed "REPLACE is safe" would wave through the first
-- declaration of every new function written that way.
--
-- So the gate asks for the closure to be stated rather than assumed, which is
-- the right instinct on a definer that writes, and this is remedy 1 from its
-- own message. The statement is idempotent and a no-op in effect.
--
-- It is stated in a separate migration because 20260921023309 and
-- 20260921024924 are already applied to production and recorded byte-exactly
-- in supabase_migrations.schema_migrations; a recorded migration is history and
-- is never edited. The definer gate reads every migration the branch touches as
-- one text, so a REVOKE here closes a declaration there.
--
-- Not added to definer-authorization.allowlist.json: that file is for functions
-- a browser is DELIBERATELY allowed to reach, and this one is not. It is closed,
-- and now it says it.
--
-- Asserted below: anon and authenticated can still execute nothing, and
-- service_role and postgres - pg_cron job 157 runs as postgres - keep the
-- EXECUTE they have always had.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

REVOKE ALL ON FUNCTION public.reconcile_ledger_nightly()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_ledger_nightly()
  TO postgres, service_role;

DO $assert$
DECLARE
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reconcile_ledger_nightly';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'reconcile_ledger_nightly is missing';
  END IF;

  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'reconcile_ledger_nightly is still reachable by a browser role';
  END IF;

  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('postgres', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'reconcile_ledger_nightly lost an EXECUTE grant it needs (pg_cron job 157 runs as postgres)';
  END IF;

  RAISE NOTICE 'reconcile_ledger_nightly closed to browser roles, postgres and service_role retained';
END;
$assert$;

COMMIT;
