CREATE FUNCTION pg_temp.submission_request() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
 'p_table_id','86100000-0000-0000-0000-000000000001','p_hand_number',8600001,
 'p_stacks',pg_temp.atomic_hand_stacks(),'p_rake',0,'p_bbj',0,'p_ref','atomic-zero-seat','p_inflow',0,
 'p_hand_row',pg_temp.atomic_hand_row(),'p_units','[]'::jsonb,
 'p_instance_id','atomic-hand-boundary-probe','p_lease_generation','86500000-0000-0000-0000-000000000001',
 'p_post_commit_obligations',pg_temp.atomic_hand_obligations());
$$;
CREATE FUNCTION pg_temp.commit_submission() RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.fn_ca_commit_hand_submission('86400000-0000-0000-0000-000000000001',
 'atomic-hand-boundary-probe','86500000-0000-0000-0000-000000000001');
$$;
CREATE FUNCTION pg_temp.submission_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'HAND SUBMISSION FAIL: %',label; END IF;
RAISE NOTICE 'HAND SUBMISSION PASS: %',label; END $$;

-- Synthetic cash opening uses the same captured public financial owners. No
-- funding certification is invented; the existing legacy provenance is explicit.
DO $cash_successor$
DECLARE q jsonb; r jsonb;
BEGIN
 BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  INSERT INTO public.cash_games(id,club_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot)
   VALUES('86900000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Submission Cash Probe','classic','nlh',1,2,6,'{}');
  -- Opening rows only. Restore every real trigger before invoking retention.
  PERFORM set_config('session_replication_role','replica',true);
  INSERT INTO public.tables(id,name,tournament_id,game_type,game_variant,status,lifecycle,club_id,small_blind,big_blind,cluster_id,seat_game_scope,seat_admission_key)
   VALUES('87100000-0000-0000-0000-000000000001','Cash submission',NULL,'cash','nlh','running','live',
    '20000000-0000-0000-0000-000000000001',1,2,'86900000-0000-0000-0000-000000000001',
    'cluster:86900000-0000-0000-0000-000000000001','cash');
  INSERT INTO public.table_seats SELECT (jsonb_populate_record(NULL::public.table_seats,to_jsonb(t)||jsonb_build_object(
   'id',replace(t.id::text,'86300000','87300000'),'occupancy_id',gen_random_uuid(),'table_id','87100000-0000-0000-0000-000000000001',
   'active_game_scope','cluster:86900000-0000-0000-0000-000000000001','active_parent_key','cash'))).*
   FROM public.table_seats t WHERE table_id='86100000-0000-0000-0000-000000000001';
  PERFORM set_config('session_replication_role','origin',true);
  INSERT INTO public.engine_table_leases(table_id,instance_id,lease_generation,protocol_version,heartbeat_at)
   VALUES('87100000-0000-0000-0000-000000000001','atomic-hand-boundary-probe','86500000-0000-0000-0000-000000000001',2,clock_timestamp());
  INSERT INTO public.hand_state_snapshots(table_id,hand_number,state_json,config_json,dealer_seat,players_json,stage)
   VALUES('87100000-0000-0000-0000-000000000001',8700001,'{"stage":"river"}','{}',1,'[]','river');
  q:=replace(replace(replace(replace(pg_temp.submission_request()::text,'86100000','87100000'),'86300000','87300000'),'86400000','87400000'),'8600001','8700001')::jsonb;
  q:=jsonb_set(q,'{p_hand_row,tournament_id}','null');
  q:=jsonb_set(q,'{p_post_commit_obligations,pending_addons}','{"enabled":true,"max_buy_in":200}');
  q:=jsonb_set(q,'{p_post_commit_obligations,promo_playthrough}',
   (SELECT jsonb_agg(jsonb_build_object('club_id','20000000-0000-0000-0000-000000000001',
     'user_id',key,'wagered',value) ORDER BY key)
    FROM jsonb_each(q->'p_hand_row'->'_accepted_post_commit_facts'->'contributions') WHERE value::text::numeric>0));
  r:=public.fn_ca_retain_hand_submission(q);
  PERFORM pg_temp.submission_assert(r->>'retained'='true','actual cash lease retains original without a tournament permit');
  CREATE FUNCTION pg_temp.cash_submission_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$
   BEGIN RAISE EXCEPTION 'isolated cash canonical interruption' USING ERRCODE='XX000'; END $fault$;
  CREATE TRIGGER zz_cash_submission_fault BEFORE INSERT ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION pg_temp.cash_submission_fault();
  r:=public.fn_ca_commit_hand_submission('87400000-0000-0000-0000-000000000001','atomic-hand-boundary-probe','86500000-0000-0000-0000-000000000001');
  PERFORM pg_temp.submission_assert(r->>'reason'='atomic_hand_rolled_back' AND r->>'sqlstate'='XX000'
   AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id='87100000-0000-0000-0000-000000000001'),'cash canonical failure preserves unspent exact original');
  DROP TRIGGER zz_cash_submission_fault ON public.hand_projection_outbox;
  UPDATE public.engine_table_leases SET instance_id='successor-one',lease_generation='86500000-0000-0000-0000-000000000002',heartbeat_at=clock_timestamp()
   WHERE table_id='87100000-0000-0000-0000-000000000001';
  r:=public.fn_ca_resume_hand_submission('87100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  RAISE NOTICE 'cash successor outcome: %',r;
  PERFORM pg_temp.submission_assert(r->>'completed'='true' AND r->>'post_commit_completed'='true'
   AND r->>'financial_handoff'='true' AND r->'permit_id'='null'::jsonb,'actual cash successor completes retained public financial and postcommit owner');
  PERFORM pg_temp.submission_assert((SELECT sum(stack)=20 FROM public.table_seats WHERE table_id='87100000-0000-0000-0000-000000000001')
   AND NOT EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id='87100000-0000-0000-0000-000000000001' AND NOT is_complete)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch),'cash successor conserves stacks and acknowledges snapshot without dispatch residue');
  r:=public.fn_ca_resume_hand_submission('87100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  PERFORM pg_temp.submission_assert(r->>'found'='false' AND (SELECT count(*)=1 FROM smarter_private.hand_submission_handoffs),'cash startup replay cannot spend a second financial claim');
  RAISE EXCEPTION 'restore cash fixture' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
END $cash_successor$;
INSERT INTO public.hand_state_snapshots(table_id,hand_number,state_json,config_json,dealer_seat,players_json,stage)
VALUES('86100000-0000-0000-0000-000000000001',8600001,'{"stage":"preflop"}','{}',1,'[]','preflop');
INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state)
VALUES('86600000-0000-0000-0000-000000000001','86000000-0000-0000-0000-000000000001',
 '86100000-0000-0000-0000-000000000001',1,8600001,'86700000-0000-0000-0000-000000000001',
 '86500000-0000-0000-0000-000000000001','reserved');
