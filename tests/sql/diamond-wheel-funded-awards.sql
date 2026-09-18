-- Every monetary mutation below is inside the isolated cluster's rolled-back transaction.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
DO $$
DECLARE player uuid:='d1000000-0000-4000-8000-000000000005';owner uuid:='d1000000-0000-4000-8000-000000000002';club uuid:='d1000000-0000-4000-8000-000000000003';
 result jsonb;replay jsonb;st jsonb;game_result jsonb;award uuid;commit uuid;game_commit uuid;seed text;game_seed text;drop_value integer;nonce bigint;point numeric;point2 numeric;
 target integer;variant integer;expected_game text;i integer;stake integer;before_player numeric;before_owner numeric;before_spent numeric;before_intake numeric;before_alloc numeric;
 bonus public.wheel_bonus_awards;after_bonus public.wheel_bonus_awards;hash bytea;cutoffs integer[]:=ARRAY[10000,15000,29000,39000,47000,61000,71000,73000,87000,97000,98000,100000];
 floor_point integer;double_it boolean;extra integer;kind text;cost integer;mint_count bigint;denied boolean;d date:=(now() AT TIME ZONE 'America/Chicago')::date;daily uuid;cl jsonb;
 funding_case record; funding_group integer;cfg_before jsonb;cfg_after jsonb;funding_cfg public.diamond_game_configs;funding_pool public.diamond_game_pools;
