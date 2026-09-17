BEGIN;
DO $$
DECLARE x jsonb; r jsonb; t uuid; o uuid; fixed boolean:=current_setting('fixture.expect_fixed')::boolean;
BEGIN
 x:=fixture_pko_tables();t:=(x->>'t')::uuid;
 r:=fixture_claim(t,(x->>'a')::uuid,(x->>'b')::uuid,3);
 IF NOT fixed THEN
   PERFORM fixture_assert(r->>'ok'='true' AND r->>'bounty_blocked'='pko_order_already_advanced'
     AND r->>'obligation_id' IS NULL,'old claim loses independent-table bounty solely to global cutoff');
 ELSE
   PERFORM fixture_assert(r->>'ok'='true' AND r->>'bounty_blocked' IS NULL AND r->>'obligation_id' IS NOT NULL,
     'independent lower hand records its exact bounty obligation');
   o:=(r->>'obligation_id')::uuid;
   r:=fn_collect_bounty_obligation(o);
   PERFORM fixture_assert(r->>'ok'='true' AND r->>'marker_verified'='true'
     AND (r->>'paid_cash')::numeric=2.50 AND (r->>'added_to_head')::numeric=2.51,
     'independent lower hand pays exact cash and head');
   PERFORM fixture_assert((SELECT sum(amount) FROM wallet_transactions WHERE related_entity_id=t)=5.00
     AND (SELECT bounty_pool_paid FROM tournaments WHERE id=t)=5.00
     AND (SELECT count(*) FROM tournament_bounties WHERE tournament_id=t)=2,
     'both independent heads conserve synthetic cash and markers');
   PERFORM fixture_assert((SELECT current_bounty FROM tournament_players WHERE tournament_id=t AND user_id=(x->>'b')::uuid)=7.52,
     'exact lower-hand knocker receives progressive head');
   r:=fn_collect_bounty_obligation(o);
   PERFORM fixture_assert(r->>'already'='true' AND r->>'marker_verified'='true','lower hand remains replayable after higher cutoff');
 END IF;
END $$;
ROLLBACK;
