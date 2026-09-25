-- A superseded original hands off its retained hand (2026-09-22).
-- Composed after the hand-submission-native opening (tournament 86000000...,
-- table 86100000..., hand 8600001, original generation 86500000...01) and run
-- inside one transaction the harness rolls back.
--
-- Production recorded this shape 69 times on 2026-09-18: the original retained
-- its exact request, its in-process lease proof expired, it never dispatched,
-- and the same process claimed the tournament lease again under a NEW
-- generation. No receipt, no failure row, no handoff and no dispatch exist.
SELECT public.fn_ca_retain_hand_submission(pg_temp.submission_request());
DO $superseded_same_generation$
DECLARE r jsonb;
BEGIN
 BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id','86000000-0000-0000-0000-000000000001',true);
  PERFORM set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000001',true);
  UPDATE public.tables SET lifecycle=NULL WHERE id='86100000-0000-0000-0000-000000000001';
  r:=public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','atomic-hand-boundary-probe','86500000-0000-0000-0000-000000000001');
  PERFORM pg_temp.submission_assert(r->>'completed'='false' AND r->>'reason'='original_failure_or_handoff_unproven'
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs)
   AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001'),
   'superseded: the original generation is never its own successor');
  RAISE EXCEPTION 'restore same generation fixture' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
