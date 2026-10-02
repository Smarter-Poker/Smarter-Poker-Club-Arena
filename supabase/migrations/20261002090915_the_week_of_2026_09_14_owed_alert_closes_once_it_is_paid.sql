-- 20261002090915_the_week_of_2026_09_14_owed_alert_closes_once_it_is_paid.sql
--
-- THE WEEK OF 2026-09-14 OWED ALERT CLOSES ONCE IT IS PAID (2026-10-02)
--
-- deferred_rakeback_basis_2026_09_14 (bfe0b305) is the reader of the week's
-- owed rakeback: 20260926131420 reopened it "until that payment is made".
-- The payment is the legacy cascade operation 19aa02d6 (20260926145917
-- certified, 20261002025516 pays), on Dan's 2026-09-26 decision "Pay the
-- measured 138,303.43", reaffirmed 2026-10-02 ("pay it how you feel it's
-- necessary or don't, it doesn't matter as long as the bug or glitch is
-- done"). Neither the payer nor 20261002025516 touches the alert, so without
-- this it stays open over a paid week.
--
-- WHAT THIS DOES. Moves no chip. Refuses unless the operation is PAID and both
-- deferred obligation rows of the week (Deep Stack Society 44,931.08, Midway
-- Union 93,372.35) are discharged by it for 138,301.89 in all. Then resolves
-- the alert with the receipt and this disposition:
--   * paid per payee through the cascade: 138,301.89 (676 periods);
--   * 1.54 of the recorded 138,303.43 is the whole-cent rounding of 676
--     per-payee amounts. It belongs to no payee, so it cannot be paid without
--     inventing one: disposition house_retained_unattributable.
-- The pruner that destroyed per-player attribution for the week is fixed
-- (20260925143224 for cash rake records; 20261002082452 for tournament hands
-- while their event is unsettled).

-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE id = 'bfe0b305-551a-44d3-8237-a8519912acb1' AND resolved IS TRUE AND context->'final_disposition'->>'migration' = '20261002090915_the_week_of_2026_09_14_owed_alert_closes_once_it_is_paid') = 1

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $mig$
DECLARE
  c_mig    CONSTANT text := '20261002090915_the_week_of_2026_09_14_owed_alert_closes_once_it_is_paid';
  c_alert  CONSTANT uuid := 'bfe0b305-551a-44d3-8237-a8519912acb1';
  c_op     CONSTANT uuid := '19aa02d6-1023-441a-9979-3e65ceab6240';
  c_from   CONSTANT timestamptz := '2026-09-14 07:00:00+00';
  c_actor  CONSTANT uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  v_state text; v_paid_at timestamptz; v_n int; v_sum numeric; v_pending numeric; v_periods int;
BEGIN
  SELECT state, paid_at INTO v_state, v_paid_at
    FROM public.accounting_owner_legacy_operations
   WHERE operation_id = c_op AND period_start = c_from AND mode = 'legacy_cascade';
  IF v_state IS DISTINCT FROM 'paid' OR v_paid_at IS NULL THEN
    RAISE EXCEPTION 'week 0914 alert: operation 19aa02d6 is % (paid_at %), not paid; the alert stays open until the week is paid', v_state, v_paid_at;
  END IF;

  SELECT count(*), round(sum(discharged_amount), 2), round(sum(pending_amount), 2), sum(discharged_periods)
    INTO v_n, v_sum, v_pending, v_periods
    FROM public.accounting_deferred_obligations
   WHERE period_start = c_from AND discharged_operation_id = c_op;
  IF v_n <> 2 OR v_sum <> 138301.89 OR v_pending <> 138303.43 THEN
    RAISE EXCEPTION 'week 0914 alert: expected 2 obligations discharged by 19aa02d6 for 138,301.89 of 138,303.43, read % for % of %', v_n, v_sum, v_pending;
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_deferred_obligations
              WHERE period_start = c_from AND discharged_operation_id IS NULL) THEN
    RAISE EXCEPTION 'week 0914 alert: an obligation of the week is still undischarged';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.financial_alerts
                  WHERE id = c_alert AND source = 'deferred_rakeback_basis_2026_09_14'
                    AND resolved IS NOT TRUE
                    AND (context->'basis_decision'->>'owed_total')::numeric = 138303.43) THEN
    RAISE EXCEPTION 'week 0914 alert: bfe0b305 is not the open 138,303.43 reader this migration was written against';
  END IF;

  UPDATE public.financial_alerts
     SET context = context || jsonb_build_object(
           'owed', (context->'owed') || jsonb_build_object('status', 'paid'),
           'final_disposition', jsonb_build_object(
             'paid_by_operation', c_op, 'paid_at', v_paid_at,
             'paid_amount', v_sum, 'paid_periods', v_periods,
             'recorded_owed', v_pending,
             'house_retained_unattributable', round(v_pending - v_sum, 2),
             'why_unattributable', 'whole-cent rounding of the per-payee amounts; it belongs to no payee',
             'ruling', 'Dan 2026-09-26 "Pay the measured 138,303.43"; 2026-10-02 "pay it how you feel it''s necessary or don''t, as long as the bug is done"',
             'pruner_fixed_by', jsonb_build_array('20260925143224', '20261002082452'),
             'migration', c_mig)),
         resolved = true, resolved_at = now(), resolved_by = c_actor,
         resolution = format(
           'Paid. The week of 2026-09-14 rakeback was paid per payee through the legacy cascade, operation %s at %s: %s over %s periods against the recorded %s. '
           || 'The %s difference is the whole-cent rounding of the per-payee amounts, belongs to no payee, and is recorded house_retained_unattributable. '
           || 'The pruner that removed per-player rake records is fixed (20260925143224; tournament hands 20261002082452). Migration %s.',
           c_op, v_paid_at, v_sum, v_periods, v_pending, round(v_pending - v_sum, 2), c_mig)
   WHERE id = c_alert AND resolved IS NOT TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'week 0914 alert: bfe0b305 did not resolve'; END IF;

  IF EXISTS (SELECT 1 FROM public.financial_alerts
              WHERE source = 'deferred_rakeback_basis_2026_09_14' AND resolved IS NOT TRUE) THEN
    RAISE EXCEPTION 'week 0914 alert post-image: a reader of the week is still open';
  END IF;
END
$mig$;

COMMIT;
