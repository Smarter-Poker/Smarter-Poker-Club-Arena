BEGIN;
-- Real canonical final-deal terminal acceptance in a rollback-only local transaction.
-- Opening balances and a completed prior fixed-place payment are synthetic fixtures.
-- Claims, new payments, batches, receipts, lifecycle, and seat capabilities are real.


CREATE FUNCTION pg_temp.deal_assert(ok boolean, label text) RETURNS void
LANGUAGE plpgsql AS $assert$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
 RAISE NOTICE 'PASS %',label;
END $assert$;

CREATE TEMP TABLE native_deal_request(proposal_id uuid, revision text, review_id uuid);
DO $consent$
DECLARE tid uuid:='87000000-0000-0000-0000-000000000001'; r jsonb; p jsonb; review jsonb; i integer;
BEGIN
 PERFORM pg_temp.deal_assert(current_setting('session_replication_role')='origin','native triggers enabled before consent or payment');
 r:=public.fn_settle_tournament_obligation(tid,'refund',NULL,md5('atomic-deal-user:1')::uuid,
  1,'native-refund-boundary',NULL,NULL);
 PERFORM pg_temp.deal_assert(r->>'ok'='false' AND r->>'refused_reason'='exact_refund_authority_required',
  'existing exact refund authority refusal survives the strict public wrapper');
 PERFORM set_config('request.jwt.claim.sub',md5('atomic-deal-user:1')::uuid::text,true);
 review:=public.fn_request_tournament_deal_review(tid,auth.uid());
 PERFORM pg_temp.deal_assert(review->>'state'='requested','real participant requests deal review');
 PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
 PERFORM set_config('app.smarter_manager_request_fenced','protocol-2',true);
 PERFORM set_config('app.smarter_tournament_id',tid::text,true);
 PERFORM set_config('app.smarter_tournament_lease_generation','87900000-0000-0000-0000-000000000001',true);
 r:=public.fn_begin_tournament_deal_review(tid,(review->>'review_id')::uuid);
 PERFORM pg_temp.deal_assert(r->>'review_state'='reviewing','current manager begins bounded parked-hand review');
 p:=public.fn_get_tournament_deal_proposal(tid);
 PERFORM pg_temp.deal_assert(p->>'ok'='true' AND p->>'pool_cents'='10000'
   AND p->>'deal_cents'='9500'
   AND (SELECT sum((x->>'amount_cents')::bigint) FROM jsonb_array_elements(p->'shares')x)=9500,
   'immutable reviewed recipient shares conserve the exact available pool');
 FOR i IN 1..5 LOOP
  PERFORM set_config('request.jwt.claim.sub',md5('atomic-deal-user:'||i)::uuid::text,true);
  r:=public.fn_cast_tournament_deal_vote(tid,(p->>'proposal_id')::uuid,auth.uid());
  PERFORM pg_temp.deal_assert(r->>'ok'='true','real participant '||i||' consents to exact proposal');
 END LOOP;
 r:=public.fn_get_tournament_deal_consensus(tid);
 PERFORM pg_temp.deal_assert(r->>'ready'='true' AND r->>'proposal_id'=p->>'proposal_id'
   AND r->>'revision'=p->>'revision' AND jsonb_array_length(r->'voter_ids')=5,
   'all five current participants have exact unanimous consent');
 INSERT INTO native_deal_request VALUES((p->>'proposal_id')::uuid,p->>'revision',(review->>'review_id')::uuid);
END $consent$;

-- Observe real capability rows without authorizing any seat ourselves.
CREATE TEMP TABLE native_deal_terminal_expected_seats ON COMMIT DROP AS
SELECT s.id AS seat_id,s.user_id,t.tournament_id
FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
WHERE t.tournament_id='87000000-0000-0000-0000-000000000001' AND s.left_at IS NULL;
CREATE TEMP TABLE native_deal_terminal_authority_events (
 action text NOT NULL, capability jsonb NOT NULL
) ON COMMIT DROP;
CREATE FUNCTION pg_temp.deal_terminal_authority_observer() RETURNS trigger
LANGUAGE plpgsql AS $observer$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.tournament_id='87000000-0000-0000-0000-000000000001' THEN
   INSERT INTO native_deal_terminal_authority_events VALUES ('INSERT',to_jsonb(NEW));
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.tournament_id='87000000-0000-0000-0000-000000000001' THEN
  INSERT INTO native_deal_terminal_authority_events VALUES ('DELETE',to_jsonb(OLD));
 END IF;
 RETURN OLD;
