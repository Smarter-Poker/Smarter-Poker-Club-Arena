-- 20260909190430 reserved by scripts/new-migration.mjs after Supabase CLI creation.
-- Preserve the existing engine-only ACL explicitly alongside the Phase 3 body replacement.
-- Production already has this ACL; CREATE OR REPLACE preserved it. This records
-- the permission contract for the complete branch without rewriting applied history.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';
REVOKE ALL ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric)
  TO service_role;
COMMIT;
