BEGIN;
DO $$
DECLARE x jsonb; t uuid; c public.tournament_knockout_candidates%ROWTYPE; o uuid; r jsonb;
 fixed boolean:=current_setting('fixture.expect_fixed')::boolean;
BEGIN
 x:=fixture_pko_tables();t:=(x->>'t')::uuid;
 SELECT * INTO c FROM tournament_knockout_candidates WHERE tournament_id=t AND eliminated_user_id=(x->>'a')::uuid;
 -- Exact synthetic pending receipt isolates the payer's admission check from
 -- the separately tested claim door. This is not a production backfill path.
 INSERT INTO tournament_bounty_obligations(tournament_id,eliminated_user_id,table_id,hand_id,hand_number,
  settlement_completed_at,seat_joined_at,position,prize,mode,head_amount,knocker_user_id,claimants)
 VALUES(t,c.eliminated_user_id,c.table_id,c.hand_id,c.hand_number,now(),c.seat_joined_at,3,0,'pko',5.01,(x->>'b')::uuid,
  jsonb_build_array(jsonb_build_object('user_id',x->>'b','weight',1))) RETURNING id INTO o;
 UPDATE tournament_players SET status='eliminated',position=3 WHERE tournament_id=t AND user_id=c.eliminated_user_id;
 r:=fn_collect_bounty_obligation(o);
 PERFORM fixture_assert(CASE WHEN fixed THEN r->>'ok'='true' AND r->>'marker_verified'='true'
   ELSE r->>'reason'='pko_order_already_advanced' END,'payer independently verifies disjoint-table admission');
 PERFORM fixture_assert((SELECT sum(amount) FROM wallet_transactions WHERE related_entity_id=t)=CASE WHEN fixed THEN 5.00 ELSE 2.50 END,
   'payer admits exactly one additional cash half only with the independence proof');
END $$;
ROLLBACK;
