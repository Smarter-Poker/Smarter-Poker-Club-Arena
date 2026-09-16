BEGIN;
DO $$
DECLARE x jsonb; t uuid; lower_table uuid; claims jsonb; kind text; r jsonb; o uuid;
BEGIN
 FOREACH kind IN ARRAY ARRAY['same_table','shared_eliminated','later_eliminated_is_claimant',
   'later_collector_is_eliminated','shared_collector','pending_later_overlap','missing_watermark',
   'incomplete_marker','wrong_watermark_hand','eliminated_claimant','malformed_later_claimant',
   'empty_later_claimants','malformed_input','duplicate_input','self_claimant','empty_input','null_input'] LOOP
  x:=fixture_pko_tables();t:=(x->>'t')::uuid;lower_table:=(x->>'lower_table')::uuid;
  claims:=jsonb_build_array(jsonb_build_object('user_id',x->>'b','weight',1));
  CASE kind
   WHEN 'same_table' THEN UPDATE tournament_bounty_obligations SET table_id=lower_table WHERE id=(x->>'higher')::uuid;
   WHEN 'shared_eliminated' THEN UPDATE tournament_bounty_obligations SET eliminated_user_id=(x->>'a')::uuid WHERE id=(x->>'higher')::uuid;
   WHEN 'later_eliminated_is_claimant' THEN UPDATE tournament_bounty_obligations SET eliminated_user_id=(x->>'b')::uuid WHERE id=(x->>'higher')::uuid;
   WHEN 'later_collector_is_eliminated' THEN UPDATE tournament_bounty_obligations SET claimants=jsonb_build_array(jsonb_build_object('user_id',x->>'a','weight',1)) WHERE id=(x->>'higher')::uuid;
   WHEN 'shared_collector' THEN UPDATE tournament_bounty_obligations SET claimants=claims WHERE id=(x->>'higher')::uuid;
   WHEN 'pending_later_overlap' THEN
    INSERT INTO tournament_bounty_obligations(tournament_id,eliminated_user_id,table_id,hand_id,hand_number,settlement_completed_at,seat_joined_at,position,prize,mode,head_amount,knocker_user_id,claimants)
      VALUES(t,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),5000003,now(),now()-interval '1 hour',2,0,'pko',5.01,(x->>'b')::uuid,claims);
   WHEN 'missing_watermark' THEN DELETE FROM tournament_pko_settlement_watermarks WHERE tournament_id=t;
   WHEN 'incomplete_marker' THEN DELETE FROM tournament_bounties WHERE bounty_obligation_id=(x->>'higher')::uuid;
   WHEN 'wrong_watermark_hand' THEN UPDATE tournament_pko_settlement_watermarks SET last_settled_hand_number=5000003 WHERE tournament_id=t;
   WHEN 'eliminated_claimant' THEN UPDATE tournament_players SET status='eliminated' WHERE tournament_id=t AND user_id=(x->>'b')::uuid;
   WHEN 'malformed_later_claimant' THEN UPDATE tournament_bounty_obligations SET claimants='[{"user_id":"bad-id","weight":1}]'::jsonb WHERE id=(x->>'higher')::uuid;
   WHEN 'empty_later_claimants' THEN UPDATE tournament_bounty_obligations SET claimants='[]'::jsonb WHERE id=(x->>'higher')::uuid;
   WHEN 'malformed_input' THEN claims:='[{"user_id":"bad-id","weight":1}]'::jsonb;
   WHEN 'duplicate_input' THEN claims:=claims||claims;
   WHEN 'self_claimant' THEN claims:=jsonb_build_array(jsonb_build_object('user_id',x->>'a','weight',1));
   WHEN 'empty_input' THEN claims:='[]'::jsonb;
   WHEN 'null_input' THEN claims:='null'::jsonb;
  END CASE;
  PERFORM fixture_assert(fn_pko_hand_is_independent_of_later_settlements(t,lower_table,5000001,(x->>'a')::uuid,claims) IS FALSE,
    'independence unavailable: '||kind);
  IF kind IN ('same_table','shared_collector','eliminated_claimant') THEN
   r:=fixture_claim(t,(x->>'a')::uuid,(x->>'b')::uuid,3);
   PERFORM fixture_assert(r->>'bounty_blocked'='pko_order_already_advanced' AND r->>'obligation_id' IS NULL,
     'actual claim retains order refusal: '||kind);
   PERFORM fixture_assert((SELECT sum(amount) FROM wallet_transactions WHERE related_entity_id=t)=2.50,
     'refused claim transfers no additional cash: '||kind);
  END IF;
 END LOOP;
 x:=fixture_pko_tables();t:=(x->>'t')::uuid;
 r:=fixture_claim(t,(x->>'a')::uuid,(x->>'b')::uuid,3);o:=(r->>'obligation_id')::uuid;
 UPDATE tournament_players SET current_bounty=current_bounty+1 WHERE tournament_id=t AND user_id=(x->>'a')::uuid;
 r:=fn_collect_bounty_obligation(o);
 PERFORM fixture_assert(r->>'reason'='head_snapshot_changed','independent table cannot waive exact head snapshot');
 PERFORM fixture_assert((SELECT sum(amount) FROM wallet_transactions WHERE related_entity_id=t)=2.50,'snapshot refusal pays nothing');

 x:=fixture_pko_tables();t:=(x->>'t')::uuid;
 INSERT INTO chip_ledger VALUES((x->>'a')::uuid,t,'rebuy','player_wallet','prize_liability','posted',5,clock_timestamp());
 INSERT INTO hand_history(id,table_id,tournament_id,hand_number,created_at,players,pots,winners)
 VALUES(gen_random_uuid(),(x->>'lower_table')::uuid,t,5000005,clock_timestamp(),
   jsonb_build_array(jsonb_build_object('userId',x->>'a','stack',1000)),'[]','[]');
 r:=fixture_claim(t,(x->>'a')::uuid,(x->>'b')::uuid,3);
 PERFORM fixture_assert(r->>'ok'='false' AND r->>'reason'='knockout_bust_time_unproven','rebought generation that played on is still refused');
END $$;
ROLLBACK;
