-- Synthetic accepted records with a move into a table that reserved an older
-- hand number. Uses the actual claim/collector and the documented wallet stub.
BEGIN;
DO $$
DECLARE t uuid; tb2 uuid:=gen_random_uuid(); r jsonb; h uuid;
 a uuid:='a0000000-0000-4000-8000-000000000001';
 b uuid:='b0000000-0000-4000-8000-000000000001';
 c uuid:='c0000000-0000-4000-8000-000000000001';
 d uuid:='d0000000-0000-4000-8000-000000000001';
BEGIN
 t:=fixture_event('PKO preallocated hand move',ARRAY[a,b,c,d]::text[],5);
 UPDATE tournaments SET is_mystery_bounty=false,is_pko=true WHERE id=t;
 INSERT INTO tables(id,tournament_id,current_players) VALUES(tb2,t,2);
 UPDATE tournament_players SET table_id=tb2 WHERE tournament_id=t AND user_id IN(c,d);
 UPDATE table_seats SET table_id=tb2 WHERE table_id IN(SELECT id FROM tables WHERE tournament_id=t) AND user_id IN(c,d);
 PERFORM fixture_bust(t,a,b,6100002,clock_timestamp()-interval '5 seconds');
 UPDATE tournament_players SET chips=2000 WHERE tournament_id=t AND user_id=b;
 UPDATE table_seats SET stack=2000 WHERE table_id IN(SELECT id FROM tables WHERE tournament_id=t) AND user_id=b;
 r:=fixture_claim(t,a,b,4);
 PERFORM fixture_assert(r->>'ok'='true' AND r->>'obligation_id' IS NOT NULL,'chronological predecessor claimed before move');
 r:=fn_collect_bounty_obligation((r->>'obligation_id')::uuid);
 PERFORM fixture_assert((r->>'paid_cash')::numeric=2.50 AND (r->>'added_to_head')::numeric=2.50,'chronological predecessor paid exact carry before move');
 -- No new head was purchased; the old head and entry remain the same.
 UPDATE tournament_players SET table_id=tb2 WHERE tournament_id=t AND user_id=b;
 UPDATE table_seats SET table_id=tb2 WHERE table_id IN(SELECT id FROM tables WHERE tournament_id=t) AND user_id=b;
 h:=fixture_bust(t,b,c,6100001,clock_timestamp());
 UPDATE tournament_knockout_candidates SET stack_before=2000 WHERE hand_id=h;
 UPDATE hand_history SET
  players=jsonb_build_array(jsonb_build_object('userId',b,'stack',0),jsonb_build_object('userId',c,'stack',3000)),
  pots=jsonb_build_array(jsonb_build_object('index',0,'amount',3000,'eligible',jsonb_build_array(b,c))),
  winners=jsonb_build_array(jsonb_build_object('userId',c,'amount',3000,'potIndex',0)) WHERE id=h;
 UPDATE settlement_idempotency_keys SET result=jsonb_set(result,ARRAY['written',c::text],'3000'::jsonb) WHERE hand_id=h;
 UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,ARRAY['written',c::text],'3000'::jsonb) WHERE hand_id=h;
 UPDATE tournament_players SET chips=3000 WHERE tournament_id=t AND user_id=c;
 UPDATE table_seats SET stack=3000 WHERE table_id=tb2 AND user_id=c;
 r:=fixture_claim(t,b,c,3);
 PERFORM fixture_assert(r->>'ok'='true' AND r->>'bounty_blocked'='pko_order_already_advanced'
   AND r->>'obligation_id' IS NULL,'COUNTEREXAMPLE: chronological successor is discarded solely because its reserved hand number is lower');
 PERFORM fixture_assert(NOT EXISTS(SELECT 1 FROM wallet_transactions WHERE related_entity_id=t AND user_id=c),
   'COUNTEREXAMPLE: rightful successor collector receives nothing despite its complete predecessor');
END $$;
ROLLBACK;
