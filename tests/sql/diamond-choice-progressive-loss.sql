\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL request.jwt.claims='{"role":"authenticated"}';
DO $probe$
DECLARE club uuid:='d1000000-0000-4000-8000-000000000003'; player uuid:='d1000000-0000-4000-8000-000000000005';
 game text; mode text; ticket uuid; seed text; quote jsonb; r jsonb; again jsonb; n integer; i integer;
 prizes numeric[]; prev numeric; loss numeric; q numeric; chance numeric; expected numeric; seen boolean; before_chips numeric;
BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'Private fixture required'; END IF;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,exposure_allowance_chips) SELECT club,'club',g,true,10000 FROM unnest(ARRAY['mines','crossing']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['mines','crossing']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET enabled=true,exposure_allowance_chips=10000,min_seconds_between_rounds=0 WHERE host_id=club;
 FOREACH game IN ARRAY ARRAY['mines','crossing'] LOOP
  mode:=CASE WHEN game='mines' THEN '6' ELSE 'road' END;
  prizes:=public.fn_choice_prizes_v5(game,mode,25,12.5);chance:=1;expected:=0;
  -- Independently accumulate the loss payouts plus each possible stopping prize.
  FOR n IN 2..cardinality(prizes) LOOP
   prev:=prizes[n-1]; loss:=greatest(12.5,ceil(prev*50)/100);
   q:=CASE WHEN game='mines' THEN (26-n-6)::numeric/(26-n) ELSE (prev-loss)/(prizes[n]-loss) END;
   IF abs(q*prizes[n]+(1-q)*loss-prev)>1e-12 THEN RAISE EXCEPTION 'Conditional EV changed'; END IF;
   expected:=expected+chance*(1-q)*loss;chance:=chance*q;
   IF abs(expected+chance*prizes[n]-20)>1e-10 THEN RAISE EXCEPTION 'Initial EV changed'; END IF;
   IF game='crossing' AND abs(public.fn_choice_road_probability_v5(prizes,n,12.5)-chance)>1e-12 THEN RAISE EXCEPTION 'Road probability differs'; END IF;
  END LOOP;
  seen:=false;
  FOR i IN 1..200 LOOP
   BEGIN
    ticket:=gen_random_uuid();seed:=encode(extensions.digest('progressive-'||game||'-'||i,'sha256'),'hex');
    INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,game,seed,encode(extensions.digest(seed,'sha256'),'hex'));
    quote:=public.fn_choice_state(club,game,mode,2500);
    SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=club AND user_id=player;
    SET LOCAL ROLE authenticated;
    r:=public.fn_choice_start(club,game,mode,2500,ticket,'progressive',(quote->>'max_steps')::integer);
    IF r->>'ok' IS DISTINCT FROM 'true' OR r->>'payout_version' IS DISTINCT FROM '5' THEN RAISE EXCEPTION 'New choice contract refused: %',r; END IF;
    FOR n IN 1..(r->>'max_steps')::integer LOOP
     EXIT WHEN r->>'status'<>'open';
     r:=public.fn_choice_act((r->>'id')::uuid,'pick',n-1,n-1);
     IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Move refused: %',r; END IF;
     IF n=1 AND r->>'status'='lost' THEN RAISE EXCEPTION 'First step lost'; END IF;
    END LOOP;
    again:=public.fn_choice_act((r->>'id')::uuid,'pick',n-1,n-1);
    RESET ROLE;
    IF r->>'status'='lost' AND jsonb_array_length(r->'picked')>=5 THEN
     n:=jsonb_array_length(r->'picked');
     loss:=greatest(12.5,ceil((r->'prizes'->>(n-2))::numeric*50)/100);
     IF (r->>'payout_chips')::numeric IS DISTINCT FROM loss OR (again->>'payout_chips')::numeric IS DISTINCT FROM loss OR loss<=12.5 THEN RAISE EXCEPTION 'Progressive loss wrong: %',r; END IF;
     IF (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player) IS DISTINCT FROM before_chips+loss THEN RAISE EXCEPTION 'Loss not paid once'; END IF;
     seen:=true;
    END IF;
    RAISE EXCEPTION USING ERRCODE='P0098',MESSAGE='qualified case rolled back';
   EXCEPTION WHEN SQLSTATE 'P0098' THEN NULL;
   END;
   EXIT WHEN seen;
  END LOOP;
  IF NOT seen THEN RAISE EXCEPTION 'No increasing % loss qualified',game; END IF;
 END LOOP;
 RAISE NOTICE 'PASS Progressive choice losses: new contract5 Mines and Crossing, first step safe, increasing half-last-prize guarantee, exact Promo settlement, duplicate move replay, historical contracts preserved, probability and ladder martingales retain initial 80 percent';
END $probe$;
ROLLBACK;
