-- ═══════════════════════════════════════════════════════════════════════════
--  THE CONSERVATION DEFINERS STAY CLOSED (chip-std Lane F, 2026-09-02)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Tier 1. Grants only: no DDL, no PostgREST reload, no data moved.
--
-- 20260902173645_tournament_chips_are_conserved_hand_by_hand re-declared two
-- SECURITY DEFINER writers with CREATE OR REPLACE FUNCTION. CREATE OR REPLACE
-- preserves the ACL the function already had, and production's ACL for both
-- was read back on 2026-09-02 18:35 UTC before this file was written:
--
--   fn_ca_settle_hand_stacks_absolute  {postgres=X, service_role=X}
--   fn_spin_chip_conservation_check    {postgres=X, service_role=X}
--
-- so nothing in a browser can reach either today, and nothing in this branch
-- opened them. scripts/ci/check-definer-authorization.mjs cannot see the live
-- ACL; it reads the branch's migrations and treats a declared writer as open
-- until a REVOKE that names PUBLIC, anon and authenticated closes it. This
-- file is that statement, so the declaration carries its own authorization
-- and the gate does not have to trust a comment. Applying it changes nothing.
--
-- Both are engine/sweep functions: the settle RPC is called by the Hetzner
-- engine with the service key after every hand, and the conservation check
-- is the pg_cron detector. Nobody in a browser should call either.

BEGIN;

REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_spin_chip_conservation_check(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_chip_conservation_check(integer)
  TO service_role;

COMMIT;
