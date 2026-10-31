-- Disposable PostgreSQL 17 only. Opening, financial functions and F06 lease
-- authority are supplied by test-hand-submission.py's actual captured closure.
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('app.smarter_data_actor','tournament-manager',true);
SELECT set_config('app.smarter_tournament_id','86000000-0000-0000-0000-000000000001',true);
SELECT set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000001',true);
INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state)
SELECT '86600000-0000-0000-0000-000000000001',tournament_id,id,f06_lifecycle,8600001,
 '86700000-0000-0000-0000-000000000001','86500000-0000-0000-0000-000000000001','reserved'
 FROM public.tables WHERE id='86100000-0000-0000-0000-000000000001';
INSERT INTO public.hand_state_snapshots(table_id,hand_number,state_json,config_json,dealer_seat,players_json,stage)
VALUES('86100000-0000-0000-0000-000000000001',8600001,'{"stage":"preflop"}','{}',1,'[]','preflop');

CREATE FUNCTION pg_temp.continuation_payload(seq bigint) RETURNS text LANGUAGE sql AS $$
 SELECT jsonb_build_object('version',1,'original',jsonb_build_object(
  'tournament_id',tournament_id::text,'lease_generation',generation::text,'table_id',table_id::text,
  'lifecycle',lifecycle::text,'permit_id',permit_id::text,'hand_number',hand_number::text,'custody_id',custody_id::text),
 'seats',(SELECT jsonb_agg(jsonb_build_object('user_id',user_id::text,'seat_id',id::text,
  'seat_joined_at',joined_at,'stack_before',stack) ORDER BY id) FROM public.table_seats WHERE table_id=h.table_id AND left_at IS NULL),
 'batch',jsonb_build_object('version',1,'sequence',seq,'controller','private-controller-qualification',
  'events',CASE WHEN seq=0 THEN '[]'::jsonb ELSE '[{"type":"TURN_CHANGE","seat":1,"availableActions":["fold","call"]}]'::jsonb END,
  'engine','{}'::jsonb))::text
 FROM smarter_private.f06_hand_permits h WHERE permit_id='86600000-0000-0000-0000-000000000001';
