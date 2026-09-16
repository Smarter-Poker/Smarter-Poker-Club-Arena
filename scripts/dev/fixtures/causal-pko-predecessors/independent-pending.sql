BEGIN;
DO $$
DECLARE t uuid;tb2 uuid:=gen_random_uuid();r jsonb;o1 uuid;o2 uuid;
 a uuid:='a0000000-0000-4000-8000-000000000001';b uuid:='b0000000-0000-4000-8000-000000000001';
 c uuid:='c0000000-0000-4000-8000-000000000001';d uuid:='d0000000-0000-4000-8000-000000000001';
BEGIN
 t:=fixture_event('Two independent pending heads',ARRAY[a,b,c,d]::text[],5);
 UPDATE tournaments SET is_mystery_bounty=false,is_pko=true WHERE id=t;
 INSERT INTO tables(id,tournament_id,current_players) VALUES(tb2,t,2);
 UPDATE tournament_players SET table_id=tb2 WHERE tournament_id=t AND user_id IN(c,d);
 UPDATE table_seats SET table_id=tb2 WHERE table_id IN(SELECT id FROM tables WHERE tournament_id=t) AND user_id IN(c,d);
 PERFORM fixture_bust(t,a,b,6300001,clock_timestamp()-interval '5 seconds');
 PERFORM fixture_bust(t,c,d,6300002,clock_timestamp());
 r:=fixture_claim(t,a,b,4);o1:=(r->>'obligation_id')::uuid;
 PERFORM fixture_assert(r->>'ok'='true' AND o1 IS NOT NULL,'first independent head claim');
 r:=fixture_claim(t,c,d,3);o2:=(r->>'obligation_id')::uuid;
 PERFORM fixture_assert(r->>'ok'='true' AND o2 IS NOT NULL,'second independent head claim beside pending first');
 r:=fn_collect_bounty_obligation(o2);
 PERFORM fixture_assert(r->>'ok'='true' AND r->>'marker_verified'='true','unrelated lower-number pending head does not block second payout');
 r:=fn_collect_bounty_obligation(o1);
 PERFORM fixture_assert(r->>'ok'='true' AND r->>'marker_verified'='true','first independent head pays below preserved higher watermark');
 PERFORM fixture_assert((SELECT sum(amount)=5 AND count(*)=2 FROM wallet_transactions WHERE related_entity_id=t),
   'independent collections conserve exact cash once');
END $$;
ROLLBACK;