END $superseded_same_generation$;
DO $superseded_generation$
DECLARE r jsonb; c record; before_seats jsonb; after_seats jsonb; receipt jsonb; expected jsonb;
BEGIN
 BEGIN
  PERFORM pg_temp.submission_assert(NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_failures)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch)
   AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001'),
   'superseded: the original left no receipt, failure, handoff or dispatch');
  -- The original's heartbeats stop; the real claim door installs a new generation.
  UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '1 hour'
   WHERE tournament_id='86000000-0000-0000-0000-000000000001';
  SELECT * INTO c FROM public.claim_tournament_lease_v2('86000000-0000-0000-0000-000000000001','successor-one',NULL,'86500000-0000-0000-0000-000000000002',30);
  PERFORM pg_temp.submission_assert(c.granted AND c.lease_generation='86500000-0000-0000-0000-000000000002','superseded: real claim installs the successor generation');
  -- Production tournament tables never carry lifecycle 'live'.
  UPDATE public.tables SET lifecycle=NULL WHERE id='86100000-0000-0000-0000-000000000001';
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id','86000000-0000-0000-0000-000000000001',true);
  PERFORM set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000002',true);
  SELECT jsonb_agg(jsonb_build_object('id',id,'stack',stack) ORDER BY id) INTO before_seats FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001';
  SELECT jsonb_agg(jsonb_build_object('id',(x->>'seat_id')::uuid,'stack',(x->>'stack')::numeric) ORDER BY (x->>'seat_id')::uuid) INTO expected
   FROM jsonb_array_elements((SELECT request->'p_stacks' FROM smarter_private.hand_submissions)) x;
  PERFORM pg_temp.submission_assert((SELECT bool_and(seat.stack=(x->>'stack_before')::numeric) FROM jsonb_array_elements((SELECT request->'p_stacks' FROM smarter_private.hand_submissions)) x
   JOIN public.table_seats seat ON seat.id=(x->>'seat_id')::uuid),'superseded: every seat still holds its recorded stack_before');
  r:=public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  RAISE NOTICE 'superseded successor outcome: %',r;
  PERFORM pg_temp.submission_assert(r->>'completed'='true' AND r->>'financial_handoff'='true' AND r->>'post_commit_completed'='true'
   AND r->>'submission_id'='86400000-0000-0000-0000-000000000001' AND r->>'history_id'='86400000-0000-0000-0000-000000000001',
   'superseded: the current generation continues the retained original once');
  SELECT jsonb_agg(jsonb_build_object('id',id,'stack',stack) ORDER BY id) INTO after_seats FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001';
  PERFORM pg_temp.submission_assert(after_seats=expected AND (SELECT sum(stack)=20 FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001'),
   'superseded: seats move once, from the recorded before-stacks to the retained result');
  PERFORM pg_temp.submission_assert((SELECT count(*)=1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001'
    AND hand_id='86400000-0000-0000-0000-000000000001' AND post_commit_result->>'ok'='true')
   AND (SELECT count(*)=1 FROM public.hand_history WHERE table_id='86100000-0000-0000-0000-000000000001' AND hand_number=8600001),
   'superseded: exactly one receipt and one hand row');
  PERFORM pg_temp.submission_assert((SELECT count(*)=1 FROM smarter_private.hand_submission_handoffs
    WHERE original_generation='86500000-0000-0000-0000-000000000001' AND lease_generation='86500000-0000-0000-0000-000000000002' AND instance_id='successor-one')
   AND (SELECT result->>'handoff_evidence'='superseded_generation' FROM smarter_private.hand_submission_handoff_results)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_failures)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch),
   'superseded: one spent claim records the superseded generation, no failure is invented');
  PERFORM pg_temp.submission_assert((SELECT state='accepted' AND generation='86500000-0000-0000-0000-000000000001' AND evidence_id='86400000-0000-0000-0000-000000000001'
    FROM smarter_private.f06_hand_permits WHERE permit_id='86600000-0000-0000-0000-000000000001')
   AND NOT EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id='86100000-0000-0000-0000-000000000001' AND NOT is_complete),
   'superseded: the original permit finishes accepted and its snapshot completes');
  SELECT jsonb_agg(to_jsonb(a)) INTO receipt FROM public.hand_atomic_commits a WHERE table_id='86100000-0000-0000-0000-000000000001';
  r:=public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  PERFORM pg_temp.submission_assert(r->>'found'='false'
   AND receipt=(SELECT jsonb_agg(to_jsonb(a)) FROM public.hand_atomic_commits a WHERE table_id='86100000-0000-0000-0000-000000000001')
   AND (SELECT count(*)=1 FROM smarter_private.hand_submission_handoffs),'superseded: a repeated start has no second financial effect');
  -- The original door, still presenting its superseded generation, is fenced.
  r:=pg_temp.commit_submission();
  RAISE NOTICE 'superseded original replay outcome: %',r;
  PERFORM pg_temp.submission_assert(r->>'success'='false' AND r->>'reason'='hand_lease_lost'
   AND after_seats=(SELECT jsonb_agg(jsonb_build_object('id',id,'stack',stack) ORDER BY id) FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001')
   AND receipt=(SELECT jsonb_agg(to_jsonb(a)) FROM public.hand_atomic_commits a WHERE table_id='86100000-0000-0000-0000-000000000001')
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_failures),
   'superseded: the fenced original cannot settle again');
  -- Even if the original generation held the lease again, it only replays.
  UPDATE public.engine_tournament_leases SET instance_id='atomic-hand-boundary-probe',lease_generation='86500000-0000-0000-0000-000000000001',heartbeat_at=clock_timestamp()
   WHERE tournament_id='86000000-0000-0000-0000-000000000001';
  BEGIN
   r:=pg_temp.commit_submission();
  EXCEPTION WHEN OTHERS THEN r:=jsonb_build_object('raised',SQLSTATE,'error',SQLERRM);
  END;
  RAISE NOTICE 'resurrected original outcome: %',r;
  PERFORM pg_temp.submission_assert(after_seats=(SELECT jsonb_agg(jsonb_build_object('id',id,'stack',stack) ORDER BY id) FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001')
   AND (SELECT count(*)=1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001')
   AND (SELECT payload_hash FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001')=(receipt->0->>'payload_hash')
   AND (SELECT count(*)=1 FROM public.hand_history WHERE table_id='86100000-0000-0000-0000-000000000001' AND hand_number=8600001),
   'superseded: an original that holds the lease again moves no chip and adds no receipt');
  RAISE EXCEPTION 'restore superseded fixture' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
END $superseded_generation$;
DO $superseded_changed_seat$
DECLARE denied boolean:=false; c record;
BEGIN
 BEGIN
  UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '1 hour'
   WHERE tournament_id='86000000-0000-0000-0000-000000000001';
  SELECT * INTO c FROM public.claim_tournament_lease_v2('86000000-0000-0000-0000-000000000001','successor-one',NULL,'86500000-0000-0000-0000-000000000002',30);
  UPDATE public.tables SET lifecycle=NULL WHERE id='86100000-0000-0000-0000-000000000001';
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id','86000000-0000-0000-0000-000000000001',true);
  PERFORM set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000002',true);
  UPDATE public.table_seats SET joined_at=joined_at+interval '1 second' WHERE id='86300000-0000-0000-0000-000000000001';
  BEGIN PERFORM public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_SUBMISSION_HANDOFF_STATE_CHANGED'; END;
  PERFORM pg_temp.submission_assert(denied AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs)
   AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001'),
   'superseded: a changed seat still refuses before any financial claim');
  UPDATE public.table_seats SET joined_at=joined_at-interval '1 second' WHERE id='86300000-0000-0000-0000-000000000001';
  UPDATE public.tables SET lifecycle='breaking' WHERE id='86100000-0000-0000-0000-000000000001';
  denied:=false;
  BEGIN PERFORM public.fn_ca_resume_hand_submission('86100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  EXCEPTION WHEN SQLSTATE '55000' THEN denied:=SQLERRM='HAND_SUBMISSION_TABLE_NOT_ADMITTED'; END;
  PERFORM pg_temp.submission_assert(denied AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs),
   'superseded: a breaking tournament table is still not admitted');
  RAISE EXCEPTION 'restore changed seat fixture' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
END $superseded_changed_seat$;
DO $superseded_cash$
DECLARE q jsonb; r jsonb; c record;
BEGIN
 BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  INSERT INTO public.cash_games(id,club_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot)
   VALUES('86900000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Superseded Cash Probe','classic','nlh',1,2,6,'{}');
  PERFORM set_config('session_replication_role','replica',true);
  INSERT INTO public.tables(id,name,tournament_id,game_type,game_variant,status,lifecycle,club_id,small_blind,big_blind,cluster_id,seat_game_scope,seat_admission_key)
   VALUES('87100000-0000-0000-0000-000000000001','Superseded cash',NULL,'cash','nlh','running','live',
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
  -- The original never dispatches. Its heartbeats stop and the real cash claim
  -- door installs the successor generation.
  UPDATE public.engine_table_leases SET heartbeat_at=clock_timestamp()-interval '1 hour'
   WHERE table_id='87100000-0000-0000-0000-000000000001';
  SELECT * INTO c FROM public.claim_table_lease_v2('87100000-0000-0000-0000-000000000001','successor-one',NULL,'86500000-0000-0000-0000-000000000002',30);
  r:=public.fn_ca_resume_hand_submission('87100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  RAISE NOTICE 'superseded cash successor outcome: %',r;
  PERFORM pg_temp.submission_assert(c.granted AND r->>'completed'='true' AND r->>'financial_handoff'='true' AND r->>'post_commit_completed'='true'
   AND r->'permit_id'='null'::jsonb
   AND (SELECT count(*)=1 FROM public.hand_atomic_commits WHERE table_id='87100000-0000-0000-0000-000000000001' AND post_commit_result->>'ok'='true')
   AND (SELECT sum(stack)=20 FROM public.table_seats WHERE table_id='87100000-0000-0000-0000-000000000001')
   AND (SELECT result->>'handoff_evidence'='superseded_generation' FROM smarter_private.hand_submission_handoff_results
     WHERE submission_id='87400000-0000-0000-0000-000000000001')
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_failures)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch),
   'superseded: a cash successor continues an undispatched original once');
  r:=public.fn_ca_resume_hand_submission('87100000-0000-0000-0000-000000000001','successor-one','86500000-0000-0000-0000-000000000002');
  PERFORM pg_temp.submission_assert(r->>'found'='false' AND (SELECT count(*)=1 FROM smarter_private.hand_submission_handoffs),
   'superseded: a cash restart spends no second claim');
  RAISE EXCEPTION 'restore superseded cash fixture' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
END $superseded_cash$;
SELECT 'HAND_SUBMISSION_SUPERSEDED_PASS';
