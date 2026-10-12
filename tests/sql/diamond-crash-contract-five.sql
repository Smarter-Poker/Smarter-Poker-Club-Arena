\set ON_ERROR_STOP on
-- Private, synthetic PostgreSQL only. Actual JWT role, real wheel spins and the
-- real Crash starter, decider, cash-out and receipt after migration
-- 20261012114801 (Dan, 2026-10-12): contract 5 never crashes before 1.25x,
-- opens cash-out at 1.26x, pays back the round's own return R at every target
-- (chosen from its floor for a 2.9x average, 0.95 to 1.20), gives every flight
-- a 20x cap and climbs at k = 0.08; a round sealed under contract 4 keeps its
-- 1.10x point, its 1.11x cash-out and its 0.80 return. Every
-- expectation is derived first and read back second. Rolled back.
BEGIN;
SET LOCAL statement_timeout='300s';
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL "request.jwt.claims"='{"role":"authenticated"}';
DO $probe$
#variable_conflict use_variable
DECLARE
 club uuid:='d1000000-0000-4000-8000-000000000003';
 player uuid:='d1000000-0000-4000-8000-000000000005';
 two48 constant numeric:=281474976710656;
 i integer; t integer; boost integer; doubled boolean; cases integer:=0;
 commit uuid; ticket uuid; seed text; nonce bigint; roll numeric; point bigint;
 r jsonb; quote jsonb; started jsonb; settled jsonb; refused jsonb; award public.wheel_bonus_awards; round public.crash_rounds;
 bet numeric; minimum numeric; rp numeric; total numeric; s numeric; v numeric; hits integer; expect numeric; band numeric; old_rid uuid;
 before_chips numeric; report text:='';
