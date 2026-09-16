BEGIN;
DO $$
DECLARE x jsonb;r jsonb;t uuid;a uuid;b uuid;c uuid;o uuid; inverted boolean;
BEGIN
 FOREACH inverted IN ARRAY ARRAY[false,true] LOOP
 x:=fixture_chain(inverted); t:=(x->>'t')::uuid;a:=(x->>'a')::uuid;b:=(x->>'b')::uuid;c:=(x->>'c')::uuid;
 r:=fixture_claim(t,b,c,3);
 PERFORM fixture_assert(r->>'ok'='false' AND r->>'reason'='pko_predecessor_not_ready'
   AND r->'predecessor_proof'->>'status'='blocked','downstream head refuses unclaimed accepted predecessor');
 PERFORM fixture_assert(NOT EXISTS(SELECT 1 FROM tournament_bounty_obligations WHERE tournament_id=t)
   AND (SELECT status='playing' AND current_bounty=5 FROM tournament_players WHERE tournament_id=t AND user_id=b),
   'refused downstream claim preserves playing status and original head; no stale obligation');
 r:=fixture_claim(t,a,b,4);o:=(r->>'obligation_id')::uuid;
 PERFORM fixture_assert(r->>'ok'='true' AND o IS NOT NULL,'ready exact ancestor can be claimed');
 r:=fn_collect_bounty_obligation(o);
 PERFORM fixture_assert((r->>'paid_cash')::numeric=2.50 AND (r->>'added_to_head')::numeric=2.50,'ancestor pays its exact2.50 cash and carry');
 r:=fixture_claim(t,b,c,3);o:=(r->>'obligation_id')::uuid;
 PERFORM fixture_assert(r->>'ok'='true' AND o IS NOT NULL,'downstream retries successfully after exact predecessor marker');
 r:=fn_collect_bounty_obligation(o);
 PERFORM fixture_assert((r->>'paid_cash')::numeric=3.75 AND (r->>'added_to_head')::numeric=3.75,'downstream now pays3.75 from correct7.50head');
 r:=fn_collect_bounty_obligation(o);
 PERFORM fixture_assert(r->>'already'='true' AND r->>'marker_verified'='true','settled downstream replay returns canonical receipt');
 PERFORM fixture_assert((SELECT sum(amount)=6.25 AND count(*)=2 FROM wallet_transactions WHERE related_entity_id=t),
   'chain conserves exact cash with no duplicate replay payment');
 END LOOP;
END $$;
ROLLBACK;