DO $retained$
DECLARE r jsonb; q jsonb:=pg_temp.submission_request(); denied boolean:=false;
BEGIN
 r:=public.fn_ca_retain_hand_submission(q);
 PERFORM pg_temp.submission_assert(r->>'retained'='true' AND r->>'submission_id'=q->'p_hand_row'->>'id','positive exact original receipt');
 PERFORM pg_temp.submission_assert((SELECT request=q FROM smarter_private.hand_submissions),'complete original payload durable');
 PERFORM pg_temp.submission_assert(NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001')
 AND EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id='86100000-0000-0000-0000-000000000001' AND NOT is_complete),'retention is not financial acceptance or snapshot completion');
 r:=public.fn_ca_retain_hand_submission(q);
 PERFORM pg_temp.submission_assert(r->>'replay'='true' AND (SELECT count(*)=1 FROM smarter_private.hand_submissions),'same original retain replay');
 BEGIN PERFORM public.fn_ca_retain_hand_submission(jsonb_set(q,'{p_rake}','1')); EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_SUBMISSION_ORIGINAL_PAYLOAD_REQUIRED'; END;
 PERFORM pg_temp.submission_assert(denied,'changed original request refuses');
 denied:=false;
 BEGIN PERFORM public.fn_ca_commit_hand_settlement('86100000-0000-0000-0000-000000000001',8600001,pg_temp.atomic_hand_stacks(),
  1,0,'atomic-zero-seat',0,pg_temp.atomic_hand_row(),'[]','atomic-hand-boundary-probe',
  '86500000-0000-0000-0000-000000000001',pg_temp.atomic_hand_obligations());
 EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_SUBMISSION_ORIGINAL_PAYLOAD_REQUIRED'; END;
 PERFORM pg_temp.submission_assert(denied,'old public door cannot bypass retained original');
