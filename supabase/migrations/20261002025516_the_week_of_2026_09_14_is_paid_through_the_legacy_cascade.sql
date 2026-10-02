-- 20261002025516_the_week_of_2026_09_14_is_paid_through_the_legacy_cascade.sql
--
-- THE WEEK OF 2026-09-14 IS PAID THROUGH THE LEGACY CASCADE (owner-authorized,
-- runs once; step 2 of 2)
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
-- Step 2: pays, once, the certification that 20260926145917 recorded under
-- operation id 19aa02d6-1023-441a-9979-3e65ceab6240, with
-- fn_accounting_legacy_pay_week (installed by 20260926140858). It re-checks
-- that no certified period changed and every payer can cover what it owes.
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
-- RUNS ONCE. A replay finds the operation paid, is refused below as a
-- duplicate and rolls back whole. Any moved figure refuses the whole transaction; pay
-- refuses inside :45-:04 and during a platform freeze. No cron, watcher or
-- retry, and no clearing account.
--
-- @live-proof: (SELECT state = 'paid' FROM public.accounting_owner_legacy_operations WHERE operation_id = '19aa02d6-1023-441a-9979-3e65ceab6240')
-- @live-proof: (SELECT count(*) = 2 FROM public.accounting_deferred_obligations WHERE period_start = '2026-09-14 07:00:00+00' AND discharged_operation_id = '19aa02d6-1023-441a-9979-3e65ceab6240')

BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '840s';

DO $op$
DECLARE
  c_op    CONSTANT uuid := '19aa02d6-1023-441a-9979-3e65ceab6240';
  c_union CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';
  c_from  CONSTANT timestamptz := '2026-09-14 07:00:00+00';
  v_paid jsonb; v_cron bigint; v_floor timestamptz; v_n bigint; v_pos bigint;
BEGIN
  IF (SELECT state FROM public.accounting_owner_legacy_operations WHERE operation_id = c_op) IS DISTINCT FROM 'certified' THEN
    RAISE EXCEPTION 'week 2026-09-14: operation % is not certified and unpaid (apply 20260926145917 first; never replay)', c_op;
  END IF;
  SELECT count(*) INTO v_cron FROM cron.job;
  SELECT earliest_period_start INTO v_floor FROM public.union_settlement_floor WHERE union_id = c_union;
  SELECT count(*) FILTER (WHERE rakeback_amount > 0) INTO v_pos
    FROM public.accounting_legacy_rakeback_certificates WHERE operation_id = c_op;

  v_paid := public.fn_accounting_legacy_pay_week(c_op);
  IF (v_paid->>'round1_union_to_clubs')::numeric <> 339323.01
     OR (v_paid->>'round2_club_direct')::numeric <> 488214.01 OR (v_paid->>'round2_legs')::int <> 137
     OR (v_paid->>'round3_amount')::numeric <> 138301.89 OR (v_paid->>'round3_periods')::int <> 676
     OR (v_paid->>'round3_payees')::bigint <> v_pos OR (v_paid->>'legs')::bigint <> 2 + 137 + v_pos
     OR (v_paid->>'recorded_commission_rows_settled')::bigint <> 1823910
     OR (v_paid->>'superseded_periods_closed')::int <> 600
     OR (v_paid->>'union_rake_wallet_before')::numeric - (v_paid->>'union_rake_wallet_after')::numeric <> 339323.01
     OR v_paid ? 'duplicate' THEN
    RAISE EXCEPTION 'week 2026-09-14: the payment is not the certified one: %', v_paid;
  END IF;

  SELECT count(*) INTO v_n FROM public.accounting_legacy_rakeback_certificates c
    JOIN public.rakeback_periods rp ON rp.id = c.period_id
   WHERE c.operation_id = c_op AND rp.status = 'paid'
     AND (SELECT count(*) FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id = rp.id AND pp.status = 'paid') = 1;
  IF v_n <> 676 THEN RAISE EXCEPTION 'week 2026-09-14: % of 676 periods are paid exactly once', v_n; END IF;
  IF (SELECT count(*) FROM public.chip_ledger l WHERE l.metadata->>'legacy_operation_id' = c_op::text) <> 2 + 137 + v_pos
     OR EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.metadata->>'legacy_operation_id' = c_op::text
       AND ((SELECT count(*) FROM public.settlement_invoices i WHERE i.source_ledger_id = l.id AND i.status = 'paid' AND i.message_sent AND i.chips_transferred AND i.net_amount = l.amount) <> 1
         OR NOT EXISTS (SELECT 1 FROM public.settlement_invoices i JOIN public.accounting_invoice_deliveries d ON d.invoice_id = i.id
              JOIN public.social_messages m ON m.id = d.message_id AND m.message_type = 'invoice'
              JOIN public.notifications n ON n.id = d.notification_id AND n.user_id = d.recipient_id
             WHERE i.source_ledger_id = l.id)
         OR (l.category = 'rakeback' AND l.to_type = 'player_wallet' AND NOT EXISTS (
              SELECT 1 FROM public.settlement_invoices i JOIN public.accounting_invoice_deliveries d ON d.invoice_id = i.id
               WHERE i.source_ledger_id = l.id AND d.recipient_id = l.to_entity_id)))) THEN
    RAISE EXCEPTION 'week 2026-09-14: a leg is missing its receipt, Messenger record or notification';
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.metadata->>'legacy_operation_id' = c_op::text
              AND (l.from_type = 'settlement_suspense' OR l.to_type = 'settlement_suspense')) THEN
    RAISE EXCEPTION 'week 2026-09-14: a leg touched the clearing account';
  END IF;
  IF (SELECT count(*) FROM public.accounting_deferred_obligations WHERE period_start = c_from AND discharged_operation_id = c_op) <> 2
     OR (SELECT sum(discharged_amount) FROM public.accounting_deferred_obligations WHERE period_start = c_from) <> 138301.89 THEN
    RAISE EXCEPTION 'week 2026-09-14: the obligation rows are not discharged whole';
  END IF;
  IF (SELECT count(*) FROM cron.job) <> v_cron
     OR (SELECT earliest_period_start FROM public.union_settlement_floor WHERE union_id = c_union) IS DISTINCT FROM v_floor
     OR v_floor IS DISTINCT FROM '2026-09-21 07:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'week 2026-09-14: the settlement schedule moved';
  END IF;
  RAISE NOTICE 'week 2026-09-14 paid through the legacy cascade: %', v_paid;
END
$op$;

COMMIT;
