BEGIN;
DO $$
DECLARE x jsonb;t uuid;a uuid;b uuid;c uuid;d uuid;r jsonb;h uuid;debt uuid;anchor timestamptz;
BEGIN
 x:=fixture_chain();t:=(x->>'t')::uuid;a:=(x->>'a')::uuid;b:=(x->>'b')::uuid;c:=(x->>'c')::uuid;d:=(x->>'d')::uuid;
 SELECT committed_at INTO anchor FROM hand_atomic_commits WHERE hand_id=(x->>'b_hand')::uuid;
 h:=fixture_bust(t,d,b,6200003,anchor-interval '1 second');
 -- This synthetic accepted chain has two earlier incoming heads to B.
 r:=fixture_claim(t,b,c,2);
 PERFORM fixture_assert(r->>'ok'='false' AND jsonb_array_length(r->'predecessor_proof'->'predecessors')=2,
   'both exact unclaimed incoming heads are visible');
 r:=fixture_claim(t,a,b,4);r:=fn_collect_bounty_obligation((r->>'obligation_id')::uuid);
 r:=fixture_claim(t,b,c,2);
 PERFORM fixture_assert(r->>'ok'='false' AND jsonb_array_length(r->'predecessor_proof'->'predecessors')=1,
   'one incoming payment cannot clear a head with another unpaid ancestor');
 r:=fixture_claim(t,d,b,3);r:=fn_collect_bounty_obligation((r->>'obligation_id')::uuid);
 PERFORM fixture_assert(r->>'ok'='true','second incoming head settles');
 r:=fixture_claim(t,b,c,2);debt:=(r->>'obligation_id')::uuid;
 PERFORM fixture_assert(r->>'ok'='true' AND (SELECT head_amount=10 FROM tournament_bounty_obligations WHERE id=debt),
   'downstream snapshot includes both exact incoming carries');
 r:=fn_collect_bounty_obligation(debt);
 PERFORM fixture_assert((r->>'paid_cash')::numeric=5 AND (r->>'added_to_head')::numeric=5,
   'multiple-predecessor head pays exact5cash and5carry');
 PERFORM fixture_assert((SELECT sum(amount)=10 AND count(*)=3 FROM wallet_transactions WHERE related_entity_id=t),
   'multiple-predecessor cash and remaining heads conserve funded20pool');
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE x jsonb;t uuid;a uuid;b uuid;c uuid;d uuid;r jsonb;h uuid;debt uuid;anchor timestamptz;
BEGIN
 x:=fixture_chain();t:=(x->>'t')::uuid;a:=(x->>'a')::uuid;b:=(x->>'b')::uuid;c:=(x->>'c')::uuid;d:=(x->>'d')::uuid;
 SELECT committed_at INTO anchor FROM hand_atomic_commits WHERE hand_id=(x->>'b_hand')::uuid;
 h:=fixture_bust(t,c,d,6200003,anchor+interval '1 second');
 UPDATE tournament_knockout_candidates SET stack_before=3000 WHERE hand_id=h;
 r:=fixture_claim(t,c,d,2);
 PERFORM fixture_assert(r->>'ok'='false','third link refuses before its second-link predecessor');
 r:=fixture_claim(t,a,b,4);r:=fn_collect_bounty_obligation((r->>'obligation_id')::uuid);
 r:=fixture_claim(t,c,d,2);
 PERFORM fixture_assert(r->>'ok'='false','first-link payment does not prematurely clear third-link head');
 r:=fixture_claim(t,b,c,3);r:=fn_collect_bounty_obligation((r->>'obligation_id')::uuid);
 r:=fixture_claim(t,c,d,2);debt:=(r->>'obligation_id')::uuid;
 PERFORM fixture_assert(r->>'ok'='true' AND (SELECT head_amount=8.75 FROM tournament_bounty_obligations WHERE id=debt),
   'third-link snapshot includes compounded progressive carry');
 r:=fn_collect_bounty_obligation(debt);
 PERFORM fixture_assert((r->>'paid_cash')::numeric=4.37 AND (r->>'added_to_head')::numeric=4.38,
   'three-link chain preserves existing exact odd-cent split');
 PERFORM fixture_assert((SELECT sum(amount)=10.62 FROM wallet_transactions WHERE related_entity_id=t)
   AND (SELECT current_bounty=9.38 FROM tournament_players WHERE tournament_id=t AND user_id=d),
   'three-link cash plus surviving head equals original20pool');
END $$;
ROLLBACK;
