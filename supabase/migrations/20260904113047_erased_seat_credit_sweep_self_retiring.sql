-- ═══════════════════════════════════════════════════════════════════════════
-- A SELF-RETIRING SWEEP FOR THE ERASURE WINDOW (chip standard, 2026-09-04).
--
-- 20260904104847 made the database side immune (delta mode) and
-- 20260904112929 restored every credit erased up to the apply. But delta
-- mode only engages when the engine sends stack_before, and the engine that
-- does is in the same pull request as this file: until it is built and
-- deployed the running engine still writes absolute stacks, and its fixed
-- barrier is not yet running either. Credits will keep being erased at the
-- measured rate (~30 an hour, ~2,500 chips) for the hours in between.
--
-- This sweep runs the restoration hourly over the trailing window and then
-- RETIRES ITSELF the first time it finds nothing to restore while every hand
-- settlement of the previous two hours ran in delta mode - i.e. once the new
-- engine has been serving for two hours and the window is clean. Dan's
-- standard (2026-09-03) is no watchdogs and crons where a structural
-- guarantee exists; the structural guarantee is the delta write, and this
-- cron exists only for the deploy gap and removes itself when the gap closes.
--
-- Scheduled at :20, well clear of the :55-:00 maintenance freeze that would
-- refuse its wallet writes. The leading SET is its own statement: a
-- statement cannot extend its own timeout (lesson 3, 2026-09-03 handoff).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_ca_erased_seat_credit_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_res jsonb; v_delta_hands bigint; v_absolute_hands bigint; v_retired boolean := false;
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'fn_ca_erased_seat_credit_sweep is operator/service only';
  END IF;

  v_res := public.fn_ca_restore_erased_seat_credits(now() - interval '4 hours', now() - interval '15 minutes', false);

  IF COALESCE((v_res->>'count')::int, 0) > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_erased_seat_credit_sweep', 'ledger_imbalance', 'info',
      'erased-seat-credits:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      (v_res->>'total')::numeric, 0, (v_res->>'total')::numeric,
      'ledger', 'table_seats', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      format('%s seat credit(s) erased by the pre-delta engine were restored to their club wallets (%s chips) - see chip_transactions.seat_credit_restored',
             v_res->>'count', v_res->>'total'),
      false, jsonb_build_object('count', v_res->>'count', 'total', v_res->>'total', 'horses', v_res->>'horses'));
  END IF;

  SELECT count(*) FILTER (WHERE totals->>'mode' = 'delta'),
         count(*) FILTER (WHERE totals->>'mode' IS DISTINCT FROM 'delta')
    INTO v_delta_hands, v_absolute_hands
    FROM public.ca_settlements
   WHERE settlement_type = 'hand_stacks' AND state = 'final'
     AND created_at > now() - interval '2 hours';

  IF COALESCE((v_res->>'count')::int, 0) = 0 AND v_delta_hands > 100 AND v_absolute_hands = 0 THEN
    PERFORM cron.unschedule('ca-erased-seat-credit-sweep');
    v_retired := true;
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_erased_seat_credit_sweep', 'ledger_imbalance', 'info',
      'erased-seat-credits-retired',
      0, 0, 0, 'ledger', 'table_seats', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      format('the erased-seat-credit sweep retired itself: %s delta-mode hand writes and no absolute writes in the last two hours, and nothing left to restore', v_delta_hands),
      false, jsonb_build_object('delta_hands', v_delta_hands));
  END IF;

  RETURN v_res || jsonb_build_object('delta_hands', v_delta_hands, 'absolute_hands', v_absolute_hands, 'retired', v_retired);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_erased_seat_credit_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_erased_seat_credit_sweep() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-erased-seat-credit-sweep') THEN
    PERFORM cron.unschedule('ca-erased-seat-credit-sweep');
  END IF;
  PERFORM cron.schedule('ca-erased-seat-credit-sweep', '20 * * * *',
    $cmd$SET statement_timeout = '840s'; SELECT public.fn_ca_erased_seat_credit_sweep();$cmd$);
  -- Every scheduled function must resolve (lesson from 20260903233601).
  IF to_regprocedure('public.fn_ca_erased_seat_credit_sweep()') IS NULL THEN
    RAISE EXCEPTION 'sweep function did not land';
  END IF;
END $$;
