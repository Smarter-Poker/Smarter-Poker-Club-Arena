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
-- This calls the operation installed by 20260926140858 exactly once, under
-- the fixed operation id e5b10b0a-4b5a-4a57-8804-1347b1910786:
--   fn_accounting_legacy_certify_week(..., 'union_direct', ...) certifies each
--     recorded period (owner_legacy_v1) and chooses its destination wallet;
--   fn_accounting_legacy_pay_week pays each one from the union rake treasury
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
-- @live-proof: (SELECT state = 'paid' FROM public.accounting_owner_legacy_operations WHERE operation_id = 'e5b10b0a-4b5a-4a57-8804-1347b1910786')
-- @live-proof: (SELECT count(*) = 2 FROM public.accounting_deferred_obligations WHERE period_start = '2026-09-07 07:00:00+00' AND discharged_operation_id = 'e5b10b0a-4b5a-4a57-8804-1347b1910786')

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '600s';

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

  v_paid := public.fn_accounting_legacy_pay_week(c_op);
  IF (v_paid->>'round3_amount')::numeric <> 117192.35 OR (v_paid->>'round3_periods')::int <> 583
     OR (v_paid->>'round3_payees')::int <> 582 OR (v_paid->>'legs')::int <> 582
     OR (v_paid->>'round1_union_to_clubs')::numeric <> 0 OR (v_paid->>'round2_legs')::int <> 0
     OR (v_paid->>'union_rake_wallet_before')::numeric - (v_paid->>'union_rake_wallet_after')::numeric <> 117192.35
     OR v_paid ? 'duplicate' THEN
    RAISE EXCEPTION 'week 2026-09-07: the payment is not the certified one: %', v_paid;
  END IF;

  -- Every certified period paid once; every leg receipted and delivered to
  -- its payee as an invoice Messenger record with its own notification.
  SELECT count(*) INTO v_n FROM public.accounting_legacy_rakeback_certificates c
    JOIN public.rakeback_periods rp ON rp.id = c.period_id
   WHERE c.operation_id = c_op AND rp.status = 'paid'
     AND (SELECT count(*) FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id = rp.id AND pp.status = 'paid') = 1;
  IF v_n <> 583 THEN RAISE EXCEPTION 'week 2026-09-07: % of 583 periods are paid exactly once', v_n; END IF;
  IF (SELECT count(*) FROM public.chip_ledger l WHERE l.metadata->>'legacy_operation_id' = c_op::text) <> 582
     OR EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.metadata->>'legacy_operation_id' = c_op::text
       AND (l.from_type <> 'union_wallet' OR l.to_type <> 'player_wallet' OR l.category <> 'rakeback'
         OR (SELECT count(*) FROM public.settlement_invoices i WHERE i.source_ledger_id = l.id AND i.status = 'paid' AND i.message_sent AND i.chips_transferred AND i.net_amount = l.amount) <> 1
         OR NOT EXISTS (SELECT 1 FROM public.settlement_invoices i JOIN public.accounting_invoice_deliveries d ON d.invoice_id = i.id
              JOIN public.social_messages m ON m.id = d.message_id AND m.message_type = 'invoice'
              JOIN public.notifications n ON n.id = d.notification_id AND n.user_id = d.recipient_id
             WHERE i.source_ledger_id = l.id AND d.recipient_id = l.to_entity_id))) THEN
    RAISE EXCEPTION 'week 2026-09-07: a payment is missing its leg, receipt, Messenger record or notification';
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.metadata->>'legacy_operation_id' = c_op::text
              AND (l.from_type = 'settlement_suspense' OR l.to_type = 'settlement_suspense')) THEN
    RAISE EXCEPTION 'week 2026-09-07: a leg touched the clearing account';
  END IF;
  IF (SELECT count(*) FROM public.accounting_deferred_obligations WHERE period_start = c_from AND discharged_operation_id = c_op) <> 2
     OR (SELECT sum(discharged_amount) FROM public.accounting_deferred_obligations WHERE period_start = c_from) <> 117192.35 THEN
    RAISE EXCEPTION 'week 2026-09-07: the obligation rows are not discharged whole';
  END IF;
  IF (SELECT count(*) FROM cron.job) <> v_cron
     OR (SELECT earliest_period_start FROM public.union_settlement_floor WHERE union_id = c_union) IS DISTINCT FROM v_floor
     OR v_floor IS DISTINCT FROM '2026-09-21 07:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'week 2026-09-07: the settlement schedule moved';
  END IF;
  RAISE NOTICE 'week 2026-09-07 paid by the union: %', v_paid;
END
$op$;

COMMIT;