END $observer$;
CREATE TRIGGER native_deal_terminal_authority_observer
AFTER INSERT OR DELETE ON public.tournament_seat_exit_authorizations
FOR EACH ROW EXECUTE FUNCTION pg_temp.deal_terminal_authority_observer();

CREATE FUNCTION pg_temp.assert_deal_terminal_authority() RETURNS void
LANGUAGE plpgsql AS $assert_authority$
BEGIN
 IF (SELECT count(*) FROM native_deal_terminal_authority_events WHERE action='INSERT')<>(SELECT count(*) FROM native_deal_terminal_expected_seats)
  OR (SELECT count(*) FROM native_deal_terminal_authority_events WHERE action='DELETE')<>(SELECT count(*) FROM native_deal_terminal_expected_seats)
  OR (SELECT count(DISTINCT capability->>'token') FROM native_deal_terminal_authority_events)<>LEAST((SELECT count(*) FROM native_deal_terminal_expected_seats),1)
  OR EXISTS(SELECT 1 FROM native_deal_terminal_authority_events e
   WHERE e.capability->>'operation'<>'terminal_finish'
    OR e.capability->>'tournament_id'<>'87000000-0000-0000-0000-000000000001'
    OR NOT EXISTS(SELECT 1 FROM native_deal_terminal_expected_seats s
      WHERE s.seat_id=(e.capability->>'seat_id')::uuid
       AND s.user_id=(e.capability->>'user_id')::uuid
       AND s.tournament_id=(e.capability->>'tournament_id')::uuid))
  OR EXISTS(SELECT capability FROM native_deal_terminal_authority_events WHERE action='INSERT'
            EXCEPT ALL SELECT capability FROM native_deal_terminal_authority_events WHERE action='DELETE')
  OR EXISTS(SELECT 1 FROM public.tournament_seat_exit_authorizations
            WHERE tournament_id='87000000-0000-0000-0000-000000000001')
 THEN RAISE EXCEPTION 'FAIL exact per-seat authority rows were not minted and consumed'; END IF;
END $assert_authority$;



CREATE FUNCTION pg_temp.final_deal_exact_state() RETURNS jsonb LANGUAGE plpgsql AS $state$
DECLARE result jsonb:='{}'::jsonb; item jsonb; table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['tournaments','tournament_players','tables','table_seats',
 'club_members','wallets','wallet_transactions','wallet_credit_idempotency','chip_ledger',
 'tournament_escrow','tournament_obligations','tournament_payouts',
 'tournament_final_table_deal_batches','tournament_final_table_deal_receipts',
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
   FROM native_deal_terminal_authority_events t));
END $state$;

