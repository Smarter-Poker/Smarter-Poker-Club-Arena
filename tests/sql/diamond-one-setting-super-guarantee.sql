-- Private, synthetic PostgreSQL only. Actual JWT role and canonical payout legs.
-- One setting per game, and a Super award returns at least the spin entry.
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL request.jwt.claims='{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated"}';
DO $$
#variable_conflict use_variable
DECLARE
 player uuid:='d1000000-0000-4000-8000-000000000005'; club uuid:='d1000000-0000-4000-8000-000000000003';
 game text; variant integer; point numeric; point2 numeric; roll numeric; seed text; commit uuid; ticket uuid; nonce bigint; i integer;
 result jsonb; state jsonb; started jsonb; settled jsonb; refused jsonb; award uuid; rid uuid; cell integer; drop jsonb;
 bet numeric; minimum numeric; before_chips numeric; paid numeric; prize numeric; ladder integer[]; road_target integer;
 secondary_low integer; secondary_high integer; mode text; old_mode text; won boolean;
BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'Requires The Isolated Fixture'; END IF;
 UPDATE public.wheel_configs SET exposure_allowance_chips=100000 WHERE host_id=club;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds,exposure_allowance_chips)
 SELECT club,'club',g,true,0,100000 FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET enabled=true,exposure_allowance_chips=100000,min_seconds_between_rounds=0,max_multiplier_cents=100000 WHERE host_id=club;
 UPDATE public.diamond_wheel_release SET enabled=true;

 -- The installed design.
 IF (SELECT array_agg(version ORDER BY version) FROM public.plinko_tables WHERE activated_at IS NOT NULL) IS DISTINCT FROM ARRAY[4,5] THEN RAISE EXCEPTION 'Open Plinko Tables Are Not Diamond And Super'; END IF;
 IF (SELECT min(x) FROM public.plinko_tables t, unnest(t.multipliers_cents) x WHERE t.version=4)<>52 OR (SELECT max_multiplier_cents FROM public.plinko_tables WHERE version=4)<>2000
  OR (SELECT spec_rtp FROM public.plinko_tables WHERE version=4)<>0.800000 OR (SELECT hit_rate FROM public.plinko_tables WHERE version=4)<>1 THEN RAISE EXCEPTION 'Super Plinko Table Is Not As Designed'; END IF;
 IF (SELECT multipliers_cents FROM public.plinko_tables WHERE version=5) IS DISTINCT FROM ARRAY[2000,2000,2000,1200,500,60,35,15,8,15,35,60,500,1200,2000,2000,2000]
  OR (SELECT spec_rtp FROM public.plinko_tables WHERE version=5)<>0.800000 OR (SELECT hit_rate FROM public.plinko_tables WHERE version=5)<>1 OR (SELECT name FROM public.plinko_tables WHERE version=5)<>'Diamond' THEN RAISE EXCEPTION 'Diamond Plinko Table Is Not As Designed'; END IF;
 IF public.fn_plinko_table_version(1)<>5 OR public.fn_plinko_table_version(2)<>4 THEN RAISE EXCEPTION 'Plinko Table By Stake Kind Is Not As Designed'; END IF;
 ladder:=public.fn_choice_ladder('road');
 IF cardinality(ladder)<>12 OR ladder[1]<>110 OR ladder[12]<>2000 OR public.fn_choice_mode('crossing')<>'road' OR public.fn_choice_mode('mines')<>'6' THEN RAISE EXCEPTION 'The One Road Is Not As Designed'; END IF;
 IF public.fn_diamond_bonus_minimum(2,2)<>1 OR public.fn_diamond_bonus_minimum(2)<>0.2 OR public.fn_diamond_bonus_minimum(3,2)<>1.5 THEN RAISE EXCEPTION 'The Minimum Rule Is Not As Designed'; END IF;

 -- Four Super awards from real Upgrade spins at a 100 diamond entry: the game plays 200 diamonds, 2 chips.
 FOR variant IN 1..4 LOOP
  game:=(ARRAY['plinko','crash','crossing','mines'])[variant];
  secondary_low:=(variant-1)*20000; secondary_high:=variant*20000;
  SELECT count(*)+1 INTO nonce FROM public.wheel_spins WHERE user_id=player;
  FOR i IN 1..20000 LOOP
   seed:=encode(extensions.digest('one-setting-wheel-'||game||i,'sha256'),'hex');
   point:=floor((('x'||substr(encode(extensions.hmac('wheel-v3:one-client:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/281474976710656);
   point2:=floor((('x'||substr(encode(extensions.hmac('wheel-v3-upgrade:one-client:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/281474976710656);
   EXIT WHEN point>=98000 AND point2>=secondary_low AND point2<secondary_high;
  END LOOP;
  commit:=gen_random_uuid();
  INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
  SET LOCAL ROLE authenticated;
  result:=public.fn_wheel_spin_v2(club,commit,'one-client',100,'paid',NULL);
  RESET ROLE;
  IF result->>'ok'<>'true' OR (result#>>'{outcome,ord}')::integer<>12 OR result#>>'{secondary,outcome,game}' IS DISTINCT FROM game THEN RAISE EXCEPTION 'Expected A Super % Award: %',game,result; END IF;
  award:=(result#>>'{bonus,id}')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.wheel_bonus_awards WHERE id=award AND boost_multiplier=2 AND base_diamonds=200 AND entry_diamonds=100) THEN RAISE EXCEPTION 'Super Award Shape Wrong'; END IF;
  bet:=2; minimum:=1;

  -- The quote says what the start will use, before Start.
  SET LOCAL ROLE authenticated;
  state:=public.fn_wheel_bonus_state(club,game,false,NULL,award);
  RESET ROLE;
  IF state->>'ok'<>'true' OR state#>>'{game_state,guarantee}'<>'super' OR (state#>>'{game_state,minimum_payout_chips}')::numeric<>minimum
   OR (state#>>'{game_state,plinko_table}')::integer<>4 OR state#>>'{game_state,mode}' IS DISTINCT FROM public.fn_choice_mode(game) THEN RAISE EXCEPTION 'Super Quote Wrong For %: %',game,state; END IF;
  IF game='crossing' AND (jsonb_array_length(state#>'{game_state,prizes}')<>12 OR (state#>>'{game_state,prizes,0}')::numeric<>bet*1.1 OR (state#>>'{game_state,prizes,11}')::numeric<>bet*20 OR (state#>>'{game_state,max_steps}')::integer<>12) THEN RAISE EXCEPTION 'Super Road Quote Wrong: %',state; END IF;
  IF game='mines' AND (abs((state#>>'{game_state,prizes,0}')::numeric-(minimum+(bet*0.8-minimum)*25/19.0))>0.000001 OR jsonb_array_length(state#>'{game_state,prizes}')<1) THEN RAISE EXCEPTION 'Super Mines Quote Wrong: %',state; END IF;
  IF game='plinko' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(state#>'{game_state,tables}') t WHERE (t->>'version')::integer=4 AND (t->>'available')::boolean) THEN RAISE EXCEPTION 'Super Plinko Table Not Quoted: %',state; END IF;

  -- A game seed with a known ending: a loss for Crash and the road, any board for Mines, any batch for Plinko.
  IF game='crash' THEN SELECT count(*)+1 INTO nonce FROM public.crash_rounds WHERE user_id=player;
  ELSIF game='plinko' THEN nonce:=0;
  ELSE SELECT count(*)+1 INTO nonce FROM public.diamond_choice_rounds WHERE user_id=player AND diamond_choice_rounds.game=game; END IF;
  FOR i IN 1..20000 LOOP
   seed:=encode(extensions.digest('one-setting-game-'||game||i,'sha256'),'hex');
   roll:=(('x'||substr(encode(extensions.hmac('one-game:'||nonce||CASE WHEN game='crossing' THEN ':road' ELSE '' END,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric;
   EXIT WHEN game IN('mines','plinko') OR (game='crossing' AND (roll+1)*(bet*1.1-minimum)>(bet*0.8-minimum)*281474976710656) OR (game='crash' AND public.fn_crash_point_cents(roll,bet,minimum)=100);
  END LOOP;
  ticket:=gen_random_uuid();
  INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,game,seed,encode(extensions.digest(seed,'sha256'),'hex'));
  mode:=public.fn_choice_mode(game);
  old_mode:=CASE game WHEN 'mines' THEN '5' WHEN 'crossing' THEN 'steady' ELSE NULL END;

  -- The old settings are refused for a new round, and the refusal is not a debit.
  SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=club AND user_id=player;
  SET LOCAL ROLE authenticated;
  IF game='plinko' THEN
   refused:=public.fn_wheel_bonus_start(award,ticket,'one-game',false,NULL,20,5,NULL,NULL);
   IF refused->>'error' IS DISTINCT FROM 'Plinko Has One Table. Refresh Before You Play' THEN RAISE EXCEPTION 'The Ordinary Table Was Not Refused For A Super Award: %',refused; END IF;
   refused:=public.fn_wheel_bonus_start(award,ticket,'one-game',false,NULL,2,4,NULL,NULL);
   IF refused->>'error' IS DISTINCT FROM 'Plinko Plays Ten Drops. Refresh Before You Play' THEN RAISE EXCEPTION 'A Hundred Drops Were Not Refused: %',refused; END IF;
  ELSIF game='crash' THEN refused:=NULL;
  ELSE refused:=public.fn_wheel_bonus_start(award,ticket,'one-game',false,old_mode,NULL,NULL,NULL,1); END IF;
  RESET ROLE;
  IF game<>'crash' AND (refused->>'ok' IS DISTINCT FROM 'false' OR refused->>'error' NOT IN('This Game Has One Setting. Refresh Before You Play','Plinko Has One Table. Refresh Before You Play','Plinko Plays Ten Drops. Refresh Before You Play')) THEN RAISE EXCEPTION 'Old Setting Was Not Refused For %: %',game,refused; END IF;
  IF game<>'crash' AND (SELECT status FROM public.wheel_bonus_awards WHERE id=award)<>'pending' THEN RAISE EXCEPTION 'A Refused Start Must Leave The Award Pending'; END IF;

  -- The real start, with the one setting: ten drops of a tenth of the 200 diamond stake.
  SET LOCAL ROLE authenticated;
  IF game='plinko' THEN started:=public.fn_wheel_bonus_start(award,ticket,'one-game',false,NULL,20,4,NULL,NULL);
  ELSIF game='crash' THEN started:=public.fn_wheel_bonus_start(award,ticket,'one-game',false,NULL,NULL,NULL,NULL,NULL);
  ELSE started:=public.fn_wheel_bonus_start(award,ticket,'one-game',false,mode,NULL,NULL,NULL,CASE WHEN game='crossing' THEN 12 ELSE (state#>>'{game_state,max_steps}')::integer END); END IF;
  RESET ROLE;
  IF started->>'ok'<>'true' THEN RAISE EXCEPTION 'Super % Did Not Start: %',game,started; END IF;
  IF game='plinko' THEN
   IF (started->>'table_version')::integer<>4 OR started->>'table_name'<>'Super' OR (started->>'payout_version')::integer<>3 OR (started->>'minimum_payout_chips')::numeric<>minimum THEN RAISE EXCEPTION 'Super Plinko Did Not Use The Super Table: %',started; END IF;
   IF jsonb_array_length(started->'drops')<>10 OR (started->>'diamonds_per_drop')::integer<>20 OR (started->>'bet_diamonds')::integer<>200 THEN RAISE EXCEPTION 'Super Plinko Did Not Play Ten Drops: %',started; END IF;
   paid:=0;
   FOR drop IN SELECT * FROM jsonb_array_elements(started->'drops') LOOP
    IF (drop->>'multiplier_cents')::integer<50 THEN RAISE EXCEPTION 'A Super Drop Paid Under 0.50x: %',drop; END IF;
    paid:=paid+(drop->>'payout_chips')::numeric;
   END LOOP;
   IF (started->>'payout_chips')::numeric<>GREATEST(paid,minimum) OR (started->>'payout_chips')::numeric<minimum THEN RAISE EXCEPTION 'Super Plinko Batch Below The Entry: %',started; END IF;
   IF (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player)<>before_chips+(started->>'payout_chips')::numeric THEN RAISE EXCEPTION 'Super Plinko Payout Not Booked'; END IF;
  ELSE
   IF started->>'status'<>'open' OR (started->>'minimum_payout_chips')::numeric<>minimum OR (started->>'payout_version')::integer<>3 THEN RAISE EXCEPTION 'Super % Start Did Not Seal The Guarantee: %',game,started; END IF;
   IF game<>'crash' AND started->>'mode'<>mode THEN RAISE EXCEPTION 'Super % Started With The Wrong Setting: %',game,started; END IF;
   rid:=COALESCE(started->>'round_id',started->>'id')::uuid;
   SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=club AND user_id=player;
   IF game='crash' THEN
    -- The sealed point is 1.00x: the round has already crashed, and the loss pays the entry back.
    UPDATE public.crash_rounds SET started_at=clock_timestamp()-interval '10 seconds' WHERE id=rid;
    SET LOCAL ROLE authenticated; settled:=public.fn_crash_cashout(rid,101); RESET ROLE;
    IF settled#>>'{outcome,status}'<>'crashed' OR (settled#>>'{outcome,payout_chips}')::numeric<>minimum OR (SELECT (public.fn_crash_round_result(r)->>'payout_version')::integer FROM public.crash_rounds r WHERE r.id=rid) IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'Super Crash Loss Did Not Pay The Entry: %',settled; END IF;
   ELSIF game='crossing' THEN
    -- The sealed road roll loses the first street.
    SET LOCAL ROLE authenticated; settled:=public.fn_choice_act(rid,'pick',0,0); RESET ROLE;
    IF settled->>'status'<>'lost' OR (settled->>'payout_chips')::numeric<>minimum OR (settled->>'payout_version')::integer<>3 THEN RAISE EXCEPTION 'Super Road Loss Did Not Pay The Entry: %',settled; END IF;
   ELSE
    -- One gem then the mine: the win books the sealed first prize, and a second Super board loses.
    IF (SELECT cardinality(mine_cells) FROM public.diamond_choice_rounds WHERE id=rid)<>6 THEN RAISE EXCEPTION 'Super Mines Did Not Deal Six Mines'; END IF;
    SELECT n INTO cell FROM generate_series(0,24) n, public.diamond_choice_rounds r WHERE r.id=rid AND NOT(n=ANY(r.mine_cells)) LIMIT 1;
    SET LOCAL ROLE authenticated; settled:=public.fn_choice_act(rid,'pick',cell,0); RESET ROLE;
    IF settled->>'status'<>'open' OR (settled->>'payout_version')::integer<>3 THEN RAISE EXCEPTION 'Super Mines First Gem Wrong: %',settled; END IF;
    SELECT n INTO cell FROM generate_series(0,24) n, public.diamond_choice_rounds r WHERE r.id=rid AND (n=ANY(r.mine_cells)) LIMIT 1;
    SET LOCAL ROLE authenticated; settled:=public.fn_choice_act(rid,'pick',cell,1); RESET ROLE;
    IF settled->>'status'<>'lost' OR (settled->>'payout_chips')::numeric<>minimum THEN RAISE EXCEPTION 'Super Mines Loss Did Not Pay The Entry: %',settled; END IF;
   END IF;
   IF (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player)<>before_chips+minimum THEN RAISE EXCEPTION 'Super % Guarantee Not Booked',game; END IF;
  END IF;
  IF (SELECT status FROM public.wheel_bonus_awards WHERE id=award)<>'redeemed' THEN RAISE EXCEPTION 'Super Award Not Redeemed'; END IF;
 END LOOP;

 -- An ordinary award keeps its 10% floor, the Diamond table, the same road, six mines, and refuses the old settings.
 FOREACH game IN ARRAY ARRAY['plinko','crossing','mines'] LOOP
  road_target:=CASE game WHEN 'plinko' THEN 1 WHEN 'crossing' THEN 7 ELSE 10 END;
  SELECT count(*)+1 INTO nonce FROM public.wheel_spins WHERE user_id=player;
  FOR i IN 1..20000 LOOP
   seed:=encode(extensions.digest('one-setting-plain-'||game||i,'sha256'),'hex');
   point:=floor((('x'||substr(encode(extensions.hmac('wheel-v3:one-client:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/281474976710656);
   EXIT WHEN (game='plinko' AND point<10000) OR (game='crossing' AND point>=59200 AND point<69200) OR (game='mines' AND point>=85800 AND point<95800);
  END LOOP;
  commit:=gen_random_uuid();
  INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
  SET LOCAL ROLE authenticated;
  result:=public.fn_wheel_spin_v2(club,commit,'one-client',100,'paid',NULL);
  RESET ROLE;
  IF result->>'ok'<>'true' OR (result#>>'{outcome,ord}')::integer<>road_target THEN RAISE EXCEPTION 'Expected An Ordinary % Award: % (unfinished: %)',game,result,
   (SELECT string_agg(a.game||':'||a.status||':'||COALESCE((SELECT r.status FROM public.diamond_choice_rounds r WHERE r.commit_id=a.commit_id),(SELECT c.status FROM public.crash_rounds c WHERE c.commit_id=a.commit_id),'-'),',') FROM public.wheel_bonus_awards a WHERE a.user_id=player AND public.fn_wheel_bonus_unfinished(a)); END IF;
  award:=(result#>>'{bonus,id}')::uuid; bet:=1; minimum:=0.1;
  SET LOCAL ROLE authenticated;
  state:=public.fn_wheel_bonus_state(club,game,false,NULL,award);
  RESET ROLE;
  IF state#>>'{game_state,guarantee}'<>'standard' OR (state#>>'{game_state,minimum_payout_chips}')::numeric<>minimum OR state#>>'{game_state,mode}' IS DISTINCT FROM public.fn_choice_mode(game) OR (state#>>'{game_state,plinko_table}')::integer<>5 THEN RAISE EXCEPTION 'Ordinary Quote Wrong For %: %',game,state; END IF;
  IF game='plinko' THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(state#>'{game_state,tables}') t WHERE (t->>'version')::integer=5 AND (t->>'available')::boolean) THEN RAISE EXCEPTION 'Diamond Plinko Table Not Quoted: %',state; END IF;
   ticket:=gen_random_uuid(); seed:=encode(extensions.digest('one-setting-plain-game-plinko','sha256'),'hex');
   INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,game,seed,encode(extensions.digest(seed,'sha256'),'hex'));
   SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=club AND user_id=player;
   SET LOCAL ROLE authenticated;
   refused:=public.fn_wheel_bonus_start(award,ticket,'plain-game',false,NULL,10,4,NULL,NULL);
   IF refused->>'error' IS DISTINCT FROM 'Plinko Has One Table. Refresh Before You Play' THEN RAISE EXCEPTION 'The Super Table Was Not Refused For An Ordinary Award: %',refused; END IF;
   refused:=public.fn_wheel_bonus_start(award,ticket,'plain-game',false,NULL,5,5,NULL,NULL);
   IF refused->>'error' IS DISTINCT FROM 'Plinko Plays Ten Drops. Refresh Before You Play' THEN RAISE EXCEPTION 'Twenty Drops Were Not Refused: %',refused; END IF;
   refused:=public.fn_wheel_bonus_start(award,ticket,'plain-game',false,NULL,1,5,NULL,NULL);
   IF refused->>'error' IS DISTINCT FROM 'Plinko Plays Ten Drops. Refresh Before You Play' THEN RAISE EXCEPTION 'A Hundred Drops Were Not Refused: %',refused; END IF;
   started:=public.fn_wheel_bonus_start(award,ticket,'plain-game',false,NULL,10,5,NULL,NULL);
   RESET ROLE;
   IF started->>'ok'<>'true' OR (started->>'table_version')::integer<>5 OR started->>'table_name'<>'Diamond' OR (started->>'payout_version')::integer<>1 OR (started->>'minimum_payout_chips')::numeric<>0
    OR jsonb_array_length(started->'drops')<>10 OR (started->>'diamonds_per_drop')::integer<>10 OR (started->>'bet_diamonds')::integer<>100 THEN RAISE EXCEPTION 'Ordinary Plinko Did Not Play Ten Drops On The Diamond Table: %',started; END IF;
   paid:=0;
   FOR drop IN SELECT * FROM jsonb_array_elements(started->'drops') LOOP
    IF (drop->>'multiplier_cents')::integer<>(SELECT multipliers_cents[(drop->>'slot')::integer+1] FROM public.plinko_tables WHERE version=5) THEN RAISE EXCEPTION 'A Diamond Drop Paid Off The Table: %',drop; END IF;
    paid:=paid+(drop->>'payout_chips')::numeric;
   END LOOP;
   IF (started->>'payout_chips')::numeric<>paid OR (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player)<>before_chips+paid THEN RAISE EXCEPTION 'Ordinary Plinko Payout Not Booked: %',started; END IF;
   IF (SELECT status FROM public.wheel_bonus_awards WHERE id=award)<>'redeemed' THEN RAISE EXCEPTION 'Ordinary Plinko Award Not Redeemed'; END IF;
   CONTINUE;
  END IF;
  IF game='crossing' AND ((state#>>'{game_state,max_steps}')::integer<>12 OR (state#>>'{game_state,prizes,11}')::numeric<>20) THEN RAISE EXCEPTION 'Ordinary Road Must Open All Twelve Streets: %',state; END IF;
  IF game='mines' AND abs((state#>>'{game_state,prizes,0}')::numeric-(minimum+(bet*0.8-minimum)*25/19.0))>0.000001 THEN RAISE EXCEPTION 'Ordinary Mines Quote Wrong: %',state; END IF;
  SELECT count(*)+1 INTO nonce FROM public.diamond_choice_rounds WHERE user_id=player AND diamond_choice_rounds.game=game;
  seed:=encode(extensions.digest('one-setting-plain-game-'||game,'sha256'),'hex');
  ticket:=gen_random_uuid();
  INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,game,seed,encode(extensions.digest(seed,'sha256'),'hex'));
  mode:=public.fn_choice_mode(game);
  SET LOCAL ROLE authenticated;
  refused:=public.fn_wheel_bonus_start(award,ticket,'plain-game',false,CASE game WHEN 'mines' THEN '15' ELSE 'extreme' END,NULL,NULL,NULL,1);
  started:=public.fn_wheel_bonus_start(award,ticket,'plain-game',false,mode,NULL,NULL,NULL,CASE WHEN game='crossing' THEN 12 ELSE (state#>>'{game_state,max_steps}')::integer END);
  RESET ROLE;
  IF refused->>'ok' IS DISTINCT FROM 'false' OR refused->>'error'<>'This Game Has One Setting. Refresh Before You Play' THEN RAISE EXCEPTION 'Old Ladder Was Not Refused For %: %',game,refused; END IF;
  IF started->>'ok'<>'true' OR started->>'mode'<>mode OR (started->>'minimum_payout_chips')::numeric<>minimum OR (started->>'payout_version')::integer<>2 THEN RAISE EXCEPTION 'Ordinary % Start Wrong: %',game,started; END IF;
  IF game='crossing' AND ((started->>'max_steps')::integer<>12 OR (started#>>'{prizes,11}')::numeric<>20) THEN RAISE EXCEPTION 'Ordinary Road Sealed With The Wrong Ladder: %',started; END IF;
  rid:=COALESCE(started->>'round_id',started->>'id')::uuid;
  IF game='mines' AND (SELECT cardinality(mine_cells) FROM public.diamond_choice_rounds WHERE id=rid)<>6 THEN RAISE EXCEPTION 'Ordinary Mines Did Not Deal Six Mines'; END IF;
  -- Finish the round so the next spin is admitted: one step, then the book or the loss.
  IF game='mines' THEN SELECT n INTO cell FROM generate_series(0,24) n, public.diamond_choice_rounds r WHERE r.id=rid AND NOT(n=ANY(r.mine_cells)) LIMIT 1; ELSE cell:=0; END IF;
  SET LOCAL ROLE authenticated; settled:=public.fn_choice_act(rid,'pick',cell,0); RESET ROLE;
  IF settled->>'status'='open' THEN SET LOCAL ROLE authenticated; settled:=public.fn_choice_act(rid,'cashout',NULL,1); RESET ROLE; END IF;
  IF settled->>'status' NOT IN ('cashed','lost') OR (settled->>'status'='lost' AND (settled->>'payout_chips')::numeric<>minimum) THEN RAISE EXCEPTION 'Ordinary % Round Did Not Settle: %',game,settled; END IF;
 END LOOP;

 -- Sealed history keeps verifying: the three ladders and the old boards still read.
 IF (public.fn_choice_ladder('steady'))[12]<>2400 OR (public.fn_choice_ladder('bold'))[10]<>15000 OR (public.fn_choice_ladder('extreme'))[8]<>25600 THEN RAISE EXCEPTION 'Sealed Ladders Lost'; END IF;
 IF cardinality(public.fn_choice_board('s','c',1,15))<>15 OR cardinality(public.fn_choice_prizes('mines','10',1))<>15 THEN RAISE EXCEPTION 'Sealed Mines Boards Lost'; END IF;

 RAISE NOTICE 'PASS One setting and Super guarantee: Diamond and Super tables, ten drops a game, twelve-street road, six mines, exact quotes before Start, old settings and other drop counts refused without a debit, Super Plinko batch and Crash, road and Mines losses pay the entry, ordinary floor kept, sealed history readable';
END $$;
ROLLBACK;
