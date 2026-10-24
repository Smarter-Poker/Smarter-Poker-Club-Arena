-- Real accepted-hand readers and terminal roots; synthetic local events only.
BEGIN;
CREATE FUNCTION pg_temp.chests_only_case() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE x jsonb;t uuid;activated timestamptz;
BEGIN
 x:=fixture_terminal_case('mystery_active');t:=(x->>'t')::uuid;
 INSERT INTO tournament_bounty_chests(tournament_id,seq,tier,amount_cents) VALUES(t,1,'base',1000);
 SELECT committed_at+interval '1 second' INTO activated FROM hand_atomic_commits WHERE hand_id=(x->>'hand')::uuid;
 UPDATE tournaments SET mystery_bounty_regular_pool_percent=0,mystery_bounty_pool_percent=100,
  mystery_bounty_stage='active',mystery_bounty_activation_generation=1,
  mystery_bounty_activated_at=activated,mystery_bounty_pool_cents=1000 WHERE id=t;
 UPDATE tournament_knockout_candidates SET state='eliminated',resolved_at=activated WHERE tournament_id=t;
 RETURN x;
END $$;
DO $$
DECLARE x jsonb;t uuid;r jsonb;before_state jsonb;label text;mode text;h uuid;first_result jsonb;
BEGIN
 FOREACH label IN ARRAY ARRAY['eliminated','rebought','winner'] LOOP
  x:=pg_temp.chests_only_case();t:=(x->>'t')::uuid;
  UPDATE tournament_knockout_candidates SET state=label WHERE tournament_id=t;
  before_state:=fixture_terminal_snapshot(t);
  r:=fn_bounty_candidate_completion_status_v1(t);
  PERFORM fixture_assert(r->>'ok'='true','recorded pre-money '||label||' carries no bounty obligation');
  PERFORM fixture_assert(before_state=fixture_terminal_snapshot(t),'coverage reader never changes money or receipts');
 END LOOP;
 FOREACH mode IN ARRAY ARRAY['at_activation','after_activation','missing_receipt','wrong_generation','pending',
  'unresolved','resolved_before_commit','regular_half','pko','not_mystery','invalid_accepted_hand'] LOOP
  x:=pg_temp.chests_only_case();t:=(x->>'t')::uuid;
  CASE mode
   WHEN 'at_activation' THEN UPDATE tournament_mystery_activation_receipts SET activated_at=(SELECT committed_at FROM hand_atomic_commits WHERE hand_id=(x->>'hand')::uuid) WHERE tournament_id=t;
   WHEN 'after_activation' THEN UPDATE tournament_mystery_activation_receipts SET activated_at=(SELECT committed_at-interval '1 second' FROM hand_atomic_commits WHERE hand_id=(x->>'hand')::uuid) WHERE tournament_id=t;
   WHEN 'missing_receipt' THEN DELETE FROM tournament_mystery_activation_receipts WHERE tournament_id=t;
   WHEN 'wrong_generation' THEN UPDATE tournament_mystery_activation_receipts SET activation_generation=2 WHERE tournament_id=t;
   WHEN 'pending' THEN UPDATE tournament_knockout_candidates SET state='pending' WHERE tournament_id=t;
   WHEN 'unresolved' THEN UPDATE tournament_knockout_candidates SET resolved_at=NULL WHERE tournament_id=t;
   WHEN 'resolved_before_commit' THEN UPDATE tournament_knockout_candidates SET resolved_at=(SELECT committed_at-interval '1 microsecond' FROM hand_atomic_commits WHERE hand_id=(x->>'hand')::uuid) WHERE tournament_id=t;
   WHEN 'regular_half' THEN UPDATE tournaments SET mystery_bounty_regular_pool_percent=50 WHERE id=t;
   WHEN 'pko' THEN UPDATE tournaments SET is_pko=true WHERE id=t;
   WHEN 'not_mystery' THEN UPDATE tournaments SET is_mystery_bounty=false WHERE id=t;
   WHEN 'invalid_accepted_hand' THEN UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{written}','{}') WHERE hand_id=(x->>'hand')::uuid;
  END CASE;
  before_state:=fixture_terminal_snapshot(t);
  r:=fn_mystery_bounty_settle(t,(x->>'b')::uuid);
  PERFORM fixture_assert(r->>'ok'='false','no exemption for '||mode);
  PERFORM fixture_assert(before_state=fixture_terminal_snapshot(t),'refusal preserves money and receipts for '||mode);
 END LOOP;
 -- An exempt first generation must never hide a later unpaid chest knockout.
 x:=pg_temp.chests_only_case();t:=(x->>'t')::uuid;
 h:=fixture_bust(t,(x->>'b')::uuid,(x->>'a')::uuid,7300002,clock_timestamp()+interval '10 seconds');
 r:=fn_bounty_candidate_completion_status_v1(t);
 PERFORM fixture_assert(r->>'ok'='false' AND r->>'hand_id'=h::text,'scan continues through exempt generations to the later debt');
 -- Exercise original mystery close and ordinary residual owners, not only the reader.
 x:=pg_temp.chests_only_case();t:=(x->>'t')::uuid;
 before_state:=fixture_terminal_snapshot(t);
 r:=fn_mystery_bounty_settle(t,(x->>'b')::uuid);first_result:=r;
 PERFORM fixture_assert(r->>'ok'='true' AND r->>'balanced'='true' AND (r->>'residual_paid_cents')::bigint=1000,'chests-only event closes its exact funded inventory');
 PERFORM fixture_assert((SELECT count(*)=1 AND sum(amount)=10 FROM wallet_transactions WHERE related_entity_id=t),'one exact champion payment conserves all ten funded chips');
 r:=fn_finalize_bounty_pool(t,(x->>'b')::uuid);
 PERFORM fixture_assert(r->>'ok'='true' AND (r->>'residual')::numeric=0,'ordinary close cannot pay the mystery pool again');
 before_state:=fixture_terminal_snapshot(t);
 r:=fn_mystery_bounty_settle(t,(x->>'b')::uuid);
 PERFORM fixture_assert(r=first_result AND before_state=fixture_terminal_snapshot(t),'immutable receipt replay never repeats a payment');
END $$;
ROLLBACK;
