BEGIN;
DO $$
DECLARE o uuid; t uuid; r jsonb; before_state jsonb; old_context text; i integer; a text; split_case boolean;
  expected boolean:=current_setting('fixture.expect_fixed')::boolean; source_ob public.tournament_bounty_obligations%ROWTYPE;
BEGIN
  FOREACH a IN ARRAY ARRAY['chips','diamonds'] LOOP
    FOREACH split_case IN ARRAY ARRAY[false,true] LOOP
      o:=fixture_replay_case(a,split_case);
      SELECT * INTO source_ob FROM tournament_bounty_obligations WHERE id=o; t:=source_ob.tournament_id;
      before_state:=fixture_financial_snapshot(t);
      FOR i IN 1..5 LOOP
        r:=fn_collect_bounty_obligation(o);
        IF expected THEN
          PERFORM fixture_assert(r->>'ok'='true' AND r->>'already'='true' AND r->>'marker_verified'='true'
            AND r->>'obligation_id'=o::text
            AND (r->>'paid_cash')::numeric+(r->>'added_to_head')::numeric=source_ob.head_amount,
            a||' split='||split_case||' exact settled replay #'||i);
        ELSE
          PERFORM fixture_assert(r->>'ok'='false' AND r->>'reason'='pko_order_already_advanced',
            'old body rejects a fully settled '||a||' receipt after newer hand');
        END IF;
      END LOOP;
      PERFORM fixture_assert(fixture_financial_snapshot(t)=before_state,'replay leaves every financial fixture row unchanged');
      PERFORM fixture_assert((SELECT last_settled_hand_number=3000002 FROM tournament_pko_settlement_watermarks WHERE tournament_id=t),
        'replay never rewinds watermark');
      DELETE FROM tournament_bounties WHERE bounty_obligation_id=o;
      r:=fn_collect_bounty_obligation(o);
      PERFORM fixture_assert(r->>'ok'='false' AND r->>'reason'=CASE WHEN expected THEN 'settled_marker_incomplete' ELSE 'pko_order_already_advanced' END,
        'corrupt settled receipt is refused');
      UPDATE tournament_bounty_obligations SET state='pending',settled_at=NULL WHERE id=o;
      r:=fn_collect_bounty_obligation(o);
      PERFORM fixture_assert(r->>'ok'='false' AND r->>'reason'='pko_order_already_advanced','pending admission still respects order');
    END LOOP;
  END LOOP;

  o:=fixture_replay_case(); SELECT * INTO source_ob FROM tournament_bounty_obligations WHERE id=o; t:=source_ob.tournament_id;
  DELETE FROM tournament_pko_settlement_watermarks WHERE tournament_id=t;
  UPDATE tournament_bounty_obligations SET state='pending',settled_at=NULL,hand_number=3000000 WHERE tournament_id=t AND id<>o;
  before_state:=fixture_financial_snapshot(t);
  r:=fn_collect_bounty_obligation(o);
  PERFORM fixture_assert(CASE WHEN expected THEN r->>'ok'='true' AND r->>'already'='true'
      ELSE r->>'reason'='pending_pko_predecessor' END,'settled replay is not new work behind pending predecessor');
  PERFORM fixture_assert(fixture_financial_snapshot(t)=before_state,'predecessor case writes no financial state');

  PERFORM set_config('app.bounty_obligation_id',gen_random_uuid()::text,true);
  r:=fn_collect_bounty(t,source_ob.eliminated_user_id,source_ob.knocker_user_id,source_ob.claimants);
  PERFORM fixture_assert(r->>'reason'='bounty_obligation_not_ready','unknown generation refused');
  PERFORM set_config('app.bounty_obligation_id',o::text,true);
  r:=fn_collect_bounty(t,gen_random_uuid(),source_ob.knocker_user_id,source_ob.claimants);
  PERFORM fixture_assert(r->>'reason'='bounty_obligation_not_ready','wrong eliminated player refused');
  PERFORM set_config('app.bounty_obligation_id','',true);
  UPDATE tournament_bounty_obligations SET eliminated_user_id=source_ob.eliminated_user_id,
    seat_joined_at=source_ob.seat_joined_at+interval '1 minute' WHERE tournament_id=t AND id<>o;
  r:=fn_collect_bounty(t,source_ob.eliminated_user_id,source_ob.knocker_user_id,source_ob.claimants);
  PERFORM fixture_assert(r->>'reason'='bounty_generation_identity_required','ambiguous same-player generations refused');
  old_context:='a0000000-0000-4000-8000-000000000009';
  PERFORM set_config('app.bounty_obligation_id',old_context,true);
  r:=fn_collect_bounty_obligation(o);
  PERFORM fixture_assert(current_setting('app.bounty_obligation_id')=old_context,'wrapper restores caller generation context');
  PERFORM fixture_assert(CASE WHEN expected THEN r->>'already'='true' ELSE r->>'reason'='pending_pko_predecessor' END,
    'exact generation remains replayable with another generation present');
END $$;
ROLLBACK;
