-- Rollback-only normal cash proof. Opening custody/standings are synthetic;
-- every paid-before amount and later credit uses the actual owner-only payer.
-- Claims, terminal completion, receipts, and seat capabilities are real.
-- @FINAL_DEAL_RUNTIME@
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
 'id','98020000-0000-0000-0000-000000000001','tournament_id','98010000-0000-0000-0000-000000000001',
 'club_id','20000000-0000-0000-0000-000000000001',
 'table_id','98030000-0000-0000-0000-000000000001','seat_number',1,
 'chips',10,'status','playing','position',NULL,'prize',0,
 'eliminated_at',NULL,'elimination_sequence',NULL))).*
FROM public.tournament_players t WHERE id='31000000-0000-0000-0000-000000000001';
INSERT INTO public.tournament_players
SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(t)||jsonb_build_object(
 'id','98020000-0000-0000-0000-000000000002','tournament_id','98010000-0000-0000-0000-000000000001',
 'user_id','10000000-0000-0000-0000-000000000002','username','Canonical Bubble user',
 'club_id','20000000-0000-0000-0000-000000000001','table_id',NULL,'seat_number',NULL,'prize',0,
 'chips',0,'status','eliminated','position',2,'elimination_sequence',1,'eliminated_at',transaction_timestamp()))).*
FROM public.tournament_players t WHERE id='31000000-0000-0000-0000-000000000001';
INSERT INTO public.tournament_escrow
SELECT (jsonb_populate_record(NULL::public.tournament_escrow,to_jsonb(t)||jsonb_build_object(
 'tournament_id','98010000-0000-0000-0000-000000000001','opened_from','canonical-bubble-native-proof'))).*
FROM public.tournament_escrow t WHERE tournament_id='30000000-0000-0000-0000-000000000001';
INSERT INTO public.tables
 (id,name,tournament_id,status,lifecycle,current_players,game_type,club_id)
VALUES ('98030000-0000-0000-0000-000000000001','Canonical Bubble terminal table',
 '98010000-0000-0000-0000-000000000001','running','live',1,
 'tournament','20000000-0000-0000-0000-000000000001');
INSERT INTO public.table_seats
 (id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,is_sitting_out,club_id)
VALUES ('98040000-0000-0000-0000-000000000001','98030000-0000-0000-0000-000000000001',1,
 '10000000-0000-0000-0000-000000000001',10,'active',NULL,false,false,
 '20000000-0000-0000-0000-000000000001');
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
-- Observe real capability rows without authorizing any seat ourselves.
CREATE TEMP TABLE native_bubble_terminal_expected_seats ON COMMIT DROP AS
SELECT s.id AS seat_id,s.user_id,t.tournament_id
FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
WHERE t.tournament_id='98010000-0000-0000-0000-000000000001' AND s.left_at IS NULL;
CREATE TEMP TABLE native_bubble_terminal_authority_events (
 action text NOT NULL, capability jsonb NOT NULL
) ON COMMIT DROP;
CREATE FUNCTION pg_temp.bubble_terminal_authority_observer() RETURNS trigger
LANGUAGE plpgsql AS $observer$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.tournament_id='98010000-0000-0000-0000-000000000001' THEN
   INSERT INTO native_bubble_terminal_authority_events VALUES ('INSERT',to_jsonb(NEW));
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.tournament_id='98010000-0000-0000-0000-000000000001' THEN
  INSERT INTO native_bubble_terminal_authority_events VALUES ('DELETE',to_jsonb(OLD));
 END IF;
 RETURN OLD;
END $observer$;
CREATE TRIGGER native_bubble_terminal_authority_observer
AFTER INSERT OR DELETE ON public.tournament_seat_exit_authorizations
FOR EACH ROW EXECUTE FUNCTION pg_temp.bubble_terminal_authority_observer();

