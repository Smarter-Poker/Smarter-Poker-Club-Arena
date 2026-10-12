\set ON_ERROR_STOP on
-- After contract 6: each sealed contract-5 crossing round left open across the
-- install settles exactly as contract 5 decides (its own road roll, its own
-- loss rule), pays once, and its replay names the street contract 5 computes.
SET "test.user"='d1000000-0000-4000-8000-000000000005';
SET request.jwt.claims='{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated"}';
DO $after$
DECLARE w record; r public.diamond_choice_rounds; result jsonb; again jsonb; before_chips numeric; expect numeric; entry uuid; replay jsonb; seen integer:=0;
BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'Private fixture required'; END IF;
 IF to_regprocedure('public.fn_choice_road_coin_v6(text,text,bigint,integer)') IS NULL THEN RAISE EXCEPTION 'Contract 6 not installed'; END IF;
 FOR w IN SELECT * FROM pg_temp.crossing_v5_witness LOOP
  SELECT * INTO r FROM public.diamond_choice_rounds WHERE id=w.round_id;
  SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=r.club_id AND user_id=r.user_id;
  SET LOCAL ROLE authenticated;
  result:=public.fn_choice_act(r.id,'pick',1,1);
  again:=public.fn_choice_act(r.id,'pick',1,1);
  RESET ROLE;
  IF result->>'payout_version'<>'5' OR again IS DISTINCT FROM result OR result#>'{proof,coins}' IS NOT NULL THEN RAISE EXCEPTION 'Contract 6 rewrote a sealed contract 5 round: %',result; END IF;
  IF w.survives[2] THEN
   IF result->>'status'<>'open' THEN RAISE EXCEPTION 'Contract 5 street two changed outcome: %',result; END IF;
   SET LOCAL ROLE authenticated;
   result:=public.fn_choice_act(r.id,'cashout',NULL,2);
   RESET ROLE;
   expect:=r.prizes[2];
   IF result->>'status'<>'cashed' OR abs((result->>'payout_chips')::numeric-expect)>0.01 THEN RAISE EXCEPTION 'Contract 5 cash-out changed: %',result; END IF;
  ELSE
   expect:=public.fn_choice_loss_floor_v5(r.prizes,1,r.minimum_payout_chips);
   IF result->>'status'<>'lost' OR (result->>'payout_chips')::numeric IS DISTINCT FROM expect THEN RAISE EXCEPTION 'Contract 5 loss changed: %',result; END IF;
  END IF;
  IF (SELECT chip_balance FROM public.club_members WHERE club_id=r.club_id AND user_id=r.user_id) IS DISTINCT FROM before_chips+(result->>'payout_chips')::numeric THEN RAISE EXCEPTION 'Contract 5 round was not paid once'; END IF;
  -- The replay of a sealed contract-5 road names contract 5's street, not
  -- contract 4's (the defect fn_diamond_bonus_replay carried until today). The
  -- bonus entry is the one the platform writes for an ordinary round.
  INSERT INTO public.diamond_bonus_entries(user_id,club_id,host_id,host_kind,game,commit_id,base_diamonds,added_diamonds,request,result,is_fixture)
   VALUES(r.user_id,r.club_id,r.host_id,r.host_kind,'crossing',r.commit_id,2500,0,'{}'::jsonb,result,false) RETURNING id INTO entry;
  SET LOCAL ROLE authenticated;
  replay:=public.fn_diamond_bonus_replay(entry);
  RESET ROLE;
  IF (replay#>>'{replay,data,road_end}')::integer IS DISTINCT FROM w.road_end OR replay#>'{replay,data,coins}' IS NOT NULL THEN RAISE EXCEPTION 'Contract 5 replay named the wrong street: % vs %',replay,w.road_end; END IF;
  seen:=seen+1;
 END LOOP;
 IF seen<>1 THEN RAISE EXCEPTION 'Contract 5 transition case missing'; END IF;
 RAISE NOTICE 'PASS Sealed contract 5 crossing round (street two %) survived contract 6: its own roll decided street two, a loss kept half the last prize, it paid once, and its replay names contract 5''s street',
  CASE WHEN current_setting('crossing.survive')::boolean THEN 'safe' ELSE 'hit' END;
END $after$;