$$;
CREATE FUNCTION pg_temp.retain_continuation(seq bigint, payload text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.fn_f06_retain_hand_continuation('86000000-0000-0000-0000-000000000001',
  '86500000-0000-0000-0000-000000000001','86100000-0000-0000-0000-000000000001',8600001,seq,
  coalesce(payload,pg_temp.continuation_payload(seq)),
  encode(extensions.digest(coalesce(payload,pg_temp.continuation_payload(seq)),'sha256'),'hex'));
$$;
CREATE FUNCTION pg_temp.continuation_assert(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'CONTINUATION FAIL: %',label; END IF;
 RAISE NOTICE 'CONTINUATION PASS: %',label;
END $$;
DO $boundaries$
DECLARE denied boolean; role_name text; operation text;
BEGIN
 FOR role_name IN SELECT unnest(ARRAY['anon','authenticated','service_role']) LOOP
  denied:=false;
  BEGIN
   EXECUTE format('SET LOCAL ROLE %I',role_name);
   PERFORM 1 FROM smarter_private.hand_continuations;
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  RESET ROLE;
  PERFORM pg_temp.continuation_assert(denied,'private deck table denies direct read to '||role_name);
 END LOOP;
 FOR operation IN SELECT unnest(ARRAY['UPDATE smarter_private.hand_continuation_dispositions SET disposition=disposition',
  'DELETE FROM smarter_private.hand_continuation_dispositions','TRUNCATE smarter_private.hand_continuation_dispositions']) LOOP
  BEGIN
   INSERT INTO smarter_private.hand_continuation_dispositions VALUES('86100000-0000-0000-0000-000000000099',8600099,'retained');
   denied:=false;
   BEGIN EXECUTE operation; EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_SUBMISSION_IMMUTABLE'; END;
   PERFORM pg_temp.continuation_assert(denied,'continuation unique disposition immutable: '||operation);
   RAISE EXCEPTION 'restore disposition' USING ERRCODE='P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
 END LOOP;
 BEGIN
  INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,enforce_freeze,ownership_token)
   VALUES(true,'counting_down',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '4 minutes',true,'86800000-0000-0000-0000-000000000001');
  denied:=false;
  BEGIN PERFORM pg_temp.retain_continuation(0); EXCEPTION WHEN OTHERS THEN denied:=SQLERRM='PLATFORM_FROZEN'; END;
  PERFORM pg_temp.continuation_assert(denied AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_continuations),'maintenance freeze refuses retention before any private deck write');
  denied:=false;
  BEGIN PERFORM public.fn_f06_claim_hand_continuation('86000000-0000-0000-0000-000000000001',
   '86500000-0000-0000-0000-000000000001','86100000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN denied:=SQLERRM='PLATFORM_FROZEN'; END;
  PERFORM pg_temp.continuation_assert(denied,'maintenance freeze refuses claim even before capsule exists');
  RAISE EXCEPTION 'restore freeze' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
END $boundaries$;
DO $legacy$
DECLARE st jsonb; ctrl jsonb; payload text; token timestamptz; r jsonb; denied boolean;
BEGIN
 BEGIN
  UPDATE public.engine_tournament_leases SET lease_generation='86500000-0000-0000-0000-000000000002',heartbeat_at=clock_timestamp()
   WHERE tournament_id='86000000-0000-0000-0000-000000000001';
  PERFORM set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000002',true);
  st:=jsonb_build_object('stage','river','pot',2,'currentBet',0,'sawFlop',true,'currentPlayerSeat',1,
   'communityCards',jsonb_build_array('2d','3h','4s','5c','6d'),'communityCards2','[]'::jsonb,'communityCards3','[]'::jsonb,
   'actionHistory','[{"stage":"turn","publicNode":{"mode":"tournament","asset":"chips","bombPot":false,"allInOrFold":false,"boardCount":1,"street":"preflop","seats":[[1,9,1],[2,8,2]]}}]'::jsonb,
   'players',(SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat',seat_number,'stack',stack-1,'totalInvested',1,
    'bet',0,'is_all_in',false,'is_folded',false,'is_sitting_out',false,'returnedUncalled',0,
    'cards',CASE WHEN seat_number=1 THEN '["7d","8h","9s","Tc","Jd"]'::jsonb ELSE '["Qd","Kh","As","2c","3d"]'::jsonb END) ORDER BY seat_number)
    FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001'));
  UPDATE public.hand_state_snapshots SET state_json=st,stage='river',
   config_json='{"gameVariant":"plo5","tableId":"86100000-0000-0000-0000-000000000001","handNumber":8600001,"ante":0,"smallBlind":1,"bigBlind":2,"rakeConfig":{"percent":0,"cap":0},"bbjConfig":{"enabled":false}}',
   updated_at=clock_timestamp() WHERE hand_number=8600001 RETURNING updated_at INTO token;
  SELECT jsonb_build_object('version',1,'config',config_json||'{"isTournament":true,"asset":"chips"}', 'state',st,
   'deck','[]'::jsonb,'deckAvailability','unused_after_river','handStarted',true,'handCompleted',false,'handFsm','river',
   'postedBlindSeats','{"smallBlind":1,"bigBlind":2}'::jsonb,'riverCalled','[]'::jsonb,'activeBoardCount',1,'allInShowdownLocked',false,'allInRunoutWitness',NULL,
   'pineappleDiscardsRemaining','[]'::jsonb,'pineappleKnownDeadCards','[]'::jsonb,
   'preparedPineappleRunoutDiscards',NULL,'pendingPerPotAwards','[]'::jsonb)
   INTO ctrl FROM public.hand_state_snapshots WHERE hand_number=8600001;
  payload:=jsonb_set(pg_temp.continuation_payload(0)::jsonb,'{batch,controller}',to_jsonb(ctrl::text))::text;
  denied:=false;
  BEGIN PERFORM public.fn_f06_claim_legacy_river_continuation('86000000-0000-0000-0000-000000000001',
   '86500000-0000-0000-0000-000000000002','86100000-0000-0000-0000-000000000001',8600001,
   token-interval '1 second',payload,encode(extensions.digest(payload,'sha256'),'hex'));
  EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_CONTINUATION_LEGACY_ORIGINAL_UNPROVEN'; END;
  PERFORM pg_temp.continuation_assert(denied,'legacy snapshot optimistic token refuses stale evidence');
  r:=public.fn_f06_claim_legacy_river_continuation('86000000-0000-0000-0000-000000000001',
   '86500000-0000-0000-0000-000000000002','86100000-0000-0000-0000-000000000001',8600001,
   token,payload,encode(extensions.digest(payload,'sha256'),'hex'));
  PERFORM pg_temp.continuation_assert(r->>'ok'='true','exact saved unacted river anchors under successor');
  PERFORM pg_temp.continuation_assert((SELECT c.payload::jsonb#>>'{batch,controller}'=ctrl::text FROM smarter_private.hand_continuations c)
   AND (SELECT sum(stack)=20 FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001'),
   'legacy claim preserves exact saved river without cards actions or chip effects');
  denied:=false;
  BEGIN PERFORM public.complete_hand_snapshot('86100000-0000-0000-0000-000000000001',8600001);
  EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_CONTINUATION_UNSETTLED'; END;
  PERFORM pg_temp.continuation_assert(denied,'legacy original survives old snapshot cleanup');
  RAISE EXCEPTION 'restore legacy fixture' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
END $legacy$;
DO $cases$
DECLARE r jsonb; p text; denied boolean; value text; original text;
BEGIN
  PERFORM pg_temp.continuation_assert(NOT EXISTS(SELECT 1 FROM smarter_private.hand_continuations),'no invented original');
  denied:=false;
  BEGIN PERFORM pg_temp.retain_continuation(1); EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_CONTINUATION_ANCHOR_REQUIRED'; END;
  PERFORM pg_temp.continuation_assert(denied,'action cannot precede prepared deck anchor');
  original:=pg_temp.continuation_payload(0);
  r:=pg_temp.retain_continuation(0,original);
  PERFORM pg_temp.continuation_assert(r->>'ok'='true' AND r->>'sequence'='0','private anchor retained');
  PERFORM pg_temp.continuation_assert((SELECT payload=original FROM smarter_private.hand_continuations),'anchor bytes exact');
  r:=pg_temp.retain_continuation(0,original);
  PERFORM pg_temp.continuation_assert(r->>'ok'='true' AND (SELECT count(*)=1 FROM smarter_private.hand_continuations),'lost acknowledgement replays same original');
  denied:=false;
  BEGIN PERFORM pg_temp.retain_continuation(0,replace(original,'private-controller-qualification','another-deck'));
  EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_CONTINUATION_SEQUENCE_CHANGED'; END;
  PERFORM pg_temp.continuation_assert(denied,'same sequence different deck refuses');
  denied:=false;
  BEGIN PERFORM pg_temp.retain_continuation(2); EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_CONTINUATION_SEQUENCE_CHANGED'; END;
  PERFORM pg_temp.continuation_assert(denied,'missing action sequence refuses');
  r:=pg_temp.retain_continuation(1);
  PERFORM pg_temp.continuation_assert(r->>'ok'='true' AND r->>'sequence'='1','next original action retained');
  denied:=false;
  BEGIN PERFORM public.complete_hand_snapshot('86100000-0000-0000-0000-000000000001',8600001);
  EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_CONTINUATION_UNSETTLED'; END;
  PERFORM pg_temp.continuation_assert(denied AND EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE hand_number=8600001 AND NOT is_complete),'legacy startup cannot discard retained unfinished hand');
  denied:=false;
  BEGIN UPDATE smarter_private.f06_hand_permits SET state='never_started',evidence_id=permit_id
   WHERE permit_id='86600000-0000-0000-0000-000000000001';
  EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_CONTINUATION_UNSETTLED'; END;
  PERFORM pg_temp.continuation_assert(denied AND EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE hand_number=8600001 AND state='reserved'),'permit disposition cannot erase unfinished original');
  denied:=false;
  BEGIN PERFORM set_config('request.jwt.claim.role','authenticated',true); PERFORM pg_temp.retain_continuation(2);
  EXCEPTION WHEN SQLSTATE '42501' THEN denied:=SQLERRM='F06_PROTOCOL2_REQUIRED'; END;
  PERFORM pg_temp.continuation_assert(denied,'browser actor cannot write private deck');
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  UPDATE public.engine_tournament_leases SET lease_generation='86500000-0000-0000-0000-000000000002',heartbeat_at=clock_timestamp()
   WHERE tournament_id='86000000-0000-0000-0000-000000000001';
  denied:=false;
  BEGIN PERFORM pg_temp.retain_continuation(2); EXCEPTION WHEN SQLSTATE '42501' THEN denied:=SQLERRM='F06_LEASE_FENCED'; END;
  PERFORM pg_temp.continuation_assert(denied,'dead writer cannot append another action');
  PERFORM set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000002',true);
  r:=public.fn_f06_claim_hand_continuation('86000000-0000-0000-0000-000000000001',
    '86500000-0000-0000-0000-000000000002','86100000-0000-0000-0000-000000000001');
  PERFORM pg_temp.continuation_assert(r->>'ok'='true' AND r#>>'{continuation,sequence}'='1','successor claims latest original');
  PERFORM pg_temp.continuation_assert((SELECT original_generation='86500000-0000-0000-0000-000000000001'
    AND writer_generation='86500000-0000-0000-0000-000000000002' FROM smarter_private.hand_continuations),'claim preserves original immutable generation');
  PERFORM pg_temp.continuation_assert((SELECT sum(stack)=20 FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001')
    AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001'),'claim neither moves nor pays chips');
  r:=public.fn_f06_claim_hand_continuation('86000000-0000-0000-0000-000000000001',
    '86500000-0000-0000-0000-000000000002','86100000-0000-0000-0000-000000000001');
  PERFORM pg_temp.continuation_assert(r#>>'{continuation,sequence}'='1','repeated claim preserves same continuation');
  -- A paid add-on must be carried by its native financial semantics. This
  -- recovery cannot erase it to make the old baseline match.
  denied:=false;
  BEGIN
    UPDATE public.table_seats SET stack=stack+10 WHERE id='86300000-0000-0000-0000-000000000001';
    PERFORM public.fn_f06_claim_hand_continuation('86000000-0000-0000-0000-000000000001',
      '86500000-0000-0000-0000-000000000002','86100000-0000-0000-0000-000000000001');
  EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_CONTINUATION_ROSTER_CHANGED'; END;
  PERFORM pg_temp.continuation_assert(denied,'changed durable stack cannot be overwritten by recovery');
END $cases$;
DO $terminal$
DECLARE q jsonb; r jsonb; payload text; final_stacks jsonb;
BEGIN
 payload:=jsonb_set(pg_temp.continuation_payload(2)::jsonb,'{batch,controller}',to_jsonb('{"handCompleted":true}'::text))::text;
 PERFORM public.fn_f06_retain_hand_continuation('86000000-0000-0000-0000-000000000001',
  '86500000-0000-0000-0000-000000000002','86100000-0000-0000-0000-000000000001',8600001,2,
  payload,encode(extensions.digest(payload,'sha256'),'hex'));
 q:=jsonb_build_object('p_table_id','86100000-0000-0000-0000-000000000001','p_hand_number',8600001,
  'p_stacks',pg_temp.atomic_hand_stacks(),'p_rake',0,'p_bbj',0,'p_ref','atomic-zero-seat','p_inflow',0,
  'p_hand_row',pg_temp.atomic_hand_row()||jsonb_build_object('started_at',clock_timestamp()),'p_units','[]'::jsonb,'p_instance_id','atomic-hand-boundary-probe',
  'p_lease_generation','86500000-0000-0000-0000-000000000002','p_post_commit_obligations',pg_temp.atomic_hand_obligations());
 r:=public.fn_ca_retain_hand_submission(q);
 PERFORM pg_temp.continuation_assert(r->>'retained'='true','claimed terminal controller retains final request under current writer');
 BEGIN
  -- A second process may arrive after final retention and before acceptance.
  UPDATE public.engine_tournament_leases SET instance_id='successor-two',
   lease_generation='86500000-0000-0000-0000-000000000003',heartbeat_at=clock_timestamp()
   WHERE tournament_id='86000000-0000-0000-0000-000000000001';
  PERFORM set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000003',true);
  r:=public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001',
   'successor-two','86500000-0000-0000-0000-000000000003');
  RAISE NOTICE 'claimed final retention successor result: %',r;
  PERFORM pg_temp.continuation_assert(r->>'completed'='true' AND r->>'financial_handoff'='true'
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_continuations),
   'second restart after final retention settles exact recovered original once');
  RAISE EXCEPTION 'restore second-restart fixture' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
 r:=public.fn_ca_commit_hand_submission('86400000-0000-0000-0000-000000000001',
  'atomic-hand-boundary-probe','86500000-0000-0000-0000-000000000002');
 RAISE NOTICE 'claimed terminal result: %',r;
 PERFORM pg_temp.continuation_assert(r->>'success'='true' AND r->>'atomic_hand_commit'='true','claimed original settles through actual atomic financial owner');
 BEGIN
  UPDATE public.engine_tournament_leases SET instance_id='successor-two',
   lease_generation='86500000-0000-0000-0000-000000000003',heartbeat_at=clock_timestamp()
   WHERE tournament_id='86000000-0000-0000-0000-000000000001';
  PERFORM set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000003',true);
  r:=public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001',
   'successor-two','86500000-0000-0000-0000-000000000003');
  PERFORM pg_temp.continuation_assert(r->>'completed'='true' AND r->>'post_commit_completed'='true'
   AND (SELECT count(*)=1 FROM public.hand_atomic_commits),
   'second restart after atomic acceptance completes postcommit without another payout');
  RAISE EXCEPTION 'restore postcommit-restart fixture' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
 r:=public.fn_ca_process_hand_post_commit_obligations('86400000-0000-0000-0000-000000000001');
 PERFORM pg_temp.continuation_assert(r->>'ok'='true','actual postcommit obligations complete');
 r:=public.fn_f06_finish_hand('86000000-0000-0000-0000-000000000001','86500000-0000-0000-0000-000000000002',
  '86600000-0000-0000-0000-000000000001','accepted','86400000-0000-0000-0000-000000000001');
 PERFORM pg_temp.continuation_assert(r->>'generation'='86500000-0000-0000-0000-000000000001'
  AND r->>'state'='accepted' AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_continuations),'accepted original keeps identity and deletes private unused deck inline');
 SELECT jsonb_agg(to_jsonb(s) ORDER BY id) INTO final_stacks FROM public.table_seats s WHERE table_id='86100000-0000-0000-0000-000000000001';
 r:=public.fn_ca_commit_hand_submission('86400000-0000-0000-0000-000000000001',
  'atomic-hand-boundary-probe','86500000-0000-0000-0000-000000000002');
 PERFORM pg_temp.continuation_assert(r->>'success'='true' AND (SELECT count(*)=1 FROM public.hand_atomic_commits)
  AND final_stacks=(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.table_seats s WHERE table_id='86100000-0000-0000-0000-000000000001'),
  'lost final acknowledgement cannot pay or alter stacks twice');
 PERFORM pg_temp.continuation_assert((SELECT sum(stack)=20 FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001'),
  'claimed original final payout conserves tournament chips');
END $terminal$;
SELECT 'HAND_CONTINUATION_NATIVE_PASS';