CREATE FUNCTION pg_temp.assert_final_deal_completed() RETURNS void LANGUAGE plpgsql AS $complete$
DECLARE tid uuid:='87000000-0000-0000-0000-000000000001'; v jsonb;
BEGIN
 PERFORM pg_temp.deal_assert((SELECT status::text='COMPLETED' AND ended_at IS NOT NULL
  FROM public.tournaments WHERE id=tid),'native terminal lifecycle completes');
 PERFORM pg_temp.deal_assert((SELECT count(*) FROM public.tournament_finish_receipts WHERE tournament_id=tid)=1,
  'real immutable finish claim exists');
 PERFORM pg_temp.deal_assert((SELECT count(*) FROM public.tournament_final_table_deal_batches
  WHERE tournament_id=tid AND contract_version=2 AND settled_at IS NOT NULL)=1,
  'canonical writer creates exactly one settled version two batch');
 v:=public.fn_ca_verify_terminal_final_deal_batch(tid,true);
 PERFORM pg_temp.deal_assert(v->>'ok'='true','owner verifier proves settled v2 cash and final lifecycle');
 PERFORM pg_temp.deal_assert((SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id=tid)=100
  AND (SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id=tid AND source='final_table_deal')=95
  AND (SELECT sum(amount) FROM public.wallet_transactions WHERE related_entity_id=tid)=100,
  'fixed entitlement plus approved shares equals exactly one hundred paid chips');
 PERFORM pg_temp.deal_assert(NOT EXISTS(
  SELECT 1 FROM public.tournament_payouts paid CROSS JOIN LATERAL
   jsonb_array_elements((SELECT snapshot FROM public.tournament_deal_proposals
    WHERE id=(SELECT proposal_id FROM native_deal_request))->'shares')share
  WHERE paid.tournament_id=tid AND paid.source='final_table_deal'
   AND share->>'user_id'=paid.user_id::text AND paid.amount*100<>(share->>'amount_cents')::numeric),
  'each actual deal credit matches immutable approved recipient cents');
 PERFORM pg_temp.deal_assert(NOT EXISTS(SELECT 1 FROM public.tournament_obligations
  WHERE tournament_id=tid AND (amount_paid IS DISTINCT FROM amount_owed OR settled_at IS NULL)),
  'every obligation is fully paid with settlement evidence');
 PERFORM pg_temp.deal_assert((SELECT prize_balance=0 AND bounty_balance=0 AND fee_balance=0
  AND closed_at IS NOT NULL AND close_note='terminal receipt: exact zero'
  FROM public.tournament_escrow WHERE tournament_id=tid),'all three escrow balances close at exact zero');
 PERFORM pg_temp.deal_assert((SELECT count(*) FROM public.tables WHERE tournament_id=tid
  AND status='closed' AND lifecycle='closed' AND current_players=0 AND terminal_closed_at IS NOT NULL)=1
  AND NOT EXISTS(SELECT 1 FROM public.table_seats WHERE table_id='87200000-0000-0000-0000-000000000001'
   AND (left_at IS NULL OR status<>'left')),'all source seats and the final table close');
 PERFORM pg_temp.assert_deal_terminal_authority();
 PERFORM pg_temp.deal_assert(true,'native wrapper mints and consumes exact per-seat terminal capabilities');
END $complete$;

-- Observe the final receipt only after genuine money, claim, and lifecycle work.
CREATE FUNCTION pg_temp.final_deal_late_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
 IF NEW.tournament_id='87000000-0000-0000-0000-000000000001' THEN
  PERFORM pg_temp.assert_final_deal_completed();
  RAISE EXCEPTION 'expected final-deal terminal receipt fault' USING ERRCODE='ZX005';
 END IF;
 RETURN NEW;
END $fault$;
CREATE TRIGGER native_final_deal_late_fault AFTER INSERT ON public.tournament_terminal_settlements
FOR EACH ROW EXECUTE FUNCTION pg_temp.final_deal_late_fault();

DO $rollback$
DECLARE original jsonb:=pg_temp.final_deal_exact_state(); r record; caught boolean:=false;
BEGIN
 SELECT * INTO STRICT r FROM native_deal_request;
 BEGIN
  PERFORM public.fn_complete_tournament_terminal_proposal(
   '87000000-0000-0000-0000-000000000001',NULL,'final_table_deal',r.proposal_id,r.revision);
 EXCEPTION WHEN SQLSTATE 'ZX005' THEN caught:=true;
 END;
 PERFORM pg_temp.deal_assert(caught,'fault reached the final real terminal receipt after all prior effects');
 PERFORM pg_temp.deal_assert(pg_temp.final_deal_exact_state()=original,
  'late failure restores every financial, claim, batch, capability, review, and lifecycle row');
END $rollback$;
DROP TRIGGER native_final_deal_late_fault ON public.tournament_terminal_settlements;

