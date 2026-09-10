-- Rollback-only normal cash proof. Opening custody/standings are synthetic;
-- every paid-before amount and later credit uses the actual owner-only payer.
CREATE TEMP TABLE native_bubble_checks(id integer GENERATED ALWAYS AS IDENTITY,label text NOT NULL) ON COMMIT DROP;
CREATE FUNCTION pg_temp.bubble_assert(p_ok boolean,p_label text) RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
 IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',p_label; END IF;
 INSERT INTO native_bubble_checks(label) VALUES(p_label);
 RAISE NOTICE 'PASS %',p_label;
END $assert$;
DO $guard$
BEGIN
 PERFORM pg_temp.bubble_assert(current_user='postgres'
  AND NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id='98010000-0000-0000-0000-000000000001')
  AND EXISTS(SELECT 1 FROM public.tournaments WHERE id='30000000-0000-0000-0000-000000000001'),
  'owned reusable baseline and unused synthetic event');
 PERFORM pg_temp.bubble_assert(NOT EXISTS(SELECT 1 FROM unnest(ARRAY[
  'aa_guard_tournament_completing_claim','aaa_guard_atomic_satellite_completion',
  'zzzz_freeze_finalized_tournament_prize_pool','zzzz_tournament_pool_finalization_window_guard',
  'zzzz_tournaments_atomic_place_completion_guard','zzzzz_tournaments_atomic_final_table_deal_completion_guard',
  'zzzzzz_tournaments_financial_certificate']) names(name)
  WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass
   AND tgname=names.name AND tgenabled='O')), 'all seven financial guards active');
END $guard$;
SET LOCAL session_replication_role=replica;
INSERT INTO public.profiles
SELECT (jsonb_populate_record(NULL::public.profiles,to_jsonb(p)||jsonb_build_object(
 'id','10000000-0000-0000-0000-000000000002','username','canonical_bubble_native_user'))).*
FROM public.profiles p WHERE p.id='10000000-0000-0000-0000-000000000001'
 AND NOT EXISTS(SELECT 1 FROM public.profiles WHERE id='10000000-0000-0000-0000-000000000002');
INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object(
 'id','98010000-0000-0000-0000-000000000001','name','Canonical Bubble native proof',
 'buy_in_amount',1,'bubble_protection',true,'prize_pool',10,'prize_pool_finalized',true,
 'status','RUNNING','current_players',1,'synchronized_breaks',false,'on_break',false))).*
FROM public.tournaments t WHERE id='30000000-0000-0000-0000-000000000001';
INSERT INTO public.tournament_players
SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(t)||jsonb_build_object(
 'id','98020000-0000-0000-0000-000000000001','tournament_id','98010000-0000-0000-0000-000000000001'))).*
FROM public.tournament_players t WHERE id='31000000-0000-0000-0000-000000000001';
INSERT INTO public.tournament_players
SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(t)||jsonb_build_object(
 'id','98020000-0000-0000-0000-000000000002','tournament_id','98010000-0000-0000-0000-000000000001',
 'user_id','10000000-0000-0000-0000-000000000002','username','Canonical Bubble user',
 'chips',0,'status','eliminated','position',2,'elimination_sequence',1,'eliminated_at',transaction_timestamp()))).*
FROM public.tournament_players t WHERE id='31000000-0000-0000-0000-000000000001';
INSERT INTO public.tournament_escrow
SELECT (jsonb_populate_record(NULL::public.tournament_escrow,to_jsonb(t)||jsonb_build_object(
 'tournament_id','98010000-0000-0000-0000-000000000001','opened_from','canonical-bubble-native-proof'))).*
FROM public.tournament_escrow t WHERE tournament_id='30000000-0000-0000-0000-000000000001';
SET LOCAL session_replication_role=origin;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
CREATE TEMP TABLE native_bubble_initial ON COMMIT DROP AS
SELECT '@BUBBLE_STATE@'::text AS state,@BUBBLE_INITIAL_AMOUNT@::numeric AS paid,NULL::text AS source;
CREATE FUNCTION pg_temp.bubble_money_state() RETURNS jsonb LANGUAGE sql AS $state$
SELECT jsonb_build_object(
 'event',(SELECT to_jsonb(t) FROM public.tournaments t WHERE id='98010000-0000-0000-0000-000000000001'),
 'players',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_players t WHERE tournament_id='98010000-0000-0000-0000-000000000001'),
 'escrow',(SELECT to_jsonb(t) FROM public.tournament_escrow t WHERE tournament_id='98010000-0000-0000-0000-000000000001'),
 'batch',(SELECT to_jsonb(t) FROM public.tournament_place_settlement_batches t WHERE tournament_id='98010000-0000-0000-0000-000000000001'),
 'obligations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_obligations t WHERE tournament_id='98010000-0000-0000-0000-000000000001'),
 'payouts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_payouts t WHERE tournament_id='98010000-0000-0000-0000-000000000001'),
 'wallet_keys',(SELECT jsonb_agg(to_jsonb(t) ORDER BY key) FROM public.wallet_credit_idempotency t WHERE key LIKE 'tourney:98010000-0000-0000-0000-000000000001:%'),
 'wallet_journal',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.wallet_transactions t WHERE related_entity_id='98010000-0000-0000-0000-000000000001'),
 'chip_ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.chip_ledger t WHERE tournament_id='98010000-0000-0000-0000-000000000001'),
 'wallets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.wallets t),
 'club_members',(SELECT jsonb_agg(to_jsonb(t) ORDER BY club_id,user_id) FROM public.club_members t),
 'club_wallets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY club_id) FROM public.club_wallets t),
 'finish',(SELECT to_jsonb(t) FROM public.tournament_finish_receipts t WHERE tournament_id='98010000-0000-0000-0000-000000000001'));
