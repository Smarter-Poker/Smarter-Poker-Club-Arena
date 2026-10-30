-- Reserved by scripts/new-migration.mjs. One closed incident, not a repair job.
-- KingFish's first Lightning hand won 1 (400 -> 401); thirteen later normal
-- folds deducted 26 before the authorized stop closed the session at 375.
-- The client private-room recovery fix is PR #8755. Preserve every settled
-- hand, the initial win, the funded 375 anchor, and all opponents' outcomes.
-- Midway Union hosted this game: its union bank absorbs the client error,
-- using the maintained house-settlement precedent 20261026172816. KINGS is
-- solely the original destination wallet; its treasury is never charged.
-- Existing union debit + explicit club credit primitives own the movement.
-- Apply only protected-main bytes, after a single self-aborting rollback probe.
-- @live-proof: (SELECT count(*) FROM public.chip_ledger WHERE idempotency_key='lightning-card-incident:bdacfcbf-af5d-441b-a76d-4a52dfa33688' AND from_type='union_bank' AND from_entity_id='fade0000-0000-0000-0000-000000000001' AND to_type='player_wallet' AND to_entity_id='47965354-0e56-43ef-931c-ddaab82af765' AND club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4' AND amount=26 AND status='posted')=1
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
DO $settle$
DECLARE
 c_mig constant text:='20261030161608_house_covers_kingfish_lightning_missing_card_losses';
 c_key constant text:='lightning-card-incident:bdacfcbf-af5d-441b-a76d-4a52dfa33688';
 c_session constant uuid:='bdacfcbf-af5d-441b-a76d-4a52dfa33688';
 c_user constant uuid:='47965354-0e56-43ef-931c-ddaab82af765';
 c_cluster constant uuid:='563279fc-c09a-48a6-b487-c4f34f289095';
 c_slot constant uuid:='7cdf4d74-fe69-4196-baf5-264102f4b2db';
 c_anchor constant uuid:='71cb19cb-24bc-4653-8e99-159cb844aa21';
 c_club constant uuid:='a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
 c_union constant uuid:='fade0000-0000-0000-0000-000000000001';
 c_actor constant uuid:='2d1cd6c3-5700-4af9-a271-d4863fdab20d';
 c_amount constant numeric:=26;
 v_reason text; v_intent jsonb; v_adj uuid; v_leg public.chip_ledger%ROWTYPE;
 v_tx public.chip_transactions%ROWTYPE; v_bank numeric; v_wallet numeric;
 v_bank_after numeric; v_wallet_after numeric; v_debit jsonb; v_credit jsonb;
 v_saved jsonb; v_setting text; v_replay boolean:=false; v_n integer;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' THEN
  RAISE EXCEPTION 'lightning_incident_postgres_only' USING ERRCODE='42501';
 END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended(c_key,0)) THEN
  RAISE EXCEPTION 'lightning_incident_operation_owned' USING ERRCODE='55P03';
 END IF;
 IF EXISTS(SELECT FROM (VALUES ('public.fn_ca_adjustment_under_10_9(uuid,uuid,numeric,text,text,text)','2439f6a5fce1589734a6180260e5d0d1'),('public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])','2eb458ce27b0116d2f7ad4603ca719dd'),('public.fn_ca_union_wallet_ledger_shape(text)','988e05b7293e2582573496febaa26161'),('public.fn_credit_chips(uuid,uuid,numeric,text,jsonb)','cd276555a2ddb34171f025ee91af9ee3'),('public.fn_union_debit_wallet(uuid,text,numeric,text,uuid,uuid,text,uuid,text)','d23400cb934c1c2ae4d067058ec418a4'),('public.fn_union_debit_wallet_zd3core(uuid,text,numeric,text,uuid,uuid,text,uuid)','2b51a9540e5ed24961aed8434a8ffdd8'))x(signature,body_md5)
   LEFT JOIN pg_proc p ON p.oid=to_regprocedure(x.signature)
   WHERE p.oid IS NULL OR p.proowner<>'postgres'::regrole OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM x.body_md5)
  OR NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.ca_correction_request_intents_v1'::regclass
    AND tgname='ca_correction_intent_immutable_v1' AND tgenabled IN('O','A')
    AND tgfoid='public.ca_correction_intent_immutable_v1()'::regprocedure AND NOT tgisinternal)
  OR NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.club_members'::regclass
    AND tgname='trg_club_members_audit_chip_movement' AND tgenabled IN('O','A')
    AND tgfoid='public.fn_club_members_ledger_writer()'::regprocedure AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'lightning_incident_original_money_owner_changed' USING ERRCODE='23514';
 END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'lightning_incident_platform_frozen' USING ERRCODE='55006';
 END IF;
 IF NOT EXISTS(SELECT FROM public.lightning_pool_session WHERE id=c_session
   AND player_id=c_user AND cluster_id=c_cluster AND state='closed'
   AND exit_reason='stop_playing' AND starting_stack=400 AND ending_stack=375
   AND net_result=-25 AND hands=14 AND normal_folds=13 AND auto_rebuy_total=0
   AND entered_at='2026-10-30T13:59:35.613142Z' AND exited_at='2026-10-30T14:10:23.790315Z')
  OR NOT EXISTS(SELECT FROM public.lightning_pool_slot WHERE id=c_slot
    AND pool_session_id=c_session AND player_id=c_user AND cluster_id=c_cluster)
  OR NOT EXISTS(SELECT FROM public.tables WHERE id=c_anchor AND cluster_id=c_cluster AND union_id=c_union)
  OR NOT EXISTS(SELECT FROM public.cash_games WHERE id=c_cluster AND union_id=c_union)
  OR NOT EXISTS(SELECT FROM public.chip_ledger WHERE id='1dc69fe7-65d8-440b-8fc8-9fe0e6be8594'
    AND from_type='player_wallet' AND from_entity_id=c_user AND to_type='table_stack'
    AND club_id=c_club AND table_id=c_anchor AND amount=400 AND status='posted') THEN
  RAISE EXCEPTION 'lightning_incident_admission_or_funding_changed' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM public.lightning_hand_player WHERE pool_slot_id=c_slot AND player_id=c_user)<>14
  OR (SELECT sum(net_result) FROM public.lightning_hand_player WHERE pool_slot_id=c_slot AND player_id=c_user) IS DISTINCT FROM -25::numeric
  OR (SELECT sum(net_result) FROM public.lightning_hand_player WHERE pool_slot_id=c_slot AND player_id=c_user AND hand_id<>'eca1f5cf-d533-4e47-a534-c84ed612633c') IS DISTINCT FROM -26::numeric
  OR (SELECT count(*) FROM public.lightning_hand_player WHERE pool_slot_id=c_slot AND player_id=c_user AND fold_type='normal')<>13
  OR EXISTS(SELECT FROM public.lightning_hand_player hp LEFT JOIN public.lightning_instance i ON i.hand_id=hp.hand_id
    WHERE hp.pool_slot_id=c_slot AND hp.player_id=c_user AND (i.state IS DISTINCT FROM 'complete' OR hp.stack_after-hp.stack_before IS DISTINCT FROM hp.net_result))
  OR NOT EXISTS(SELECT FROM public.lightning_hand_player WHERE pool_slot_id=c_slot AND player_id=c_user
    AND hand_id='eca1f5cf-d533-4e47-a534-c84ed612633c' AND stack_before=400 AND stack_after=401 AND net_result=1 AND fold_type='none') THEN
  RAISE EXCEPTION 'lightning_incident_completed_hands_changed' USING ERRCODE='23514';
 END IF;
 v_reason:='KingFish (47965354-0e56-43ef-931c-ddaab82af765) joined Midway Union NLH 1/2 Lightning in session bdacfcbf-af5d-441b-a76d-4a52dfa33688 on 2026-10-30. '
  ||'The client remained on a physical observer room without the private cards or action pill, including after reopening. The client cause is repaired in PR #8755. '
  ||'The first hand legitimately won 1 chip, taking 400 to 401, and is preserved. Thirteen later normal-fold hands lost 26 before the authorized Stop Playing closed the session at 375. '
  ||'Under CLAUDE.md 10.9 the hosting Midway Union bank pays a 26-chip house make-good into the original KINGS CLUB player wallet, not the current home-club default. '
  ||'KINGS treasury, the funded 375 anchor, all settled hands and every opponent remain unchanged. Migration '||c_mig;
 v_intent:=jsonb_build_object('version',1,'session_id',c_session,'cluster_id',c_cluster,'pool_slot_id',c_slot,
  'user_id',c_user,'source_type','union_bank','source_union_id',c_union,'destination_type','player_wallet',
  'destination_club_id',c_club,'amount',c_amount,'reason',v_reason,'migration',c_mig);
 SELECT count(*) INTO v_n FROM public.chip_ledger WHERE idempotency_key=c_key;
 IF v_n>0 THEN
  IF v_n<>1 THEN RAISE EXCEPTION 'lightning_incident_receipt_ambiguous'; END IF;
  SELECT * INTO STRICT v_leg FROM public.chip_ledger WHERE idempotency_key=c_key;
  SELECT count(*) INTO v_n FROM public.chip_transactions WHERE metadata->>'idempotency_key'=c_key;
  IF v_n<>1 THEN RAISE EXCEPTION 'lightning_incident_credit_receipt_missing'; END IF;
  SELECT * INTO STRICT v_tx FROM public.chip_transactions WHERE metadata->>'idempotency_key'=c_key;
  IF v_leg.status IS DISTINCT FROM 'posted' OR v_leg.amount IS DISTINCT FROM c_amount
   OR v_leg.category IS DISTINCT FROM 'settlement' OR v_leg.from_type IS DISTINCT FROM 'union_bank'
   OR v_leg.from_entity_id IS DISTINCT FROM c_union OR v_leg.to_type IS DISTINCT FROM 'player_wallet'
   OR v_leg.to_entity_id IS DISTINCT FROM c_user OR v_leg.club_id IS DISTINCT FROM c_club
   OR v_leg.tournament_id IS NOT NULL OR v_leg.performed_by IS DISTINCT FROM c_actor
   OR v_tx.to_user_id IS DISTINCT FROM c_user OR v_tx.club_id IS DISTINCT FROM c_club
   OR v_tx.amount IS DISTINCT FROM c_amount OR v_tx.transaction_type IS DISTINCT FROM 'chip_credit'
   OR v_tx.notes IS DISTINCT FROM v_reason OR v_tx.metadata->'intent' IS DISTINCT FROM v_intent
   OR v_tx.metadata->>'executed_by' IS DISTINCT FROM 'postgres'
   OR (v_tx.metadata->>'bank_before')::numeric-(v_tx.metadata->>'bank_after')::numeric IS DISTINCT FROM c_amount
   OR (v_tx.metadata->>'wallet_after')::numeric-(v_tx.metadata->>'wallet_before')::numeric IS DISTINCT FROM c_amount
   OR v_tx.balance_after IS DISTINCT FROM (v_tx.metadata->>'wallet_after')::numeric
   OR v_leg.correlation_id IS DISTINCT FROM (v_tx.metadata->>'adjustment_id')::uuid
   OR NOT EXISTS(SELECT FROM public.ca_manual_adjustments WHERE id=v_leg.correlation_id
     AND target_kind='player_wallet' AND target_id=c_user AND amount=c_amount AND asset='chips'
     AND status='settled' AND reason=v_reason AND decision_note='migration '||c_mig)
   OR NOT EXISTS(SELECT FROM public.ca_correction_request_intents_v1 WHERE linkage_key=c_key AND ledger_id=v_leg.id
     AND request_intent=v_intent||jsonb_build_object('adjustment_id',v_leg.correlation_id,'credit_transaction_id',v_tx.id,
      'bank_before',(v_tx.metadata->>'bank_before')::numeric,'bank_after',(v_tx.metadata->>'bank_after')::numeric,
      'wallet_before',(v_tx.metadata->>'wallet_before')::numeric,'wallet_after',(v_tx.metadata->>'wallet_after')::numeric))
   OR NOT EXISTS(SELECT FROM public.ca_op_claims WHERE op_id=c_key||':bank' AND fn_name='fn_union_debit_wallet'
     AND result->>'success'='true' AND (result->>'amount')::numeric=c_amount
     AND (result->>'balance_before')::numeric=(v_tx.metadata->>'bank_before')::numeric
     AND (result->>'balance_after')::numeric=(v_tx.metadata->>'bank_after')::numeric) THEN
   RAISE EXCEPTION 'lightning_incident_exact_receipt_changed' USING ERRCODE='23514';
  END IF;
  v_replay:=true;
 ELSE
  IF EXISTS(SELECT FROM public.ca_correction_request_intents_v1 WHERE linkage_key=c_key)
   OR EXISTS(SELECT FROM public.ca_op_claims WHERE op_id=c_key||':bank')
   OR EXISTS(SELECT FROM public.chip_transactions WHERE metadata->>'idempotency_key'=c_key)
   OR EXISTS(SELECT FROM public.ca_manual_adjustments WHERE target_id=c_user AND reason LIKE '%'||c_session::text||'%') THEN
   RAISE EXCEPTION 'lightning_incident_partial_or_other_compensation_requires_inspection';
  END IF;
  SELECT chip_balance INTO v_bank FROM public.union_wallets WHERE union_id=c_union FOR UPDATE;
  SELECT chip_balance INTO v_wallet FROM public.club_members WHERE club_id=c_club AND user_id=c_user
    AND status='active' AND role IN ('owner','co_owner','player','member') FOR NO KEY UPDATE;
  IF v_bank IS NULL OR v_bank<c_amount OR v_bank::text IN('NaN','Infinity','-Infinity')
   OR v_wallet IS NULL OR v_wallet<0 OR v_wallet::text IN('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'lightning_incident_bank_or_original_wallet_unavailable';
  END IF;
  SELECT jsonb_object_agg(k,coalesce(current_setting(k,true),'')) INTO v_saved FROM unnest(ARRAY[
   'app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_counterparty_label',
   'app.ledger_settlement','app.ledger_idempotency_key','app.ledger_correlation','app.ledger_autoskip_union_wallets',
   'app.ledger_club_id','app.ledger_hand_id','app.ledger_tournament','app.ledger_tournament_id'])k;
  v_adj:=public.fn_ca_adjustment_under_10_9(NULL,c_user,c_amount,v_reason,c_mig,'Codex: KingFish Lightning card incident');
  PERFORM public.fn_ca_declare_ledger('settlement','union_bank',c_union,NULL,c_key,ARRAY['union_wallets']);
  PERFORM set_config('app.ledger_correlation',v_adj::text,true);
  PERFORM set_config('app.ledger_club_id',c_club::text,true);
  PERFORM set_config('app.ledger_hand_id','',true); PERFORM set_config('app.ledger_tournament','',true);
  PERFORM set_config('app.ledger_tournament_id','',true);
  v_debit:=public.fn_union_debit_wallet(c_union,'chip',c_amount,'lightning_card_incident',c_club,NULL,v_reason,c_actor,c_key||':bank');
  IF v_debit->>'success' IS DISTINCT FROM 'true' OR v_debit->>'replayed'='true'
   OR (v_debit->>'balance_before')::numeric IS DISTINCT FROM v_bank
   OR (v_debit->>'balance_after')::numeric IS DISTINCT FROM v_bank-c_amount THEN
   RAISE EXCEPTION 'lightning_incident_bank_debit_unconfirmed';
  END IF;
  v_credit:=public.fn_credit_chips(c_club,c_user,c_amount,v_reason,jsonb_build_object('transaction_type','chip_credit',
   'idempotency_key',c_key,'intent',v_intent,'adjustment_id',v_adj,'executed_by',current_user,
   'bank_before',v_bank,'bank_after',v_bank-c_amount,'wallet_before',v_wallet,'wallet_after',v_wallet+c_amount));
  IF v_credit->>'success' IS DISTINCT FROM 'true' OR (v_credit->>'balance_before')::numeric IS DISTINCT FROM v_wallet
   OR (v_credit->>'balance_after')::numeric IS DISTINCT FROM v_wallet+c_amount THEN
   RAISE EXCEPTION 'lightning_incident_original_wallet_credit_unconfirmed';
  END IF;
  SELECT chip_balance INTO v_bank_after FROM public.union_wallets WHERE union_id=c_union;
  SELECT chip_balance INTO v_wallet_after FROM public.club_members WHERE club_id=c_club AND user_id=c_user;
  IF v_bank-v_bank_after IS DISTINCT FROM c_amount OR v_wallet_after-v_wallet IS DISTINCT FROM c_amount THEN
   RAISE EXCEPTION 'lightning_incident_conservation_failed';
  END IF;
  SELECT * INTO STRICT v_leg FROM public.chip_ledger WHERE idempotency_key=c_key AND status='posted'
   AND from_type='union_bank' AND from_entity_id=c_union AND to_type='player_wallet'
   AND to_entity_id=c_user AND club_id=c_club AND amount=c_amount AND category='settlement'
   AND correlation_id=v_adj AND tournament_id IS NULL AND performed_by=c_actor;
  SELECT * INTO STRICT v_tx FROM public.chip_transactions WHERE metadata->>'idempotency_key'=c_key
   AND to_user_id=c_user AND club_id=c_club AND amount=c_amount AND metadata->'intent'=v_intent;
  IF (SELECT count(*) FROM public.chip_ledger WHERE idempotency_key=c_key)<>1 THEN
   RAISE EXCEPTION 'lightning_incident_duplicate_journal';
  END IF;
  INSERT INTO public.ca_correction_request_intents_v1(linkage_key,ledger_id,request_intent)
  VALUES(c_key,v_leg.id,v_intent||jsonb_build_object('adjustment_id',v_adj,'credit_transaction_id',v_tx.id,
   'bank_before',v_bank,'bank_after',v_bank_after,'wallet_before',v_wallet,'wallet_after',v_wallet_after));
  IF NOT FOUND THEN RAISE EXCEPTION 'lightning_incident_immutable_intent_missing'; END IF;
  UPDATE public.ca_manual_adjustments SET status='settled' WHERE id=v_adj AND status='approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'lightning_incident_adjustment_transition_failed'; END IF;
  INSERT INTO public.financial_alerts(severity,source,message,context,resolved,resolved_at,resolution)
  VALUES('warning','lightning_card_incident','Lightning Missing Card Loss Settled By The House',
   jsonb_build_object('session_id',c_session,'user_id',c_user,'amount',c_amount,'source_union_id',c_union,
    'destination_club_id',c_club,'adjustment_id',v_adj,'ledger_id',v_leg.id,'chip_transaction_id',v_tx.id,
    'idempotency_key',c_key,'migration',c_mig,'initial_win_preserved',1),true,now(),v_reason);
  FOR v_setting IN SELECT jsonb_object_keys(v_saved) LOOP PERFORM set_config(v_setting,v_saved->>v_setting,true); END LOOP;
 END IF;
 -- One MCP call containing this exact DO block with this LOCAL flag must fail
 -- here. The exception rolls back the bank, credit, journal and every receipt.
 IF current_setting('ca.lightning_card_incident_probe',true)='on' THEN
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'LIGHTNING_INCIDENT_PROBE_OK rollback replay=% bank_before=% bank_after=% wallet_before=% wallet_after=% amount=% ledger=%',
   v_replay,v_bank,v_bank_after,v_wallet,v_wallet_after,c_amount,v_leg.id;
 END IF;
END $settle$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
