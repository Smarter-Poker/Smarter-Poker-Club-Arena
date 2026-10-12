-- 20261002110247_deep_stack_society_guarantee_coverage_is_restored_after_the_.sql
-- ===========================================================================
--  DEEP STACK SOCIETY'S GUARANTEE COVERAGE IS RESTORED AFTER THE WEEK OF
--  2026-09-14 RAKEBACK WAS PAID FROM ITS TREASURY
-- ===========================================================================
--
-- 20261002092328 (#5805) funded Deep Stack Society (2a1132b9, standalone, its
-- own treasury is its guarantee bank) through fn_ca_fund_club by exactly what
-- the 205,358.97 payment of the week of 2026-09-14 (operation 19aa02d6)
-- needed plus a 10,000.00 float. Before the payment the treasury (201,728.44
-- at 09:24 UTC) covered every published guarantee of the club; after it the
-- treasury was 8,200.00 at 10:58 UTC against 38,768.50 of live uncovered
-- guarantees (prize guarantees and guaranteed satellite seats net of the
-- pools collected), so the club's published guarantees were no longer
-- covered: a 20,000.00 GTD (16,400.00 overlay) cannot start on a 8,200.00
-- bank. The shortfall is caused by the payment; nothing else moved the
-- treasury by that order.
--
-- DECISION (CLAUDE.md 10.9, delegated by Dan): the house restores the
-- coverage through the same sanctioned door #5805 used, fn_ca_fund_club (a
-- ledgered system_mint into club_treasury), by exactly the club's guarantee
-- shortfall at apply time: greatest(0, floor + live uncovered guarantees -
-- treasury), the same exposure fn_tournament_management_readiness_for_row
-- counts for a club bank. Nothing is paid to any player. Refuses unless the
-- payment it follows was made (the #5805 funding key exists and operation
-- 19aa02d6 is no longer certified-and-unpaid), the key is unused (a replay
-- mints nothing), and the amount is at most 45,000.00 (read it again).

-- @live-proof: (SELECT count(*) FROM public.chip_ledger WHERE idempotency_key = 'club-funding:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3:guarantee-coverage-after-legacy-week-2026-09-14') <= 1

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $mig$
DECLARE
  c_dss      CONSTANT uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  c_op       CONSTANT uuid := '19aa02d6-1023-441a-9979-3e65ceab6240';
  c_paid_key CONSTANT text := 'club-funding:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3:legacy-week-2026-09-14';
  c_key      CONSTANT text := 'club-funding:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3:guarantee-coverage-after-legacy-week-2026-09-14';
  c_cap      CONSTANT numeric := 45000.00;
  v_state text; v_before numeric; v_floor numeric; v_exposure numeric;
  v_amount numeric; v_res jsonb; v_after numeric; v_leg numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = c_paid_key) THEN
    RAISE EXCEPTION 'dss coverage: % was never journaled; the week of 2026-09-14 was not paid from this treasury', c_paid_key;
  END IF;
  SELECT state INTO v_state FROM public.accounting_owner_legacy_operations
   WHERE operation_id = c_op AND mode = 'legacy_cascade';
  IF v_state IS NULL OR v_state = 'certified' THEN
    RAISE EXCEPTION 'dss coverage: operation 19aa02d6 is %, not paid; nothing was drawn to restore', v_state;
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = c_key) THEN
    RAISE NOTICE 'dss coverage: % already journaled - nothing minted', c_key;
    RETURN;
  END IF;

  SELECT COALESCE(chip_treasury, 0), COALESCE(guarantee_treasury_floor, 0)
    INTO v_before, v_floor
    FROM public.clubs WHERE id = c_dss AND union_id IS NULL FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dss coverage: Deep Stack Society is missing or no longer standalone';
  END IF;

  SELECT COALESCE(sum(greatest(
           greatest(
             COALESCE(t.guaranteed_prize, 0),
             CASE
               WHEN COALESCE(t.satellite_seats, 0) > 0
                    AND (
                      lower(COALESCE(t.variant, '')) = 'satellite'
                      OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE'
                      OR COALESCE(t.satellite_target_id, t.satellite_target) IS NOT NULL
                    )
               THEN COALESCE(
                 (COALESCE(target.buy_in_amount, 0) + COALESCE(target.buy_in_fee, 0))
                 * t.satellite_seats,
                 0
               )
               ELSE 0
             END
           ) - COALESCE(t.prize_pool, 0),
           0
         )), 0)
    INTO v_exposure
    FROM public.tournaments t
    LEFT JOIN public.tournaments target
      ON target.id = COALESCE(t.satellite_target_id, t.satellite_target)
   WHERE t.club_id = c_dss
     AND (COALESCE(t.is_private, false) OR t.union_id IS NULL)
     AND NOT COALESCE(t.prize_pool_finalized, false)
     AND upper(t.status::text) IN ('ANNOUNCED', 'REGISTERING', 'RUNNING');

  v_amount := round(greatest(0, v_floor + v_exposure - v_before), 2);
  IF v_amount <= 0 THEN
    RAISE NOTICE 'dss coverage: treasury % already covers % of live guarantees; nothing minted', v_before, v_exposure;
    RETURN;
  END IF;
  IF v_amount > c_cap THEN
    RAISE EXCEPTION 'dss coverage: shortfall % (treasury %, live guarantees %) exceeds %; read it again before funding', v_amount, v_before, v_exposure, c_cap;
  END IF;

  v_res := public.fn_ca_fund_club(c_dss, v_amount,
    format('House restores Deep Stack Society guarantee coverage drawn down by the week of 2026-09-14 rakeback payment (operation 19aa02d6, funded by migration 20261002092328, #5805): treasury %s against %s of live uncovered guarantees, minted %s, the exact shortfall. Migration 20261002110247.', v_before, v_exposure, v_amount),
    c_key);
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE OR (v_res->>'replayed')::boolean THEN
    RAISE EXCEPTION 'dss coverage: fn_ca_fund_club did not fund: %', v_res;
  END IF;

  SELECT chip_treasury INTO v_after FROM public.clubs WHERE id = c_dss;
  SELECT sum(amount) INTO v_leg FROM public.chip_ledger WHERE idempotency_key = c_key;
  IF round(v_after - v_before, 2) <> v_amount OR v_leg IS DISTINCT FROM v_amount
     OR v_after < v_floor + v_exposure THEN
    RAISE EXCEPTION 'dss coverage post-image: treasury % -> % (minted %, leg %), live guarantees %', v_before, v_after, v_amount, v_leg, v_exposure;
  END IF;
  RAISE NOTICE 'dss coverage: treasury % -> % (minted %, live guarantees %)', v_before, v_after, v_amount, v_exposure;
END
$mig$;

COMMIT;
