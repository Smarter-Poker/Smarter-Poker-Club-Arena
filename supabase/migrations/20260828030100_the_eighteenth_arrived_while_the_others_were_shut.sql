-- ═══════════════════════════════════════════════════════════════════════════
--  THE EIGHTEENTH, WHICH APPEARED WHILE THE OTHER SEVENTEEN WERE BEING SHUT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Applied to production 2026-08-27 via the Supabase MCP (apply_migration
-- "revoke_browser_execute_on_payout_shortfall_repair").
--
-- fn_pay_backed_payout_shortfalls(boolean, integer) landed on main in #1537,
-- hours after the sweep that found the other seventeen. Same shape: SECURITY
-- DEFINER, EXECUTE held by `authenticated`, it writes, and it never references
-- auth.uid(), auth.role() or auth.jwt() anywhere.
--
-- It is not a harmless sweep. With p_apply => true it calls
-- fn_tournament_payout_reconcile(id, true), which PAYS CHIPS, across up to
-- p_limit completed events, and writes tournament_payout_backfill_log. It has
-- no caller in any of the seven repos; it is a repair pass a human runs.
--
-- This one function is the argument for the gate that ships beside these
-- migrations, scripts/ci/check-definer-authorization.mjs. Seventeen instances
-- of a class were closed and the eighteenth was written the same afternoon, by
-- an author who had no way to know the rule existed. A rule nothing enforces
-- decays at the speed people write code.

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer)
    FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer)
    TO service_role;

  IF has_function_privilege('authenticated',
       'public.fn_pay_backed_payout_shortfalls(boolean, integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_pay_backed_payout_shortfalls(boolean, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'revoke did not take on fn_pay_backed_payout_shortfalls';
  END IF;
END $$;
