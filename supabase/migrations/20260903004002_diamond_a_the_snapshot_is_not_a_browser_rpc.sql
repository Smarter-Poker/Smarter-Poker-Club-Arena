-- Diamond Accounting Standard, Lane A, companion migration.
--
-- The hourly diamond supply snapshot declares who may call it.
--
-- `check-definer-authorization` blocked the Lane A push on fn_ca_diamond_snapshot,
-- and it was right to. The function is SECURITY DEFINER, it WRITES (one row into
-- ca_diamond_snapshots per call), and it never asks who is calling: there is no
-- auth.uid(), auth.role() or auth.jwt() anywhere in it, because it is a cron sweep
-- (cron job 201, ca-diamond-snapshot-hourly) and has never needed to know.
--
-- The guard reads a branch's migrations statically and starts every function from the
-- Postgres default, which is EXECUTE to PUBLIC. The migration that replaced this body
-- said nothing about grants, so the guard could only assume the door was open.
--
-- MEASURED: in production the door is already shut. The live ACL is
-- `postgres=X/postgres | service_role=X/postgres`; has_function_privilege reports false
-- for both `authenticated` and `anon`. CREATE OR REPLACE preserves the existing ACL, so
-- replacing the body did not widen anything. These statements are therefore a no-op
-- against the current grants. They are still worth applying, because the guard's demand
-- is the right one: a migration should STATE its access posture rather than leave it to
-- be inferred, which is also swarm brief rule 8 ("in-file REVOKE/GRANT stating who may
-- call"). An assumption that happens to be true today is not a declaration.
--
-- WHY NOBODY IN A BROWSER SHOULD EVER CALL IT: this is remedy 1 from the guard's own
-- output, and it is not merely tidiness here. Each call appends a row to
-- ca_diamond_snapshots, and scripts/ci/check-chip-conservation.mjs reads the trailing
-- four hours of that table as the Hetzner engine deploy money gate. A caller who could
-- invoke the snapshot at will could move the gate.
--
-- PUBLIC is named as well as the two roles. A REVOKE that names only one role while
-- PUBLIC still holds the privilege reads as a fix and does nothing.
--
-- GRANT and REVOKE are not in pgrst_ddl_watch's statement list, so this migration
-- triggers no PostgREST schema reload (CLAUDE.md production DDL policy, rule 5).
--
-- ROLLBACK: GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_snapshot() TO authenticated;
-- (which would re-open a door that has been shut in production all along).

BEGIN;

SET LOCAL lock_timeout = '4s';

REVOKE ALL ON FUNCTION public.fn_ca_diamond_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_snapshot() TO service_role;

COMMENT ON FUNCTION public.fn_ca_diamond_snapshot() IS
  'DR10. Hourly diamond supply snapshot (cron job 201). total = SUM(profiles.diamonds), the canonical store, read once. user_diamonds, user_diamond_balance and diamond_wallets are mirrors: recorded and compared for equality, never added. Drift is measured against prev.profile_diamonds so the basis is continuous across the 2026-09-03 identity change. service_role only: it writes the rows the engine deploy money gate reads, so no browser role may call it.';

DO $assert$
BEGIN
  IF has_function_privilege('authenticated', 'public.fn_ca_diamond_snapshot()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_diamond_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can still execute fn_ca_diamond_snapshot';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_ca_diamond_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on fn_ca_diamond_snapshot, which would stop the hourly supply snapshot';
  END IF;
END
$assert$;

COMMIT;
