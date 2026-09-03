-- ===========================================================================
-- THE DB PAYERS STATE THEIR OWN GRANTS
-- Chip Accounting Standard, Lane A3, 2026-09-02. Companion to
-- 20260902201000_db_payers_settle_through_obligations.
--
-- Production already holds this ACL for every function below: EXECUTE for
-- the owner and service_role only, nothing for PUBLIC, anon or authenticated
-- (verified against has_function_privilege before this file was written).
-- The re-pointing migration redefined the bodies with CREATE OR REPLACE,
-- which keeps the ACL, but said nothing about it - and check-definer-
-- authorization reads the branch, not production: a rebuild from this
-- repository would create each of them with the Postgres default of EXECUTE
-- to PUBLIC, which every browser role inherits. These are the sweeps, the
-- reconciler, the deal and the settle function itself; nobody in a browser
-- may call any of them.
--
-- GRANT and REVOKE are not in pgrst_ddl_watch's list: no schema reload.
-- ===========================================================================
BEGIN;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(uuid, text, integer, uuid, numeric, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(uuid, text, integer, uuid, numeric, text, text, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_backpay_guarantee_shortfalls(boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_backpay_guarantee_shortfalls(boolean, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_backpay_spin_unpaid_winners(boolean, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_backpay_spin_unpaid_winners(boolean, integer, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_backpay_hu_winner_shortfalls(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_backpay_hu_winner_shortfalls(integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_final_table_deal(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_final_table_deal(uuid)
  TO service_role;

DO $chk$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.fn_settle_tournament_obligation(uuid, text, integer, uuid, numeric, text, text, uuid)',
    'public.fn_tournament_payout_reconcile(uuid, boolean)',
    'public.fn_pay_backed_payout_shortfalls(boolean, integer)',
    'public.fn_ca_backpay_guarantee_shortfalls(boolean, integer)',
    'public.fn_backpay_spin_unpaid_winners(boolean, integer, integer)',
    'public.fn_backpay_hu_winner_shortfalls(integer)',
    'public.fn_final_table_deal(uuid)']
  LOOP
    IF has_function_privilege('authenticated', v_sig, 'EXECUTE')
       OR has_function_privilege('anon', v_sig, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'ASSERT: grants did not take on %', v_sig;
    END IF;
  END LOOP;
  RAISE NOTICE 'chip-std lane A3: seven DB payers are service_role only';
END $chk$;

COMMIT;
