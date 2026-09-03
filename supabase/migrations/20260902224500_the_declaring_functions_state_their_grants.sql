-- ===========================================================================
-- THE DECLARING FUNCTIONS STATE THEIR OWN GRANTS
-- Chip Accounting Roadmap Phase 1.2 + 1.3, 2026-09-02. Companion to
-- 20260902220500_the_undeclared_legs_name_their_counterparty,
-- 20260902221500_the_horse_door_declares_the_same_way and
-- 20260902224000_every_entry_and_prize_leg_names_its_counterparty.
-- Same shape as 20260902203500_db_payers_state_their_grants.
--
-- Production already holds this ACL for every function below: EXECUTE for
-- the owner and service_role only, nothing for PUBLIC, anon or authenticated
-- (read from pg_proc.proacl before this file was written:
-- {postgres=X/postgres,service_role=X/postgres} on all five). The three
-- declaration migrations redefined the bodies with CREATE OR REPLACE, which
-- keeps the ACL, but said nothing about it - and check-definer-authorization
-- reads the branch, not production: a rebuild from this repository would
-- create each of them with the Postgres default of EXECUTE to PUBLIC. The
-- spin settle, the two BBJ promo sweeps, the horse registration door and the
-- tournament credit funnel are engine and cron paths; nobody in a browser
-- may call any of them. (fn_register_for_tournament keeps `authenticated`:
-- it binds the actor to auth.uid() and is the player's own door.)
--
-- GRANT and REVOKE are not in pgrst_ddl_watch's list: no schema reload.
-- No-op against production; states the truth in the file.
-- ===========================================================================
BEGIN;

REVOKE ALL ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_sweep_bbj_promo(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sweep_bbj_promo(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_sweep_bbj_promo_all()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sweep_bbj_promo_all()
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid, integer, text)
  TO service_role;

DO $chk$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric)',
    'public.fn_sweep_bbj_promo(uuid)',
    'public.fn_sweep_bbj_promo_all()',
    'public.fn_register_horse_for_tournament(uuid, uuid)',
    'public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid, integer, text)'
  ] LOOP
    IF has_function_privilege('anon', v_sig, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'browser role can still execute %', v_sig;
    END IF;
    IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role lost EXECUTE on %', v_sig;
    END IF;
  END LOOP;
END $chk$;

COMMIT;
