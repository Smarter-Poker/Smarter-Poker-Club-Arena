-- Index shapes corresponding to production; these minimal source fixtures did
-- not previously need the candidate indexes for tiny replay tests.
CREATE UNIQUE INDEX fixture_candidate_id ON tournament_knockout_candidates(id);
CREATE UNIQUE INDEX fixture_candidate_event_hand_user ON tournament_knockout_candidates(tournament_id,hand_number,eliminated_user_id);
CREATE UNIQUE INDEX fixture_obligation_id ON tournament_bounty_obligations(id);
CREATE INDEX fixture_obligation_event_hand_user ON tournament_bounty_obligations(tournament_id,hand_number,eliminated_user_id);
BEGIN;
DO $$
DECLARE x jsonb;t uuid;a uuid;b uuid;c uuid;d uuid;tb uuid;r jsonb;k record;
 count_now integer:=0;goal integer;started timestamptz;
BEGIN
 x:=fixture_chain();t:=(x->>'t')::uuid;a:=(x->>'a')::uuid;b:=(x->>'b')::uuid;c:=(x->>'c')::uuid;d:=(x->>'d')::uuid;
 SELECT * INTO k FROM tournament_knockout_candidates WHERE tournament_id=t AND eliminated_user_id=b;
 tb:=k.table_id;r:=fixture_claim(t,a,b,4);r:=fn_collect_bounty_obligation((r->>'obligation_id')::uuid);
 CREATE TEMP TABLE added_candidates(i int,u uuid,h uuid) ON COMMIT DROP;
 FOREACH goal IN ARRAY ARRAY[0,1000,9998,10000] LOOP
  TRUNCATE added_candidates;
  INSERT INTO added_candidates SELECT i,gen_random_uuid(),gen_random_uuid() FROM generate_series(count_now+1,goal) i;
  INSERT INTO hand_history(id,table_id,tournament_id,hand_number,created_at,players,pots,winners)
   SELECT h,tb,t,7000000+i,now()-interval '61 seconds',
     jsonb_build_array(jsonb_build_object('userId',u,'stack',0),jsonb_build_object('userId',d,'stack',2000)),
     jsonb_build_array(jsonb_build_object('index',0,'amount',2000,'eligible',jsonb_build_array(u,d))),
     jsonb_build_array(jsonb_build_object('userId',d,'amount',2000,'potIndex',0)) FROM added_candidates;
  INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result,committed_at)
   SELECT tb,7000000+i,h,md5(h::text),jsonb_build_object('hand_id',h,'table_id',tb,'hand_number',7000000+i,'written',jsonb_build_object(u::text,0,d::text,2000)),now()-interval '60 seconds' FROM added_candidates;
  INSERT INTO settlement_idempotency_keys(table_id,hand_id,status,completed_at,result)
   SELECT tb,h,'succeeded',now()-interval '62 seconds',jsonb_build_object('hand_id',h,'table_id',tb,'hand_number',7000000+i,'written',jsonb_build_object(u::text,0,d::text,2000)) FROM added_candidates;
  INSERT INTO tournament_knockout_candidates(tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,hand_id,hand_number,stack_before,stack_after,state,created_at)
   SELECT t,u,tb,gen_random_uuid(),'2026-09-10 00:00:00+00',h,7000000+i,1000,0,'pending',now()-interval '63 seconds' FROM added_candidates;
  count_now:=goal;ANALYZE tournament_knockout_candidates;ANALYZE hand_atomic_commits;ANALYZE settlement_idempotency_keys;ANALYZE hand_history;
  started:=clock_timestamp();
  r:=fn_pko_claim_predecessor_status_v1(t,b,k.table_id,k.hand_id,k.hand_number,k.seat_joined_at);
  RAISE NOTICE 'SCOPE_COST synthetic_nonparticipants=% elapsed_ms=% status=% inspected=%',goal,extract(epoch from clock_timestamp()-started)*1000,r->>'status',r->>'inspected';
  IF goal<10000 THEN
   PERFORM fixture_assert(r->>'ok'='true' AND (r->>'inspected')::integer=goal+1,'complete indexed scope proves independent heads at size'||goal);
  ELSE
   PERFORM fixture_assert(r->>'ok'='false' AND r->>'reason'='predecessor_scope_incomplete','overflow cannot become truncated successful proof');
  END IF;
 END LOOP;
END $$;
ROLLBACK;