END $retained$;
DO $guards$
DECLARE denied boolean; action text; original jsonb; r jsonb;
BEGIN
 SELECT request INTO original FROM smarter_private.hand_submissions;
 FOR action IN SELECT unnest(ARRAY[
  'UPDATE smarter_private.hand_submissions SET request=request',
  'DELETE FROM smarter_private.hand_submissions',
  'TRUNCATE smarter_private.hand_submissions',
  'UPDATE smarter_private.hand_submission_dispositions SET disposition=disposition',
  'DELETE FROM smarter_private.hand_submission_dispositions',
  'TRUNCATE smarter_private.hand_submission_dispositions']) LOOP
  denied:=false;
  BEGIN EXECUTE action; EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_SUBMISSION_IMMUTABLE'; END;
  PERFORM pg_temp.submission_assert(denied,'private immutable row/truncate: '||action);
 END LOOP;
 denied:=false;
 BEGIN UPDATE smarter_private.f06_hand_permits SET state='never_started',evidence_id=permit_id
 WHERE permit_id='86600000-0000-0000-0000-000000000001';
 EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='F06_RETAINED_HAND_SUBMISSION_REQUIRES_ACCEPTED_DISPOSITION'; END;
 PERFORM pg_temp.submission_assert(denied AND (SELECT state='reserved' FROM smarter_private.f06_hand_permits
 WHERE permit_id='86600000-0000-0000-0000-000000000001'),'retained original refuses incompatible no-start disposition');
 denied:=false;
 BEGIN PERFORM public.complete_hand_snapshot('86100000-0000-0000-0000-000000000001',8600001);
 EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_SUBMISSION_ACCEPTANCE_REQUIRED_FOR_COMPLETION'; END;
 PERFORM pg_temp.submission_assert(denied AND EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id='86100000-0000-0000-0000-000000000001' AND NOT is_complete),'actual legacy crash cleanup refuses retained unaccepted hand');
 denied:=false;
 BEGIN PERFORM public.fn_ca_commit_hand_submission('86400000-0000-0000-0000-000000000001','other-owner','86500000-0000-0000-0000-000000000001');
 EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_SUBMISSION_ORIGINAL_OWNER_REQUIRED'; END;
 PERFORM pg_temp.submission_assert(denied,'replacement owner cannot bypass original lease');
 BEGIN
  UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '1 hour'
  WHERE tournament_id='86000000-0000-0000-0000-000000000001';
  r:=pg_temp.commit_submission();
  PERFORM pg_temp.submission_assert(r->>'success'='false' AND r->>'reason'='hand_lease_stale','stale original lease refuses continuation');
  RAISE EXCEPTION 'fixture restore lease' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
 PERFORM pg_temp.submission_assert((SELECT request=original FROM smarter_private.hand_submissions),'refusals preserve original payload');
 PERFORM pg_temp.submission_assert(NOT EXISTS(SELECT 1 FROM pg_constraint
 WHERE conrelid IN('smarter_private.hand_submissions'::regclass,'smarter_private.hand_submission_dispositions'::regclass) AND contype='f'),'journal has no hot-row foreign keys');
 PERFORM pg_temp.submission_assert(NOT has_table_privilege('service_role','smarter_private.hand_submissions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 AND NOT has_table_privilege('authenticated','smarter_private.hand_submissions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 AND NOT has_function_privilege('authenticated','public.fn_ca_retain_hand_submission(jsonb)','EXECUTE')
 AND NOT has_function_privilege('anon','public.fn_ca_commit_hand_submission(uuid,text,uuid)','EXECUTE'),'private table and browser RPC ACLs deny access');
END $guards$;
SET LOCAL SESSION AUTHORIZATION service_role;
SELECT public.fn_ca_retain_hand_submission(pg_temp.submission_request());
RESET SESSION AUTHORIZATION;
SELECT pg_temp.submission_assert((SELECT count(*)=1 FROM smarter_private.hand_submissions),'service role owns exact public retention replay');
DO $unknown$
DECLARE r jsonb;
BEGIN
 BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id','86000000-0000-0000-0000-000000000001',true);
  PERFORM set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000002',true);
  UPDATE public.engine_tournament_leases SET instance_id='successor-one',lease_generation='86500000-0000-0000-0000-000000000002',heartbeat_at=clock_timestamp()
  WHERE tournament_id='86000000-0000-0000-0000-000000000001';
  r:=public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  PERFORM pg_temp.submission_assert(r->>'completed'='false' AND r->>'reason'='original_failure_or_handoff_unproven'
    AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs),'journal plus replacement never converts unknown transport into failure');
  RAISE EXCEPTION 'restore unknown fixture' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
