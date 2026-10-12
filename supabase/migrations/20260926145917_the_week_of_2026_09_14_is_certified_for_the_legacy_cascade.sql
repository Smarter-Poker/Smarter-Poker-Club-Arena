-- 20260926145917_the_week_of_2026_09_14_is_certified_for_the_legacy_cascade.sql
--
-- THE WEEK OF 2026-09-14 IS CERTIFIED FOR THE LEGACY CASCADE (owner-authorized,
-- runs once; step 1 of 2)
--
-- DECISION (Dan, 2026-09-26): "Pay the measured 138,303.43." The whole week
-- 2026-09-14 07:00Z -> 2026-09-21 07:00Z runs through the normal cascade on a
-- documented legacy basis: the union funds its clubs (round 1 shape), the
-- agents receive their unpaid commissions of the week (round 2 shape) and fund
-- their players' rakeback (round 3 shape), each payee's club taken from the
-- recorded earning sources, under certificate kind owner_legacy_v1 carrying
-- the measurement, the authorization and the operation id. This supersedes
-- the "no chip moves here" of 20260926131554: that migration recorded the week
-- as OWED for a one-off payment, and this is that payment.
--
-- Step 1 (this file) certifies the week under the fixed operation id
-- 19aa02d6-1023-441a-9979-3e65ceab6240 with fn_accounting_legacy_certify_week
-- (installed by 20260926140858): it writes the owner_legacy_v1 certificates,
-- the round 1 / round 2 plan and the restated / opened periods, and moves no
-- chip. Step 2 (20261002025516) pays exactly that certification. They are two
-- transactions so that each fits the apply door and the hour outside the
-- break window and the hourly cascade (cron 272 at :40).
--
-- MEASURED read-only against production on 2026-09-26 (the basis is set out
-- in 20260926140858's header):
--   cash rake basis 615,842.54 (Deep Stack Society 238,816.96; Club JAQK
--     173,982.96 and SHARK CLUB 203,042.62 at the union's tables) - the
--     recorded basis of 20260921082544 to the cent;
--   rakeback 138,301.89 on 676 periods, paid per payee in whole cents (Deep
--     Stack Society 44,931.27, Club JAQK 46,752.70, SHARK CLUB 46,617.92),
--     against the recorded 138,303.43 - the 1.54 is written on the discharged
--     rows and no payee is invented for it;
--   round 1: the union pays Club JAQK 156,584.66 and SHARK CLUB 182,738.35
--     (0.9000 of each club's cash rake, truncated to cents);
--   round 2: 488,214.01 of commission on 137 hierarchy edges; the 1,823,910
--     recorded, unsettled cash commission rows of the week (413,186.31 from
--     the stalled legacy writer) are settled by this payment, not paid again;
--   600 recorded legacy rows with no measured cash payable in their club
--     (493 on the union house club, 107 in Deep Stack Society) are closed as
--     superseded, never deleted; 266 are restated and 410 opened.
-- No agent and no club is short; the pay step re-checks every payer and
-- refuses the whole operation with the exact shortfall if one is.
--
-- NOT PAID HERE: the week's tournament-fee rakeback and tournament commission
-- are outside the recorded obligation and remain undecided.
--
-- RUNS ONCE. A replay refuses (legacy_discharge_already_recorded) and rolls
-- back whole. Any moved figure refuses the whole transaction. No cron,
-- watcher or retry.
--
-- @live-proof: (SELECT state IN ('certified','paid') FROM public.accounting_owner_legacy_operations WHERE operation_id = '19aa02d6-1023-441a-9979-3e65ceab6240')

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '840s';

DO $op$
DECLARE
  c_op    CONSTANT uuid := '19aa02d6-1023-441a-9979-3e65ceab6240';
  c_union CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';
  c_from  CONSTANT timestamptz := '2026-09-14 07:00:00+00';
  v_cert jsonb; v_paid jsonb; v_cron bigint; v_floor timestamptz; v_n bigint; v_pos bigint;
BEGIN
  IF to_regprocedure('public.fn_accounting_legacy_certify_week(uuid,timestamptz,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('public.fn_accounting_legacy_pay_week(uuid)') IS NULL THEN
    RAISE EXCEPTION 'requires 20260926140858 (the owner legacy discharge operation) installed first';
  END IF;
  SELECT count(*) INTO v_cron FROM cron.job;
  SELECT earliest_period_start INTO v_floor FROM public.union_settlement_floor WHERE union_id = c_union;

  v_cert := public.fn_accounting_legacy_certify_week(c_op, c_from, 'legacy_cascade',
    'Dan (owner), chat decision 2026-09-26, relayed by the coordinator',
    'DECISION 1, week of 2026-09-14: "Pay the measured 138,303.43." Run the whole week through the normal cascade on a documented LEGACY basis: union funds clubs (round 1 shape), agents receive their unpaid commissions of the week (round 2 shape) and fund player rakeback (round 3 shape); each payee''s club derived from the recorded earning sources; a new, explicitly marked legacy certificate kind carrying the measurement, the owner authorization and the operation id.',
    '{"basis": 615842.54, "pairs": 676, "payable": 138301.89,
      "payable_by_club": {"2a1132b9-5ba2-42e6-9f01-30a7fcffebe3": 44931.27, "a0000000-0000-0000-0000-000000000001": 46752.70, "a41434bb-8d0c-400a-8f0d-e8b3d65afed4": 46617.92},
      "commission_total": 488214.01,
      "round1": {"a0000000-0000-0000-0000-000000000001": 156584.66, "a41434bb-8d0c-400a-8f0d-e8b3d65afed4": 182738.35},
      "round2_legs": 137, "superseded_periods": 600}'::jsonb);
  IF (v_cert->>'restated_periods')::int <> 266 OR (v_cert->>'opened_periods')::int <> 410
     OR v_cert->'recorded_commission_rows' IS DISTINCT FROM '{"rows": 1823910, "amount": 413186.31}'::jsonb THEN
    RAISE EXCEPTION 'week 2026-09-14: the recorded rows moved since the read-only measurement: %', v_cert;
  END IF;
  SELECT count(*) FILTER (WHERE rakeback_amount > 0) INTO v_pos
    FROM public.accounting_legacy_rakeback_certificates WHERE operation_id = c_op;

  IF (SELECT count(*) FROM public.accounting_legacy_rakeback_certificates WHERE operation_id = c_op) <> 676
     OR (SELECT sum(rakeback_amount) FROM public.accounting_legacy_rakeback_certificates WHERE operation_id = c_op) <> 138301.89
     OR (SELECT count(*) FROM public.accounting_legacy_settlement_legs WHERE operation_id = c_op AND round_no = 1) <> 2
     OR (SELECT count(*) FROM public.accounting_legacy_settlement_legs WHERE operation_id = c_op AND round_no = 2) <> 137
     OR (SELECT state FROM public.accounting_owner_legacy_operations WHERE operation_id = c_op) <> 'certified' THEN
    RAISE EXCEPTION 'week 2026-09-14: the certification is not the measured one';
  END IF;
  RAISE NOTICE 'week 2026-09-14 certified (no chip moved): %', v_cert;
END
$op$;

COMMIT;
