-- The real strict public wrapper must refuse every pool kind even when called
-- by the owner; the correction is exclusively in inaccessible internal leaves.
DO $strict_cash_before$
DECLARE
  v_before jsonb:=pg_temp.exact_deal_money_state();
  v_result jsonb;
  v_kind text;
  v_call text;
BEGIN
  PERFORM pg_temp.deal_assert(current_setting('session_replication_role')='origin',
    'all financial checks run with native triggers active');
  v_result:=public.fn_settle_tournament_obligation(
    '87000000-0000-0000-0000-000000000001','refund',NULL,
    md5('atomic-deal-user:1')::uuid,1,'stage_b_probe',NULL,NULL);
  PERFORM pg_temp.deal_assert(
    v_result->>'refused_reason'='exact_refund_authority_required'
      AND (v_result->>'ok')::boolean=false,
    'strict public payer keeps every refund behind exact entitlement authority');
  FOREACH v_kind IN ARRAY ARRAY['place','bubble_protection','final_table_deal',
      'late_reg_adjustment','satellite_remainder','seat']
  LOOP
    v_result:=public.fn_settle_tournament_obligation(
      '87000000-0000-0000-0000-000000000001',v_kind,1,
      md5('atomic-deal-user:1')::uuid,1,'stage_b_probe',NULL,NULL);
    PERFORM pg_temp.deal_assert(v_result->>'refused_reason'='atomic_batch_required'
      AND (v_result->>'ok')::boolean=false,
      'strict public payer refuses '||v_kind);
  END LOOP;
  FOREACH v_call IN ARRAY ARRAY[
    $call$SELECT public.fn_ca_settle_tournament_place_raw(
      '87000000-0000-0000-0000-000000000001',6,md5('atomic-deal-user:6')::uuid,5)$call$,
    $call$SELECT public.fn_ca_settle_tournament_bubble_raw(
      '87000000-0000-0000-0000-000000000001',md5('atomic-deal-user:1')::uuid,1)$call$,
    $call$SELECT public.fn_ca_settle_final_table_deal_share_raw(
      '87000000-0000-0000-0000-000000000001',md5('atomic-deal-user:1')::uuid,1)$call$
  ]
  LOOP
    BEGIN
      EXECUTE v_call;
      RAISE EXCEPTION 'unchanged raw payer unexpectedly succeeded';
    EXCEPTION WHEN SQLSTATE 'P0404' THEN
      IF SQLERRM NOT LIKE '%atomic_batch_required%' THEN RAISE; END IF;
    END;
    PERFORM pg_temp.deal_assert(true,'unchanged raw payer reproduces strict public refusal');
  END LOOP;
  BEGIN
    PERFORM public.fn_settle_tournament_final_table_deal(
      '87000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'unchanged full deal unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    IF SQLERRM NOT LIKE '%atomic_batch_required%' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.deal_assert(pg_temp.exact_deal_money_state()=v_before,
    'unchanged full deal fails atomically under the strict public payer');
END;
$strict_cash_before$;

-- @CONTRACTION_NEGATIVES@
-- @CONTRACTION_BLOCK@

DO $strict_cash_after$
DECLARE v_kind text; v_result jsonb; v_identity text;
BEGIN
  FOREACH v_identity IN ARRAY ARRAY[
    'public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)',
    'public.fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric)',
    'public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)'
  ]
  LOOP
    PERFORM pg_temp.deal_assert(
      NOT has_function_privilege('anon',v_identity,'EXECUTE')
      AND NOT has_function_privilege('authenticated',v_identity,'EXECUTE')
      AND NOT has_function_privilege('service_role',v_identity,'EXECUTE'),
      'corrected raw payer remains owner-only: '||v_identity);
  END LOOP;
  FOREACH v_kind IN ARRAY ARRAY['place','bubble_protection','final_table_deal']
  LOOP
    v_result:=public.fn_settle_tournament_obligation(
      '87000000-0000-0000-0000-000000000001',v_kind,1,
      md5('atomic-deal-user:1')::uuid,1,'stage_b_probe',NULL,NULL);
    PERFORM pg_temp.deal_assert(v_result->>'refused_reason'='atomic_batch_required',
      'correcting internal calls does not reopen public '||v_kind);
  END LOOP;
END;
$strict_cash_after$;

-- Exercise the normal place authority with a real, pool-funded bubble and an
-- observed winner. This is a complete cash batch, with genuine wallet journals.
DO $strict_cash_places$
DECLARE
  v_result jsonb;
  v_replay jsonb;
  v_wallet_before numeric;
  v_wallet_after numeric;
  v_payouts_before jsonb;
  v_payouts_after jsonb;
BEGIN
  v_result:=public.fn_claim_tournament_finish(
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001','native-stage-b-cash-payer-probe');
  PERFORM pg_temp.deal_assert((v_result->>'ok')::boolean
    AND v_result->>'status'='COMPLETING',
    'native finish claim admits the observed cash winner before payment');
  v_result:=public.fn_settle_tournament_places(
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001');
  PERFORM pg_temp.deal_assert((v_result->>'ok')::boolean
    AND (SELECT prize_balance FROM public.tournament_escrow
      WHERE tournament_id='30000000-0000-0000-0000-000000000001')=0
    AND (SELECT sum(amount) FROM public.tournament_payouts
      WHERE tournament_id='30000000-0000-0000-0000-000000000001')=10
    AND (SELECT sum(amount) FROM public.tournament_payouts
      WHERE tournament_id='30000000-0000-0000-0000-000000000001'
        AND source='bubble_protection')=1
    AND NOT EXISTS(SELECT 1 FROM public.tournament_obligations
      WHERE tournament_id='30000000-0000-0000-0000-000000000001'
        AND amount_owed<>amount_paid),
    'normal cash authority pays the exact nine-chip winner and one-chip bubble');
  SELECT sum(amount) INTO v_wallet_before FROM public.wallet_transactions
    WHERE related_entity_id='30000000-0000-0000-0000-000000000001';
  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) INTO v_payouts_before
    FROM public.tournament_payouts p
    WHERE p.tournament_id='30000000-0000-0000-0000-000000000001';
  v_replay:=public.fn_settle_tournament_places(
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001');
  SELECT sum(amount) INTO v_wallet_after FROM public.wallet_transactions
    WHERE related_entity_id='30000000-0000-0000-0000-000000000001';
  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) INTO v_payouts_after
    FROM public.tournament_payouts p
    WHERE p.tournament_id='30000000-0000-0000-0000-000000000001';
  PERFORM pg_temp.deal_assert(v_wallet_before=10 AND v_wallet_after=10
    AND v_payouts_before=v_payouts_after AND (v_replay->>'ok')::boolean,
    'normal cash replay preserves exact payouts and native wallet journal');
END;
$strict_cash_places$;