END $unknown$;
CREATE FUNCTION pg_temp.submission_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'isolated accepted-hand storage interruption' USING ERRCODE='XX000'; END $$;
CREATE TRIGGER zz_submission_fault BEFORE INSERT ON public.hand_projection_outbox
 FOR EACH ROW EXECUTE FUNCTION pg_temp.submission_fault();
DO $refusal$
DECLARE r jsonb;
BEGIN
 r:=pg_temp.commit_submission();
 RAISE NOTICE 'submission outcome: %',r;
 PERFORM pg_temp.submission_assert(r->>'success'='false' AND r->>'reason'='atomic_hand_rolled_back'
 AND r->>'sqlstate'='XX000','real canonical semantic rollback returned');
 PERFORM pg_temp.submission_assert((SELECT count(*)=1 FROM smarter_private.hand_submissions)
 AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001')
 AND EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id='86100000-0000-0000-0000-000000000001' AND NOT is_complete)
 AND (SELECT sum(stack)=20 FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001'),'refusal retains original and active snapshot with full financial rollback');
END $refusal$;
DO $spent$
DECLARE r jsonb;
BEGIN
 BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id','86000000-0000-0000-0000-000000000001',true);
  PERFORM set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000002',true);
  UPDATE public.engine_tournament_leases SET instance_id='successor-one',lease_generation='86500000-0000-0000-0000-000000000002',heartbeat_at=clock_timestamp()
  WHERE tournament_id='86000000-0000-0000-0000-000000000001';
  r:=public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  PERFORM pg_temp.submission_assert(r->>'reason'='successor_financial_refused'
   AND (SELECT count(*)=1 FROM smarter_private.hand_submission_handoffs)
   AND (SELECT result->>'sqlstate'='XX000' FROM smarter_private.hand_submission_handoff_results),'successor semantic refusal commits one spent claim and exact outcome');
  r:=public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  PERFORM pg_temp.submission_assert(r->>'reason'='successor_financial_claim_spent'
   AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001')
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch),'replacement repeats readback only after spent failed claim');
  RAISE EXCEPTION 'restore spent fixture' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
END $spent$;
DROP TRIGGER zz_submission_fault ON public.hand_projection_outbox;
CREATE FUNCTION pg_temp.submission_postcommit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.post_commit_completed_at IS NOT NULL AND OLD.post_commit_completed_at IS NULL THEN
 RAISE EXCEPTION 'isolated postcommit interruption' USING ERRCODE='P9010'; END IF; RETURN NEW; END $$;