CREATE FUNCTION pg_temp.assert_bubble_terminal_authority() RETURNS void
LANGUAGE plpgsql AS $assert_authority$
BEGIN
 IF (SELECT count(*) FROM native_bubble_terminal_authority_events WHERE action='INSERT')<>(SELECT count(*) FROM native_bubble_terminal_expected_seats)
  OR (SELECT count(*) FROM native_bubble_terminal_authority_events WHERE action='DELETE')<>(SELECT count(*) FROM native_bubble_terminal_expected_seats)
  OR (SELECT count(DISTINCT capability->>'token') FROM native_bubble_terminal_authority_events)<>LEAST((SELECT count(*) FROM native_bubble_terminal_expected_seats),1)
  OR EXISTS(SELECT 1 FROM native_bubble_terminal_authority_events e
   WHERE e.capability->>'operation'<>'terminal_finish'
    OR e.capability->>'tournament_id'<>'98010000-0000-0000-0000-000000000001'
    OR NOT EXISTS(SELECT 1 FROM native_bubble_terminal_expected_seats s
      WHERE s.seat_id=(e.capability->>'seat_id')::uuid
       AND s.user_id=(e.capability->>'user_id')::uuid
       AND s.tournament_id=(e.capability->>'tournament_id')::uuid))
  OR EXISTS(SELECT capability FROM native_bubble_terminal_authority_events WHERE action='INSERT'
            EXCEPT ALL SELECT capability FROM native_bubble_terminal_authority_events WHERE action='DELETE')
  OR EXISTS(SELECT 1 FROM public.tournament_seat_exit_authorizations
            WHERE tournament_id='98010000-0000-0000-0000-000000000001')
 THEN RAISE EXCEPTION 'FAIL exact per-seat authority rows were not minted and consumed'; END IF;
END $assert_authority$;



CREATE FUNCTION pg_temp.bubble_terminal_state() RETURNS jsonb LANGUAGE plpgsql AS $state$
DECLARE result jsonb:='{}'::jsonb; item jsonb; table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['tournaments','tournament_players','tables','table_seats',
 'clubs','club_wallets','union_wallets','club_members','wallets','wallet_transactions','wallet_credit_idempotency','chip_ledger',
 'tournament_escrow','tournament_obligations','tournament_payouts',
 'tournament_place_settlement_batches','tournament_final_table_deal_batches','tournament_final_table_deal_receipts',
 'tournament_finish_receipts','tournament_terminal_settlements',
 'tournament_rake_settlements','rake_records','rake_attributions','agent_commissions',
 'player_stats','vip_points_carry','tournament_seat_exit_authorizations',
 'tournament_deal_reviews','tournament_deal_proposals','tournament_deal_proposal_consents',
 'tournament_deal_proposal_executions']
 LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM public.%I t',table_name) INTO item;
  result:=result||jsonb_build_object(table_name,item);
 END LOOP;
 RETURN result||jsonb_build_object('observed_seat_authority',
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)
   FROM native_bubble_terminal_authority_events t));
END $state$;

CREATE FUNCTION pg_temp.assert_bubble_completed() RETURNS void LANGUAGE plpgsql AS $complete$
DECLARE tid uuid:='98010000-0000-0000-0000-000000000001';
 v_paid numeric:=(SELECT paid FROM native_bubble_initial);
