-- Every monetary mutation below is inside the isolated cluster's rolled-back transaction.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
-- PostgREST retains JWT claims inside SECURITY DEFINER calls. SET ROLE alone
-- would become postgres there and incorrectly exercise the service bypass.
SET LOCAL "request.jwt.claims"='{"role":"authenticated"}';
DO $guard$
DECLARE assignment text; denied boolean; before_profile jsonb; after_profile jsonb;
BEGIN
 IF public.fn_is_service_context() IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'Authenticated claims must survive SECURITY DEFINER owner context';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.profiles'::regclass
   AND tgname='trg_guard_profile_privileged_columns' AND tgenabled='O') THEN
  RAISE EXCEPTION 'The real profile guard must be active';
 END IF;
 FOREACH assignment IN ARRAY ARRAY['diamonds=COALESCE(diamonds,0)+1',
   'diamond_multiplier=COALESCE(diamond_multiplier,1)+1','is_vip=NOT COALESCE(is_vip,false)',
   'vip_tier=''guard-probe''','vip_expires_at=now()+interval ''1 day'''] LOOP
  denied:=false;
  BEGIN
   EXECUTE 'UPDATE public.profiles SET '||assignment||' WHERE id=auth.uid()';
  EXCEPTION WHEN insufficient_privilege THEN
   IF SQLERRM NOT LIKE 'profiles.% is server-managed%' THEN RAISE; END IF;
   denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Direct profile write escaped guard: %',assignment; END IF;
 END LOOP;
 -- The mirror trigger runs before the guard and normalizes mirror-only writes.
 -- Assert it leaves the complete stored profile unchanged, rather than demanding
 -- a rejection after that earlier trigger has already removed the attempted edit.
 SELECT to_jsonb(p) INTO before_profile FROM public.profiles p WHERE id=auth.uid();
 UPDATE public.profiles SET diamond_balance=COALESCE(diamond_balance,0)+1 WHERE id=auth.uid();
 SELECT to_jsonb(p) INTO after_profile FROM public.profiles p WHERE id=auth.uid();
 IF after_profile IS DISTINCT FROM before_profile THEN RAISE EXCEPTION 'Diamond mirror edit changed the stored profile'; END IF;
 denied:=false;
 SET LOCAL ROLE authenticated;
 BEGIN
  PERFORM public.add_diamonds_to_balance(auth.uid(),1,'adjustment','forbidden','guard-direct-credit',NULL);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true;
 END;
 RESET ROLE;
 IF NOT denied THEN RAISE EXCEPTION 'A browser called the private ledger writer'; END IF;
 RAISE NOTICE 'PASS Wheel JWT profile guard: direct currency and VIP writes denied, mirror unchanged, ledger writer private';
