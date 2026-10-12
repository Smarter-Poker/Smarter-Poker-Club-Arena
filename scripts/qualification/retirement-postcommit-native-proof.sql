SET request.jwt.claim.role='service_role'; SET request.jwt.claims='{"role":"service_role"}';
BEGIN;SET LOCAL session_replication_role=replica;
DO $seed$
DECLARE i integer;j integer;event integer;np integer;na integer;uid uuid;tid uuid;eid uuid;
 profile public.profiles;roster public.tournament_players;seat public.table_seats;
 counts integer[]:=ARRAY[1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,1,1,1,1,1,1,1,3,1,1,1,1,1,1,1,1,1,1,1,1,1,2,2,2,1,1,1,1,1,1,2,1,1,1,1,2,1,2,1,1,1,1,1];
BEGIN
 FOR i IN 58..58 LOOP
  event:=CASE WHEN i<=4 THEN 1 ELSE i-3 END;
  na:=counts[i];np:=CASE WHEN i<=53 THEN 3 ELSE 2 END;
  tid:=retirement_native.fixture_id(1,i);eid:=retirement_native.fixture_id(2,event);
  INSERT INTO retirement_native.cases VALUES(i,tid,eid,retirement_native.fixture_id(3,i),retirement_native.fixture_id(4,event),retirement_native.fixture_id(5,event),na,np);
  INSERT INTO public.tournaments
  SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object('id',eid,'name','Retirement original synthetic event '||event,'status','RUNNING','format_contract','mtt-v1','started_at','2026-09-08T12:00:00+00:00','start_time','2026-09-08T12:00:00+00:00','created_at','2026-09-08T11:00:00+00:00','current_players',12,'max_players',60,'current_level',1,'club_id','a0000000-0000-0000-0000-000000000001'))).* FROM public.tournaments t WHERE id='86000000-0000-0000-0000-000000000001' ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,game_variant,club_id,max_players,seat_game_scope,seat_admission_key,small_blind,big_blind) VALUES(tid,'Retirement original synthetic table '||i,eid,'running',NULL,np,'tournament','nlh','a0000000-0000-0000-0000-000000000001',6,'table:'||tid,'tournament:'||eid,1,2);
  INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,lease_generation,protocol_version,heartbeat_at)
   VALUES(eid,'synthetic-original',retirement_native.fixture_id(4,event),2,clock_timestamp()) ON CONFLICT(tournament_id) DO NOTHING;
  FOR j IN 1..np LOOP
   uid:=retirement_native.fixture_id(6,i*10+j);
   INSERT INTO auth.users(id) VALUES(uid);
   INSERT INTO public.users(id,username) VALUES(uid,'retirement_synthetic_'||i||'_'||j);
   INSERT INTO public.profiles(id,username,display_name,is_horse,status,horse_status) VALUES(uid,'retirement_synthetic_'||i||'_'||j,'Synthetic paid entrant',true,'active','active');
   INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES('a0000000-0000-0000-0000-000000000001',uid,'player','active',0);
   INSERT INTO public.tournament_players
   SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(tp)||jsonb_build_object('id',retirement_native.fixture_id(7,i*10+j),'tournament_id',eid,'user_id',uid,'chips',100,'status','playing','table_id',tid,'seat_number',j,'position',NULL,'prize',0,'eliminated_at',NULL,'elimination_sequence',NULL,'add_on',false,'rebuys',0))).* FROM public.tournament_players tp WHERE id='86200000-0000-0000-0000-000000000001';
   INSERT INTO public.table_seats
   SELECT (jsonb_populate_record(NULL::public.table_seats,to_jsonb(s)||jsonb_build_object('club_id','a0000000-0000-0000-0000-000000000001','id',retirement_native.fixture_id(8,i*10+j),'table_id',tid,'user_id',uid,'seat_number',j,'stack',100,'left_at',NULL,'status','active','joined_at','2026-09-08T12:00:00+00:00','occupancy_id',retirement_native.fixture_id(9,i*10+j),'is_sitting_out',false,'active_game_scope','table:'||tid,'active_parent_key','tournament:'||eid))).* FROM public.table_seats s WHERE id='86300000-0000-0000-0000-000000000001';
  END LOOP;
 END LOOP;