BEGIN
 PERFORM pg_temp.bubble_assert((SELECT status::text='COMPLETED' AND ended_at IS NOT NULL
  FROM public.tournaments WHERE id=tid),'real Bubble terminal lifecycle completes');
 PERFORM pg_temp.bubble_assert((SELECT count(*) FROM public.tournament_finish_receipts WHERE tournament_id=tid)=1
  AND (SELECT count(*) FROM public.tournament_terminal_settlements WHERE tournament_id=tid)=1,
  'one genuine finish claim and one immutable terminal settlement exist');
 PERFORM pg_temp.bubble_assert(
  (SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id=tid AND position=1)=9
  AND (SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id=tid AND source='bubble_protection')=1
  AND (SELECT sum(amount) FROM public.wallet_transactions WHERE related_entity_id=tid AND type='credit')=10,
  'exact 9.00 place plus 1.00 Bubble uses actual payout and wallet evidence');
 PERFORM pg_temp.bubble_assert(EXISTS(SELECT 1 FROM public.tournament_place_settlement_batches b
  JOIN public.tournament_obligations o ON o.id=b.bubble_obligation_id
  WHERE b.tournament_id=tid AND b.contract_version=2
   AND b.settled_at IS NOT NULL AND b.amount_owed=9 AND b.place_count=1
   AND b.bubble_amount_owed=1 AND b.bubble_amount_paid_before=v_paid
   AND b.escrow_required=10-v_paid AND b.escrow_available=10-v_paid
   AND b.bubble_source='engine.fn_settle_tournament_bubble_protection'
   AND b.bubble_source IS NOT DISTINCT FROM o.source
   AND o.user_id='10000000-0000-0000-0000-000000000002' AND o.amount_paid=1),
  'immutable batch records canonical Bubble source and exact paid-before funding');
 PERFORM pg_temp.bubble_assert(
  (public.fn_ca_verify_terminal_place_batch(tid,true)->>'ok')='true',
  'canonical batch verifies actual money and terminal closure');
 PERFORM pg_temp.bubble_assert(NOT EXISTS(SELECT 1 FROM public.tournament_obligations
  WHERE tournament_id=tid AND (amount_paid IS DISTINCT FROM amount_owed OR settled_at IS NULL)),
  'every obligation is fully paid with settlement evidence');
 PERFORM pg_temp.bubble_assert((SELECT prize_balance=0 AND bounty_balance=0 AND fee_balance=0
  AND closed_at IS NOT NULL AND close_note='terminal receipt: exact zero'
  FROM public.tournament_escrow WHERE tournament_id=tid),
  'prize, bounty and fee escrow close at exact zero');
 PERFORM pg_temp.bubble_assert((SELECT count(*) FROM public.tables WHERE tournament_id=tid
  AND status='closed' AND lifecycle='closed' AND current_players=0 AND terminal_closed_at IS NOT NULL)=1
  AND (SELECT count(*) FROM public.table_seats WHERE table_id='98030000-0000-0000-0000-000000000001')=1
  AND NOT EXISTS(SELECT 1 FROM public.table_seats WHERE table_id='98030000-0000-0000-0000-000000000001'
   AND (left_at IS NULL OR status<>'left')),'the actual winner seat and tournament table close');
 PERFORM pg_temp.assert_bubble_terminal_authority();
 PERFORM pg_temp.bubble_assert((SELECT count(*) FROM native_bubble_terminal_expected_seats)=1,
  'one actual live seat receives and consumes exact terminal exit authority');
END $complete$;

CREATE FUNCTION pg_temp.bubble_terminal_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
 IF NEW.tournament_id='98010000-0000-0000-0000-000000000001' THEN
  PERFORM pg_temp.assert_bubble_completed();
  RAISE EXCEPTION 'expected final Bubble terminal receipt fault' USING ERRCODE='ZX006';
 END IF;
 RETURN NEW;
END $fault$;
CREATE TRIGGER native_bubble_terminal_receipt_fault AFTER INSERT ON public.tournament_terminal_settlements
FOR EACH ROW EXECUTE FUNCTION pg_temp.bubble_terminal_receipt_fault();
DO $rollback$
DECLARE before_state jsonb:=pg_temp.bubble_terminal_state(); refused boolean:=false;
BEGIN
 BEGIN
  PERFORM public.fn_complete_tournament_terminal('98010000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001','places');
 EXCEPTION WHEN SQLSTATE 'ZX006' THEN refused:=true;
 END;
 PERFORM pg_temp.bubble_assert(refused,
  'late fault reaches the actual terminal receipt after money and closure');
 PERFORM pg_temp.bubble_assert(pg_temp.bubble_terminal_state() IS NOT DISTINCT FROM before_state,
  'late receipt failure rolls back every payment, batch, capability and lifecycle row');
END $rollback$;
DROP TRIGGER native_bubble_terminal_receipt_fault ON public.tournament_terminal_settlements;

