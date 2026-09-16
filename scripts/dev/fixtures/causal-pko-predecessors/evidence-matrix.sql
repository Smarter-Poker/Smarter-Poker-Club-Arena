CREATE FUNCTION fixture_causal_snapshot(t uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
  'players',(SELECT jsonb_agg(to_jsonb(x) ORDER BY user_id) FROM tournament_players x WHERE tournament_id=t),
  'candidates',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM tournament_knockout_candidates x WHERE tournament_id=t),
  'obligations',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM tournament_bounty_obligations x WHERE tournament_id=t),
  'wallet',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM wallet_transactions x WHERE related_entity_id=t),
  'markers',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM tournament_bounties x WHERE tournament_id=t),
  'event',(SELECT to_jsonb(x) FROM tournaments x WHERE id=t));
$$;
BEGIN;
DO $$
DECLARE label text;x jsonb;r jsonb;t uuid;a uuid;b uuid;c uuid;h uuid;before_state jsonb;o uuid;
BEGIN
 FOREACH label IN ARRAY ARRAY['history_missing','atomic_missing','settlement_missing',
  'opaque_roster','duplicate_roster','roster_stack_mismatch','invalid_written_stack',
  'opaque_pots','unaccepted_recipient','recipient_outside_roster','resolved_without_claim',
  'rebought_without_claim','settled_state_only','settled_wrong_generation','pending_predecessor','orphan_pending'] LOOP
  x:=fixture_chain();t:=(x->>'t')::uuid;a:=(x->>'a')::uuid;b:=(x->>'b')::uuid;c:=(x->>'c')::uuid;
  SELECT hand_id INTO h FROM tournament_knockout_candidates WHERE tournament_id=t AND eliminated_user_id=a;
  CASE label
   WHEN 'history_missing' THEN DELETE FROM hand_history WHERE id=h;
   WHEN 'atomic_missing' THEN DELETE FROM hand_atomic_commits WHERE hand_id=h;
   WHEN 'settlement_missing' THEN DELETE FROM settlement_idempotency_keys WHERE hand_id=h;
   WHEN 'opaque_roster' THEN UPDATE hand_history SET players='{}' WHERE id=h;
   WHEN 'duplicate_roster' THEN UPDATE hand_history SET players=players||jsonb_build_array(players->0) WHERE id=h;
   WHEN 'roster_stack_mismatch' THEN UPDATE hand_history SET players=jsonb_set(players,'{1,stack}','2001') WHERE id=h;
   WHEN 'invalid_written_stack' THEN
    UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,ARRAY['written',b::text],'"bad"') WHERE hand_id=h;
    UPDATE settlement_idempotency_keys SET result=jsonb_set(result,ARRAY['written',b::text],'"bad"') WHERE hand_id=h;
   WHEN 'opaque_pots' THEN UPDATE hand_history SET pots='{}' WHERE id=h;
   WHEN 'unaccepted_recipient' THEN UPDATE hand_history SET winners=jsonb_set(winners,'{0,userId}',to_jsonb(x->>'d')) WHERE id=h;
   WHEN 'recipient_outside_roster' THEN
    UPDATE hand_history SET players=jsonb_build_array(players->0) WHERE id=h;
    UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{written}',(stack_result->'written')-b::text) WHERE hand_id=h;
    UPDATE settlement_idempotency_keys SET result=jsonb_set(result,'{written}',(result->'written')-b::text) WHERE hand_id=h;
   WHEN 'resolved_without_claim' THEN UPDATE tournament_knockout_candidates SET state='eliminated',resolved_at=clock_timestamp() WHERE hand_id=h;
   WHEN 'rebought_without_claim' THEN UPDATE tournament_knockout_candidates SET state='rebought',resolved_at=clock_timestamp() WHERE hand_id=h;
   WHEN 'settled_state_only' THEN
    r:=fixture_claim(t,a,b,4);o:=(r->>'obligation_id')::uuid;
    UPDATE tournament_bounty_obligations SET state='settled',settled_at=clock_timestamp() WHERE id=o;
   WHEN 'settled_wrong_generation' THEN
    r:=fixture_claim(t,a,b,4);o:=(r->>'obligation_id')::uuid;
    r:=fn_collect_bounty_obligation(o);
    UPDATE tournament_bounty_obligations SET settlement_completed_at=settlement_completed_at-interval '1 second' WHERE id=o;
   WHEN 'pending_predecessor' THEN r:=fixture_claim(t,a,b,4);
   WHEN 'orphan_pending' THEN
    r:=fixture_claim(t,a,b,4);DELETE FROM tournament_knockout_candidates WHERE hand_id=h;
  END CASE;
  before_state:=fixture_causal_snapshot(t);
  r:=fixture_claim(t,b,c,3);
  PERFORM fixture_assert(r->>'ok'='false' AND r->>'reason'='pko_predecessor_not_ready','unready evidence refuses: '||label);
  PERFORM fixture_assert(before_state IS NOT DISTINCT FROM fixture_causal_snapshot(t),'refusal changes no head/result/payment: '||label);
 END LOOP;
END $$;
ROLLBACK;

-- Corrupting source evidence after payment never turns exact settled replay
-- into another payment or a new dependency admission.
BEGIN;
DO $$
DECLARE x jsonb;r jsonb;t uuid;a uuid;b uuid;o uuid;before_state jsonb;
BEGIN
 x:=fixture_chain();t:=(x->>'t')::uuid;a:=(x->>'a')::uuid;b:=(x->>'b')::uuid;
 r:=fixture_claim(t,a,b,4);o:=(r->>'obligation_id')::uuid;r:=fn_collect_bounty_obligation(o);
 DELETE FROM hand_history WHERE tournament_id=t;
 before_state:=fixture_causal_snapshot(t);
 r:=fn_collect_bounty_obligation(o);
 PERFORM fixture_assert(r->>'already'='true' AND r->>'marker_verified'='true','complete settled replay survives unavailable historical source');
 PERFORM fixture_assert(before_state IS NOT DISTINCT FROM fixture_causal_snapshot(t),'settled replay leaves exact financial and result state unchanged');
END $$;
ROLLBACK;