END $guard$;
DO $$
DECLARE player uuid:='d1000000-0000-4000-8000-000000000005';owner uuid:='d1000000-0000-4000-8000-000000000002';club uuid:='d1000000-0000-4000-8000-000000000003';
 result jsonb;replay jsonb;st jsonb;game_result jsonb;award uuid;commit uuid;game_commit uuid;seed text;game_seed text;drop_value integer;nonce bigint;point numeric;point2 numeric;
 target integer;variant integer;expected_game text;i integer;stake integer;before_player numeric;before_owner numeric;before_spent numeric;before_intake numeric;before_alloc numeric;
 bonus public.wheel_bonus_awards;after_bonus public.wheel_bonus_awards;hash bytea;secondary_cutoffs integer[]:=ARRAY[20000,40000,60000,80000,89600,97000,99000,100000]; secondary_floor integer; before_chips numeric; before_promo numeric; before_bank numeric; cutoffs integer[]:=ARRAY[10000,15000,29600,39600,44600,59200,69200,71200,85800,95800,98000,100000];
 floor_point integer;double_it boolean;extra integer;kind text;cost integer;mint_count bigint;denied boolean;d date:=(now() AT TIME ZONE 'America/Chicago')::date;daily uuid;cl jsonb;
 historical_receipt constant jsonb:=$historical${"ok":true,"pool":{"chips_paid":5.25,"diamond_float":6061.0},"bonus":{"id":"08b0fbcd-1ed7-4dab-85c0-e526fd116239","game":"plinko","club_id":"d1000000-0000-4000-8000-000000000003","cap_cents":100000,"base_diamonds":5000,"entry_diamonds":2500,"boost_multiplier":2},"club_id":"d1000000-0000-4000-8000-000000000003","host_id":"d1000000-0000-4000-8000-000000000003","outcome":{"ord":12,"game":null,"kind":"upgrade","label":"Upgrade","amount":5000,"locked":false,"weight":2000,"multiplier":2,"probability":0.02,"value_chips":50.0},"spin_id":"85d46beb-41ad-4038-9276-f2295cf73410","welcome":false,"balances":{"diamonds":95949,"member_chips":13.67},"fairness":{"roll":276893916919784,"nonce":16,"domain":"wheel-v2","locked":[],"commit_id":"3514c96e-7f58-49ff-84b0-3212373bd545","client_seed":"client","server_seed":"4cf4a7c1e35095a715e194a117f64015706278aee5dcdd4547b0daf429335f18","weight_total":100000,"eligible_ords":[1,2,3,4,5,6,7,8,9,10,11,12],"server_seed_hash":"738fbdec57add54f659126536649e24d2642c081233a29e7139b9ad6a6ee21c3"},"replayed":false,"segments":[{"ord":1,"game":"plinko","kind":"bonus","label":"Diamond Plinko","amount":2500,"locked":false,"weight":10000,"multiplier":1,"probability":0.1,"value_chips":25.0},{"ord":2,"game":null,"kind":"chips","label":"1x Chips","amount":25.0,"locked":false,"weight":5000,"multiplier":1,"probability":0.05,"value_chips":25.0},{"ord":3,"game":null,"kind":"throwables","label":"Throwables","amount":1000.0,"locked":false,"weight":14000,"multiplier":0.4,"probability":0.14,"value_chips":10.0},{"ord":4,"game":"crash","kind":"bonus","label":"Diamond Crash","amount":2500,"locked":false,"weight":10000,"multiplier":1,"probability":0.1,"value_chips":25.0},{"ord":5,"game":null,"kind":"diamonds","label":"2x Diamonds","amount":5000,"locked":false,"weight":8000,"multiplier":2,"probability":0.08,"value_chips":50.0},{"ord":6,"game":null,"kind":"time_bank","label":"Time Bank","amount":1000.0,"locked":false,"weight":14000,"multiplier":0.4,"probability":0.14,"value_chips":10.0},{"ord":7,"game":"crossing","kind":"bonus","label":"Donkey Cross","amount":2500,"locked":false,"weight":10000,"multiplier":1,"probability":0.1,"value_chips":25.0},{"ord":8,"game":null,"kind":"chips","label":"2x Chips","amount":50.0,"locked":false,"weight":2000,"multiplier":2,"probability":0.02,"value_chips":50.0},{"ord":9,"game":null,"kind":"rabbit_hunt","label":"Rabbit Hunt","amount":1000.0,"locked":false,"weight":14000,"multiplier":0.4,"probability":0.14,"value_chips":10.0},{"ord":10,"game":"mines","kind":"bonus","label":"Diamond Mines","amount":2500,"locked":false,"weight":10000,"multiplier":1,"probability":0.1,"value_chips":25.0},{"ord":11,"game":null,"kind":"chips","label":"3x Chips","amount":75.0,"locked":false,"weight":1000,"multiplier":3,"probability":0.01,"value_chips":75.0},{"ord":12,"game":null,"kind":"upgrade","label":"Upgrade","amount":5000,"locked":false,"weight":2000,"multiplier":2,"probability":0.02,"value_chips":50.0}],"secondary":{"outcome":{"ord":1,"game":"plinko","kind":"bonus","label":"Diamond Plinko","amount":5000,"locked":false,"weight":25000,"multiplier":2,"probability":0.25,"value_chips":50.0},"fairness":{"roll":30001411788624,"nonce":16,"domain":"wheel-v2-upgrade","locked":[],"commit_id":"3514c96e-7f58-49ff-84b0-3212373bd545","client_seed":"client","server_seed":"4cf4a7c1e35095a715e194a117f64015706278aee5dcdd4547b0daf429335f18","weight_total":100000,"eligible_ords":[1,2,3,4],"server_seed_hash":"738fbdec57add54f659126536649e24d2642c081233a29e7139b9ad6a6ee21c3"},"segments":[{"ord":1,"game":"plinko","kind":"bonus","label":"Diamond Plinko","amount":5000,"locked":false,"weight":25000,"multiplier":2,"probability":0.25,"value_chips":50.0},{"ord":2,"game":"crash","kind":"bonus","label":"Diamond Crash","amount":5000,"locked":false,"weight":25000,"multiplier":2,"probability":0.25,"value_chips":50.0},{"ord":3,"game":"crossing","kind":"bonus","label":"Donkey Cross","amount":5000,"locked":false,"weight":25000,"multiplier":2,"probability":0.25,"value_chips":50.0},{"ord":4,"game":"mines","kind":"bonus","label":"Diamond Mines","amount":5000,"locked":false,"weight":25000,"multiplier":2,"probability":0.25,"value_chips":50.0}]},"created_at":"2026-09-17T20:14:23.397421+00:00","daily_bonus":false,"bonus_ticket_id":null,"entry_funded_by":"player","segment_version":2,"contract_version":2,"diamonds_per_chip":100,"spin_price_diamonds":2500,"entry_value_diamonds":2500,"player_cost_diamonds":2500}$historical$::jsonb; historical_row public.wheel_spins;
 funding_case record; funding_group integer;cfg_before jsonb;cfg_after jsonb;funding_cfg public.diamond_game_configs;funding_pool public.diamond_game_pools;
