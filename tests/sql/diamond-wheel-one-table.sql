-- Run only in the private Diamond fixture created by test-accounting-delivery.sh,
-- after 20261012041752_one_wheel_for_everyone.sql is applied on top of the exact
-- installed preimages (owner request 2026-10-12, Dan: "THE VIP WHEEL THAT ONLY
-- AWARDS DIAMONDS, CHIPS OR BONUS GAMES SHOULD BE THE SAME WHEEL THAT NON VIP
-- MEMBERS GET. THERE SHOULDN'T BE A DIFFERENCE.").
--
-- REAL SPINS through fn_wheel_spin_v2 and fn_wheel_state_v2, never a copy:
--
--  A. a member who is NOT a VIP and a lifetime VIP are shown the identical
--     twelve-card table, with no throwable, time bank or rabbit hunt on it, and
--     both are told `vip: true` (the receipt flag that names the item-free table);
--  B. the non-VIP lands ords 3, 6 and 9 and is paid 0.2x, 0.25x and 0.3x chips
--     into the member wallet, journaled, with no inventory grant;
--  C. three hundred real non-VIP spins: never an item, never a grant, every
--     receipt `vip: true` drawing from the published follow-up row, no prize
--     repeated, and the mix a game half the time and chips the other half;
--  D. a paid batch of five, which spins through the same function, deals the
--     same table to the non-VIP;
--  E. the retired item-price gate cannot close the wheel any more: with the
--     throwable price moved, the state stays open and a spin is accepted.
-- Everything rolls back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL "request.jwt.claims"='{"role":"authenticated"}';
DO $guard$ BEGIN
 IF current_database() IS DISTINCT FROM 'diamond_games_probe'
    OR NOT EXISTS (SELECT 1 FROM public.ca_financial_epochs WHERE name='Isolated Diamond financial probe' AND is_current) THEN
  RAISE EXCEPTION 'one-table probe requires the isolated fixture';
 END IF;
END $guard$;

CREATE FUNCTION pg_temp.force_ord(p_player uuid,p_club uuid,p_ord integer,p_entry integer,p_tag text)
RETURNS jsonb LANGUAGE plpgsql AS $force$
DECLARE seed text;i integer;commit uuid;outcome jsonb;found jsonb;
BEGIN
 FOR i IN 1..4000 LOOP
  BEGIN
   seed:=encode(extensions.digest('wheel-one-'||p_tag||'-'||p_ord||'-'||i,'sha256'),'hex');
   commit:=gen_random_uuid();
   INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash)
    VALUES(commit,p_player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
   SET LOCAL ROLE authenticated;
   outcome:=public.fn_wheel_spin_v2(p_club,commit,'oneprobe',p_entry,'paid',NULL);
   RESET ROLE;
   IF outcome->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'A forced spin was refused (ord %): %',p_ord,outcome; END IF;
   IF (outcome#>>'{outcome,ord}')::integer=p_ord THEN found:=outcome; EXIT; END IF;
   RAISE EXCEPTION USING ERRCODE='P0099',MESSAGE='roll this attempt back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
 END LOOP;
 IF found IS NULL THEN RAISE EXCEPTION 'No fixed seed in 4000 real spins reached ord %',p_ord; END IF;
 RETURN found;
END $force$;

CREATE FUNCTION pg_temp.clear_queue(p_player uuid,p_host uuid) RETURNS void LANGUAGE plpgsql AS $clear$
BEGIN
 DELETE FROM public.wheel_bonus_awards WHERE user_id=p_player;
 DELETE FROM public.wheel_card_awards WHERE user_id=p_player;
 UPDATE public.diamond_game_pools SET reserved_chips=0,wheel_allocated_diamonds=0 WHERE host_id=p_host;
END $clear$;

DO $probe$
DECLARE
 player uuid:='d1000000-0000-4000-8000-000000000005';
 vip_player uuid:='d1000000-0000-4000-8000-000000000001';
 club uuid:='d1000000-0000-4000-8000-000000000003';
 spins integer:=300;
 i integer;commit uuid;seed text;result jsonb;st jsonb;vip_st jsonb;v_ord integer;v_kind text;game text;
 prev_ord integer;prev_game text;w integer[];row_weights integer[];
 games_n integer:=0;chips_n integer:=0;chi numeric;
 member_before numeric;mult numeric;chips numeric;grants_before bigint;
 req uuid;prepared jsonb;receipt jsonb;r jsonb;
 samples jsonb:='{}';sample_key text;
BEGIN
 UPDATE public.wheel_configs SET enabled=true,exposure_allowance_chips=1000000,min_seconds_between_spins=0,
   max_spins_per_player_per_day=100000,purchased_only=false,welcome_spin_enabled=false WHERE host_id=club;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds,exposure_allowance_chips)
  SELECT club,'club',g,true,0,1000000 FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET enabled=true,exposure_allowance_chips=1000000,min_seconds_between_rounds=0,
   max_multiplier_cents=100000,max_bet_diamonds=7500 WHERE host_id=club;
 UPDATE public.wheel_pools SET diamond_float=50000 WHERE host_id=club;
 UPDATE public.diamond_wheel_release SET enabled=true;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 UPDATE public.profiles SET is_vip=true,vip_tier='lifetime',vip_expires_at=NULL WHERE id=vip_player;
 PERFORM public.add_diamonds_to_balance(vip_player,100000,'adjustment','One table probe float','wheel-one-vip-float',NULL);
 PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',true);
 IF public.fn_wheel_is_vip(player) OR NOT public.fn_wheel_is_vip(vip_player) THEN
  RAISE EXCEPTION 'The fixture does not hold one member and one VIP'; END IF;

 -- ── A. ONE TABLE, SHOWN TO BOTH ───────────────────────────────────────────
 SET LOCAL ROLE authenticated;
 st:=public.fn_wheel_state_v2(club,100);
 RESET ROLE;
 PERFORM set_config('test.user',vip_player::text,true);
 SET LOCAL ROLE authenticated;
 vip_st:=public.fn_wheel_state_v2(club,100);
 RESET ROLE;
 PERFORM set_config('test.user',player::text,true);
 samples:=jsonb_set(samples,ARRAY['state'],st);
 IF st->>'available' IS DISTINCT FROM 'true' OR vip_st->>'available' IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'The wheel is not open for both: % / %',st->>'reason',vip_st->>'reason'; END IF;
 IF st->'segments' IS DISTINCT FROM vip_st->'segments' OR st->'upgrade_segments' IS DISTINCT FROM vip_st->'upgrade_segments' THEN
  RAISE EXCEPTION 'A member and a VIP were shown different wheels: % / %',st->'segments',vip_st->'segments'; END IF;
 IF st->>'vip'<>'true' OR vip_st->>'vip'<>'true' OR st->>'contract_version'<>'4' OR st->>'model_version'<>'wheel-v4'
  OR jsonb_array_length(st->'segments')<>12
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(st->'segments') s WHERE s->>'kind' IN('throwables','time_bank','rabbit_hunt'))
  OR (SELECT count(*) FROM jsonb_array_elements(st->'segments') s WHERE s->>'kind'='chips')<>6
  OR (SELECT array_agg((s->>'multiplier')::numeric ORDER BY (s->>'ord')::integer) FROM jsonb_array_elements(st->'segments') s WHERE (s->>'ord')::integer IN(3,6,9))
     IS DISTINCT FROM ARRAY[.2,.25,.3]::numeric[] THEN
  RAISE EXCEPTION 'The member is not shown the item-free table: %',st->'segments'; END IF;

 -- ── B. THE THREE CARDS THAT USED TO BE ITEMS PAY CHIPS ────────────────────
 SELECT count(*) INTO grants_before FROM public.feature_purchases WHERE user_id=player AND source='diamond_wheel';
 FOREACH v_ord IN ARRAY ARRAY[3,6,9] LOOP
  SELECT COALESCE(chip_balance,0) INTO member_before FROM public.club_members WHERE club_id=club AND user_id=player;
  result:=pg_temp.force_ord(player,club,v_ord,100,'member');
  mult:=(result#>>'{outcome,multiplier}')::numeric;
  chips:=(result#>>'{outcome,amount}')::numeric;
  IF result->>'vip'<>'true' OR result#>>'{outcome,kind}'<>'chips' OR result->'outcome'->'grants' IS NOT NULL
   OR mult IS DISTINCT FROM (CASE v_ord WHEN 3 THEN .2 WHEN 6 THEN .25 ELSE .3 END)
   OR chips<>100*mult/100
   OR (result#>>'{outcome,value_chips}')::numeric<>chips
   OR (SELECT COALESCE(chip_balance,0) FROM public.club_members WHERE club_id=club AND user_id=player)<>member_before+chips
   OR (SELECT count(*) FROM public.chip_ledger WHERE idempotency_key IN('wheel-prize:'||(result->>'spin_id'),'wheel-prize:'||(result->>'spin_id')||':bank') AND status='posted' AND category='wheel_prize' AND to_entity_id=player)<1
   OR (SELECT count(*) FROM public.chip_transactions WHERE club_id=club AND to_user_id=player AND transaction_type='wheel_prize' AND amount=chips)<1 THEN
   RAISE EXCEPTION 'The member''s card on ord % did not pay chips exactly: %',v_ord,result->'outcome'; END IF;
  samples:=jsonb_set(samples,ARRAY[v_ord::text],result);
  PERFORM pg_temp.clear_queue(player,club);
 END LOOP;

 -- ── C. THREE HUNDRED REAL SPINS FOR A MEMBER WHO IS NOT A VIP ─────────────
 -- The previous outcome is the last spin section B left behind.
 prev_ord:=(result#>>'{outcome,ord}')::integer;
 prev_game:=COALESCE(result#>>'{secondary,outcome,game}',result#>>'{outcome,game}');
 FOR i IN 1..spins LOOP
  seed:=encode(extensions.digest('wheel-one-draw-'||i,'sha256'),'hex');
  commit:=gen_random_uuid();
  INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash)
   VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
  SET LOCAL ROLE authenticated;
  result:=public.fn_wheel_spin_v2(club,commit,'oneprobe',25,'paid',NULL);
  RESET ROLE;
  IF result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Spin % was refused: %',i,result; END IF;
  v_ord:=(result#>>'{outcome,ord}')::integer;
  v_kind:=result#>>'{outcome,kind}';
  game:=COALESCE(result#>>'{secondary,outcome,game}',result#>>'{outcome,game}');
  IF result->>'vip'<>'true' OR result->>'contract_version'<>'4' OR result->>'model'<>'wheel-v4'
   OR v_kind IN('throwables','time_bank','rabbit_hunt') OR result->'outcome'->'grants' IS NOT NULL
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(result->'segments') s WHERE s->>'kind' IN('throwables','time_bank','rabbit_hunt')) THEN
   RAISE EXCEPTION 'Spin % dealt the member an item or the wrong table: %',i,result->'outcome'; END IF;
  SELECT array_agg(v::integer ORDER BY o) INTO w FROM jsonb_array_elements_text(result#>'{fairness,weights}') WITH ORDINALITY x(v,o);
  row_weights:=public.fn_wheel_v4_weights(prev_ord::smallint,CASE WHEN prev_ord=12 THEN prev_game END);
  IF w IS DISTINCT FROM row_weights THEN
   RAISE EXCEPTION 'Spin % drew from % but the published law after ord % is %',i,w,prev_ord,row_weights; END IF;
  IF prev_ord IS NOT NULL AND v_ord=prev_ord THEN RAISE EXCEPTION 'Spin % repeated ord %',i,v_ord; END IF;
  IF prev_game IS NOT NULL AND game IS NOT NULL AND game=prev_game THEN RAISE EXCEPTION 'Spin % repeated the game %',i,game; END IF;
  IF v_kind IN('bonus','upgrade','diamonds') THEN games_n:=games_n+1;
  ELSIF v_kind='chips' THEN chips_n:=chips_n+1;
  ELSE RAISE EXCEPTION 'Spin % paid an unknown kind %',i,v_kind; END IF;
  IF i=1 THEN samples:=jsonb_set(samples,ARRAY['first'],result); END IF;
  prev_ord:=v_ord;prev_game:=game;
  PERFORM pg_temp.clear_queue(player,club);
 END LOOP;
 chi:=(games_n-spins*.5)^2/(spins*.5)+(chips_n-spins*.5)^2/(spins*.5);
 IF chi>=10.828 THEN
  RAISE EXCEPTION 'The member''s mix over % spins was %/% (chi-square % on one degree of freedom)',spins,games_n,chips_n,chi; END IF;
 IF (SELECT count(*) FROM public.feature_purchases WHERE user_id=player AND source='diamond_wheel')<>grants_before THEN
  RAISE EXCEPTION 'A member was granted wheel inventory'; END IF;

 -- ── D. A PAID BATCH DEALS THE SAME TABLE ──────────────────────────────────
 -- In its own rolled-back block, as the atomic-batch probe does, so the run it
 -- opens does not stand in front of section E.
 BEGIN
  req:=gen_random_uuid();
  SET LOCAL ROLE authenticated;
  prepared:=public.fn_wheel_batch_prepare(req,club,5,100);
  RESET ROLE;
  IF prepared->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'The batch was not prepared: %',prepared; END IF;
  SET LOCAL ROLE authenticated;
  receipt:=public.fn_wheel_batch_begin(req,'oneprobe-batch');
  RESET ROLE;
  IF receipt->>'ok' IS DISTINCT FROM 'true' OR jsonb_array_length(receipt->'receipts')<>5 THEN RAISE EXCEPTION 'The batch was refused: %',receipt; END IF;
  FOR r IN SELECT x FROM jsonb_array_elements(receipt->'receipts') x LOOP
   IF r->>'vip'<>'true' OR r#>>'{outcome,kind}' IN('throwables','time_bank','rabbit_hunt') OR r->'outcome'->'grants' IS NOT NULL
    OR r->'segments' IS DISTINCT FROM st->'segments' THEN
    RAISE EXCEPTION 'A batch spin dealt a different table: %',r->'outcome'; END IF;
  END LOOP;
  RAISE EXCEPTION USING ERRCODE='P0099',MESSAGE='batch case rolled back';
 EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
 END;
 PERFORM pg_temp.clear_queue(player,club);

 -- ── E. THE ITEM PRICES NO LONGER CLOSE THE WHEEL ──────────────────────────
 UPDATE public.feature_pricing SET diamond_cost=diamond_cost+1 WHERE feature='throwable';
 IF NOT FOUND THEN RAISE EXCEPTION 'The fixture has no throwable price to move'; END IF;
 SET LOCAL ROLE authenticated;
 st:=public.fn_wheel_state_v2(club,100);
 RESET ROLE;
 IF st->>'available' IS DISTINCT FROM 'true' OR st->>'reason' IS NOT NULL THEN
  RAISE EXCEPTION 'A moved item price still closed the wheel: %',st->>'reason'; END IF;
 seed:=encode(extensions.digest('wheel-one-repriced','sha256'),'hex');
 commit:=gen_random_uuid();
 INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash)
  VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
 SET LOCAL ROLE authenticated;
 result:=public.fn_wheel_spin_v2(club,commit,'oneprobe',100,'paid',NULL);
 RESET ROLE;
 IF result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'A moved item price still refused a spin: %',result; END IF;

 FOR sample_key IN SELECT jsonb_object_keys(samples) ORDER BY 1 LOOP
  RAISE NOTICE 'WHEEL_SAMPLE %',jsonb_build_object('kind','wheel-one-'||sample_key,'stake',CASE WHEN sample_key='first' THEN 25 ELSE 100 END,'value',samples->sample_key);
 END LOOP;
 RAISE NOTICE 'PASS One wheel for everyone: a member and a lifetime VIP shown the identical item-free table and both told vip true; the member paid 0.2x/0.25x/0.3x chips on ords 3/6/9 with no grant; % real member spins with no item, no repeat and the published row, mix %/% (chi-square %); a paid batch of five on the same table; a moved item price no longer closes the wheel',spins,games_n,chips_n,round(chi,3);
END $probe$;
ROLLBACK;
