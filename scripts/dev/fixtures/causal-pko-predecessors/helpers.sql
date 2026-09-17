-- The old fixture assigned timestamps that cannot occur in the atomic writer.
-- This wrapper changes only synthetic builders, aligning receipt creation before
-- the captured final accepted commit. It never alters a production function.
ALTER FUNCTION fixture_bust(uuid,uuid,uuid,bigint,timestamptz) RENAME TO fixture_bust_before_causal_clock;
CREATE FUNCTION fixture_bust(p_t uuid,p_user uuid,p_knocker uuid,p_hand_number bigint,p_committed_at timestamptz)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE h uuid;
BEGIN
 h:=fixture_bust_before_causal_clock(p_t,p_user,p_knocker,p_hand_number,p_committed_at);
 UPDATE hand_history SET created_at=p_committed_at-interval '1 millisecond' WHERE id=h;
 UPDATE tournament_knockout_candidates SET created_at=p_committed_at-interval '2 milliseconds' WHERE hand_id=h;
 UPDATE settlement_idempotency_keys SET completed_at=p_committed_at-interval '3 milliseconds' WHERE hand_id=h;
 RETURN h;
END $$;

CREATE FUNCTION fixture_chain(p_inverted boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t uuid; h uuid;
 a uuid:='a0000000-0000-4000-8000-000000000001';
 b uuid:='b0000000-0000-4000-8000-000000000001';
 c uuid:='c0000000-0000-4000-8000-000000000001';
 d uuid:='d0000000-0000-4000-8000-000000000001';
BEGIN
 t:=fixture_event('R37 accepted dependency chain',ARRAY[a,b,c,d]::text[],5);
 UPDATE tournaments SET is_mystery_bounty=false,is_pko=true WHERE id=t;
 PERFORM fixture_bust(t,a,b,CASE WHEN p_inverted THEN 6200002 ELSE 6200001 END,clock_timestamp()-interval '5 seconds');
 UPDATE tournament_players SET chips=2000 WHERE tournament_id=t AND user_id=b;
 UPDATE table_seats SET stack=2000 WHERE table_id IN(SELECT id FROM tables WHERE tournament_id=t) AND user_id=b;
 h:=fixture_bust(t,b,c,CASE WHEN p_inverted THEN 6200001 ELSE 6200002 END,clock_timestamp());
 UPDATE tournament_knockout_candidates SET stack_before=2000 WHERE hand_id=h;
 UPDATE hand_history SET
  players=jsonb_build_array(jsonb_build_object('userId',b,'stack',0),jsonb_build_object('userId',c,'stack',3000)),
  pots=jsonb_build_array(jsonb_build_object('index',0,'amount',3000,'eligible',jsonb_build_array(b,c))),
  winners=jsonb_build_array(jsonb_build_object('userId',c,'amount',3000,'potIndex',0)) WHERE id=h;
 UPDATE settlement_idempotency_keys SET result=jsonb_set(result,ARRAY['written',c::text],'3000'::jsonb) WHERE hand_id=h;
 UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,ARRAY['written',c::text],'3000'::jsonb) WHERE hand_id=h;
 UPDATE tournament_players SET chips=3000 WHERE tournament_id=t AND user_id=c;
 UPDATE table_seats SET stack=3000 WHERE table_id IN(SELECT id FROM tables WHERE tournament_id=t) AND user_id=c;
 RETURN jsonb_build_object('t',t,'a',a,'b',b,'c',c,'d',d,'b_hand',h);
END $$;
