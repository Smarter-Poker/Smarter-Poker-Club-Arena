\set ON_ERROR_STOP on
-- Exact final v4 money path, private synthetic PostgreSQL only. Each case
-- rolls back independently, including the real spin, award, addon and receipt.
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL request.jwt.claims='{"role":"authenticated"}';
DO $probe$
DECLARE
 club uuid:='d1000000-0000-4000-8000-000000000003';
 player uuid:='d1000000-0000-4000-8000-000000000005';
 game text; mode text; boost integer; doubled boolean; i integer; cases integer:=0;
 commit uuid; ticket uuid; seed text; r jsonb; started jsonb; again jsonb; quote jsonb;
 award public.wheel_bonus_awards; before_diamonds numeric; after_spin numeric;
 total integer; paid integer; minimum numeric; table_version integer;
BEGIN
 IF current_database()<>'diamond_games_probe' OR NOT EXISTS(SELECT 1 FROM public.ca_financial_epochs WHERE name='Isolated Diamond financial probe' AND is_current) THEN RAISE EXCEPTION 'Private fixture required'; END IF;
 UPDATE public.wheel_configs SET enabled=true,diamond_seed=5000,exposure_allowance_chips=2500,min_seconds_between_spins=0,max_spins_per_player_per_day=100000,purchased_only=false,welcome_spin_enabled=false WHERE host_id=club;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds,exposure_allowance_chips) SELECT club,'club',g,true,0,2500 FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs c SET enabled=true,exposure_allowance_chips=2500,min_seconds_between_rounds=0,max_bet_diamonds=5000,max_multiplier_cents=CASE WHEN c.game='crash' THEN 2500 WHEN c.game='plinko' THEN 100000 ELSE 25600 END WHERE host_id=club;
 UPDATE public.wheel_pools SET diamond_seed=5000,diamond_float=5000 WHERE host_id=club;
 UPDATE public.diamond_wheel_release SET enabled=true;
 r:=public.fn_wheel_state_v2(club,2500);
 IF r->>'available' IS DISTINCT FROM 'true' OR (r->>'max_funded_entry')::integer IS DISTINCT FROM 2500 THEN RAISE EXCEPTION 'Maximum quote refused: %',r; END IF;
 r:=public.fn_wheel_state_v2(club,2501);
 IF r->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Spin above maximum admitted'; END IF;
 FOREACH game IN ARRAY ARRAY['plinko','crash','crossing','mines'] LOOP
  mode:=CASE WHEN game='crossing' THEN 'road' WHEN game='mines' THEN '6' END;
  FOR boost IN 1..2 LOOP
   FOREACH doubled IN ARRAY ARRAY[false,true] LOOP
    BEGIN
     -- A fixed seed must produce the requested game through the real v4 draw.
     award:=NULL;
     FOR i IN 1..20000 LOOP
      BEGIN
       seed:=encode(extensions.digest('maximum-'||game||'-'||boost||'-'||i,'sha256'),'hex');commit:=gen_random_uuid();
       INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
       SELECT diamonds INTO before_diamonds FROM public.profiles WHERE id=player;
       SET LOCAL ROLE authenticated;
       r:=public.fn_wheel_spin_v2(club,commit,'maximum',2500,'paid',NULL);
       RESET ROLE;
       IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Maximum spin refused: %',r; END IF;
       IF r#>>'{bonus,game}' IS DISTINCT FROM game OR (r#>>'{bonus,boost_multiplier}')::integer IS DISTINCT FROM boost THEN RAISE EXCEPTION USING ERRCODE='P0099',MESSAGE='next fixed seed'; END IF;
       SELECT * INTO award FROM public.wheel_bonus_awards WHERE id=(r#>>'{bonus,id}')::uuid;
       EXIT;
      EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
      END;
     END LOOP;
     IF award.id IS NULL THEN RAISE EXCEPTION 'No maximum % boost % reached',game,boost; END IF;
     SELECT diamonds INTO after_spin FROM public.profiles WHERE id=player;
     IF after_spin<>before_diamonds-2500 OR award.base_diamonds<>2500*boost OR award.reserved_chips<20*(award.base_diamonds+2500)::numeric/100 THEN RAISE EXCEPTION 'Maximum spin or addon reservation wrong'; END IF;
     total:=2500*boost+CASE WHEN doubled THEN 2500 ELSE 0 END;
     paid:=2500+CASE WHEN doubled THEN 2500 ELSE 0 END;
     minimum:=CASE WHEN boost=2 AND doubled THEN 50 ELSE total::numeric/200 END;
     table_version:=CASE WHEN boost=2 AND doubled THEN 6 ELSE 4 END;
     SET LOCAL ROLE authenticated;
     quote:=public.fn_wheel_bonus_state(club,game,doubled,NULL,award.id);
     RESET ROLE;
     IF quote->>'ok' IS DISTINCT FROM 'true' OR (quote#>>'{game_state,bet_diamonds}')::integer IS DISTINCT FROM total OR (quote#>>'{game_state,minimum_payout_chips}')::numeric IS DISTINCT FROM minimum THEN RAISE EXCEPTION 'Maximum bonus quote wrong: %',quote; END IF;
     ticket:=gen_random_uuid();seed:=encode(extensions.digest('maximum-game-'||game,'sha256'),'hex');
     INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,game,seed,encode(extensions.digest(seed,'sha256'),'hex'));
     SET LOCAL ROLE authenticated;
     started:=public.fn_wheel_bonus_start(award.id,ticket,'maximum-game',doubled,mode,CASE WHEN game='plinko' THEN total END,CASE WHEN game='plinko' THEN table_version END,NULL,CASE WHEN game IN('crossing','mines') THEN (quote#>>'{game_state,max_steps}')::integer END);
     again:=public.fn_wheel_bonus_start(award.id,ticket,'maximum-game',doubled,mode,CASE WHEN game='plinko' THEN total END,CASE WHEN game='plinko' THEN table_version END,NULL,CASE WHEN game IN('crossing','mines') THEN (quote#>>'{game_state,max_steps}')::integer END);
     RESET ROLE;
     IF started->>'ok' IS DISTINCT FROM 'true' OR (started->>'bet_diamonds')::integer IS DISTINCT FROM total OR (started->>'minimum_payout_chips')::numeric IS DISTINCT FROM minimum OR ((started#>>'{bonus,entry_diamonds}')::integer+(started#>>'{bonus,added_diamonds}')::integer) IS DISTINCT FROM paid OR again->>'replayed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Maximum bonus start/replay wrong: % / %',started,again; END IF;
     IF (SELECT diamonds FROM public.profiles WHERE id=player)<>after_spin-(CASE WHEN doubled THEN 2500 ELSE 0 END) THEN RAISE EXCEPTION 'Addon debit wrong or duplicated'; END IF;
     IF game='crash' AND (SELECT cap_cents FROM public.crash_rounds WHERE commit_id=ticket) NOT BETWEEN 2000 AND 2500 THEN RAISE EXCEPTION 'Crash ceiling changed'; END IF;
     cases:=cases+1;
     RAISE EXCEPTION USING ERRCODE='P0098',MESSAGE='qualified case rolled back';
    EXCEPTION WHEN SQLSTATE 'P0098' THEN NULL;
    END;
   END LOOP;
  END LOOP;
 END LOOP;
 IF cases<>16 THEN RAISE EXCEPTION 'Missing maximum combinations: %',cases; END IF;
 RAISE NOTICE 'PASS Maximum and Double Down: all 16 real v4 combinations, four ordinary/Super games with/without addon, 2500 spin ceiling, exact 2500/5000/7500 stake, 12.50/25/50 floors, addon debited once, receipt replay, Crash stays 25x';
END $probe$;
ROLLBACK;
