-- Run only on the task-owned network-none empty-catalog PG17 qualification.
-- Synthetic counterfactual opening is isolated from tested native operations.
SET request.jwt.claim.role='service_role';
SET request.jwt.claims='{"role":"service_role"}';
BEGIN;
SET LOCAL session_replication_role=replica;
TRUNCATE smarter_private.retirement_original_hand_qualification CASCADE;
INSERT INTO smarter_private.retirement_original_hand_qualification
SELECT s.submission_id,s.request_hash,c.table_id,c.tournament_id,s.hand_number,
 jsonb_build_object('submission_id',s.submission_id,'request_hash',s.request_hash,'table_id',c.table_id,'tournament_id',c.tournament_id,'hand_number',s.hand_number,'rows',(
 SELECT jsonb_agg(jsonb_build_object('user_id',tp.user_id,'stack',x,'roster',(
  SELECT jsonb_object_agg(key,value) FROM jsonb_each(to_jsonb(tp)) WHERE key=ANY(ARRAY['id','user_id','tournament_id','status','chips','position','prize','table_id','seat_number','rebuys','add_on','eliminated_at','current_bounty','bounty_winnings','bounties_collected','rebuy_prompt_until','elimination_sequence'])),
 'seat',(SELECT jsonb_object_agg(key,value) FROM jsonb_each(to_jsonb(ts)) WHERE key=ANY(ARRAY['id','table_id','user_id','club_id','seat_number','joined_at','occupancy_id','stack','left_at','status','is_sitting_out','is_away','leave_pending','active_game_scope','active_parent_key']))) ORDER BY tp.user_id)
 FROM public.tournament_players tp JOIN public.table_seats ts ON ts.table_id=c.table_id AND ts.user_id=tp.user_id
 CROSS JOIN LATERAL jsonb_array_elements(s.request->'p_stacks')x
 WHERE tp.tournament_id=c.tournament_id AND tp.status='eliminated' AND x->>'user_id'=tp.user_id::text))
FROM retirement_native.cases c JOIN smarter_private.hand_submissions s ON s.submission_id=c.submission_id;
SET LOCAL session_replication_role=origin;
COMMIT;
CREATE FUNCTION retirement_native.assert_true(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'RETIREMENT NATIVE FAIL: %',label; END IF;
RAISE NOTICE 'RETIREMENT NATIVE PASS: %',label; END $$;
SELECT retirement_native.assert_true((SELECT count(*)=57 AND count(DISTINCT tournament_id)=54 AND sum(jsonb_array_length(expected->'rows'))=66 FROM smarter_private.retirement_original_hand_qualification),'57 original hands / 54 events / 66 exact synthetic force postimages');
SELECT retirement_native.assert_true((SELECT sum(dealt)=167 AND (SELECT max(n)=4 FROM(SELECT count(*)n FROM retirement_native.cases GROUP BY tournament_id)x) FROM retirement_native.cases),'167 dealt originals including four-table event');
CREATE FUNCTION retirement_native.resume_case(i integer) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c retirement_native.cases;r jsonb;
BEGIN
 SELECT * INTO STRICT c FROM retirement_native.cases WHERE cases.i=resume_case.i;
 PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
 PERFORM set_config('app.smarter_tournament_id',c.tournament_id::text,true);
 PERFORM set_config('app.smarter_tournament_lease_generation',c.successor_generation::text,true);
 UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id=c.tournament_id;
 r:=public.fn_ca_resume_hand_submission(c.table_id,'synthetic-successor',c.successor_generation);
 RETURN r;
END $$;
DO $negative$
DECLARE action text;denied boolean;r jsonb;before jsonb;
BEGIN
 FOR action IN SELECT unnest(ARRAY[
  'UPDATE public.table_seats SET stack=stack+1 WHERE id=retirement_native.fixture_id(8,11)',
  'UPDATE public.table_seats SET user_id=retirement_native.fixture_id(6,12) WHERE id=retirement_native.fixture_id(8,11)',
  'UPDATE public.table_seats SET joined_at=joined_at+interval ''1 second'' WHERE id=retirement_native.fixture_id(8,11)',
  'UPDATE public.tournament_players SET table_id=retirement_native.fixture_id(1,2) WHERE id=retirement_native.fixture_id(7,11)',
  'UPDATE public.tournament_players SET rebuys=rebuys+1 WHERE id=retirement_native.fixture_id(7,11)',
  'UPDATE public.tournament_players SET add_on=true WHERE id=retirement_native.fixture_id(7,11)',
  'UPDATE smarter_private.patterned_identity_retirements SET replacement_horse_id=retirement_native.fixture_id(6,12) WHERE old_id=retirement_native.fixture_id(6,11)',
  'INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state) VALUES(retirement_native.fixture_id(10,99),retirement_native.fixture_id(2,1),retirement_native.fixture_id(1,1),1,9700099,retirement_native.fixture_id(11,99),retirement_native.fixture_id(5,1),''accepted'')'
 ]) LOOP
  BEGIN
   PERFORM set_config('session_replication_role','replica',true);EXECUTE action;
   PERFORM set_config('session_replication_role','origin',true);denied:=false;
   BEGIN r:=retirement_native.resume_case(1); EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM LIKE 'RETIREMENT_ORIGINAL_%'; END;
   PERFORM retirement_native.assert_true(denied,'changed custody / moved / repurchase / later permit refuses: '||action);
   PERFORM retirement_native.assert_true(NOT EXISTS(SELECT 1 FROM smarter_private.retirement_original_hand_restorations) AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs),'negative case restores no metadata or original claim');
   RAISE EXCEPTION 'restore isolated counterfactual' USING ERRCODE='P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
 END LOOP;
