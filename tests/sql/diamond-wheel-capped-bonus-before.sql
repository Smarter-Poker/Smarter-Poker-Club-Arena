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
 st:=public.fn_wheel_state_v2(club,100);
 IF st->>'available'<>'false' OR st->>'reason'<>'The Host Must Fund Every Bonus Before A Spin' OR (st->>'max_funded_entry')::integer<>0 THEN RAISE EXCEPTION 'Expected preimage failure: %',st; END IF;
 commit:=gen_random_uuid(); seed:='cap-regression-before';
 INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
 r:=public.fn_wheel_spin_v2(club,commit,'cap-test',100,'paid',NULL);
 IF r->>'ok'<>'false' OR r->>'error'<>'The Host Must Fund Every Bonus Before A Spin' THEN RAISE EXCEPTION 'Spin did not reproduce refusal: %',r; END IF;
 RAISE NOTICE 'PASS Before repair: a funded 25x Crash config refuses the wheel despite covering 20x of the doubled stake';
END $probe$;
ROLLBACK;