END $seed$;
SET LOCAL session_replication_role=origin;COMMIT;
CREATE TRIGGER zz_retirement_original_failure BEFORE INSERT ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION retirement_native.submission_fault();
DO $retention$
DECLARE c retirement_native.cases;q jsonb;stacks jsonb;players jsonb;tb jsonb;r jsonb;
BEGIN
 FOR c IN SELECT * FROM retirement_native.cases WHERE i=58 ORDER BY i LOOP
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id',c.tournament_id::text,true);
  PERFORM set_config('app.smarter_tournament_lease_generation',c.original_generation::text,true);
  UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id=c.tournament_id;
  INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state)
   VALUES(retirement_native.fixture_id(10,c.i),c.tournament_id,c.table_id,1,9700000+c.i,retirement_native.fixture_id(11,c.i),c.original_generation,'reserved');
  INSERT INTO public.hand_state_snapshots(table_id,hand_number,state_json,config_json,dealer_seat,players_json,stage)
   VALUES(c.table_id,9700000+c.i,'{"stage":"river"}','{}',1,'[]','river');
  SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,'seat_joined_at',s.joined_at,'stack_before',100,'stack',CASE s.seat_number WHEN 1 THEN 99 WHEN 2 THEN 101 ELSE 100 END) ORDER BY s.seat_number),
   jsonb_agg(jsonb_build_object('user_id',s.user_id,'stack',CASE s.seat_number WHEN 1 THEN 99 WHEN 2 THEN 101 ELSE 100 END) ORDER BY s.seat_number),
   jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,'seat_joined_at',s.joined_at,'uses_remaining',3,'seconds_remaining',17) ORDER BY s.seat_number)
   INTO stacks,players,tb FROM public.table_seats s WHERE s.table_id=c.table_id;
  q:=jsonb_build_object('p_table_id',c.table_id,'p_hand_number',9700000+c.i,'p_stacks',stacks,'p_rake',0,'p_bbj',0,'p_ref','retirement-synthetic-original','p_inflow',0,'p_units','[]'::jsonb,'p_instance_id','synthetic-original','p_lease_generation',c.original_generation,
   'p_hand_row',jsonb_build_object('id',c.submission_id,'table_id',c.table_id,'tournament_id',c.tournament_id,'hand_number',9700000+c.i,'started_at','2026-09-08T12:00:02+00:00','ended_at','2026-09-08T12:00:03+00:00','game_variant','nlh','small_blind',1,'big_blind',2,'pot_size',2,'rake_amount',0,'bbj_amount',0,'players',players,'actions','[]'::jsonb,'winners',jsonb_build_array(jsonb_build_object('user_id',retirement_native.fixture_id(6,c.i*10+2),'amount',2)),'_accepted_post_commit_facts',jsonb_build_object('contributions',jsonb_build_object(retirement_native.fixture_id(6,c.i*10+1)::text,1,retirement_native.fixture_id(6,c.i*10+2)::text,1),'returned_uncalled','{}'::jsonb,'insurance','[]'::jsonb)),
   'p_post_commit_obligations',jsonb_build_object('version','1','time_banks',tb,'promo_playthrough','[]'::jsonb,'insurance','[]'::jsonb,'pending_addons',NULL,'rake',NULL,'bbj_contribution',NULL));
  r:=public.fn_ca_retain_hand_submission(q);
  IF r->>'retained' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'synthetic original not retained %',r; END IF;
  r:=public.fn_ca_commit_hand_submission(c.submission_id,'synthetic-original',c.original_generation);
  IF r->>'success' IS DISTINCT FROM 'false' OR (r->>'error' IS DISTINCT FROM 'isolated accepted-hand storage interruption' AND r->>'sqlstate' IS DISTINCT FROM 'XX000') OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=c.table_id) THEN RAISE EXCEPTION 'original fault not atomic %',r; END IF;
 END LOOP;
END $retention$;
DROP TRIGGER zz_retirement_original_failure ON public.hand_projection_outbox;
BEGIN;SET LOCAL session_replication_role=replica;
DO $force$
DECLARE c retirement_native.cases;j integer;uid uuid;
BEGIN
 FOR c IN SELECT * FROM retirement_native.cases WHERE i=58 ORDER BY i LOOP
  FOR j IN 1..c.affected LOOP
   uid:=retirement_native.fixture_id(6,c.i*10+j);
   UPDATE public.profiles SET status='deleted',horse_status='disabled' WHERE id=uid;
   INSERT INTO smarter_private.patterned_identity_retirements(old_id,cohort,username_before,display_name_before,full_name_before,alias_before,avatar_url_before,arena_avatar_url_before,cover_photo_url_before,bio_before,status_text_before,status_before,is_online_before,horse_status_before,users_username_before,users_avatar_url_before,tombstone,benched_at,retired_at)
    VALUES(uid,'horse','synthetic','synthetic','','','','','','','','active',false,'active','synthetic','','synthetic','2026-10-06 15:07:13Z','2026-10-06 15:41:00Z');
   UPDATE public.tournament_players SET status='eliminated',eliminated_at='2026-10-06 15:33:05Z' WHERE tournament_id=c.tournament_id AND user_id=uid;
   UPDATE public.table_seats SET left_at='2026-10-06 15:33:04.8Z',status='left',is_sitting_out=true,active_game_scope=NULL,active_parent_key=NULL WHERE table_id=c.table_id AND user_id=uid;
  END LOOP;
 END LOOP;
 UPDATE public.engine_tournament_leases l SET instance_id='synthetic-successor',lease_generation=cx.successor_generation,heartbeat_at=clock_timestamp() FROM retirement_native.cases cx WHERE l.tournament_id=cx.tournament_id AND cx.i=58;