BEGIN
 IF public.fn_wheel_v2_enabled() OR (public.fn_wheel_state_v2(club,100)->>'enabled')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'Migration activated before client cutover'; END IF;
 IF (SELECT count(*) FROM public.fn_wheel_v2_model())<>12 OR (SELECT sum(weight) FROM public.fn_wheel_v2_model())<>100000 OR EXISTS(SELECT 1 FROM public.fn_wheel_v2_model() model WHERE model.kind='nothing') THEN RAISE EXCEPTION 'Wrong model'; END IF;
 -- Independent exact rational expectation, every permitted entry including odd units.
 FOR stake IN 25..2500 LOOP
  IF (SELECT sum(m.weight*m.multiplier*CASE WHEN m.kind IN ('bonus','upgrade') THEN .8 ELSE 1 END)/100000*stake FROM public.fn_wheel_v2_model() m) <> .8*stake THEN RAISE EXCEPTION 'Wrong model expectation'; END IF;
 END LOOP;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds,exposure_allowance_chips) SELECT club,'club',g,true,0,100000 FROM unnest(ARRAY['crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET exposure_allowance_chips=100000,min_seconds_between_rounds=0 WHERE host_id=club;
 UPDATE public.diamond_wheel_release SET enabled=true;
 SET LOCAL ROLE authenticated;
 st:=public.fn_wheel_state_v2(club,25);
 RESET ROLE;
 IF st->>'ok' IS DISTINCT FROM 'true' OR st->>'available' IS DISTINCT FROM 'true' OR st->>'enabled' IS DISTINCT FROM 'true'
  OR (st#>>'{config,spin_price_diamonds}')::integer<>25 OR jsonb_array_length(st->'segments')<>12 THEN RAISE EXCEPTION 'Active state is not wired: %',st; END IF;
 RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel-state','stake',25,'value',st);
 -- The configured allowance is an explicit admission policy, even with a larger bank.
 UPDATE public.diamond_game_configs SET exposure_allowance_chips=1250,cap_fraction=.95 WHERE host_id=club;
 st:=public.fn_wheel_state_v2(club,2500);
 IF st->>'available' IS DISTINCT FROM 'false' OR (st->>'max_funded_entry')::integer<>2043 THEN RAISE EXCEPTION 'Funded range ignored configured exposure: %',st; END IF;
 st:=public.fn_wheel_state_v2(club,2043);
 IF st->>'available' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Exact funded boundary refused: %',st; END IF;
 -- Actual 2026-09-17 host pool figures, mapped to synthetic local identities.
 -- Exercise the real owner setter, not an invented config write implementation.
 FOR funding_group IN 1..2 LOOP
  FOR funding_case IN SELECT * FROM (VALUES
   (1,'crash',0::numeric,0::numeric,1528.95::numeric),
   (1,'crossing',0,0,1528.95),(1,'mines',0,0,1528.95),(1,'plinko',0,0,1528.95),
   (2,'crash',1000,9.50,1528.45),(2,'crossing',200,0,1526.95),
   (2,'mines',1400,3.65,1518.60),(2,'plinko',1500,8.78,1522.73)
  ) v(host_case,game,intake,paid,minimum) WHERE host_case=funding_group LOOP
   UPDATE public.diamond_game_pools SET intake_diamonds=funding_case.intake,chips_paid=funding_case.paid WHERE host_id=club AND game=funding_case.game;
   SELECT to_jsonb(c) INTO cfg_before FROM public.diamond_game_configs c WHERE host_id=club AND game=funding_case.game;
   SET LOCAL ROLE authenticated;
   result:=public.fn_diamond_game_set_config(club,funding_case.game,jsonb_build_object('exposure_allowance_chips',funding_case.minimum));
   RESET ROLE;
   IF result->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Ordinary player changed exposure'; END IF;
   PERFORM set_config('test.user',owner::text,true);
   SET LOCAL ROLE authenticated;
   result:=public.fn_diamond_game_set_config(club,funding_case.game,jsonb_build_object('exposure_allowance_chips',funding_case.minimum));
   RESET ROLE;
   PERFORM set_config('test.user',player::text,true);
   SELECT * INTO funding_cfg FROM public.diamond_game_configs c WHERE host_id=club AND game=funding_case.game;
   cfg_after:=to_jsonb(funding_cfg);
   SELECT * INTO funding_pool FROM public.diamond_game_pools WHERE host_id=club AND game=funding_case.game;
   IF result->>'ok' IS DISTINCT FROM 'true' OR funding_cfg.updated_by IS DISTINCT FROM owner
     OR cfg_before-ARRAY['exposure_allowance_chips','updated_at','updated_by'] IS DISTINCT FROM cfg_after-ARRAY['exposure_allowance_chips','updated_at','updated_by'] THEN RAISE EXCEPTION 'Exposure-only setter changed another setting: %',result; END IF;
   IF public.fn_diamond_game_cap_cents(funding_cfg,funding_pool,200000,50,100000)<>3000 THEN RAISE EXCEPTION 'Prospective minimum does not cover Upgrade Double Down'; END IF;
   funding_cfg.exposure_allowance_chips:=funding_cfg.exposure_allowance_chips-.01;
   IF public.fn_diamond_game_cap_cents(funding_cfg,funding_pool,200000,50,100000)>=3000 THEN RAISE EXCEPTION 'Proposed minimum was not minimal to one cent'; END IF;
  END LOOP;
  st:=public.fn_wheel_state_v2(club,2500);
  IF st->>'available' IS DISTINCT FROM 'true' OR (st->>'max_funded_entry')::integer<>2500 THEN RAISE EXCEPTION 'Prospective host values did not open full range: %',st; END IF;
 END LOOP;
 UPDATE public.diamond_game_pools SET intake_diamonds=0,chips_paid=0 WHERE host_id=club;
 UPDATE public.diamond_game_configs SET exposure_allowance_chips=100000 WHERE host_id=club;


 -- Legacy new entries close; no wager is consumed. Historical receipts remain covered by preceding probes.
 game_commit:=gen_random_uuid();INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(game_commit,player,'plinko','legacy','hash');
 result:=public.fn_diamond_bonus_start(club,'plinko',100,false,game_commit,'legacy',NULL,1,1,NULL,NULL);
 IF result->>'error' IS DISTINCT FROM 'Win This Bonus On Diamond Spins First' THEN RAISE EXCEPTION 'Legacy direct game still open: %',result; END IF;
 FOR target IN 1..12 LOOP
  FOR variant IN 1..(CASE WHEN target=12 THEN 4 WHEN target IN(1,4,7,10) THEN 2 ELSE 1 END) LOOP
   stake:=CASE WHEN target=12 THEN 2500 WHEN target=3 THEN 26 WHEN target=2 THEN 25 ELSE 100 END;
   drop_value:=CASE WHEN stake=2500 THEN 100 ELSE 1 END;
   double_it:=variant%2=0 OR target=12;extra:=CASE WHEN double_it THEN stake ELSE 0 END;
   SELECT count(*)+1 INTO nonce FROM public.wheel_spins WHERE user_id=player;
   floor_point:=CASE WHEN target=1 THEN 0 ELSE cutoffs[target-1] END;
   FOR i IN 1..100000 LOOP
    seed:=encode(extensions.digest('wheel-fixture-'||target||'-'||variant||'-'||i,'sha256'),'hex');
    hash:=extensions.hmac('wheel-v2:client:'||nonce,seed,'sha256');
    point:=floor((('x'||substr(encode(hash,'hex'),1,12))::bit(48)::bigint)::numeric*100000/281474976710656);
    point2:=floor((('x'||substr(encode(extensions.hmac('wheel-v2-upgrade:client:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*4/281474976710656)+1;
    EXIT WHEN point>=floor_point AND point<cutoffs[target] AND (target<>12 OR point2=variant);
   END LOOP;
   commit:=gen_random_uuid();INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
   SELECT diamonds INTO before_player FROM public.profiles WHERE id=player;SELECT diamonds INTO before_owner FROM public.profiles WHERE id=owner;
   before_spent:=public.fn_diamond_games_spent_today(club,player);
   SET LOCAL ROLE authenticated;
   result:=public.fn_wheel_spin_v2(club,commit,'client',stake,'paid',NULL);
   RESET ROLE;
   IF result->>'ok' IS DISTINCT FROM 'true' OR (result#>>'{outcome,ord}')::integer IS DISTINCT FROM target OR result->>'contract_version' IS DISTINCT FROM '2' OR jsonb_array_length(result->'segments')<>12 THEN RAISE EXCEPTION 'Wheel failed target %: %',target,result; END IF;
   RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel','stake',stake,'value',result);
   kind:=result#>>'{outcome,kind}';
   IF (SELECT diamonds FROM public.profiles WHERE id=player) IS DISTINCT FROM before_player-stake+(CASE WHEN kind='diamonds' THEN stake*2 ELSE 0 END) THEN RAISE EXCEPTION 'Wrong player intake/prize'; END IF;
   cost:=CASE WHEN kind='diamonds' THEN stake*2 WHEN kind IN('throwables','time_bank','rabbit_hunt') THEN (result#>>'{outcome,value_chips}')::numeric*100 ELSE 0 END;
   IF (SELECT diamonds FROM public.profiles WHERE id=owner) IS DISTINCT FROM before_owner+stake-cost THEN RAISE EXCEPTION 'Wrong host intake/prize'; END IF;
   SET LOCAL ROLE authenticated;
   replay:=public.fn_wheel_spin_v2(club,commit,'client',stake,'paid',NULL);
   RESET ROLE;
   IF replay-'replayed' IS DISTINCT FROM result-'replayed' OR replay->>'replayed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Spin replay changed'; END IF;
   IF public.fn_wheel_spin_v2(club,commit,'client',stake+1,'paid',NULL)->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Changed stake replay accepted'; END IF;
   IF kind IN('bonus','upgrade') THEN
    award:=(result#>>'{bonus,id}')::uuid;SELECT * INTO bonus FROM public.wheel_bonus_awards WHERE id=award;
    expected_game:=CASE target WHEN 1 THEN 'plinko' WHEN 4 THEN 'crash' WHEN 7 THEN 'crossing' WHEN 10 THEN 'mines' ELSE (ARRAY['plinko','crash','crossing','mines'])[variant] END;
    IF bonus.game IS DISTINCT FROM expected_game OR bonus.base_diamonds IS DISTINCT FROM stake*(CASE WHEN target=12 THEN 2 ELSE 1 END) THEN RAISE EXCEPTION 'Wrong earned game budget'; END IF;
    IF target=12 AND (jsonb_array_length(result#>'{secondary,segments}')<>4 OR result#>>'{secondary,outcome,game}' IS DISTINCT FROM expected_game) THEN RAISE EXCEPTION 'Wrong Upgrade seal'; END IF;
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
    IF expected_game='crash' THEN game_result:=public.fn_crash_cashout((game_result->>'round_id')::uuid,101);
    ELSIF expected_game IN('crossing','mines') THEN game_result:=public.fn_choice_act((game_result->>'id')::uuid,'pick',0,0); END IF;
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
 commit:=(public.fn_wheel_commit()->>'commit_id')::uuid;
 result:=public.fn_wheel_spin_v2(club,commit,'daily',100,'daily',daily);
 RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel','mode','daily','stake',100,'value',result);
 IF result->>'ok' IS DISTINCT FROM 'true' OR result->>'entry_funded_by'<>'mint' OR result->>'player_cost_diamonds'<>'0' OR (SELECT count(*) FROM public.ca_mint_ledger WHERE op_id='daily-bonus-spin:'||daily AND amount=100)<>1 THEN RAISE EXCEPTION 'Mint entry failed: %',result; END IF;
 -- Inventory rewards retire owner funds in the Mint register; they never issue new funds.
 SELECT count(*) INTO mint_count FROM public.ca_mint_ledger WHERE action='mint';
 UPDATE public.wheel_configs SET welcome_budget_chips=10000 WHERE host_id=club;
 result:=public.fn_wheel_spin_v2(club,(public.fn_wheel_commit()->>'commit_id')::uuid,'welcome',100,'welcome',NULL);
 RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel','mode','welcome','stake',100,'value',result);
 IF result->>'ok' IS DISTINCT FROM 'true' OR result->>'welcome'<>'true' OR (SELECT count(*) FROM public.ca_mint_ledger WHERE action='mint')<>mint_count THEN RAISE EXCEPTION 'Welcome failed or minted: %',result; END IF;
 replay:=public.fn_wheel_spin_v2(club,(public.fn_wheel_commit()->>'commit_id')::uuid,'welcome-twice',100,'welcome',NULL);
 IF replay->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Welcome spent twice'; END IF;
 IF has_table_privilege('authenticated','wheel_bonus_awards','INSERT') OR has_table_privilege('authenticated','diamond_wheel_release','UPDATE') OR has_function_privilege('authenticated','fn_wheel_bonus_player_debit(integer)','EXECUTE') OR has_function_privilege('anon','fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)','EXECUTE') THEN RAISE EXCEPTION 'Private award authority exposed'; END IF;
 RAISE NOTICE 'PASS Wheel v2: twelve fixed outcomes, exact model, sealed Upgrade, owner custody, inventory, prepaid four-game budgets, Double Down, replay identity, reserved cover, claimed Mint entry, independent welcome and private authority';
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
