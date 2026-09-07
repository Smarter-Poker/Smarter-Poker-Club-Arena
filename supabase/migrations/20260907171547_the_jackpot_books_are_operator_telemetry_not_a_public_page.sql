-- ═══════════════════════════════════════════════════════════════════════════
--  THE JACKPOT BOOKS ARE OPERATOR TELEMETRY, NOT A PUBLIC PAGE
--  BBJ build plan phase 5, and a guard catching me (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `check-definer-authorization` refused the phase-5 push and it was right. Five
-- SECURITY DEFINER functions on the jackpot's accounting surface were executable
-- by `anon` - a caller with no account - and none of them asks who is calling:
--
--   fn_bbj_promo_bank_check          the promo bank's whole reconciliation
--   fn_bbj_conservation_check        every pool's inflow, outflow and balances
--   fn_rake_bbj_invariants           per-hand rake and jackpot violations
--   fn_bbj_table_share_farming       jackpot recipients and their user ids
--   fn_bbj_contributions_total       lifetime jackpot inflow
--
-- Four of the five I wrote or replaced today, and every one of them inherited
-- `EXECUTE` from `PUBLIC` without my noticing, because `CREATE OR REPLACE`
-- keeps whatever grants the function already had and a brand-new function gets
-- PUBLIC by default. Read together they hand an anonymous caller the platform's
-- jackpot books: what every pool holds, what it has paid, where its accounting
-- does not balance, and the user ids of everyone who has ever won.
--
-- THE GUARD'S OWN WORDS: "READ-ONLY IS NOT THE SAME AS HARMLESS." Its remedy
-- number one is this migration exactly - operator and engine telemetry closes to
-- the browser roles and opens to `service_role`, which is what `pg_cron` and the
-- engine already use.
--
-- AND I RAN THAT CHECK EARLIER AND BELIEVED IT. It printed "OK - 2 SECURITY
-- DEFINER function(s) declared across 1 migration(s)" while five were open,
-- because at that moment only two of the seven migration files existed on disk
-- and the check reads the diff, not the database. A green check answers only the
-- question it was asked; I asked it too early and then quoted it as if it had
-- covered the whole phase (CLAUDE.md 10.86).
--
-- Naming PUBLIC as well as the roles is not belt-and-braces: `anon` inherits
-- whatever `PUBLIC` holds, so revoking `anon` alone reads as a fix and does
-- nothing.
--
-- Verified after applying: no browser role can execute any of the five,
-- `service_role` can execute all five, and `fn_ca_conservation_sweep()` still
-- returns `{"ok": true, "checks_run": 17, "errored": 0}` - the sweep that calls
-- three of them was the thing most at risk from getting this wrong.
--
-- ROLLBACK: `GRANT EXECUTE ON FUNCTION public.<name>(<types>) TO PUBLIC;` per
-- function - but do not, without reading the guard's message first.

BEGIN;

REVOKE ALL ON FUNCTION public.fn_bbj_promo_bank_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_promo_bank_check() TO service_role;

REVOKE ALL ON FUNCTION public.fn_bbj_conservation_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_conservation_check() TO service_role;

REVOKE ALL ON FUNCTION public.fn_rake_bbj_invariants(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_bbj_invariants(integer) TO service_role;

REVOKE ALL ON FUNCTION public.fn_bbj_table_share_farming(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_table_share_farming(integer) TO service_role;

REVOKE ALL ON FUNCTION public.fn_bbj_contributions_total() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_contributions_total() TO service_role;

DO $$
DECLARE r record; v_open text := '';
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_bbj_promo_bank_check','fn_bbj_conservation_check',
                         'fn_rake_bbj_invariants','fn_bbj_table_share_farming',
                         'fn_bbj_contributions_total')
  LOOP
    IF has_function_privilege('anon', r.sig, 'EXECUTE')
       OR has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      v_open := v_open || r.sig || ' ';
    END IF;
    /* The sweep and the engine must still be able to run these. A revoke that
       silences a money check is worse than the exposure it closed. */
    IF NOT has_function_privilege('service_role', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'the sweep can no longer run %', r.sig;
    END IF;
  END LOOP;

  IF v_open <> '' THEN
    RAISE EXCEPTION 'still reachable by a browser role: %', v_open;
  END IF;
END $$;

COMMIT;