END $force$;
INSERT INTO smarter_private.retirement_original_hand_qualification
SELECT s.submission_id,s.request_hash,c.table_id,c.tournament_id,s.hand_number,
 jsonb_build_object('submission_id',s.submission_id,'request_hash',s.request_hash,'table_id',c.table_id,'tournament_id',c.tournament_id,'hand_number',s.hand_number,'rows',(
 SELECT jsonb_agg(jsonb_build_object('user_id',tp.user_id,'stack',x,'roster',(
  SELECT jsonb_object_agg(key,value) FROM jsonb_each(to_jsonb(tp)) WHERE key=ANY(ARRAY['id','user_id','tournament_id','status','chips','position','prize','table_id','seat_number','rebuys','add_on','eliminated_at','current_bounty','bounty_winnings','bounties_collected','rebuy_prompt_until','elimination_sequence'])),
 'seat',(SELECT jsonb_object_agg(key,value) FROM jsonb_each(to_jsonb(ts)) WHERE key=ANY(ARRAY['id','table_id','user_id','club_id','seat_number','joined_at','occupancy_id','stack','left_at','status','is_sitting_out','is_away','leave_pending','active_game_scope','active_parent_key']))) ORDER BY tp.user_id)
 FROM public.tournament_players tp JOIN public.table_seats ts ON ts.table_id=c.table_id AND ts.user_id=tp.user_id
 CROSS JOIN LATERAL jsonb_array_elements(s.request->'p_stacks')x
 WHERE tp.tournament_id=c.tournament_id AND tp.status='eliminated' AND x->>'user_id'=tp.user_id::text))
FROM retirement_native.cases c JOIN smarter_private.hand_submissions s ON s.submission_id=c.submission_id WHERE c.i=58;
SET LOCAL session_replication_role=origin;COMMIT;
CREATE FUNCTION retirement_native.postcommit_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF OLD.post_commit_completed_at IS NULL AND NEW.post_commit_completed_at IS NOT NULL AND NEW.table_id=retirement_native.fixture_id(1,58) THEN RAISE EXCEPTION 'isolated postcommit completion interruption' USING ERRCODE='XX000'; END IF; RETURN NEW; END$$;
CREATE TRIGGER zz_retirement_postcommit_fault BEFORE UPDATE ON public.hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION retirement_native.postcommit_fault();
DO $$DECLARE r jsonb;BEGIN
r:=retirement_native.resume_case(58); RAISE NOTICE 'pending first outcome: %',r;
PERFORM retirement_native.assert_true(r->>'completed'='false' AND r->>'reason'='accepted_postcommit_pending' AND r->>'atomic_hand_commit'='true','qualified original financial acceptance persists through postcommit refusal');
PERFORM retirement_native.assert_true((SELECT count(*)=1 FROM public.hand_atomic_commits WHERE table_id=retirement_native.fixture_id(1,58)) AND (SELECT count(*)=1 FROM smarter_private.retirement_original_hand_restorations WHERE submission_id=retirement_native.fixture_id(3,58)),'one financial acceptance and one restoration on pending postcommit');
END$$;
DROP TRIGGER zz_retirement_postcommit_fault ON public.hand_atomic_commits;
DO $$DECLARE r jsonb;BEGIN
r:=retirement_native.resume_case(58); RAISE NOTICE 'pending continuation outcome: %',r;
PERFORM retirement_native.assert_true(r->>'completed'='true' AND r->>'financial_handoff'='false' AND r->>'post_commit_completed'='true','same accepted original resumes only remaining postcommit without another financial claim');
r:=retirement_native.resume_case(58); PERFORM retirement_native.assert_true(r->>'found'='false','acknowledgement-loss replay remains completed');
END$$;
-- Exact kernels independently matched by the original isolated qualification
-- and production read-only witness. These pins describe that proof, not future
-- product readiness or permission to replace a newer financial owner.
DO $$DECLARE r record;BEGIN
FOR r IN SELECT * FROM(VALUES
('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)','e9d96bfefffef41bc22b6b6f2d5da452','650835c504d7fffa6a481806936dd306'),
('public.fn_ca_process_hand_post_commit_obligations(uuid)','8d18dde12765610895b25e297a1f403f','9672653f9e15a45072de3b60ce5b0b2f'),
('public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)','3571d2b9553a9b8832cdd8e72d2ab871','544d493503612900f4ad039d9b7d27a6'),
('public.fn_ca_reject_automated_user_club_row()','7c73094df30c90f94a78cbbd5d24f504','cf49d581f597ce8235f3a30073bd54f6'),
('public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)','f85ee8fbf794e9087926715fd340499d','6e92e7d8d9d65371909d19856171ddf0'))v(signature,full_hash,body_hash) LOOP
PERFORM retirement_native.assert_true((SELECT md5(pg_get_functiondef(oid))=r.full_hash AND md5(prosrc)=r.body_hash AND proowner='postgres'::regrole AND prosecdef FROM pg_proc WHERE oid=r.signature::regprocedure),'exact current native kernel witness '||r.signature);
END LOOP;END$$;
SELECT p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid)),md5(p.prosrc),pg_get_userbyid(p.proowner),p.prosecdef,p.proconfig,p.proacl FROM pg_proc p WHERE p.proname IN('fn_ca_commit_hand_settlement','fn_ca_settle_hand_stacks_absolute','fn_ca_process_hand_post_commit_obligations','fn_f06_finish_hand','fn_ca_reject_automated_user_club_row');