CREATE TEMP TABLE native_bubble_terminal_result(receipt jsonb) ON COMMIT DROP;
DO $settle$
DECLARE result jsonb; replay jsonb; outcome jsonb; before_state jsonb; previous_timezone text;
BEGIN
 result:=public.fn_complete_tournament_terminal('98010000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001','places');
 PERFORM pg_temp.bubble_assert(result->>'ok'='true' AND result->>'fully_settled'='true'
  AND result->>'status'='COMPLETED','actual terminal authority returns one completed Bubble receipt');
 PERFORM pg_temp.assert_bubble_completed();
 PERFORM pg_temp.bubble_assert(
  COALESCE(current_setting('app.tournament_seat_exit_token',true),'')=''
  AND COALESCE(current_setting('app.tournament_seat_exit_operation',true),'')='',
  'terminal wrapper restores prior seat capability settings');
 before_state:=pg_temp.bubble_terminal_state();
 replay:=public.fn_complete_tournament_terminal('98010000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001','places');
 outcome:=public.fn_resolve_tournament_terminal_outcome('98010000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001','places');
 PERFORM pg_temp.bubble_assert(replay IS NOT DISTINCT FROM result
  AND outcome->>'terminal_committed'='true' AND outcome->>'definitively_not_committed'='false'
  AND outcome->'receipt' IS NOT DISTINCT FROM result
  AND pg_temp.bubble_terminal_state() IS NOT DISTINCT FROM before_state,
  'lost-response replay and serialized resolver preserve every row and exact receipt');
 previous_timezone:=current_setting('TimeZone');
 PERFORM set_config('TimeZone',CASE WHEN previous_timezone='UTC' THEN 'America/Chicago' ELSE 'UTC' END,true);
 PERFORM public.fn_ca_verify_terminal_place_batch('98010000-0000-0000-0000-000000000001',true);
 PERFORM set_config('TimeZone',previous_timezone,true);
 PERFORM pg_temp.bubble_assert(pg_temp.bubble_terminal_state() IS NOT DISTINCT FROM before_state,
  'terminal money proof remains valid across session timezones');
 INSERT INTO native_bubble_terminal_result VALUES(result);
END $settle$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.bubble_assert(true,'all deferred constraints forced before rollback');
SELECT 'BUBBLE_NATIVE_EVIDENCE=' || jsonb_build_object(
 'state',(SELECT state FROM native_bubble_initial),
 'initial_bubble_paid',(SELECT paid FROM native_bubble_initial),
 'initial_bubble_source',(SELECT source FROM native_bubble_initial),
 'status',(SELECT status FROM public.tournaments WHERE id='98010000-0000-0000-0000-000000000001'),
 'receipt',(SELECT receipt FROM native_bubble_terminal_result),
 'place_total',(SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id='98010000-0000-0000-0000-000000000001' AND position=1),
 'bubble_total',(SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id='98010000-0000-0000-0000-000000000001' AND source='bubble_protection'),
 'wallet_total',(SELECT sum(amount) FROM public.wallet_transactions WHERE related_entity_id='98010000-0000-0000-0000-000000000001' AND type='credit'),
 'batch',(SELECT to_jsonb(b) FROM public.tournament_place_settlement_batches b WHERE tournament_id='98010000-0000-0000-0000-000000000001'),
 'null_refusals',(SELECT jsonb_agg(to_jsonb(r) ORDER BY field) FROM native_bubble_refusals r),
 'expected_seats',(SELECT count(*) FROM native_bubble_terminal_expected_seats),
 'authority_inserts',(SELECT count(*) FROM native_bubble_terminal_authority_events WHERE action='INSERT'),
 'authority_deletes',(SELECT count(*) FROM native_bubble_terminal_authority_events WHERE action='DELETE'),
 'assertions',(SELECT jsonb_agg(label ORDER BY id) FROM native_bubble_checks),
 'assertion_count',(SELECT count(*) FROM native_bubble_checks),
 'deferred_constraints_checked',true)::text;
ROLLBACK;
