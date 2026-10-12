\set ON_ERROR_STOP on
-- Before contract 6: open a real contract-5 crossing round and cross street
-- one, so it is OPEN across the install, and record what contract 5 owes it.
-- :'survive' picks the case: a road roll that survives street two, or one hit
-- on it. A player holds one open round per game, so each case is its own run.
SET "test.user"='d1000000-0000-4000-8000-000000000005';
SET request.jwt.claims='{"role":"authenticated"}';
SET crossing.survive=:'survive';
CREATE TABLE IF NOT EXISTS pg_temp.crossing_v5_witness(round_id uuid PRIMARY KEY, survives boolean[], road_end integer);
DO $before$
DECLARE club uuid:='d1000000-0000-4000-8000-000000000003'; player uuid:='d1000000-0000-4000-8000-000000000005';
 quote jsonb; round jsonb; ticket uuid; seed text; i integer; n integer; prizes numeric[]; roll numeric; nonce bigint;
 survives boolean[]; opened integer:=0; wanted boolean:=current_setting('crossing.survive')::boolean;
BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'Private fixture required'; END IF;
 IF to_regprocedure('public.fn_choice_road_coin_v6(text,text,bigint,integer)') IS NOT NULL THEN RAISE EXCEPTION 'Contract 6 already installed'; END IF;
 FOR i IN 1..400 LOOP
  EXIT WHEN opened=1;
  seed:=encode(extensions.digest('crossing-v5-transition-'||wanted||'-'||i,'sha256'),'hex');
  SELECT count(*)+1 INTO nonce FROM public.diamond_choice_rounds WHERE user_id=player AND game='crossing';
  roll:=(('x'||substr(encode(extensions.hmac('crossing-v5-transition:'||nonce||':road',seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric;
  SET LOCAL ROLE authenticated;
  quote:=public.fn_choice_state(club,'crossing','road',2500);
  RESET ROLE;
  prizes:=ARRAY(SELECT jsonb_array_elements_text(quote->'prizes')::numeric);
  survives:=ARRAY(SELECT (roll+1)<=public.fn_choice_road_probability_v5(prizes,k,12.5)*281474976710656 FROM generate_series(1,cardinality(prizes)) k);
  CONTINUE WHEN survives[2] IS DISTINCT FROM wanted;
  ticket:=gen_random_uuid();
  INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,'crossing',seed,encode(extensions.digest(seed,'sha256'),'hex'));
  SET LOCAL ROLE authenticated;
  round:=public.fn_choice_start(club,'crossing','road',2500,ticket,'crossing-v5-transition',(quote->>'max_steps')::integer);
  IF round->>'ok' IS DISTINCT FROM 'true' OR round->>'payout_version'<>'5' THEN RAISE EXCEPTION 'Contract 5 round could not open: %',round; END IF;
  round:=public.fn_choice_act((round->>'id')::uuid,'pick',0,0);
  RESET ROLE;
  IF round->>'status'<>'open' THEN RAISE EXCEPTION 'Contract 5 street one was not certain'; END IF;
  SELECT count(*) INTO n FROM unnest(survives) s WHERE s;
  INSERT INTO pg_temp.crossing_v5_witness VALUES((round->>'id')::uuid,survives,n);
  opened:=opened+1;
 END LOOP;
 IF opened<>1 THEN RAISE EXCEPTION 'Could not seal the contract 5 case'; END IF;
END $before$;