$state$;
DO $initial$
DECLARE v_result jsonb; v_paid numeric:=(SELECT paid FROM native_bubble_initial);
BEGIN
 PERFORM pg_temp.bubble_assert(current_setting('session_replication_role')='origin','all payments run with native triggers active');
 v_result:=public.fn_claim_tournament_finish('98010000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001','native-canonical-bubble-proof');
 PERFORM pg_temp.bubble_assert(v_result->>'ok'='true' AND v_result->>'status'='COMPLETING','genuine finish claim admits the cash winner');
 INSERT INTO public.tournament_obligations(tournament_id,kind,place,user_id,amount_owed,amount_paid,source)
 VALUES('98010000-0000-0000-0000-000000000001','bubble_protection',NULL,
  '10000000-0000-0000-0000-000000000002',1,0,'engine.fn_settle_tournament_places');
 IF v_paid>0 THEN
  v_result:=public.fn_settle_tournament_obligation_before_atomic_batch_gate(
   '98010000-0000-0000-0000-000000000001','bubble_protection',NULL,
   '10000000-0000-0000-0000-000000000002',v_paid,
   'engine.fn_settle_tournament_bubble_protection',NULL,NULL);
  PERFORM pg_temp.bubble_assert(v_result->>'ok'='true' AND (v_result->>'paid')::numeric=v_paid,
   'paid-before fixture uses the actual native payer and credit journals');
 END IF;
 PERFORM pg_temp.bubble_assert(
  (SELECT amount_paid FROM public.tournament_obligations WHERE tournament_id='98010000-0000-0000-0000-000000000001')=v_paid
  AND (SELECT amount_owed FROM public.tournament_obligations WHERE tournament_id='98010000-0000-0000-0000-000000000001')=1
  AND (SELECT COALESCE(sum(amount),0) FROM public.tournament_payouts WHERE tournament_id='98010000-0000-0000-0000-000000000001')=v_paid
  AND (SELECT prize_balance FROM public.tournament_escrow WHERE tournament_id='98010000-0000-0000-0000-000000000001')=10-v_paid,
  'initial unpaid/partial/paid Bubble amount exactly matches native evidence and custody');
 UPDATE native_bubble_initial SET source=(SELECT source FROM public.tournament_obligations
  WHERE tournament_id='98010000-0000-0000-0000-000000000001' AND kind='bubble_protection');
END $initial$;
CREATE TEMP TABLE native_bubble_refusals(field text,message text,sqlstate text,constraint_name text,refusal_layer text) ON COMMIT DROP;
DO $null_evidence$
DECLARE v_field text; v_before jsonb; v_error text; v_result jsonb; v_code text; v_constraint text;
BEGIN
 FOREACH v_field IN ARRAY ARRAY['source','user_id'] LOOP
  v_before:=pg_temp.bubble_money_state();
  BEGIN
   -- Real paid Bubble first: an already-paid replay cannot repair missing
   -- source by making another credit. All of this adversarial branch rolls back.
   v_result:=public.fn_settle_tournament_obligation_before_atomic_batch_gate(
    '98010000-0000-0000-0000-000000000001','bubble_protection',NULL,
    '10000000-0000-0000-0000-000000000002',1,
    'engine.fn_settle_tournament_bubble_protection',NULL,NULL);
   IF v_result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'negative fixture payment failed'; END IF;
   EXECUTE format('UPDATE public.tournament_obligations SET %I=NULL WHERE tournament_id=$1 AND kind=''bubble_protection''',v_field)
    USING '98010000-0000-0000-0000-000000000001'::uuid;
   PERFORM public.fn_settle_tournament_places('98010000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001');
   RAISE EXCEPTION 'NULL Bubble evidence unexpectedly accepted' USING ERRCODE='ZXN01';
  EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
   IF SQLSTATE='ZXN01' OR (lower(SQLERRM) NOT LIKE '%bubble%'
     AND NOT (SQLSTATE='23514' AND ((v_field='source'
       AND v_constraint='tournament_place_settlement_batches_check1') OR (v_field='user_id'
       AND v_constraint='tournament_obligations_check1')))) THEN RAISE; END IF;
   v_error:=SQLERRM; v_code:=SQLSTATE;
  END;
  PERFORM pg_temp.bubble_assert(pg_temp.bubble_money_state() IS NOT DISTINCT FROM v_before,
   'NULL Bubble '||v_field||' refuses with exact money, batch and custody rollback');
  INSERT INTO native_bubble_refusals VALUES(v_field,v_error,v_code,v_constraint,
   CASE WHEN v_constraint='tournament_place_settlement_batches_check1' THEN 'existing_batch_constraint'
    WHEN v_constraint='tournament_obligations_check1' THEN 'existing_obligation_constraint'
    WHEN v_error LIKE 'canonical terminal batch%' THEN 'new_canonical_verifier'
    ELSE 'existing_cash_authority' END);
 END LOOP;