BEGIN
 IF current_database()<>'diamond_games_probe' OR NOT EXISTS(SELECT 1 FROM public.ca_financial_epochs WHERE name='Isolated Diamond financial probe' AND is_current) THEN RAISE EXCEPTION 'Private fixture required'; END IF;
 UPDATE public.wheel_configs SET enabled=true,exposure_allowance_chips=1000000,min_seconds_between_spins=0,max_spins_per_player_per_day=100000,purchased_only=false,welcome_spin_enabled=false WHERE host_id=club;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds,exposure_allowance_chips) SELECT club,'club',g,true,0,1000000 FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET enabled=true,exposure_allowance_chips=1000000,min_seconds_between_rounds=0,max_bet_diamonds=5000,max_rounds_per_player_per_day=100000 WHERE host_id=club;
 UPDATE public.wheel_pools SET diamond_float=50000 WHERE host_id=club;
 UPDATE public.diamond_wheel_release SET enabled=true;

 -- ── 1. THE CLAMP: TWENTY TIMES FOR EVERY FLIGHT, NEVER FASTER THAN 0.08 ─────
 UPDATE public.diamond_game_configs SET max_multiplier_cents=100000,growth_k=0.5 WHERE host_id=club AND game='crash';
 IF (SELECT max_multiplier_cents FROM public.diamond_game_configs WHERE host_id=club AND game='crash')<>2000
  OR (SELECT growth_k FROM public.diamond_game_configs WHERE host_id=club AND game='crash')<>0.08 THEN RAISE EXCEPTION 'The Crash Clamp Let A Config Off 20x Or Past 0.08'; END IF;
 UPDATE public.diamond_game_configs SET max_multiplier_cents=150 WHERE host_id=club AND game='crash';
 IF (SELECT max_multiplier_cents FROM public.diamond_game_configs WHERE host_id=club AND game='crash')<>2000 THEN RAISE EXCEPTION 'The Crash Clamp Let A Config Below 20x'; END IF;
 -- The other games are not touched by the clamp.
 UPDATE public.diamond_game_configs SET max_multiplier_cents=100000,growth_k=0.12 WHERE host_id=club AND game='plinko';
 IF (SELECT max_multiplier_cents FROM public.diamond_game_configs WHERE host_id=club AND game='plinko')<>100000 THEN RAISE EXCEPTION 'The Crash Clamp Touched Plinko'; END IF;

 -- ── 2. THE POINT: R AT EVERY TARGET, ON THE HALF, TWO-THIRDS, SMALLEST AND CLAMPED FLOOR ─
 FOR i IN 1..4 LOOP
  bet:=(ARRAY[1,75,0.25,1])[i]; minimum:=(ARRAY[0.5,50,0.13,0.79])[i];
  rp:=public.fn_crash_return_ppm_v5(bet,minimum);
  IF rp<>(ARRAY[1006430,1137983,1022420,1200000])[i] THEN RAISE EXCEPTION 'Crash Return % On % Is Not As Designed',rp,bet; END IF;
  IF public.fn_crash_point_cents_v5(two48-1,bet,minimum)<>125 THEN RAISE EXCEPTION 'Crash Floor Is Not 1.25x On %',bet; END IF;
  total:=125*two48;
  FOR t IN 126..2000 LOOP
   s:=div(100*(rp*bet*100-1000000*minimum*100)*two48, 1000000*(bet*100*t-100*minimum*100));
   IF public.fn_crash_point_cents_v5(s-1,bet,minimum)<t OR public.fn_crash_point_cents_v5(s,bet,minimum)>=t THEN RAISE EXCEPTION 'Crash Boundary Wrong At %x On %',t,bet; END IF;
   v:=1000000*(s*bet*100*t+(two48-s)*100*minimum*100);
   IF v>rp*bet*100*100*two48 OR rp*bet*100*100*two48-v>=1000000*(bet*100*t-100*minimum*100) THEN RAISE EXCEPTION 'Crash Target % Is Not Worth R On %',t,bet; END IF;
   total:=total+s;
  END LOOP;
  -- The exact 20x-capped average: 2.9x wherever the return is not clamped.
  IF (i<4 AND round(total/two48/100,1)<>2.9) OR total/two48/100 NOT BETWEEN 2.4 AND 3.0 THEN RAISE EXCEPTION 'Crash Average % On % Is Not As Designed',total/two48/100,bet; END IF;
 END LOOP;
 -- The sealed draws reach the designed survival at the designed rate (16,384 fixed seeds, 4 sigma).
 FOREACH t IN ARRAY ARRAY[126,200,500,2000] LOOP
  hits:=0; seed:=encode(extensions.digest('contract-five-'||t,'sha256'),'hex');
  FOR i IN 1..16384 LOOP
   roll:=(('x'||substr(encode(extensions.hmac('contract-five:'||i,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric;
   point:=public.fn_crash_point_cents_v5(roll,1,0.5);
   IF point<125 THEN RAISE EXCEPTION 'Crash Point % Below 1.25x',point; END IF;
   IF point>=t THEN hits:=hits+1; END IF;
  END LOOP;
  expect:=0.50643/(t/100.0-0.5); band:=4*sqrt(expect*(1-expect)/16384);
  IF abs(hits/16384.0-expect)>band THEN RAISE EXCEPTION 'Crash Survival To %x Was %, Expected %',t,round(hits/16384.0,4),round(expect,4); END IF;
  report:=report||format(' %sx %s/16384 vs %s;',to_char(t/100.0,'FM990.00'),hits,round(expect*16384));
 END LOOP;

 -- ── 3. A REAL WHEEL AWARD OF EVERY KIND: 20x, 1.25x, 1.26x, THE CONTRACT ────
 FOR boost IN 1..2 LOOP
  FOREACH doubled IN ARRAY ARRAY[false,true] LOOP
   BEGIN
    award:=NULL;
    FOR i IN 1..20000 LOOP
     BEGIN
      seed:=encode(extensions.digest('contract-five-wheel-'||boost||'-'||i,'sha256'),'hex');commit:=gen_random_uuid();
      INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
      SET LOCAL ROLE authenticated;
      r:=public.fn_wheel_spin_v2(club,commit,'contract-five',2500,'paid',NULL);
      RESET ROLE;
      IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Spin refused: %',r; END IF;
      IF r#>>'{bonus,game}' IS DISTINCT FROM 'crash' OR (r#>>'{bonus,boost_multiplier}')::integer IS DISTINCT FROM boost THEN RAISE EXCEPTION USING ERRCODE='P0099',MESSAGE='next seed'; END IF;
      SELECT * INTO award FROM public.wheel_bonus_awards WHERE id=(r#>>'{bonus,id}')::uuid;
      EXIT;
     EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
     END;
    END LOOP;
    IF award.id IS NULL THEN RAISE EXCEPTION 'No Crash award at boost %',boost; END IF;
    bet:=(2500*boost+CASE WHEN doubled THEN 2500 ELSE 0 END)/100.0;
    minimum:=CASE WHEN boost=2 AND doubled THEN 50 ELSE bet/2 END;
    -- The quote before Start names contract 5 and its floors.
    SET LOCAL ROLE authenticated;
    quote:=public.fn_wheel_bonus_state(club,'crash',doubled,NULL,award.id);
    RESET ROLE;
    IF (quote#>>'{game_state,payout_version}')::integer<>5 OR (quote#>>'{game_state,cashout_floor_cents}')::integer<>126 OR (quote#>>'{game_state,crash_floor_cents}')::integer<>125
     OR (quote#>>'{game_state,minimum_payout_chips}')::numeric<>minimum
     OR (quote#>>'{game_state,crash_return_ppm}')::integer<>public.fn_crash_return_ppm_v5(bet,minimum) THEN RAISE EXCEPTION 'Contract Five Quote Wrong: %',quote; END IF;
    -- The game's own state says which contract it deals.
    SET LOCAL ROLE authenticated;
    r:=public.fn_diamond_game_state(club,'crash');
    RESET ROLE;
    IF (r#>>'{config,payout_version}')::integer<>5 OR (r#>>'{config,max_multiplier_cents}')::integer<>2000 OR (r#>>'{config,growth_k}')::numeric<>0.08 THEN RAISE EXCEPTION 'Crash State Does Not Say Contract Five: %',r->'config'; END IF;
    -- A 1.25x auto target is refused before anything is charged: 1.25x is the floor, not a target.
    SELECT count(*)+1 INTO nonce FROM public.crash_rounds WHERE user_id=player;
    ticket:=gen_random_uuid();seed:=encode(extensions.digest('contract-five-game-'||boost||doubled,'sha256'),'hex');
    INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,'crash',seed,encode(extensions.digest(seed,'sha256'),'hex'));
    SET LOCAL ROLE authenticated;
    refused:=public.fn_wheel_bonus_start(award.id,ticket,'contract-five-game',doubled,NULL,NULL,NULL,125,NULL);
    RESET ROLE;
    IF refused->>'error' NOT LIKE 'Auto Cash Out Must Be Between 1.26x And 20.00x' THEN RAISE EXCEPTION 'A 1.25x Auto Target Was Not Refused: %',refused; END IF;
    IF (SELECT status FROM public.wheel_bonus_awards WHERE id=award.id)<>'pending' THEN RAISE EXCEPTION 'A Refusal Spent The Award'; END IF;
    SET LOCAL ROLE authenticated;
    started:=public.fn_wheel_bonus_start(award.id,ticket,'contract-five-game',doubled,NULL,NULL,NULL,NULL,NULL);
    RESET ROLE;
    IF started->>'ok' IS DISTINCT FROM 'true' OR (started->>'payout_version')::integer<>5 OR (started->>'cap_cents')::integer<>2000
     OR (started->>'cashout_floor_cents')::integer<>126 OR (started->>'crash_floor_cents')::integer<>125 OR (started->>'growth_k')::numeric<>0.08
     OR (started->>'minimum_payout_chips')::numeric<>minimum
     OR (started->>'crash_return_ppm')::integer<>public.fn_crash_return_ppm_v5(bet,minimum) THEN RAISE EXCEPTION 'Contract Five Start Wrong: %',started; END IF;
    -- The open round reveals nothing that gives the point away.
    IF started->'outcome' IS DISTINCT FROM 'null'::jsonb OR started#>'{fairness,crash_cents}' IS NOT NULL OR started#>'{fairness,server_seed}' IS NOT NULL OR started#>'{fairness,roll}' IS NOT NULL THEN RAISE EXCEPTION 'An Open Round Revealed Its Point: %',started; END IF;
    SELECT * INTO round FROM public.crash_rounds WHERE commit_id=ticket;
    IF round.payout_version<>5 OR round.cap_cents<>2000 OR round.reserved_chips<>ceil(bet*2000)/100
     OR round.crash_cents<>public.fn_crash_point_cents_v5(round.roll,bet,minimum) THEN RAISE EXCEPTION 'Sealed Contract Five Round Wrong: %',to_jsonb(round); END IF;
    -- A 1.25x cash-out is refused even with the clock past it.
    PERFORM set_config('app.ledger_maintenance','probe clock: 2.9 seconds of flight',true);
    UPDATE public.crash_rounds SET started_at=clock_timestamp()-interval '2.9 seconds' WHERE id=round.id;
    PERFORM set_config('app.ledger_maintenance','',true);
    SET LOCAL ROLE authenticated; settled:=public.fn_crash_cashout(round.id,125); RESET ROLE;
    IF settled->>'error' IS DISTINCT FROM 'Cash Out Starts At 1.26x' OR (SELECT status FROM public.crash_rounds WHERE id=round.id)<>'open' THEN RAISE EXCEPTION 'A 1.25x Cash Out Was Not Refused: %',settled; END IF;
    -- Book the win at the server's hundredth, if the sealed point is above it,
    -- or watch it crash; either way the settled receipt reveals the sealed point.
    SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=club AND user_id=player;
    SET LOCAL ROLE authenticated;
    IF round.crash_cents>=127 THEN settled:=public.fn_crash_cashout(round.id,126); ELSE settled:=public.fn_crash_settle(round.id,false); END IF;
    RESET ROLE;
    IF round.crash_cents>=127 THEN
     IF settled#>>'{outcome,status}'<>'cashed' OR (settled#>>'{outcome,cashout_cents}')::integer<>126 THEN RAISE EXCEPTION 'The 1.26x Cash Out Did Not Book: %',settled; END IF;
    ELSE
     IF settled#>>'{outcome,status}'<>'crashed' OR (settled#>>'{outcome,payout_chips}')::numeric<>minimum THEN RAISE EXCEPTION 'The Floor Crash Did Not Pay Its Minimum: %',settled; END IF;
    END IF;
    IF (settled#>>'{outcome,crash_cents}')::bigint<>round.crash_cents OR (settled#>>'{fairness,crash_cents}')::bigint<>round.crash_cents OR settled#>>'{fairness,server_seed}'<>round.server_seed THEN RAISE EXCEPTION 'The Settled Receipt Did Not Reveal The Sealed Point: %',settled; END IF;
    IF (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player)<>before_chips+(settled#>>'{outcome,payout_chips}')::numeric THEN RAISE EXCEPTION 'The Payout Did Not Reach The Wallet Exactly Once'; END IF;
    report:=report||format(' boost %s add-on %s: sealed %sx, %s;',boost,doubled,to_char(round.crash_cents/100.0,'FM99990.00'),settled#>>'{outcome,status}');
    cases:=cases+1;
    RAISE EXCEPTION USING ERRCODE='P0098',MESSAGE='case rolled back';
   EXCEPTION WHEN SQLSTATE 'P0098' THEN NULL;
   END;
  END LOOP;
 END LOOP;
 IF cases<>4 THEN RAISE EXCEPTION 'Missing Contract Five Award Kinds: %',cases; END IF;

 -- ── 4. A ROUND SEALED UNDER CONTRACT 4 KEEPS ITS OWN RULES ──────────────────
 old_rid:=gen_random_uuid();
 INSERT INTO public.crash_rounds(id,host_id,host_kind,club_id,user_id,bet_diamonds,bet_chips,diamonds_per_chip,commit_id,server_seed_hash,server_seed,client_seed,nonce,roll,crash_cents,cap_cents,growth_k,auto_cashout_cents,reserved_chips,started_at,chips_minted,diamonds_after,minimum_payout_chips,payout_version)
  VALUES(old_rid,club,'club',club,player,100,1,100,gen_random_uuid(),encode(extensions.digest('v4-server','sha256'),'hex'),'v4-server','v4-client',1,0,public.fn_crash_point_cents(200000000000000,1,0.5),2500,0.1,NULL,25,clock_timestamp()-interval '1.5 seconds',0,100000,0.5,4);
 UPDATE public.diamond_game_pools SET reserved_chips=reserved_chips+25 WHERE host_id=club AND game='crash';
 IF (SELECT crash_cents FROM public.crash_rounds WHERE id=old_rid)<>110 THEN RAISE EXCEPTION 'The Contract Four Point Moved'; END IF;
 SET LOCAL ROLE authenticated; r:=public.fn_crash_settle(old_rid,false); RESET ROLE;
 IF (r->>'cashout_floor_cents')::integer<>111 OR (r->>'crash_floor_cents')::integer<>110 OR (r->>'payout_version')::integer<>4 OR (r->>'crash_return_ppm')::integer<>800000 THEN RAISE EXCEPTION 'A Contract Four Receipt Changed Its Floors: %',r; END IF;
 IF r#>'{fairness,crash_cents}' IS NOT NULL AND r->>'status'='open' THEN RAISE EXCEPTION 'An Open Contract Four Round Revealed Its Point'; END IF;

 RAISE NOTICE 'PASS Crash contract five: 20x clamp and 0.08 pace for crash only, every target 1.26x to 20x worth at most its return within one roll and a 2.9x average on the half, two-thirds and smallest floors, 1.20 on the clamped floor, sealed survival in band:% four real wheel award kinds quoted and sealed as contract 5 with a 20x cap, 1.25x auto target and cash out refused, the point revealed only on settlement and paid once, contract 4 round keeps 1.10x and 1.11x;%',
  regexp_replace(report,' boost.*',''),substring(report from ' boost.*');
END $probe$;
ROLLBACK;
