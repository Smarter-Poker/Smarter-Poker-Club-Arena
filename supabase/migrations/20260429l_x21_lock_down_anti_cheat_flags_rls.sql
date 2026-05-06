-- ═══════════════════════════════════════════════════════════════════════════════
-- Walkthrough Round 21 — RLS policy correctness audit.
--
-- CRITICAL FINDING: anti_cheat_flags had a policy named acf_service_all
-- which IMPLIED service-role-only access, but the actual policy roles
-- attribute was {public}, granting ALL operations (SELECT/INSERT/UPDATE/
-- DELETE) to every authenticated user.
--
-- Implications under the broken policy:
--   - A flagged colluder could DELETE their own anti_cheat_flags row
--     to hide evidence.
--   - Any user could INSERT false flags against rivals.
--   - Any user could read every other user's flag history.
--
-- Other RLS findings during the audit (all clean):
--   - 47 hot tables checked for RLS-enabled-but-no-policies → 0 hits.
--   - 31 sensitive tables checked for RLS-disabled → 0 hits (everything
--     sensitive is RLS-protected).
--   - All money-flow tables (wallets, agent_commissions, rake_records,
--     cashout_requests, chip_ledger, union_wallets, etc.) had proper
--     scoped policies.
--   - Round 11 tables (rake_attributions, rake_rate_audit,
--     commission_rate_audit, tournament_waitlists, hand_actions) all
--     RLS-protected with the proper service_role + scoped-read pattern.
--
--   Only soft finding: bbj_pools allows public SELECT — accepted because
--   pool size is displayed publicly on the lobby (intentional disclosure).
--
-- Fix: drop the misnamed policy, install proper service_role-only ALL +
-- self-read for transparency to the affected user (so they can see WHY
-- they were flagged, but can't see other users' flags).
--
-- Applied to production via Supabase MCP migration
-- x21_lock_down_anti_cheat_flags_rls_v2_2026_04_29.
-- ═══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS acf_service_all ON public.anti_cheat_flags;
DROP POLICY IF EXISTS anti_cheat_flags_service_role_all ON public.anti_cheat_flags;
DROP POLICY IF EXISTS anti_cheat_flags_self_read       ON public.anti_cheat_flags;

CREATE POLICY anti_cheat_flags_service_role_all
  ON public.anti_cheat_flags
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY anti_cheat_flags_self_read
  ON public.anti_cheat_flags
  FOR SELECT
  TO authenticated
  USING (player_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.anti_cheat_flags FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.anti_cheat_flags TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.anti_cheat_flags TO service_role;