END $null_evidence$;
DO $settle$
DECLARE v_result jsonb; v_replay jsonb; v_before jsonb; v_paid numeric:=(SELECT paid FROM native_bubble_initial);
BEGIN
 v_result:=public.fn_settle_tournament_places('98010000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001');
 PERFORM pg_temp.bubble_assert(v_result->>'ok'='true'
  AND (SELECT status FROM public.tournaments WHERE id='98010000-0000-0000-0000-000000000001')='COMPLETING'
  AND (SELECT prize_balance FROM public.tournament_escrow WHERE tournament_id='98010000-0000-0000-0000-000000000001')=0,
  'real normal cash authority succeeds at COMPLETING with zero prize escrow');
 PERFORM pg_temp.bubble_assert(
  (SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id='98010000-0000-0000-0000-000000000001' AND position=1)=9
  AND (SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id='98010000-0000-0000-0000-000000000001' AND source='bubble_protection')=1
  AND (SELECT sum(amount) FROM public.wallet_transactions WHERE related_entity_id='98010000-0000-0000-0000-000000000001' AND type='credit')=10,
  'exact 9.00 place plus 1.00 Bubble uses native payout and wallet evidence');
 PERFORM pg_temp.bubble_assert(EXISTS(SELECT 1 FROM public.tournament_place_settlement_batches b
  JOIN public.tournament_obligations o ON o.id=b.bubble_obligation_id
  WHERE b.tournament_id='98010000-0000-0000-0000-000000000001' AND b.contract_version=2
   AND b.settled_at IS NOT NULL AND b.amount_owed=9 AND b.place_count=1
   AND b.bubble_amount_owed=1 AND b.bubble_amount_paid_before=v_paid
   AND b.escrow_required=10-v_paid AND b.escrow_available=10-v_paid
   AND b.bubble_source='engine.fn_settle_tournament_bubble_protection'
   AND b.bubble_source IS NOT DISTINCT FROM o.source
   AND o.user_id='10000000-0000-0000-0000-000000000002' AND o.amount_paid=1),
  'immutable batch records refreshed canonical Bubble source and unchanged paid-before funding');
 PERFORM pg_temp.bubble_assert(
  (public.fn_ca_verify_terminal_place_batch('98010000-0000-0000-0000-000000000001',false)->>'ok')='true',
  'new canonical batch passes complete actual-money verifier');
 v_before:=pg_temp.bubble_money_state();
 v_replay:=public.fn_settle_tournament_places('98010000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001');
 PERFORM pg_temp.bubble_assert(v_replay->>'ok'='true' AND pg_temp.bubble_money_state() IS NOT DISTINCT FROM v_before,
  'settled-batch COMPLETING replay preserves every observed row without extra credit');
END $settle$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.bubble_assert(true,'all deferred constraints forced before rollback');
SELECT 'NATIVE_BUBBLE_EVIDENCE=' || jsonb_build_object(
 'state',(SELECT state FROM native_bubble_initial),'initial_bubble_paid',(SELECT paid FROM native_bubble_initial),'initial_bubble_source',(SELECT source FROM native_bubble_initial),
 'status',(SELECT status FROM public.tournaments WHERE id='98010000-0000-0000-0000-000000000001'),
 'place_total',(SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id='98010000-0000-0000-0000-000000000001' AND position=1),
 'bubble_total',(SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id='98010000-0000-0000-0000-000000000001' AND source='bubble_protection'),
 'wallet_total',(SELECT sum(amount) FROM public.wallet_transactions WHERE related_entity_id='98010000-0000-0000-0000-000000000001' AND type='credit'),
 'batch',(SELECT to_jsonb(b) FROM public.tournament_place_settlement_batches b WHERE tournament_id='98010000-0000-0000-0000-000000000001'),
 'null_refusals',(SELECT jsonb_agg(to_jsonb(r) ORDER BY field) FROM native_bubble_refusals r),
 'assertions',(SELECT jsonb_agg(label ORDER BY id) FROM native_bubble_checks),
 'assertion_count',(SELECT count(*) FROM native_bubble_checks))::text;
DO $pass$ BEGIN RAISE EXCEPTION 'AUDIT_TEST_PASS: canonical Bubble cash paid-before, refreshed batch source, NULL refusal and immutable replay passed; outer transaction rolls back'; END $pass$;
