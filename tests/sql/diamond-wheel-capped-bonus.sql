\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL "request.jwt.claims"='{"role":"authenticated"}';
DO $probe$
DECLARE club uuid:='d1000000-0000-4000-8000-000000000003';
 player uuid:='d1000000-0000-4000-8000-000000000005';
 st jsonb; r jsonb; again jsonb; stake integer; i integer; commit uuid; gc uuid; seed text; award public.wheel_bonus_awards;
 before_diamonds numeric; maxentry integer;
BEGIN
 IF current_database()<>'diamond_games_probe' OR NOT EXISTS(SELECT 1 FROM public.ca_financial_epochs WHERE name='Isolated Diamond financial probe' AND is_current) THEN RAISE EXCEPTION 'Private fixture required'; END IF;
 UPDATE public.wheel_configs SET enabled=true,exposure_allowance_chips=1000000,min_seconds_between_spins=0,max_spins_per_player_per_day=100000,purchased_only=false,welcome_spin_enabled=false WHERE host_id=club;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds,exposure_allowance_chips) SELECT club,'club',g,true,0,1000000 FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET enabled=true,exposure_allowance_chips=1000000,min_seconds_between_rounds=0,max_multiplier_cents=100000 WHERE host_id=club;
 UPDATE public.wheel_pools SET diamond_float=50000 WHERE host_id=club;
 UPDATE public.diamond_wheel_release SET enabled=true;
 IF (SELECT max_multiplier_cents FROM public.diamond_game_configs WHERE host_id=club AND game='crash')<>2500 THEN RAISE EXCEPTION 'Live Crash limit missing'; END IF;
 FOREACH stake IN ARRAY ARRAY[25,100,375,2500] LOOP
  st:=public.fn_wheel_state_v2(club,stake);
  IF st->>'available'<>'true' OR (st#>>'{config,spin_price_diamonds}')::integer<>stake OR (st->>'max_funded_entry')::integer<>2500 THEN RAISE EXCEPTION 'Funded stake refused: %',st; END IF;
 END LOOP;
 UPDATE public.diamond_game_configs SET enabled=false WHERE host_id=club AND game='crash';
 st:=public.fn_wheel_state_v2(club,100);
 IF st->>'available'<>'false' THEN RAISE EXCEPTION 'Disabled game opened'; END IF;
 UPDATE public.diamond_game_configs SET enabled=true,exposure_allowance_chips=0 WHERE host_id=club AND game='crash';
 st:=public.fn_wheel_state_v2(club,2500);
 IF st->>'available'<>'false' THEN RAISE EXCEPTION 'Insufficient pool admitted'; END IF;
 UPDATE public.diamond_game_configs SET exposure_allowance_chips=1000000,max_multiplier_cents=1999 WHERE host_id=club AND game='crash';
 st:=public.fn_wheel_state_v2(club,100);
 IF st->>'available'<>'false' OR (st->>'max_funded_entry')::integer<>0 THEN RAISE EXCEPTION 'Game below 20x admitted'; END IF;
 UPDATE public.diamond_game_configs SET max_multiplier_cents=2500 WHERE host_id=club AND game='crash';
 -- Exercise the actual paid transaction, award transfer and final game ceiling.
 FOR i IN 1..4000 LOOP
  BEGIN
   commit:=gen_random_uuid();seed:=encode(extensions.digest('cap-stake-'||i,'sha256'),'hex');
   INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
   SELECT diamonds INTO before_diamonds FROM public.profiles WHERE id=player;
   r:=public.fn_wheel_spin_v2(club,commit,'cap-test',375,'paid',NULL);
   IF r->>'ok'<>'true' THEN RAISE EXCEPTION 'Paid spin refused: %',r; END IF;
   IF r#>>'{bonus,game}' IS DISTINCT FROM 'crash' THEN RAISE EXCEPTION USING ERRCODE='P0099',MESSAGE='Try next seed'; END IF;
   SELECT * INTO award FROM public.wheel_bonus_awards WHERE id=(r#>>'{bonus,id}')::uuid;
   IF award.cap_cents<2000*(award.boost_multiplier+1)/award.boost_multiplier OR award.reserved_chips<20*(award.base_diamonds+375)::numeric/100 THEN RAISE EXCEPTION 'Double Down not fully reserved'; END IF;
   again:=public.fn_wheel_spin_v2(club,commit,'cap-test',375,'paid',NULL);
   IF again->>'ok'<>'true' OR again->>'replayed'<>'true' OR (SELECT diamonds FROM public.profiles WHERE id=player)<>before_diamonds-375 THEN RAISE EXCEPTION 'Spin replay debited twice'; END IF;
   gc:=gen_random_uuid();seed:='cap-game';
   INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(gc,player,'crash',seed,encode(extensions.digest(seed,'sha256'),'hex'));
   again:=public.fn_wheel_bonus_start(award.id,gc,'cap-game',true,NULL,NULL,NULL,NULL,NULL);
   IF again->>'ok'<>'true' OR (SELECT cap_cents FROM public.crash_rounds WHERE commit_id=gc)>2500 OR (SELECT cap_cents FROM public.crash_rounds WHERE commit_id=gc)<2000 THEN RAISE EXCEPTION 'Final Crash ceiling changed or bonus refused: %',again; END IF;
   EXIT;
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
 END LOOP;
 IF award.id IS NULL THEN RAISE EXCEPTION 'No Crash bonus reached'; END IF;
 RAISE NOTICE 'PASS Capped bonus: selectable funded entries, low cover and disabled games refused, reservation units cover Double Down, Crash round ceiling stays 25x';
END $probe$;
ROLLBACK;