DO $maintenance_admission$
DECLARE denied boolean;
BEGIN
 BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id','86000000-0000-0000-0000-000000000001',true);
  PERFORM set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000002',true);
  UPDATE public.engine_tournament_leases SET instance_id='successor-one',lease_generation='86500000-0000-0000-0000-000000000002',heartbeat_at=clock_timestamp()
   WHERE tournament_id='86000000-0000-0000-0000-000000000001';
  INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,enforce_freeze,ownership_token)
   VALUES(true,'counting_down',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '4 minutes',true,'86800000-0000-0000-0000-000000000001');
  denied:=false;
  BEGIN PERFORM public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_SUBMISSION_PLATFORM_FROZEN'; END;
  PERFORM pg_temp.submission_assert(denied AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch),'actual maintenance freeze refuses before spending financial claim');
  DELETE FROM public.engine_maintenance_break WHERE id;
  CREATE FUNCTION pg_temp.submission_contention() RETURNS trigger LANGUAGE plpgsql AS $fault$
   BEGIN RAISE EXCEPTION 'isolated financial lock contention' USING ERRCODE='55P03'; END $fault$;
  CREATE TRIGGER zz_submission_contention BEFORE INSERT ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION pg_temp.submission_contention();
  denied:=false;
  BEGIN PERFORM public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  EXCEPTION WHEN SQLSTATE '40001' THEN denied:=SQLERRM LIKE 'HAND_SUBMISSION_ADMISSION_CHANGED:%'; END;
  PERFORM pg_temp.submission_assert(denied AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoff_results)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch),'canonical lock refusal rolls back claim and capability');
  DROP TRIGGER zz_submission_contention ON public.hand_projection_outbox;
  CREATE FUNCTION pg_temp.submission_lease_expiry() RETURNS trigger LANGUAGE plpgsql AS $fault$
   BEGIN
    UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '1 hour'
     WHERE tournament_id='86000000-0000-0000-0000-000000000001';
    IF TG_TABLE_NAME='hand_projection_outbox' THEN
     PERFORM smarter_private.f06_authority('86000000-0000-0000-0000-000000000001',
      '86500000-0000-0000-0000-000000000002',false);
    END IF;
    RETURN NEW;
   END $fault$;
  CREATE TRIGGER zz_submission_lease_expiry BEFORE INSERT ON smarter_private.hand_submission_handoffs
   FOR EACH ROW EXECUTE FUNCTION pg_temp.submission_lease_expiry();
  denied:=false;
  BEGIN PERFORM public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  EXCEPTION WHEN SQLSTATE '40001' THEN denied:=SQLERRM LIKE 'HAND_SUBMISSION_ADMISSION_CHANGED:%hand_lease_stale%'; END;
  PERFORM pg_temp.submission_assert(denied AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch),'actual inner exact-lease refusal does not spend financial claim');
  DROP TRIGGER zz_submission_lease_expiry ON smarter_private.hand_submission_handoffs;
  CREATE TRIGGER zz_submission_lease_expiry BEFORE INSERT ON public.hand_projection_outbox
   FOR EACH ROW EXECUTE FUNCTION pg_temp.submission_lease_expiry();
  denied:=false;
  BEGIN PERFORM public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  EXCEPTION WHEN SQLSTATE '40001' THEN denied:=SQLERRM LIKE 'HAND_SUBMISSION_ADMISSION_CHANGED:%F06_LEASE_FENCED%'; END;
  PERFORM pg_temp.submission_assert(denied AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch),'real nested F06 lease error does not spend financial claim');
  DROP TRIGGER zz_submission_lease_expiry ON public.hand_projection_outbox;
  UPDATE public.tables SET lifecycle='breaking' WHERE id='86100000-0000-0000-0000-000000000001';
  denied:=false;
  BEGIN PERFORM public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_SUBMISSION_TABLE_NOT_ADMITTED'; END;
  PERFORM pg_temp.submission_assert(denied AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs),'breaking current table refuses before spending financial claim');
  RAISE EXCEPTION 'restore maintenance fixture' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