BEGIN
 IF public.fn_wheel_v2_enabled() OR (public.fn_wheel_state_v2(club,100)->>'enabled')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'Migration activated before client cutover'; END IF;
 IF (SELECT count(*) FROM public.fn_wheel_v3_model())<>12 OR (SELECT sum(weight) FROM public.fn_wheel_v3_model())<>100000 OR EXISTS(SELECT 1 FROM public.fn_wheel_v3_model() model WHERE model.kind='nothing') THEN RAISE EXCEPTION 'Wrong model'; END IF;
 -- Independent exact rational expectation, every permitted entry including odd units.
 FOR stake IN 25..2500 LOOP
  IF (SELECT sum(m.weight*CASE WHEN m.kind='upgrade' THEN 4 ELSE m.multiplier*CASE WHEN m.kind='bonus' THEN .8 ELSE 1 END END)/100000*stake FROM public.fn_wheel_v3_model() m) <> .8*stake THEN RAISE EXCEPTION 'Wrong model expectation'; END IF;
 END LOOP;
 IF (SELECT sum(m.weight*m.multiplier*CASE WHEN m.kind='bonus' THEN .8 ELSE 1 END) FROM public.fn_wheel_v3_upgrade_model() m)<>400000 OR (SELECT count(*) FROM public.fn_wheel_v3_upgrade_model())<>8 THEN RAISE EXCEPTION 'Wrong secondary independent expectation'; END IF;
 UPDATE public.wheel_configs SET exposure_allowance_chips=100000 WHERE host_id=club;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds,exposure_allowance_chips) SELECT club,'club',g,true,0,100000 FROM unnest(ARRAY['crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET exposure_allowance_chips=100000,min_seconds_between_rounds=0 WHERE host_id=club;
 UPDATE public.diamond_wheel_release SET enabled=true;
 SET LOCAL ROLE authenticated;
 st:=public.fn_wheel_state_v2(club,25);
 RESET ROLE;
 IF st->>'ok' IS DISTINCT FROM 'true' OR st->>'available' IS DISTINCT FROM 'true' OR st->>'enabled' IS DISTINCT FROM 'true'
  OR (st#>>'{config,spin_price_diamonds}')::integer<>25 OR jsonb_array_length(st->'segments')<>12 OR jsonb_array_length(st->'upgrade_segments')<>8 OR st->>'contract_version'<>'3' THEN RAISE EXCEPTION 'Active state is not wired: %',st; END IF;
 RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel-state','stake',25,'value',st);
 -- A fixed 100x top prize must fit both configured wheel exposure and real cover.
 FOR funding_case IN SELECT * FROM (VALUES(200::numeric,.5::numeric,2473.50::numeric),(700,1.4,2469.40)) v(intake,paid,minimum) LOOP
  UPDATE public.wheel_pools SET intake_diamonds=funding_case.intake,chips_paid=funding_case.paid WHERE host_id=club;
  UPDATE public.wheel_configs SET exposure_allowance_chips=funding_case.minimum-.01 WHERE host_id=club;
  st:=public.fn_wheel_state_v2(club,2500);
  IF st->>'available' IS DISTINCT FROM 'false' OR (st->>'max_funded_entry')::integer<>2499 THEN RAISE EXCEPTION 'Wheel exposure minimum not enforced: %',st; END IF;
  commit:=gen_random_uuid();INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,'refusal','hash');
  SELECT diamonds INTO before_player FROM public.profiles WHERE id=player;
  result:=public.fn_wheel_spin_v2(club,commit,'client',2500,'paid',NULL);
  IF result->>'ok' IS DISTINCT FROM 'false' OR (SELECT consumed_by FROM public.wheel_seed_commits WHERE id=commit) IS NOT NULL OR (SELECT diamonds FROM public.profiles WHERE id=player) IS DISTINCT FROM before_player THEN RAISE EXCEPTION 'Exposure refusal consumed money or seed'; END IF;
  UPDATE public.wheel_configs SET exposure_allowance_chips=funding_case.minimum WHERE host_id=club;
  st:=public.fn_wheel_state_v2(club,2500);
  IF st->>'available' IS DISTINCT FROM 'true' OR (st->>'max_funded_entry')::integer<>2500 THEN RAISE EXCEPTION 'Exact minimum cannot open full range: %',st; END IF;
 END LOOP;
 UPDATE public.wheel_pools SET intake_diamonds=0,chips_paid=0 WHERE host_id=club;
 UPDATE public.wheel_configs SET exposure_allowance_chips=100000 WHERE host_id=club;
 BEGIN
  PERFORM * FROM public.fn_diamond_game_pay_chips('wheel_prize',club,'club',club,player,public.fn_diamond_game_cover(club,'club')-2499.99,'isolated-upgrade-cover','Isolated Cover Boundary','{}'::jsonb);
  st:=public.fn_wheel_state_v2(club,2500);
  result:=public.fn_wheel_spin_v2(club,commit,'client',2500,'paid',NULL);
  IF st->>'available' IS DISTINCT FROM 'false' OR result->>'ok' IS DISTINCT FROM 'false' OR (SELECT consumed_by FROM public.wheel_seed_commits WHERE id=commit) IS NOT NULL THEN RAISE EXCEPTION '100x lacks real host backing'; END IF;
  RAISE EXCEPTION USING ERRCODE='PDV03',MESSAGE='rollback isolated cover boundary';
 EXCEPTION WHEN SQLSTATE 'PDV03' THEN NULL;
 END;
 -- Legacy new entries close; no wager is consumed. Historical receipts remain covered by preceding probes.
 game_commit:=gen_random_uuid();INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(game_commit,player,'plinko','legacy','hash');
 result:=public.fn_diamond_bonus_start(club,'plinko',100,false,game_commit,'legacy',NULL,1,1,NULL,NULL);
 IF result->>'error' IS DISTINCT FROM 'Win This Bonus On Diamond Spins First' THEN RAISE EXCEPTION 'Legacy direct game still open: %',result; END IF;
 FOR target IN 1..12 LOOP
  FOR variant IN 1..(CASE WHEN target=12 THEN 8 WHEN target IN(1,4,7,10) THEN 2 ELSE 1 END) LOOP
   stake:=CASE WHEN target=12 OR target IN(4,7,10) THEN 2500 WHEN target IN(2,3,5,6,9) THEN 25 ELSE 100 END;
   drop_value:=CASE WHEN stake=2500 THEN 100 ELSE 1 END;
   double_it:=variant%2=0 OR target=12;extra:=CASE WHEN double_it THEN stake ELSE 0 END;
   SELECT count(*)+1 INTO nonce FROM public.wheel_spins WHERE user_id=player;
   floor_point:=CASE WHEN target=1 THEN 0 ELSE cutoffs[target-1] END;
   secondary_floor:=CASE WHEN variant=1 THEN 0 ELSE secondary_cutoffs[variant-1] END;
   FOR i IN 1..1000000 LOOP
    seed:=encode(extensions.digest('wheel-v3-fixture-'||target||'-'||variant||'-'||i,'sha256'),'hex');
    hash:=extensions.hmac('wheel-v3:client:'||nonce,seed,'sha256');
    point:=floor((('x'||substr(encode(hash,'hex'),1,12))::bit(48)::bigint)::numeric*100000/281474976710656);
    point2:=floor((('x'||substr(encode(extensions.hmac('wheel-v3-upgrade:client:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/281474976710656);
    EXIT WHEN point>=floor_point AND point<cutoffs[target] AND (target<>12 OR (point2>=secondary_floor AND point2<secondary_cutoffs[variant]));
   END LOOP;
   commit:=gen_random_uuid();INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
   SELECT diamonds INTO before_player FROM public.profiles WHERE id=player;SELECT diamonds INTO before_owner FROM public.profiles WHERE id=owner;
   IF target=12 AND variant=8 THEN
    SELECT promo_balance INTO before_promo FROM public.clubs WHERE id=club;
    PERFORM * FROM public.fn_diamond_game_pay_chips('wheel_prize',club,'club',club,player,before_promo-100,'isolated-upgrade-promo','Isolated Promo Boundary','{}'::jsonb);
    SELECT chip_treasury INTO before_bank FROM public.clubs WHERE id=club;
   END IF;
   SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=club AND user_id=player;
   before_spent:=public.fn_diamond_games_spent_today(club,player);
   SET LOCAL ROLE authenticated;
   result:=public.fn_wheel_spin_v2(club,commit,'client',stake,'paid',NULL);
   RESET ROLE;
   IF result->>'ok' IS DISTINCT FROM 'true' OR (result#>>'{outcome,ord}')::integer IS DISTINCT FROM target OR result->>'contract_version' IS DISTINCT FROM '3' OR jsonb_array_length(result->'segments')<>12 THEN RAISE EXCEPTION 'Wheel failed target %: %',target,result; END IF;
   RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel','stake',stake,'value',result);
   kind:=result#>>'{outcome,kind}';
   IF (SELECT diamonds FROM public.profiles WHERE id=player) IS DISTINCT FROM before_player-stake+(CASE WHEN kind='diamonds' THEN (result#>>'{outcome,amount}')::integer ELSE 0 END) THEN RAISE EXCEPTION 'Wrong player intake/prize'; END IF;
   cost:=CASE WHEN kind='diamonds' THEN (result#>>'{outcome,amount}')::integer WHEN kind IN('throwables','time_bank','rabbit_hunt') THEN (result#>>'{outcome,value_chips}')::numeric*100 ELSE 0 END;
   IF (SELECT diamonds FROM public.profiles WHERE id=owner) IS DISTINCT FROM before_owner+stake-cost THEN RAISE EXCEPTION 'Wrong host intake/prize'; END IF;
   IF kind IN('throwables','time_bank','rabbit_hunt','diamonds') AND (cost NOT IN(floor(stake*.5),ceil(stake*.5)) OR (result#>>'{outcome,multiplier}')::numeric<>.5) THEN RAISE EXCEPTION 'Half Entry Prize Wrong: %',result; END IF;
   SET LOCAL ROLE authenticated;
   replay:=public.fn_wheel_spin_v2(club,commit,'client',stake,'paid',NULL);
   RESET ROLE;
   IF replay-'replayed' IS DISTINCT FROM result-'replayed' OR replay->>'replayed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Spin replay changed'; END IF;
   IF public.fn_wheel_spin_v2(club,commit,'client',stake+1,'paid',NULL)->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Changed stake replay accepted'; END IF;
   IF target=12 THEN
    IF jsonb_array_length(result#>'{secondary,segments}')<>8 OR (result#>>'{secondary,outcome,ord}')::integer<>variant OR result#>>'{secondary,fairness,domain}'<>'wheel-v3-upgrade' THEN RAISE EXCEPTION 'Wrong secondary receipt'; END IF;
    IF variant>4 THEN
     IF result ? 'bonus' OR (result#>>'{secondary,outcome,amount}')::numeric<>stake::numeric/100*(ARRAY[5,10,25,100])[variant-4] OR (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player)<>before_chips+(result#>>'{secondary,outcome,amount}')::numeric THEN RAISE EXCEPTION 'Instant Upgrade chip win not paid exactly: %',result; END IF;
     IF variant=8 AND ((result#>>'{secondary,outcome,amount}')::numeric<>2500 OR (SELECT promo_balance FROM public.clubs WHERE id=club)<>0 OR (SELECT chip_treasury FROM public.clubs WHERE id=club)<>before_bank-2400) THEN RAISE EXCEPTION 'Top prize must pay2500 chips with Promo100/MainBank2400'; END IF;
    END IF;
   END IF;
   RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel-replay','stake',stake,'value',replay);
   IF kind='bonus' OR (kind='upgrade' AND variant<=4) THEN
    award:=(result#>>'{bonus,id}')::uuid;SELECT * INTO bonus FROM public.wheel_bonus_awards WHERE id=award;
    expected_game:=CASE target WHEN 1 THEN 'plinko' WHEN 4 THEN 'crash' WHEN 7 THEN 'crossing' WHEN 10 THEN 'mines' ELSE (ARRAY['plinko','crash','crossing','mines'])[variant] END;
    IF bonus.game IS DISTINCT FROM expected_game OR bonus.base_diamonds IS DISTINCT FROM stake*(CASE WHEN target=12 THEN 2 ELSE 1 END) THEN RAISE EXCEPTION 'Wrong earned game budget'; END IF;
    IF target=12 AND (jsonb_array_length(result#>'{secondary,segments}')<>8 OR result#>>'{secondary,outcome,game}' IS DISTINCT FROM expected_game) THEN RAISE EXCEPTION 'Wrong Upgrade seal'; END IF;
    -- Any unknown/foreign award is refused; its held budget cannot be spent by another money writer.
    IF public.fn_wheel_bonus_state(club,expected_game,false,NULL,gen_random_uuid())->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Mismatched award selected a fallback'; END IF;
    denied:=false;
    BEGIN UPDATE public.clubs SET promo_balance=0,chip_treasury=0 WHERE id=club; EXCEPTION WHEN OTHERS THEN IF position('Reserved' IN SQLERRM)>0 OR position('reserved' IN SQLERRM)>0 THEN denied:=true;ELSE RAISE;END IF;END;
    IF NOT denied THEN RAISE EXCEPTION 'Pending prize reservation was spendable'; END IF;
    game_commit:=gen_random_uuid();game_seed:=encode(extensions.digest('game-seed','sha256'),'hex');
    IF expected_game='crash' THEN
     SELECT count(*)+1 INTO nonce FROM public.crash_rounds WHERE user_id=player;
     FOR i IN 1..10000 LOOP
      game_seed:=encode(extensions.digest('crash-loss-'||i,'sha256'),'hex');hash:=extensions.hmac('game-client:'||nonce,game_seed,'sha256');
      EXIT WHEN public.fn_crash_point_cents((('x'||substr(encode(hash,'hex'),1,12))::bit(48)::bigint)::numeric)=100;
     END LOOP;
    END IF;
    IF expected_game='crossing' THEN
     SELECT count(*)+1 INTO nonce FROM public.diamond_choice_rounds WHERE user_id=player AND game='crossing';
     FOR i IN 1..10000 LOOP
      game_seed:=encode(extensions.digest('road-loss-'||i,'sha256'),'hex');
      point:=(('x'||substr(encode(extensions.hmac('game-client:'||nonce||':road',game_seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric;
      EXIT WHEN point>281474976710656*.9;
     END LOOP;
    END IF;
    INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(game_commit,player,expected_game,game_seed,encode(extensions.digest(game_seed,'sha256'),'hex'));
    SELECT diamonds INTO before_player FROM public.profiles WHERE id=player;
    SELECT intake_diamonds,wheel_allocated_diamonds INTO before_intake,before_alloc FROM public.diamond_game_pools WHERE host_id=club AND game=expected_game;
    -- Invalid settings abort the private start transaction, restoring its entire hold.
    SET LOCAL ROLE authenticated;
    replay:=public.fn_wheel_bonus_start(award,game_commit,'game-client',double_it,CASE WHEN expected_game='mines' THEN '5' ELSE 'steady' END,3,1,50,0);
    RESET ROLE;
    SELECT * INTO after_bonus FROM public.wheel_bonus_awards WHERE id=award;
    IF replay->>'ok' IS DISTINCT FROM 'false' OR after_bonus IS DISTINCT FROM bonus
       OR EXISTS(SELECT 1 FROM public.diamond_bonus_entries WHERE commit_id=game_commit)
       OR (SELECT consumed_by FROM public.diamond_game_commits WHERE id=game_commit) IS NOT NULL
       OR (SELECT diamonds FROM public.profiles WHERE id=player) IS DISTINCT FROM before_player
       OR (SELECT reserved_chips FROM public.diamond_game_pools WHERE host_id=club AND game=expected_game)<bonus.reserved_chips THEN
      RAISE EXCEPTION 'Rejected start consumed a funded entitlement: %',replay;
    END IF;
    PERFORM set_config('test.user',owner::text,true);
    SET LOCAL ROLE authenticated;
    replay:=public.fn_wheel_bonus_start(award,game_commit,'game-client',double_it,CASE WHEN expected_game='mines' THEN '5' ELSE 'steady' END,drop_value,1,NULL,1);
    RESET ROLE;
    PERFORM set_config('test.user',player::text,true);
    IF replay->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Another player redeemed the award'; END IF;
    SET LOCAL ROLE authenticated;
    st:=public.fn_wheel_bonus_state(club,expected_game,double_it,CASE WHEN expected_game='mines' THEN '5' ELSE 'steady' END,award);
    game_result:=public.fn_wheel_bonus_start(award,game_commit,'game-client',double_it,CASE WHEN expected_game='mines' THEN '5' ELSE 'steady' END,drop_value,1,NULL,1);
    RESET ROLE;
    RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','state','game',expected_game,'stake',stake,'double',double_it,'value',st);
    RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','start','game',expected_game,'stake',stake,'double',double_it,'value',game_result);
    IF st->>'ok' IS DISTINCT FROM 'true' OR (st#>>'{award,bet_diamonds}')::integer IS DISTINCT FROM bonus.base_diamonds+extra THEN RAISE EXCEPTION 'Award quote failed: %',st; END IF;
    IF expected_game<>'plinko' AND ((game_result->>'minimum_payout_chips')::numeric IS DISTINCT FROM ceil((bonus.base_diamonds+extra)::numeric/100*10)/100 OR game_result->>'payout_version'<>'2') THEN RAISE EXCEPTION 'Full Entry Minimum Missing: %',game_result; END IF;
    IF game_result->>'ok' IS DISTINCT FROM 'true' OR game_result->>'award_id' IS DISTINCT FROM award::text OR (game_result#>>'{bonus,entry_diamonds}')::integer IS DISTINCT FROM stake OR (game_result->>'bet_diamonds')::integer IS DISTINCT FROM bonus.base_diamonds+extra THEN RAISE EXCEPTION 'Earned % start failed: %',expected_game,game_result; END IF;
    IF (SELECT diamonds FROM public.profiles WHERE id=player) IS DISTINCT FROM before_player-extra OR (SELECT intake_diamonds FROM public.diamond_game_pools WHERE host_id=club AND game=expected_game) IS DISTINCT FROM before_intake+extra OR (SELECT wheel_allocated_diamonds FROM public.diamond_game_pools WHERE host_id=club AND game=expected_game) IS DISTINCT FROM before_alloc THEN RAISE EXCEPTION 'Prepaid base charged or allocated twice'; END IF;
    IF public.fn_diamond_games_spent_today(club,player) IS DISTINCT FROM before_spent+stake+extra THEN RAISE EXCEPTION 'Prepaid base counted as player spending twice'; END IF;
    SET LOCAL ROLE authenticated;
    replay:=public.fn_wheel_bonus_start(award,game_commit,'game-client',double_it,CASE WHEN expected_game='mines' THEN '5' ELSE 'steady' END,drop_value,1,NULL,1);
    RESET ROLE;
    RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','replay','game',expected_game,'stake',stake,'double',double_it,'value',replay);
    IF replay->>'replayed' IS DISTINCT FROM 'true' OR (SELECT diamonds FROM public.profiles WHERE id=player) IS DISTINCT FROM before_player-extra THEN RAISE EXCEPTION 'Game replay charged again'; END IF;
    IF public.fn_wheel_bonus_start(award,game_commit,'game-client',NOT double_it,CASE WHEN expected_game='mines' THEN '5' ELSE 'steady' END,drop_value,1,NULL,1)->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Award replay changed Double Down'; END IF;
    IF expected_game='plinko' AND game_result#>>'{bonus,id}' IS DISTINCT FROM game_result->>'id' THEN RAISE EXCEPTION 'Plinko receipt lost its bonus identity'; END IF;
    SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=club AND user_id=player;
    SELECT promo_balance,chip_treasury INTO before_promo,before_bank FROM public.clubs WHERE id=club;
    IF expected_game='crash' THEN game_result:=public.fn_crash_cashout((game_result->>'round_id')::uuid,101);
    ELSIF expected_game IN('crossing','mines') THEN game_result:=public.fn_choice_act((game_result->>'id')::uuid,'pick',CASE WHEN expected_game='mines' THEN (SELECT mine_cells[1] FROM public.diamond_choice_rounds WHERE id=(game_result->>'id')::uuid) ELSE 0 END,0); END IF;
    IF expected_game<>'plinko' THEN
     IF COALESCE(game_result#>>'{outcome,status}',game_result->>'status') NOT IN('lost','crashed') OR COALESCE((game_result#>>'{outcome,payout_chips}')::numeric,(game_result->>'payout_chips')::numeric) IS DISTINCT FROM ceil((bonus.base_diamonds+extra)::numeric/100*10)/100 THEN RAISE EXCEPTION 'Losing Bonus Minimum Wrong: %',game_result; END IF;
     IF (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player) IS DISTINCT FROM before_chips+(game_result->>'minimum_payout_chips')::numeric OR (SELECT promo_balance+chip_treasury FROM public.clubs WHERE id=club) IS DISTINCT FROM before_promo+before_bank-(game_result->>'minimum_payout_chips')::numeric THEN RAISE EXCEPTION 'Minimum Prize Wallet Legs Do Not Reconcile'; END IF;
     SET LOCAL ROLE authenticated;
     IF expected_game='crash' THEN replay:=public.fn_crash_cashout((game_result->>'round_id')::uuid,101);
     ELSE replay:=public.fn_choice_act((game_result->>'id')::uuid,'pick',0,0); END IF;
     RESET ROLE;
     IF COALESCE(replay->'outcome',replay) IS DISTINCT FROM COALESCE(game_result->'outcome',game_result) OR (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player) IS DISTINCT FROM before_chips+(game_result->>'minimum_payout_chips')::numeric THEN RAISE EXCEPTION 'Minimum Prize Replay Paid Twice'; END IF;
     IF (SELECT sum(amount) FROM public.chip_ledger WHERE idempotency_key IN(CASE WHEN expected_game='crash' THEN 'crash-prize:'||(game_result->>'round_id') ELSE 'choice-prize:'||(game_result->>'id') END,CASE WHEN expected_game='crash' THEN 'crash-prize:'||(game_result->>'round_id')||':bank' ELSE 'choice-prize:'||(game_result->>'id')||':bank' END)) IS DISTINCT FROM (game_result->>'minimum_payout_chips')::numeric THEN RAISE EXCEPTION 'Minimum Prize Journal Is Missing'; END IF;
    END IF;
    RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','action','game',expected_game,'stake',stake,'double',double_it,'value',game_result);
    IF game_result->>'award_id' IS DISTINCT FROM award::text THEN RAISE EXCEPTION 'Action lost award metadata'; END IF;
    SELECT * INTO after_bonus FROM public.wheel_bonus_awards WHERE id=award;
    IF after_bonus.status<>'redeemed' OR after_bonus.commit_id IS DISTINCT FROM game_commit THEN RAISE EXCEPTION 'Award not durably consumed'; END IF;
   END IF;
  END LOOP;
 END LOOP;
 -- Whole model is refused, rather than reweighted, when a single game lacks cover.
 UPDATE public.diamond_game_configs SET enabled=false WHERE host_id=club AND game='mines';
 commit:=gen_random_uuid();INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,'empty','hash');
 SELECT diamonds INTO before_player FROM public.profiles WHERE id=player;
 result:=public.fn_wheel_spin_v2(club,commit,'client',25,'paid',NULL);
 IF result->>'ok' IS DISTINCT FROM 'false' OR EXISTS(SELECT 1 FROM public.wheel_spins WHERE commit_id=commit) OR (SELECT diamonds FROM public.profiles WHERE id=player) IS DISTINCT FROM before_player THEN RAISE EXCEPTION 'Partial wheel admitted or debited'; END IF;
 UPDATE public.diamond_game_configs SET enabled=true WHERE host_id=club AND game='mines';
 -- Claimed day-ten ticket, Mint entry only, ordinary host-funded prizes, and separate welcome.
 INSERT INTO public.ca_daily_bonus_days(user_id,bonus_date,streak,cycle_day,tiles,first_claimed_at) VALUES(player,d-1,9,2,'[]',now());
 st:=public.fn_ca_daily_bonus_status();
 IF EXISTS(SELECT 1 FROM public.diamond_bonus_spin_tickets WHERE user_id=player) THEN RAISE EXCEPTION 'Preview granted daily ticket'; END IF;
 result:=public.fn_wheel_spin_v2(club,commit,'client',100,'daily',gen_random_uuid());
 IF result->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Unclaimed daily spin used'; END IF;
 cl:=public.fn_ca_daily_bonus_claim(7,gen_random_uuid(),NULL,d);daily:=(cl#>>'{granted,ticket_id}')::uuid;
 IF daily IS NULL THEN RAISE EXCEPTION 'Daily ticket claim missing: %',cl; END IF;
 SELECT count(*)+1 INTO nonce FROM public.wheel_spins WHERE user_id=player;
 FOR i IN 1..1000000 LOOP
  seed:=encode(extensions.digest('daily-top-'||i,'sha256'),'hex');
  point:=floor((('x'||substr(encode(extensions.hmac('wheel-v3:daily:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/281474976710656);
  point2:=floor((('x'||substr(encode(extensions.hmac('wheel-v3-upgrade:daily:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/281474976710656);
  EXIT WHEN point>=98000 AND point2>=99000;
 END LOOP;
 commit:=gen_random_uuid();INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
 SELECT diamonds INTO before_player FROM public.profiles WHERE id=player;SELECT diamonds INTO before_owner FROM public.profiles WHERE id=owner;
 SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=club AND user_id=player;
 result:=public.fn_wheel_spin_v2(club,commit,'daily',100,'daily',daily);
 RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel','mode','daily','stake',100,'value',result);
 IF result->>'ok' IS DISTINCT FROM 'true' OR result->>'entry_funded_by'<>'mint' OR result->>'player_cost_diamonds'<>'0' OR (SELECT count(*) FROM public.ca_mint_ledger WHERE op_id='daily-bonus-spin:'||daily AND amount=100)<>1 THEN RAISE EXCEPTION 'Mint entry failed: %',result; END IF;
 IF (result#>>'{secondary,outcome,amount}')::numeric IS DISTINCT FROM 100 OR result ? 'bonus' OR (SELECT diamonds FROM public.profiles WHERE id=player)<>before_player OR (SELECT diamonds FROM public.profiles WHERE id=owner)<>before_owner+100 OR (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player)<>before_chips+100 THEN RAISE EXCEPTION 'Daily top prize must debit host only and Mint only100entry'; END IF;
 replay:=public.fn_wheel_spin_v2(club,commit,'daily',100,'daily',daily);
 IF replay-'replayed' IS DISTINCT FROM result-'replayed' THEN RAISE EXCEPTION 'Daily replay changed'; END IF;
 RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel-replay','mode','daily','stake',100,'value',replay);
 -- Inventory rewards retire owner funds in the Mint register; they never issue new funds.
 SELECT count(*) INTO mint_count FROM public.ca_mint_ledger WHERE action='mint';
 UPDATE public.wheel_configs SET welcome_budget_chips=10000 WHERE host_id=club;
 SELECT count(*)+1 INTO nonce FROM public.wheel_spins WHERE user_id=player;
 FOR i IN 1..1000000 LOOP
  seed:=encode(extensions.digest('welcome-top-'||i,'sha256'),'hex');
  point:=floor((('x'||substr(encode(extensions.hmac('wheel-v3:welcome:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/281474976710656);
  point2:=floor((('x'||substr(encode(extensions.hmac('wheel-v3-upgrade:welcome:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/281474976710656);
  EXIT WHEN point>=98000 AND point2>=99000;
 END LOOP;
 commit:=gen_random_uuid();INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
 SELECT diamonds INTO before_player FROM public.profiles WHERE id=player;SELECT diamonds INTO before_owner FROM public.profiles WHERE id=owner;
 SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=club AND user_id=player;
 result:=public.fn_wheel_spin_v2(club,commit,'welcome',100,'welcome',NULL);
 RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel','mode','welcome','stake',100,'value',result);
 IF result->>'ok' IS DISTINCT FROM 'true' OR result->>'welcome'<>'true' OR (SELECT count(*) FROM public.ca_mint_ledger WHERE action='mint')<>mint_count THEN RAISE EXCEPTION 'Welcome failed or minted: %',result; END IF;
 IF (result#>>'{secondary,outcome,amount}')::numeric IS DISTINCT FROM 100 OR result ? 'bonus' OR (SELECT diamonds FROM public.profiles WHERE id=player)<>before_player OR (SELECT diamonds FROM public.profiles WHERE id=owner)<>before_owner OR (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player)<>before_chips+100 THEN RAISE EXCEPTION 'Welcome top prize must debit host only with no entry transfer'; END IF;
 replay:=public.fn_wheel_spin_v2(club,commit,'welcome',100,'welcome',NULL);
 IF replay-'replayed' IS DISTINCT FROM result-'replayed' THEN RAISE EXCEPTION 'Welcome replay changed'; END IF;
 RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel-replay','mode','welcome','stake',100,'value',replay);
 -- Historical local v2 receipt capture is preserved byte-for-byte after v3 cutover.
 -- Seed the already-settled record only; this fixture does not issue a prize.
 SELECT * INTO historical_row FROM public.wheel_spins WHERE user_id=player AND NOT is_welcome AND bonus_ticket_id IS NULL LIMIT 1;
 historical_row.id:=(historical_receipt->>'spin_id')::uuid;
 historical_row.commit_id:=(historical_receipt#>>'{fairness,commit_id}')::uuid;
 historical_row.client_seed:=historical_receipt#>>'{fairness,client_seed}';
 historical_row.server_seed:=historical_receipt#>>'{fairness,server_seed}';
 historical_row.server_seed_hash:=historical_receipt#>>'{fairness,server_seed_hash}';
 historical_row.nonce:=(historical_receipt#>>'{fairness,nonce}')::bigint;
 historical_row.spin_price_diamonds:=(historical_receipt->>'entry_value_diamonds')::integer;
 historical_row.segment_version:=2;historical_row.receipt_v2:=historical_receipt;
 INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(historical_row.commit_id,player,historical_row.server_seed,historical_row.server_seed_hash);
 INSERT INTO public.wheel_spins SELECT (historical_row).*;
 UPDATE public.wheel_seed_commits SET consumed_by=historical_row.id WHERE id=historical_row.commit_id;
 SELECT diamonds INTO before_player FROM public.profiles WHERE id=player;
 replay:=public.fn_wheel_spin_v2(club,historical_row.commit_id,historical_row.client_seed,historical_row.spin_price_diamonds,'paid',NULL);
 IF replay-'replayed' IS DISTINCT FROM historical_receipt-'replayed' OR (SELECT diamonds FROM public.profiles WHERE id=player)<>before_player THEN RAISE EXCEPTION 'v3 cutover rewrote or charged historical v2 receipt'; END IF;
 RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel-historical-replay','value',replay);
 SET LOCAL ROLE authenticated;
 st:=public.fn_wheel_history(club,100);
 RESET ROLE;
 IF jsonb_array_length(st)<>(SELECT count(*) FROM public.wheel_spins WHERE user_id=player) THEN RAISE EXCEPTION 'History omitted an outcome'; END IF;
 RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel-history','value',st);
 replay:=public.fn_wheel_spin_v2(club,(public.fn_wheel_commit()->>'commit_id')::uuid,'welcome-twice',100,'welcome',NULL);
 IF replay->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Welcome spent twice'; END IF;
 IF has_table_privilege('authenticated','wheel_bonus_awards','INSERT') OR has_table_privilege('authenticated','diamond_wheel_release','UPDATE') OR has_function_privilege('authenticated','fn_wheel_bonus_player_debit(integer)','EXECUTE') OR has_function_privilege('anon','fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)','EXECUTE') THEN RAISE EXCEPTION 'Private award authority exposed'; END IF;
 RAISE NOTICE 'PASS Wheel v3: twelve primary and eight weighted Upgrade prizes, exact model, 2500-chip top payout, minimum exposure and real cover, prepaid games, original-entry Double Down, private authority, replay, Mint entry and welcome';
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