CREATE TEMP TABLE native_deal_terminal_result(receipt jsonb);
DO $settle$
DECLARE r record; receipt jsonb; replay jsonb; outcome jsonb; original jsonb;
BEGIN
 SELECT * INTO STRICT r FROM native_deal_request;
 receipt:=public.fn_complete_tournament_terminal_proposal(
  '87000000-0000-0000-0000-000000000001',NULL,'final_table_deal',r.proposal_id,r.revision);
 PERFORM pg_temp.deal_assert(receipt->>'ok'='true' AND receipt->>'status'='COMPLETED'
  AND receipt->>'fully_settled'='true' AND receipt->>'proposal_id'=r.proposal_id::text
  AND receipt->>'revision'=r.revision,'real proposal wrapper returns committed exact proposal terminal receipt');
 PERFORM pg_temp.assert_final_deal_completed();
 PERFORM pg_temp.deal_assert((SELECT state='completed' FROM public.tournament_deal_reviews WHERE id=r.review_id)
  AND (SELECT count(*) FROM public.tournament_deal_proposal_executions
   WHERE tournament_id='87000000-0000-0000-0000-000000000001' AND proposal_id=r.proposal_id AND revision=r.revision)=1,
  'only successful terminal commit persists exact proposal execution and closes the review');
 PERFORM pg_temp.deal_assert(NULLIF(current_setting('app.tournament_seat_exit_token',true),'') IS NULL
  AND NULLIF(current_setting('app.tournament_seat_exit_operation',true),'') IS NULL
  AND NULLIF(current_setting('app.tournament_deal_proposal_id',true),'') IS NULL
  AND NULLIF(current_setting('app.tournament_deal_proposal_revision',true),'') IS NULL,
  'wrapper restores prior proposal and seat capability request settings');
 original:=pg_temp.final_deal_exact_state();
 replay:=public.fn_complete_tournament_terminal_proposal(
  '87000000-0000-0000-0000-000000000001',NULL,'final_table_deal',r.proposal_id,r.revision);
 outcome:=public.fn_resolve_tournament_terminal_proposal_outcome(
  '87000000-0000-0000-0000-000000000001',NULL,'final_table_deal',r.proposal_id,r.revision);
 PERFORM pg_temp.deal_assert(replay=receipt AND outcome->>'terminal_committed'='true'
  AND outcome->>'proposal_id'=r.proposal_id::text AND outcome->>'revision'=r.revision
  AND pg_temp.final_deal_exact_state()=original,
  'lost-response replay and serialized resolver preserve the exact terminal outcome without payment');
 PERFORM set_config('app.native_previous_timezone',current_setting('TimeZone'),true);
 PERFORM set_config('TimeZone','UTC',true);
 PERFORM public.fn_ca_verify_terminal_final_deal_batch(
  '87000000-0000-0000-0000-000000000001',true);
 PERFORM set_config('TimeZone',current_setting('app.native_previous_timezone'),true);
 PERFORM pg_temp.deal_assert(pg_temp.final_deal_exact_state()=original,
  'verification remains identical after a different session timezone');
 INSERT INTO native_deal_terminal_result VALUES(receipt);
END $settle$;


DO $immutability$
DECLARE original jsonb:=pg_temp.final_deal_exact_state(); caught boolean; q text;
BEGIN
 FOREACH q IN ARRAY ARRAY[
  'UPDATE public.tournament_final_table_deal_batches SET plan=''[]''::jsonb WHERE tournament_id=''87000000-0000-0000-0000-000000000001''',
  'UPDATE public.tournament_obligations SET amount_paid=amount_paid-1 WHERE tournament_id=''87000000-0000-0000-0000-000000000001'' AND kind=''final_table_deal''',
  'UPDATE public.tournament_players SET prize=prize+1 WHERE tournament_id=''87000000-0000-0000-0000-000000000001'''
 ] LOOP
  caught:=false;
  BEGIN EXECUTE q;
  EXCEPTION WHEN check_violation THEN caught:=true;
   WHEN SQLSTATE '55000' THEN
    IF SQLERRM LIKE 'terminal tournament % has immutable % evidence' THEN caught:=true;
    ELSE RAISE; END IF;
  END;
  PERFORM pg_temp.deal_assert(caught AND pg_temp.final_deal_exact_state()=original,
   'settled batch, recipient payment and result mutations are refused without change');
 END LOOP;
END $immutability$;

SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'FINAL_DEAL_NATIVE_EVIDENCE='||jsonb_build_object(
 'receipt',(SELECT receipt FROM native_deal_terminal_result),
 'claim',(SELECT to_jsonb(t) FROM public.tournament_finish_receipts t WHERE tournament_id='87000000-0000-0000-0000-000000000001'),
 'batch',(SELECT to_jsonb(t) FROM public.tournament_final_table_deal_batches t WHERE tournament_id='87000000-0000-0000-0000-000000000001'),
 'batch_receipts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.tournament_final_table_deal_receipts t WHERE tournament_id='87000000-0000-0000-0000-000000000001'),
 'expected_seats',(SELECT count(*) FROM native_deal_terminal_expected_seats),
 'authority_inserts',(SELECT count(*) FROM native_deal_terminal_authority_events WHERE action='INSERT'),
 'authority_deletes',(SELECT count(*) FROM native_deal_terminal_authority_events WHERE action='DELETE'),
 'deferred_constraints_checked',true)::text;
ROLLBACK;
