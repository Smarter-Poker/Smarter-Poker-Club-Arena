BEGIN;
DO $$
DECLARE x jsonb;t uuid;r jsonb;o uuid;started timestamptz;c public.tournament_knockout_candidates%ROWTYPE;
BEGIN
 x:=fixture_terminal_case();t:=(x->>'t')::uuid;
 r:=fixture_claim(t,(x->>'a')::uuid,(x->>'b')::uuid,2);o:=(r->>'obligation_id')::uuid;
 SELECT * INTO c FROM tournament_knockout_candidates WHERE tournament_id=t;
 CREATE TEMP TABLE coverage_added AS
  SELECT i,gen_random_uuid() u,gen_random_uuid() h FROM generate_series(1,10001) i;
 INSERT INTO tournament_knockout_candidates(tournament_id,eliminated_user_id,table_id,seat_id,
  seat_joined_at,hand_id,hand_number,stack_before,stack_after,state,created_at)
 SELECT t,u,c.table_id,gen_random_uuid(),c.seat_joined_at,h,7100000+i,1000,0,'eliminated',c.created_at
 FROM coverage_added;
 INSERT INTO tournament_bounty_obligations(tournament_id,eliminated_user_id,table_id,hand_id,
  hand_number,settlement_completed_at,seat_joined_at,position,prize,mode,head_amount,knocker_user_id,claimants)
 SELECT t,u,c.table_id,h,7100000+i,c.created_at,c.seat_joined_at,2,0,'pko',5,(x->>'b')::uuid,
  jsonb_build_array(jsonb_build_object('user_id',x->>'b','weight',1)) FROM coverage_added;
 ANALYZE tournament_knockout_candidates;ANALYZE tournament_bounty_obligations;
 started:=clock_timestamp();r:=fn_bounty_candidate_completion_status_v1(t);
 RAISE NOTICE 'COVERAGE_COST candidates=10002 elapsed_ms=%',extract(epoch from clock_timestamp()-started)*1000;
 PERFORM fixture_assert(r->>'ok'='true','complete database anti-join covers10002 recorded generations without client truncation');
 PERFORM fixture_assert(fn_tournament_has_unsettled_bounties(t),'coverage of records never substitutes for settlement of their pending debts');
 DELETE FROM tournament_bounty_obligations WHERE id=o;
 r:=fn_bounty_candidate_completion_status_v1(t);
 PERFORM fixture_assert(r->>'reason'='unclaimed_bounty_candidate' AND r->>'candidate_id'=c.id::text,
  'complete anti-join finds missing accepted head after10001 earlier recorded generations');
END $$;
ROLLBACK;
