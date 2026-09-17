BEGIN;
DO $$
DECLARE x jsonb;t uuid;r jsonb;o uuid;field text;before_state jsonb;c uuid;first_result jsonb;
BEGIN
 FOREACH field IN ARRAY ARRAY['table_id','hand_id','hand_number','eliminated_user_id','seat_joined_at'] LOOP
  x:=fixture_terminal_case();t:=(x->>'t')::uuid;
  r:=fixture_claim(t,(x->>'a')::uuid,(x->>'b')::uuid,2);o:=(r->>'obligation_id')::uuid;
  r:=fn_collect_bounty_obligation(o);
  IF field='hand_number' THEN
   UPDATE tournament_bounty_obligations SET hand_number=hand_number+1 WHERE id=o;
  ELSIF field='seat_joined_at' THEN
   UPDATE tournament_bounty_obligations SET seat_joined_at=seat_joined_at-interval '1 microsecond' WHERE id=o;
  ELSE
   EXECUTE format('UPDATE tournament_bounty_obligations SET %I=gen_random_uuid() WHERE id=$1',field) USING o;
  END IF;
  before_state:=fixture_terminal_snapshot(t);
  r:=fn_finalize_bounty_pool(t,(x->>'b')::uuid);
  PERFORM fixture_assert(r->>'reason'='unclaimed_bounty_candidate','different exact obligation '||field||' cannot cover this accepted candidate');
  PERFORM fixture_assert(before_state=fixture_terminal_snapshot(t),'mismatched generation refusal does not mutate financial state');
 END LOOP;

 -- There is a concrete award ready to reveal. The guard must run before it.
 x:=fixture_terminal_case('mystery_active');t:=(x->>'t')::uuid;c:=gen_random_uuid();
 INSERT INTO tournament_bounty_chests(id,tournament_id,seq,tier,amount_cents,status) VALUES(c,t,1,'base',1000,'reserved');
 UPDATE tournaments SET mystery_bounty_stage='active',mystery_bounty_activation_generation=1,
  mystery_bounty_pool_cents=1000,mystery_bounty_activated_at=clock_timestamp() WHERE id=t;
 INSERT INTO tournament_bounty_awards(tournament_id,chest_id,eliminated_user_id,amount_cents,tier,op_id,activation_generation)
 VALUES(t,c,(x->>'a')::uuid,1000,'base',gen_random_uuid(),1);
 before_state:=fixture_terminal_snapshot(t);
 r:=fn_mystery_bounty_settle(t,(x->>'b')::uuid);
 PERFORM fixture_assert(r->>'reason'='unclaimed_bounty_candidate','missing candidate refuses before reserved award reveal or pay');
 PERFORM fixture_assert(before_state=fixture_terminal_snapshot(t),'reserved award stays reserved after candidate refusal');

 -- No eliminated generation exists; champion owns the remaining inventory.
 t:=fixture_event('R38 clean mystery champion',ARRAY['b0000000-0000-4000-8000-000000000001'],5);
 UPDATE tournament_players SET status='winner',position=1 WHERE tournament_id=t;
 INSERT INTO tournament_bounty_chests(tournament_id,seq,tier,amount_cents) VALUES(t,1,'base',500);
 UPDATE tournaments SET mystery_bounty_stage='active',mystery_bounty_activation_generation=1,
  mystery_bounty_pool_cents=500,mystery_bounty_activated_at=clock_timestamp() WHERE id=t;
 r:=fn_mystery_bounty_settle(t,'b0000000-0000-4000-8000-000000000001');first_result:=r;
 PERFORM fixture_assert(r->>'ok'='true' AND r->>'balanced'='true' AND (r->>'residual_paid_cents')::int=500,
  'clean mystery champion receives exact remaining inventory');
 PERFORM fixture_assert((SELECT count(*)=1 AND min(status)='void' FROM tournament_bounty_chests WHERE tournament_id=t)
  AND (SELECT bounty_pool_paid=5 AND mystery_bounty_stage='complete' FROM tournaments WHERE id=t),
  'clean mystery marks inventory and stage complete atomically');
 before_state:=fixture_terminal_snapshot(t);
 r:=fn_mystery_bounty_settle(t,'b0000000-0000-4000-8000-000000000001');
 PERFORM fixture_assert(r=first_result AND before_state=fixture_terminal_snapshot(t),'active mystery exact replay does not repay residual');

 -- Corrupted settled marker retains the existing finalizer refusal.
 x:=fixture_terminal_case();t:=(x->>'t')::uuid;
 r:=fixture_claim(t,(x->>'a')::uuid,(x->>'b')::uuid,2);o:=(r->>'obligation_id')::uuid;
 r:=fn_collect_bounty_obligation(o);
 DELETE FROM tournament_bounties WHERE bounty_obligation_id=o;
 before_state:=fixture_terminal_snapshot(t);
 r:=fn_finalize_bounty_pool(t,(x->>'b')::uuid);
 PERFORM fixture_assert(r->>'reason'='pending_bounty_obligations','settled label cannot hide incomplete canonical marker');
 PERFORM fixture_assert(before_state=fixture_terminal_snapshot(t),'incomplete settled marker refuses without another payment');
END $$;
ROLLBACK;