END $negative$;
DO $lease$
DECLARE r jsonb;denied boolean:=false;
BEGIN
 BEGIN
  r:=public.fn_ca_resume_hand_submission(retirement_native.fixture_id(1,1),'synthetic-successor',retirement_native.fixture_id(5,99));
 EXCEPTION WHEN SQLSTATE '55000' OR SQLSTATE '42501' THEN denied:=SQLERRM IN('F06_PROTOCOL2_REQUIRED','RETIREMENT_ORIGINAL_LEASE_UNPROVEN'); END;
 PERFORM retirement_native.assert_true(denied OR r->>'completed'='false','foreign successor generation refuses');
END $lease$;
CREATE TRIGGER zz_retirement_financial_refusal BEFORE INSERT ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION retirement_native.submission_fault();
DO $atomic_failure$
DECLARE denied boolean:=false;r jsonb;
BEGIN
 BEGIN r:=retirement_native.resume_case(1); EXCEPTION WHEN SQLSTATE 'P0404' THEN denied:=true; END;
 PERFORM retirement_native.assert_true(denied,'caught native financial refusal aborts whole restoration transaction');
 PERFORM retirement_native.assert_true((SELECT count(*)=66 FROM public.tournament_players tp JOIN retirement_native.cases c ON c.tournament_id=tp.tournament_id AND c.table_id=tp.table_id WHERE tp.status='eliminated') AND NOT EXISTS(SELECT 1 FROM smarter_private.retirement_original_hand_restorations) AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs) AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=retirement_native.fixture_id(1,1)),'all 66 original force postimages / claims / financial effects unchanged after caught failure');
END $atomic_failure$;
DROP TRIGGER zz_retirement_financial_refusal ON public.hand_projection_outbox;
DO $success$
DECLARE c retirement_native.cases;r jsonb;
BEGIN
 FOR c IN SELECT * FROM retirement_native.cases ORDER BY i LOOP
  r:=retirement_native.resume_case(c.i);
  RAISE NOTICE 'native original outcome %: %',c.i,r;
  PERFORM retirement_native.assert_true(r->>'completed'='true' AND r->>'post_commit_completed'='true' AND r->>'financial_handoff'='true','actual original native financial + postcommit continuation '||c.i);
  r:=retirement_native.resume_case(c.i);
  PERFORM retirement_native.assert_true(r->>'found'='false','original acknowledgement replay has no second financial attempt '||c.i);
 END LOOP;
END $success$;
SELECT retirement_native.assert_true((SELECT count(*)=57 AND sum(restored_players)=66 FROM smarter_private.retirement_original_hand_restorations),'57 exact receipts / 66 rows restored inside original atomic transactions');
SELECT retirement_native.assert_true((SELECT count(*)=57 AND bool_and(stack_result->>'conservation_checked'='true' AND (stack_result->>'net_deltas')::numeric=0) FROM public.hand_atomic_commits a JOIN retirement_native.cases c ON c.table_id=a.table_id),'57 native conserved original hands / net zero');
SELECT retirement_native.assert_true((SELECT sum(s.stack)=16700 FROM public.table_seats s JOIN retirement_native.cases c ON c.table_id=s.table_id),'167 original dealt stacks conserved independently');
SELECT retirement_native.assert_true((SELECT count(*)=66 AND bool_and(p.status='deleted' AND p.horse_status='disabled' AND r.replacement_horse_id IS NULL) FROM smarter_private.patterned_identity_retirements r JOIN public.profiles p ON p.id=r.old_id),'closed identities / disabled fleet / replacement claims unchanged');
SELECT 'RETIREMENT_NATIVE_57_PASS';
