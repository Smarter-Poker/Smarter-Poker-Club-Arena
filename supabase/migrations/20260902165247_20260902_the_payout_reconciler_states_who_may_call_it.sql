-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902165247; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
--  THE PAYOUT RECONCILER STATES WHO MAY CALL IT (2026-09-02)
-- ============================================================================
--  A no-op against production, and that is the point of writing it down.
--
--  Production already restricts both functions to postgres and service_role:
--    fn_tournament_payout_reconcile  {postgres=X/postgres,service_role=X/postgres}
--    fn_tournament_payout_sweep      {postgres=X/postgres,service_role=X/postgres}
--
--  But that lock exists only as an ACL applied out of band. It is nowhere in
--  the migrations, so a database rebuilt from this repo would create both
--  functions with the default PUBLIC EXECUTE and hand every logged-in browser
--  a SECURITY DEFINER function that moves prize money and takes `p_apply` as a
--  parameter. check-definer-authorization is right to refuse a migration that
--  declares such a function and says nothing about who may run it.
--
--  Both are engine-side repair passes. Nobody in a browser should ever call
--  either one. PUBLIC is named alongside the roles because revoking a role
--  while PUBLIC still holds the grant reads as a fix and does nothing.
-- ============================================================================

REVOKE ALL ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  TO service_role;
