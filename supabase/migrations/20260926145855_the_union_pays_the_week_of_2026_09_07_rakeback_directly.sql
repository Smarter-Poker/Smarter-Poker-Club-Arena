-- 20260926145855_the_union_pays_the_week_of_2026_09_07_rakeback_directly.sql
--
-- THE UNION PAYS THE WEEK OF 2026-09-07 RAKEBACK DIRECTLY (owner-authorized,
-- runs once)
--
-- DECISION (Dan, 2026-09-26): "Union pays them directly." The week of
-- 2026-09-07 07:00Z -> 2026-09-14 07:00Z still owes 117,192.35 on 583
-- recorded pending periods (accounting_deferred_obligations: Midway Union
-- 117,188.36 on 582, Deep Stack Society 3.99 on 1). 416 + 4 other periods of
-- that week were paid on 2026-09-14 and are not touched. No clawback.
--
-- STEP 1 OF 2 (this file certifies; it moves no chip). It calls the operation
-- installed by 20260926140858 exactly once, under the fixed operation id
-- e5b10b0a-4b5a-4a57-8804-1347b1910786:
--   fn_accounting_legacy_certify_week(..., 'union_direct', ...) certifies each
--     recorded period (owner_legacy_v1) and chooses its destination wallet;
--   fn_accounting_legacy_pay_week (in 20261002041812, a separate transaction)
--     pays each one from the union rake treasury
--     (fade0000-0000-0000-0000-000000000001) with one chip_ledger leg, one
--     paid receipt, one Messenger record and one notification to the payee,
--     closes the period and discharges both obligation rows.
--
-- DESTINATION (the owner left it to the operation, and it is recorded on each
-- certificate). The payee's account in the recorded club when it exists (320
-- periods, all on the union house club). Otherwise a member-club wallet the
-- payee holds, under the union's authority: the member club whose wallet paid
-- the payee's buy-ins at the union's own tables that week (209), else before
-- it (40), else the payee's oldest union membership (14). The one Deep Stack
-- Society row belongs here: its payee holds no Deep Stack Society account and
-- played that week at the union's tables from a Club JAQK wallet. Measured
-- read-only on 2026-09-26: Midway house club 64,516.07 on 320, Club JAQK
-- 26,931.59 on 129, SHARK CLUB 25,744.69 on 134. One period is 0.00: it is
-- closed as paid with no chip leg.
--
-- RUNS ONCE. A replay refuses in certify (legacy_discharge_already_recorded)
-- and rolls back whole; pay itself returns a paid operation as a duplicate.
-- Any moved figure refuses the whole transaction, nothing is paid partially,
-- and a payer short of funds refuses with the exact shortfall. Pay refuses
-- inside :45-:04 and during a platform freeze. No cron, watcher or retry.
--
-- @live-proof: (SELECT state IN ('certified','paid') FROM public.accounting_owner_legacy_operations WHERE operation_id = 'e5b10b0a-4b5a-4a57-8804-1347b1910786')

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '840s';

DO $op$
DECLARE
  c_op    CONSTANT uuid := 'e5b10b0a-4b5a-4a57-8804-1347b1910786';
  c_union CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';
  c_from  CONSTANT timestamptz := '2026-09-07 07:00:00+00';
  v_cert jsonb; v_paid jsonb; v_cron bigint; v_floor timestamptz; v_n bigint;
BEGIN
  IF to_regprocedure('public.fn_accounting_legacy_certify_week(uuid,timestamptz,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('public.fn_accounting_legacy_pay_week(uuid)') IS NULL THEN
    RAISE EXCEPTION 'requires 20260926140858 (the owner legacy discharge operation) installed first';
  END IF;
  SELECT count(*) INTO v_cron FROM cron.job;
  SELECT earliest_period_start INTO v_floor FROM public.union_settlement_floor WHERE union_id = c_union;

  v_cert := public.fn_accounting_legacy_certify_week(c_op, c_from, 'union_direct',
    'Dan (owner), chat decision 2026-09-26, relayed by the coordinator',
    'DECISION 2, week of 2026-09-07 (remaining 117,192.35 over 583 periods): "Union pays them directly" - one documented one-off from the union rake wallet, each payment receipted with a Messenger record and a notification; no clawback; a payee with no account in the recorded club is paid to a player wallet under the union''s authority.',
    '{"periods": 583, "amount": 117192.35}'::jsonb);
  IF v_cert->'by_destination_rule' IS DISTINCT FROM
       '{"recorded_club_account": 320, "week_union_table_funding_club": 209, "prior_union_table_funding_club": 40, "oldest_union_membership": 14}'::jsonb
     OR v_cert->'by_destination_club' IS DISTINCT FROM
       '{"fade0000-0000-0000-0000-000000000001": {"periods": 320, "amount": 64516.07}, "a0000000-0000-0000-0000-000000000001": {"periods": 129, "amount": 26931.59}, "a41434bb-8d0c-400a-8f0d-e8b3d65afed4": {"periods": 134, "amount": 25744.69}}'::jsonb THEN
    RAISE EXCEPTION 'week 2026-09-07: destinations moved since the read-only measurement: %', v_cert;
  END IF;

  IF (SELECT count(*) FROM public.accounting_legacy_rakeback_certificates WHERE operation_id = c_op) <> 583
     OR (SELECT sum(rakeback_amount) FROM public.accounting_legacy_rakeback_certificates WHERE operation_id = c_op) <> 117192.35
     OR (SELECT state FROM public.accounting_owner_legacy_operations WHERE operation_id = c_op) <> 'certified' THEN
    RAISE EXCEPTION 'week 2026-09-07: the certification is not the measured one';
  END IF;
  RAISE NOTICE 'week 2026-09-07 certified (no chip moved): %', v_cert;
END
$op$;

COMMIT;