END $maintenance_admission$;
DO $later_owner$
DECLARE r jsonb; accepted_hash text; denied boolean;
BEGIN
 BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id','86000000-0000-0000-0000-000000000001',true);
  PERFORM set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000002',true);
  UPDATE public.engine_tournament_leases SET instance_id='successor-one',lease_generation='86500000-0000-0000-0000-000000000002',heartbeat_at=clock_timestamp()
  WHERE tournament_id='86000000-0000-0000-0000-000000000001';
  BEGIN
   UPDATE public.table_seats SET joined_at=joined_at+interval '1 second' WHERE id='86300000-0000-0000-0000-000000000001';
   denied:=false;
   BEGIN PERFORM public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
   EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_SUBMISSION_HANDOFF_STATE_CHANGED'; END;
   PERFORM pg_temp.submission_assert(denied AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs),'reused seat generation refuses before financial claim');
   RAISE EXCEPTION 'restore roster' USING ERRCODE='P9002';
  EXCEPTION WHEN SQLSTATE 'P9002' THEN NULL; END;
  CREATE TRIGGER zz_submission_postcommit_fault BEFORE UPDATE ON public.hand_atomic_commits
   FOR EACH ROW EXECUTE FUNCTION pg_temp.submission_postcommit_fault();
  r:=public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  PERFORM pg_temp.submission_assert(r->>'reason'='accepted_postcommit_pending' AND r->>'snapshot_completed'='true'
   AND (SELECT count(*)=1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001')
   AND (SELECT state='reserved' FROM smarter_private.f06_hand_permits WHERE permit_id='86600000-0000-0000-0000-000000000001'),'postcommit interruption preserves accepted atomic and original pending permit');
  SELECT payload_hash INTO accepted_hash FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001';
  DROP TRIGGER zz_submission_postcommit_fault ON public.hand_atomic_commits;
  INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,enforce_freeze,ownership_token)
   VALUES(true,'counting_down',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '4 minutes',true,'86800000-0000-0000-0000-000000000001');
  denied:=false;
  BEGIN PERFORM public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_SUBMISSION_PLATFORM_FROZEN'; END;
  PERFORM pg_temp.submission_assert(denied AND (SELECT count(*)=1 FROM smarter_private.hand_submission_handoffs)
   AND (SELECT payload_hash=accepted_hash AND post_commit_completed_at IS NULL FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001'),'startup accepted postcommit defers during freeze without another financial claim');
  DELETE FROM public.engine_maintenance_break WHERE id;
  UPDATE public.engine_tournament_leases SET instance_id='successor-two',lease_generation='86500000-0000-0000-0000-000000000003',heartbeat_at=clock_timestamp()
  WHERE tournament_id='86000000-0000-0000-0000-000000000001';
  PERFORM set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000003',true);
  r:=public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-two','86500000-0000-0000-0000-000000000003');
  PERFORM pg_temp.submission_assert(r->>'completed'='true' AND r->>'financial_handoff'='false'
   AND (SELECT count(*)=1 FROM smarter_private.hand_submission_handoffs)
   AND (SELECT payload_hash=accepted_hash AND post_commit_result->>'ok'='true' FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001'),'later replacement continues accepted postcommit without another financial claim');
  PERFORM pg_temp.submission_assert((SELECT state='accepted' AND evidence_id='86400000-0000-0000-0000-000000000001'
    FROM smarter_private.f06_hand_permits WHERE permit_id='86600000-0000-0000-0000-000000000001')
    AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch),'later owner finishes original F06 permit and leaves no dispatch capability');
  RAISE EXCEPTION 'restore later owner fixture' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
END $later_owner$;
DO $successor$
DECLARE r jsonb; old_request jsonb; denied boolean; old_counts jsonb;
BEGIN
 SELECT request INTO old_request FROM smarter_private.hand_submissions;
 PERFORM pg_temp.submission_assert(EXISTS(SELECT 1 FROM smarter_private.hand_submission_failures
 WHERE submission_id='86400000-0000-0000-0000-000000000001' AND result->>'sqlstate'='XX000'),'positive canonical failure survives original refusal');
 BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id','86000000-0000-0000-0000-000000000001',true);
  PERFORM set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000002',true);
  UPDATE public.engine_tournament_leases SET instance_id='successor-one',lease_generation='86500000-0000-0000-0000-000000000002',heartbeat_at=clock_timestamp()
  WHERE tournament_id='86000000-0000-0000-0000-000000000001';
  denied:=false;
  BEGIN PERFORM public.fn_ca_commit_hand_settlement('86100000-0000-0000-0000-000000000001',8600001,pg_temp.atomic_hand_stacks(),
   0,0,'atomic-zero-seat',0,pg_temp.atomic_hand_row(),'[]','successor-one',
   '86500000-0000-0000-0000-000000000002',pg_temp.atomic_hand_obligations());
  EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_SUBMISSION_ORIGINAL_PAYLOAD_REQUIRED'; END;
  PERFORM pg_temp.submission_assert(denied,'new lease alone cannot use old original through public financial door');
  r:=public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  RAISE NOTICE 'successor outcome: %',r;
  PERFORM pg_temp.submission_assert(r->>'completed'='true' AND r->>'financial_handoff'='true' AND r->>'post_commit_completed'='true','exact current successor executes retained original and finishes postcommit');
  PERFORM pg_temp.submission_assert((SELECT state='accepted' AND generation='86500000-0000-0000-0000-000000000001' AND evidence_id='86400000-0000-0000-0000-000000000001'
   FROM smarter_private.f06_hand_permits WHERE permit_id='86600000-0000-0000-0000-000000000001'),'original permit finishes accepted without rewriting its generation');
  PERFORM pg_temp.submission_assert((SELECT count(*)=1 FROM smarter_private.hand_submission_handoffs)
   AND (SELECT count(*)=1 FROM smarter_private.hand_submission_handoff_results)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch),'one durable financial claim with no reusable transaction dispatch');
  PERFORM pg_temp.submission_assert((SELECT request=old_request FROM smarter_private.hand_submissions)
   AND (SELECT sum(stack)=20 FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001'),'successor preserves immutable original and conserved stack result');
  SELECT jsonb_agg(to_jsonb(a)) INTO old_counts FROM public.hand_atomic_commits a WHERE table_id='86100000-0000-0000-0000-000000000001';
  r:=public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  PERFORM pg_temp.submission_assert(r->>'found'='false' AND old_counts=(SELECT jsonb_agg(to_jsonb(a)) FROM public.hand_atomic_commits a WHERE table_id='86100000-0000-0000-0000-000000000001'),'completed startup replay has no second financial effect');
  RAISE EXCEPTION 'restore successor fixture' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
END $successor$;

DO $accepted$
DECLARE r jsonb; first_state jsonb;
BEGIN
 r:=pg_temp.commit_submission();
 RAISE NOTICE 'submission outcome: %',r;
 PERFORM pg_temp.submission_assert(r->>'success'='true' AND r->>'atomic_hand_commit'='true'
 AND r->>'snapshot_completed'='true' AND r->>'submission_id'='86400000-0000-0000-0000-000000000001','original owner continuation accepted');
 PERFORM pg_temp.submission_assert(EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001' AND hand_id='86400000-0000-0000-0000-000000000001' AND post_commit_payload IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id='86100000-0000-0000-0000-000000000001' AND NOT is_complete),'accepted receipt and completed snapshot committed together');
 SELECT jsonb_agg(to_jsonb(s) ORDER BY id) INTO first_state FROM public.table_seats s WHERE table_id='86100000-0000-0000-0000-000000000001';
 r:=pg_temp.commit_submission();
 RAISE NOTICE 'submission outcome: %',r;
 PERFORM pg_temp.submission_assert(r->>'success'='true' AND r->>'snapshots_completed'='0'
 AND first_state=(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.table_seats s WHERE table_id='86100000-0000-0000-0000-000000000001'),'acknowledgement loss replays without another stack effect');
END $accepted$;
SELECT 'HAND_SUBMISSION_NATIVE_PASS';
