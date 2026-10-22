-- 20261022173156_mystery_bounty_definer_grants_restated.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20261022162651 re-created fn_mystery_bounty_inventory and
-- fn_mystery_bounty_unrecorded_head_cents with CREATE OR REPLACE, which keeps
-- their existing grants. Production already holds the right ones (read from
-- pg_proc.proacl on 2026-10-22: inventory is executable by authenticated and
-- service_role, the unrecorded-head helper by service_role only; anon and
-- PUBLIC hold neither). The branch's SQL never said so, so the SECURITY
-- DEFINER check read both as anon-reachable. This states the grants
-- explicitly. GRANT and REVOKE do not reload the schema cache.
--
-- The lobby's Rewards panel reads the inventory as a signed-in player; the
-- unrecorded-head helper is engine arithmetic.

-- @live-proof: (SELECT NOT has_function_privilege('anon', 'public.fn_mystery_bounty_inventory(uuid)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.fn_mystery_bounty_inventory(uuid)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.fn_mystery_bounty_unrecorded_head_cents(uuid)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fn_mystery_bounty_unrecorded_head_cents(uuid)', 'EXECUTE'))

BEGIN;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_inventory(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_inventory(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_unrecorded_head_cents(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_unrecorded_head_cents(uuid) TO service_role;

COMMIT;
