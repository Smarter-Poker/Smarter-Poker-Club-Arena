-- Synthetic accepted-hand records, actual current claim/collector/marker.
-- The inherited wallet payer is a pool-bounded stand-in, not provider proof.
BEGIN;
DO $$
DECLARE
 t uuid; r jsonb; a uuid:='a0000000-0000-4000-8000-000000000001';
 b uuid:='b0000000-0000-4000-8000-000000000001';
 c uuid:='c0000000-0000-4000-8000-000000000001';
 d uuid:='d0000000-0000-4000-8000-000000000001';
 ordered boolean; h uuid;
BEGIN
 FOREACH ordered IN ARRAY ARRAY[true,false] LOOP
  t:=fixture_event('PKO causal predecessor',ARRAY[a,b,c,d]::text[],5);
  UPDATE tournaments SET is_mystery_bounty=false,is_pko=true WHERE id=t;
  PERFORM fixture_bust(t,a,b,6000001,clock_timestamp()-interval '5 seconds');
  UPDATE tournament_players SET chips=2000 WHERE tournament_id=t AND user_id=b;
  UPDATE table_seats SET stack=2000 WHERE table_id IN(SELECT id FROM tables WHERE tournament_id=t) AND user_id=b;
  IF ordered THEN
   r:=fixture_claim(t,a,b,4);
   PERFORM fixture_assert(r->>'ok'='true' AND r->>'obligation_id' IS NOT NULL,'ordered A claim exists');
   r:=fn_collect_bounty_obligation((r->>'obligation_id')::uuid);
   PERFORM fixture_assert((r->>'paid_cash')::numeric=2.5 AND (r->>'added_to_head')::numeric=2.5,
     'ordered A bounty pays B and adds its exact progressive carry');
  END IF;
  h:=fixture_bust(t,b,c,6000002,clock_timestamp());
  UPDATE tournament_knockout_candidates SET stack_before=2000 WHERE hand_id=h;
  UPDATE hand_history SET
   players=jsonb_build_array(jsonb_build_object('userId',b,'stack',0),jsonb_build_object('userId',c,'stack',3000)),
   pots=jsonb_build_array(jsonb_build_object('index',0,'amount',3000,'eligible',jsonb_build_array(b,c))),
   winners=jsonb_build_array(jsonb_build_object('userId',c,'amount',3000,'potIndex',0))
   WHERE id=h;
  UPDATE settlement_idempotency_keys SET result=jsonb_set(result,ARRAY['written',c::text],'3000'::jsonb) WHERE hand_id=h;
  UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,ARRAY['written',c::text],'3000'::jsonb) WHERE hand_id=h;
  UPDATE tournament_players SET chips=3000 WHERE tournament_id=t AND user_id=c;
  UPDATE table_seats SET stack=3000 WHERE table_id IN(SELECT id FROM tables WHERE tournament_id=t) AND user_id=c;
  r:=fixture_claim(t,b,c,3);
  PERFORM fixture_assert(r->>'ok'='true' AND r->>'obligation_id' IS NOT NULL,
    CASE WHEN ordered THEN 'ordered B claim exists' ELSE 'COUNTEREXAMPLE: B claim skips an accepted but unclaimed predecessor' END);
  r:=fn_collect_bounty_obligation((r->>'obligation_id')::uuid);
  IF ordered THEN
   PERFORM fixture_assert((r->>'paid_cash')::numeric=3.75 AND (r->>'added_to_head')::numeric=3.75,
     'ordered B head includes A carry and pays C 3.75');
  ELSE
   PERFORM fixture_assert((r->>'paid_cash')::numeric=2.5 AND (r->>'added_to_head')::numeric=2.5,
     'COUNTEREXAMPLE: the same knockout pays C only 2.50 using B obsolete head');
   r:=fixture_claim(t,a,b,4);
   PERFORM fixture_assert(r->>'ok'='true' AND r->>'bounty_blocked'='pko_order_already_advanced'
      AND r->>'obligation_id' IS NULL,
     'COUNTEREXAMPLE: A is placed without a bounty claim after B has already been paid');
   PERFORM fixture_assert(NOT EXISTS(SELECT 1 FROM wallet_transactions WHERE related_entity_id=t AND user_id=b),
     'COUNTEREXAMPLE: rightful first knocker B has no cash payment');
  END IF;
 END LOOP;
END $$;
ROLLBACK;
