-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828032140; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
--  THE EIGHTEENTH, WHICH APPEARED WHILE THE OTHER SEVENTEEN WERE BEING SHUT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_pay_backed_payout_shortfalls(boolean, integer) landed on main in #1537 on
-- 2026-08-27, hours after the sweep that found the other seventeen. Same shape:
-- SECURITY DEFINER, EXECUTE held by `authenticated`, writes, and no reference
-- to auth.uid(), auth.role() or auth.jwt() anywhere in the body.
--
-- It is not a harmless sweep. With p_apply => true it calls
-- fn_tournament_payout_reconcile(id, true), which PAYS CHIPS, across up to
-- p_limit completed events, and writes tournament_payout_backfill_log. It has
-- no caller in any of the seven repos; it is a repair pass a human runs.
--
-- This one function is the argument for the gate that ships alongside these
-- migrations. Seventeen instances of a class were closed and the eighteenth
-- was written the same afternoon, by an author who had no way to know the rule
-- existed. A rule nothing enforces is a rule that decays at the speed people
-- write code.

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

