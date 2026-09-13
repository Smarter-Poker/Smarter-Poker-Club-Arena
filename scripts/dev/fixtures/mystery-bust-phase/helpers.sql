-- Synthetic fixture helpers (test-only, public.fixture_*). No production rows.
CREATE OR REPLACE FUNCTION public.fixture_event(
  p_name text, p_players text[], p_bounty numeric, p_stage text DEFAULT 'pending',
  p_generation bigint DEFAULT 0)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_t uuid := gen_random_uuid(); v_tb uuid := gen_random_uuid(); v_u text; v_i int := 0;
BEGIN
  INSERT INTO public.tournaments(id,name,status,is_bounty,is_mystery_bounty,bounty_amount,
    bounty_pool,bounty_pool_paid,prize_pool,prize_pool_finalized,mystery_bounty_stage,
    mystery_bounty_activation_generation)
  VALUES (v_t,p_name,'RUNNING',true,true,p_bounty,
    round(p_bounty*array_length(p_players,1),2),0,100,true,p_stage,p_generation);
  INSERT INTO public.tables(id,tournament_id,current_players) VALUES (v_tb,v_t,array_length(p_players,1));
  FOREACH v_u IN ARRAY p_players LOOP
    v_i := v_i + 1;
    INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,current_bounty,table_id,seat_number)
    VALUES (v_t,v_u::uuid,'p'||v_i,1000,'playing',p_bounty,v_tb,v_i);
    INSERT INTO public.table_seats(table_id,seat_number,user_id,stack,joined_at)
    VALUES (v_tb,v_i,v_u::uuid,1000,'2026-09-10 00:00:00+00');
  END LOOP;
  RETURN v_t;
END $$;

-- A bust proven exactly as the hand commit proves it: hand_atomic_commits,
-- the accepted zero settlement, hand_history with the pot and its winner, and
-- the pending knockout candidate. committed_at is the bust time under test.
CREATE OR REPLACE FUNCTION public.fixture_bust(
  p_t uuid, p_user uuid, p_knocker uuid, p_hand_number bigint, p_committed_at timestamptz)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_tb uuid; v_h uuid := gen_random_uuid(); v_seat record;
BEGIN
  SELECT id INTO v_tb FROM public.tables WHERE tournament_id=p_t;
  SELECT * INTO v_seat FROM public.table_seats WHERE table_id=v_tb AND user_id=p_user AND left_at IS NULL;
  INSERT INTO public.hand_history(id,table_id,tournament_id,hand_number,created_at,players,pots,winners)
  VALUES (v_h,v_tb,p_t,p_hand_number,p_committed_at+interval '1 second',
    jsonb_build_array(jsonb_build_object('userId',p_user,'stack',0),
                      jsonb_build_object('userId',p_knocker,'stack',2000)),
    jsonb_build_array(jsonb_build_object('index',0,'amount',2000,'eligible',jsonb_build_array(p_user,p_knocker))),
    jsonb_build_array(jsonb_build_object('userId',p_knocker,'amount',2000,'potIndex',0)));
  INSERT INTO public.settlement_idempotency_keys(table_id,hand_id,status,completed_at,result)
  VALUES (v_tb,v_h,'succeeded',p_committed_at,
    jsonb_build_object('hand_id',v_h,'table_id',v_tb,'hand_number',p_hand_number,
                       'written',jsonb_build_object(p_user::text,0,p_knocker::text,2000)));
  INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result,committed_at)
  VALUES (v_tb,p_hand_number,v_h,md5(v_h::text),
    jsonb_build_object('hand_id',v_h,'table_id',v_tb,'hand_number',p_hand_number,
                       'written',jsonb_build_object(p_user::text,0,p_knocker::text,2000)),
    p_committed_at);
  INSERT INTO public.tournament_knockout_candidates(tournament_id,eliminated_user_id,table_id,seat_id,
    seat_joined_at,hand_id,hand_number,stack_before,stack_after,state)
  VALUES (p_t,p_user,v_tb,v_seat.id,v_seat.joined_at,v_h,p_hand_number,1000,0,'pending');
  UPDATE public.tournament_players SET chips=0 WHERE tournament_id=p_t AND user_id=p_user;
  UPDATE public.table_seats SET stack=0 WHERE id=v_seat.id;
  RETURN v_h;
END $$;

-- Record the bust through the real claim door (the core the wrapper delegates to).
CREATE OR REPLACE FUNCTION public.fixture_claim(p_t uuid, p_user uuid, p_knocker uuid, p_position int)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c record; r jsonb;
BEGIN
  SELECT * INTO c FROM public.tournament_knockout_candidates
   WHERE tournament_id=p_t AND eliminated_user_id=p_user ORDER BY hand_number DESC LIMIT 1;
  r := public.fn_claim_bounty_legacy_candidate_20260907(p_t,p_user,p_position,0,c.table_id,c.hand_id,
         c.hand_number,c.seat_joined_at,p_knocker,NULL,0,false);
  IF COALESCE((r->>'ok')::boolean,false) AND COALESCE((r->>'claimed')::boolean,false) THEN
    UPDATE public.tournament_knockout_candidates SET state='eliminated',resolved_at=clock_timestamp()
     WHERE id=c.id AND state='pending';
  END IF;
  RETURN r;
END $$;

-- A pre-activation head that was recorded and paid (what the regular half has spent).
CREATE OR REPLACE FUNCTION public.fixture_paid_head(p_t uuid, p_user uuid, p_knocker uuid, p_position int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_head numeric;
BEGIN
  SELECT bounty_amount INTO v_head FROM public.tournaments WHERE id=p_t;
  UPDATE public.tournament_players SET status='eliminated',chips=0,position=p_position,current_bounty=0
   WHERE tournament_id=p_t AND user_id=p_user;
  INSERT INTO public.wallet_transactions(user_id,amount,type,category,related_entity_id)
  VALUES (p_knocker,v_head,'credit','bounty',p_t);
  UPDATE public.tournaments SET bounty_pool_paid=bounty_pool_paid+v_head WHERE id=p_t;
END $$;

CREATE OR REPLACE FUNCTION public.fixture_chests(p_cents bigint[]) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_agg(jsonb_build_object('seq',i,'tier','base','amount_cents',p_cents[i]) ORDER BY i)
    FROM generate_subscripts(p_cents,1) i $$;

CREATE OR REPLACE FUNCTION public.fixture_assert(p_ok boolean, p_what text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_what; END IF;
  RAISE NOTICE 'PASS: %', p_what;
END $$;
