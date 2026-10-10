-- 20261010083333_choice_losses_keep_half_the_last_prize_and_games_show_lifeti.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- Owner request 2026-10-10: new choice losses protect half the last safe prize.
-- Contract 5 preserves old sealed rounds, the initial 20 percent edge, host
-- funding, authenticated admission, journals and request replay.
-- Publish the compatible client before installation. No engine replacement.
-- The backward-compatible batch migration installs the private helpers and
-- aggregate reader first. This activation changes only existing game doors.
-- @live-proof: md5(pg_get_functiondef('public.fn_choice_start(uuid,text,text,integer,uuid,text,integer)'::regprocedure))='e7d64de5795704bc19226857fe27bc40'
-- @live-proof: md5(pg_get_functiondef('public.fn_choice_act(uuid,text,integer,integer)'::regprocedure))='746d3945a7912a68856d125802087796'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)'::regprocedure))='69d54f1fa2888a25b27b0ac0f914c589'
-- @live-proof: md5(pg_get_functiondef('public.fn_choice_state(uuid,text,text,integer)'::regprocedure))='f0399f4676fc48e51b2033f62ccd4e4f'
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='90s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_choice_start(uuid,text,text,integer,uuid,text,integer)'::regprocedure)) IS DISTINCT FROM '9f23a08e6fc887f8c0cbc48ec5f2676b' THEN RAISE EXCEPTION 'fn_choice_start preimage changed'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_choice_start(p_club_id uuid, p_game text, p_mode text, p_bet integer, p_commit_id uuid, p_client_seed text, p_max_steps integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE adm record; r public.diamond_choice_rounds; v_prizes numeric[]; cap integer; lim integer:=0; k integer;
 v_reserve numeric; v_bet jsonb; v_user uuid:=auth.uid(); v_id uuid:=gen_random_uuid(); v_roll bigint:=0; v_cells integer[]:='{}'; v_floor numeric;
BEGIN
 IF v_user IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Play'); END IF;
 IF p_game IS NULL OR p_game NOT IN ('crossing','mines') OR p_client_seed IS NULL OR length(p_client_seed) NOT BETWEEN 1 AND 64 THEN
  RETURN jsonb_build_object('ok',false,'error','Check Your Game Settings'); END IF;
 -- Serialize all requests for a ticket before either replay or admission. Changing
 -- any wager identity on a retry is a refusal, never a second debit.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_commit_id::text, 94613));
 SELECT * INTO r FROM public.diamond_choice_rounds WHERE commit_id=p_commit_id;
 IF FOUND THEN
  IF r.user_id IS DISTINCT FROM v_user OR r.club_id IS DISTINCT FROM p_club_id OR r.game IS DISTINCT FROM p_game
   OR r.mode IS DISTINCT FROM p_mode OR r.bet_diamonds IS DISTINCT FROM p_bet OR r.client_seed IS DISTINCT FROM p_client_seed
   OR r.max_steps IS DISTINCT FROM p_max_steps THEN RETURN jsonb_build_object('ok',false,'error','That Ticket Belongs To Different Game Settings'); END IF;
  RETURN public.fn_choice_result(r);
 END IF;
 -- A new round names the one setting. A sealed round above keeps the mode it was dealt.
 IF p_mode IS DISTINCT FROM public.fn_choice_mode(p_game) THEN RETURN jsonb_build_object('ok',false,'error','This Game Has One Setting. Refresh Before You Play'); END IF;
 SELECT * INTO adm FROM public.fn_diamond_game_admit(p_game,p_club_id,p_commit_id,p_client_seed,p_bet);
 IF adm.err IS NOT NULL THEN RETURN adm.err; END IF;
 SELECT * INTO r FROM public.diamond_choice_rounds WHERE host_id=adm.o_host AND user_id=v_user AND game=p_game AND status='open';
 IF FOUND THEN RETURN jsonb_build_object('ok',false,'error','Resume Your Open Round First'); END IF;
 v_floor:=public.fn_diamond_bonus_floor(adm.o_bet_chips,COALESCE((public.fn_wheel_starting_award()).boost_multiplier,1),public.fn_diamond_game_paid_diamonds(p_bet),adm.o_rate);
 v_prizes:=public.fn_choice_prizes_v5(p_game,p_mode,adm.o_bet_chips,v_floor);
 cap:=public.fn_diamond_game_cap_cents(adm.o_cfg,adm.o_pool,adm.o_bank,adm.o_bet_chips,(adm.o_cfg).max_multiplier_cents);
 FOR k IN 1..cardinality(v_prizes) LOOP
  EXIT WHEN ceil(v_prizes[k]*100)/100 > adm.o_bet_chips*cap/100;
  lim:=k;
 END LOOP;
 IF p_max_steps IS NULL OR p_max_steps<1 OR p_max_steps>lim THEN
  RETURN jsonb_build_object('ok',false,'error','The Round Limit Changed. Refresh Before You Play'); END IF;
 v_prizes:=v_prizes[1:p_max_steps];
 v_reserve:=ceil(v_prizes[p_max_steps]*100)/100;
 -- The mines board is dealt at the first pick, from this sealed seed and that pick, so the first tile is always a gem.
 IF p_game='mines' THEN v_cells:='{}';
 ELSE v_roll:=('x'||substr(encode(extensions.hmac(p_client_seed||':'||adm.o_nonce||':road',(adm.o_commit).server_seed,'sha256'),'hex'),1,12))::bit(48)::bigint; END IF;
 v_bet:=public.fn_diamond_game_take_bet(v_user,p_bet,(adm.o_cfg).purchased_only,p_game||'_bet',
  public.fn_diamond_game_debit_text(p_game,p_bet),'choice:'||v_id,jsonb_build_object('round_id',v_id,'game',p_game,'host_id',adm.o_host,'club_id',p_club_id)||public.fn_diamond_game_debit_meta(p_bet),adm.o_owner,public.fn_diamond_game_debit_text(p_game,p_bet,true));
 IF COALESCE((v_bet->>'success')::boolean,false)=false THEN RETURN jsonb_build_object('ok',false,'error','The Bet Could Not Be Paid'); END IF;
 UPDATE public.diamond_game_pools SET rounds=rounds+1,intake_diamonds=intake_diamonds+public.fn_wheel_bonus_player_debit(p_bet),
  reserved_chips=reserved_chips+v_reserve,updated_at=now() WHERE host_id=adm.o_host AND game=p_game;
 UPDATE public.diamond_game_commits SET consumed_by=v_id WHERE id=p_commit_id;
 INSERT INTO public.diamond_choice_rounds(id,host_id,host_kind,club_id,user_id,game,mode,bet_diamonds,bet_chips,diamonds_per_chip,
  commit_id,server_seed,server_seed_hash,client_seed,nonce,mine_cells,road_roll,max_steps,prizes,reserved_chips,is_fixture,minimum_payout_chips,payout_version)
 VALUES(v_id,adm.o_host,adm.o_kind,p_club_id,v_user,p_game,p_mode,p_bet,adm.o_bet_chips,adm.o_rate,p_commit_id,
  (adm.o_commit).server_seed,(adm.o_commit).server_seed_hash,p_client_seed,adm.o_nonce,v_cells,v_roll,p_max_steps,v_prizes,v_reserve,adm.o_fixture,v_floor,5) RETURNING * INTO r;
 RETURN public.fn_choice_result(r);
END $function$
;
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_choice_state(uuid,text,text,integer)'::regprocedure)) IS DISTINCT FROM 'd61db35d22a7ff226ee708d920480a60' THEN RAISE EXCEPTION 'fn_choice_state preimage changed'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_choice_state(p_club_id uuid, p_game text, p_mode text, p_bet integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE h record; cfg public.diamond_game_configs; pool public.diamond_game_pools; r public.diamond_choice_rounds;
 rate integer; prizes numeric[]:='{}'; cap integer; lim integer:=0; k integer; dia numeric:=0; member numeric;
 hist jsonb; opened jsonb; today integer; last_play timestamptz; wait_seconds integer:=0;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Play'); END IF;
 IF p_game IS NULL OR p_game NOT IN ('crossing','mines') THEN RETURN jsonb_build_object('ok',false,'error','Choose A Game'); END IF;
 SELECT * INTO h FROM public.fn_wheel_host(p_club_id);
 IF h.host_id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','That Club Could Not Be Found'); END IF;
 SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id=h.host_id AND game=p_game;
 SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id=h.host_id AND game=p_game;
 rate:=public.fn_ca_bridge_rate();
 IF rate IS NULL OR rate<=0 THEN RETURN jsonb_build_object('ok',false,'error','The Bridge Rate Is Not Set'); END IF;
 IF cfg.host_id IS NOT NULL AND p_bet BETWEEN cfg.min_bet_diamonds AND cfg.max_bet_diamonds AND p_bet BETWEEN 25 AND 5000 THEN
  prizes:=public.fn_choice_prizes_v5(p_game,public.fn_choice_mode(p_game),p_bet::numeric/rate,public.fn_diamond_bonus_floor(p_bet::numeric/rate,1,p_bet,rate));
  cap:=public.fn_diamond_game_cap_cents(cfg,pool,public.fn_diamond_game_cover(h.host_id,h.host_kind),p_bet::numeric/rate,cfg.max_multiplier_cents);
  FOR k IN 1..cardinality(prizes) LOOP EXIT WHEN ceil(prizes[k]*100)/100>(p_bet::numeric/rate)*cap/100; lim:=k; END LOOP;
  prizes:=prizes[1:lim];
 END IF;
 SELECT COALESCE(diamonds,0) INTO dia FROM public.profiles WHERE id=auth.uid();
 IF cfg.purchased_only THEN dia:=LEAST(dia,public.fn_wheel_purchased_available(auth.uid())); END IF;
 SELECT chip_balance INTO member FROM public.club_members WHERE club_id=p_club_id AND user_id=auth.uid() AND COALESCE(status,'active') IN ('active','approved');
 SELECT * INTO r FROM public.diamond_choice_rounds WHERE host_id=h.host_id AND club_id=p_club_id AND user_id=auth.uid() AND game=p_game AND status='open';
 IF FOUND THEN opened:=public.fn_choice_result(r); END IF;
 SELECT COALESCE(jsonb_agg(public.fn_choice_result(x) ORDER BY x.created_at DESC),'[]') INTO hist FROM
  (SELECT * FROM public.diamond_choice_rounds WHERE host_id=h.host_id AND club_id=p_club_id AND user_id=auth.uid() AND game=p_game AND status<>'open' ORDER BY created_at DESC LIMIT 20) x;
 SELECT count(*)::integer,max(created_at) INTO today,last_play FROM public.diamond_choice_rounds WHERE host_id=h.host_id AND user_id=auth.uid() AND game=p_game AND (created_at AT TIME ZONE 'America/Chicago')::date=(now() AT TIME ZONE 'America/Chicago')::date;
 IF last_play IS NOT NULL THEN wait_seconds:=GREATEST(0,cfg.min_seconds_between_rounds-floor(extract(epoch FROM (now()-last_play)))::integer); END IF;
 RETURN jsonb_build_object('ok',true,'rounds_today',today,'daily_limit',COALESCE(cfg.max_rounds_per_player_per_day,0),'diamonds_today',public.fn_diamond_games_spent_today(h.host_id,auth.uid()),'seconds_until_next',wait_seconds,'available',COALESCE(cfg.enabled,false) AND public.fn_diamond_spins_owner_agreed(h.host_id,h.host_kind),'reason',CASE WHEN cfg.host_id IS NULL THEN 'Not Open Here Yet' END,
 'frozen',public.fn_platform_frozen() OR EXISTS(SELECT 1 FROM public.ca_payout_freeze WHERE scope=p_game AND cleared_at IS NULL),'diamonds',COALESCE(dia,0),'member_chips',COALESCE(member,0),'is_member',member IS NOT NULL,
 'diamonds_per_chip',rate,'bets',COALESCE(to_jsonb(cfg.bet_options),'[]'),'max_steps',lim,'prizes',to_jsonb(COALESCE(prizes,'{}'::numeric[])),
 'open_round',opened,'history',hist);
END $function$
;
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)'::regprocedure)) IS DISTINCT FROM '2cffb97ec964a082f8491ff7b4690994' THEN RAISE EXCEPTION 'fn_wheel_bonus_state preimage changed'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_wheel_bonus_state(p_club_id uuid, p_game text, p_double boolean DEFAULT false, p_mode text DEFAULT NULL::text, p_award_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE a public.wheel_bonus_awards;awards jsonb;v_state jsonb;v_award jsonb;total integer;cap integer;rate integer;prizes numeric[];lim integer:=0;k integer;v_paid integer;v_floor numeric;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Play'); END IF;
 IF p_game IS NULL OR p_game NOT IN('plinko','crash','crossing','mines') OR p_double IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Choose A Bonus Game'); END IF;
 SELECT * INTO a FROM public.wheel_bonus_awards WHERE user_id=auth.uid() AND club_id=p_club_id AND game=p_game AND (p_award_id IS NULL OR id=p_award_id)
 ORDER BY (status='pending') DESC,created_at DESC LIMIT 1;
 IF p_award_id IS NOT NULL AND a.id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','This Bonus Award Does Not Match This Game'); END IF;
 SELECT COALESCE(jsonb_agg(public.fn_wheel_bonus_public_award(x,p_double) ORDER BY (x.status='pending') DESC,x.created_at DESC),'[]') INTO awards FROM
  (SELECT * FROM public.wheel_bonus_awards WHERE user_id=auth.uid() AND club_id=p_club_id AND game=p_game ORDER BY (status='pending') DESC,created_at DESC LIMIT 50) x;
 IF p_game IN('crossing','mines') THEN v_state:=public.fn_choice_state(p_club_id,p_game,public.fn_choice_mode(p_game),100);
 ELSE v_state:=public.fn_diamond_game_state(p_club_id,p_game); END IF;
 v_state:=v_state||jsonb_build_object('club_id',p_club_id,'game',p_game);
 IF a.id IS NOT NULL THEN
  v_award:=public.fn_wheel_bonus_public_award(a,p_double);total:=(v_award->>'bet_diamonds')::integer;cap:=(v_award->>'cap_cents')::integer;rate:=public.fn_ca_bridge_rate();
  v_state:=v_state||jsonb_build_object('cap_cents',cap,'bet_diamonds',total,'bets',jsonb_build_array(jsonb_build_object('bet_diamonds',total,'bet_chips',total::numeric/rate,'cap_cents',cap,'playable',cap>=101)));
  v_paid:=a.entry_diamonds+(total-a.base_diamonds);
  v_floor:=public.fn_diamond_bonus_floor(total::numeric/rate,a.boost_multiplier,v_paid,rate);
  -- What this award starts with, from the server, so the client can show the guarantee before Start.
  v_state:=v_state||jsonb_build_object('mode',public.fn_choice_mode(p_game),'plinko_table',public.fn_plinko_table_for_floor(total::numeric/rate,v_floor),
   'minimum_payout_chips',v_floor,'guarantee',CASE WHEN a.boost_multiplier=2 THEN 'super' ELSE 'standard' END,
   'payout_version',CASE WHEN p_game IN('crossing','mines') THEN 5 ELSE 4 END,'paid_diamonds',v_paid,'cashout_floor_cents',111,'crash_floor_cents',110,
   'plinko_denominations',(SELECT COALESCE(jsonb_agg(DISTINCT d ORDER BY d),'[]'::jsonb) FROM unnest(ARRAY[1,2,4,5,10,20,25,50,100,250,500,total]) d WHERE total%d=0 AND total/d BETWEEN 1 AND 100));

  IF p_game IN('crossing','mines') THEN
   prizes:=public.fn_choice_prizes_v5(p_game,public.fn_choice_mode(p_game),total::numeric/rate,v_floor);
   FOR k IN 1..cardinality(prizes) LOOP EXIT WHEN ceil(prizes[k]*100)/100>total::numeric/rate*cap/100;lim:=k;END LOOP;
   v_state:=v_state||jsonb_build_object('max_steps',lim,'prizes',to_jsonb(COALESCE(prizes[1:lim],'{}'::numeric[])));
  ELSIF p_game='plinko' THEN
   v_state:=jsonb_set(v_state,'{tables}',COALESCE((SELECT jsonb_agg(t||jsonb_build_object('available',(t->>'max_multiplier_cents')::integer<=cap)) FROM jsonb_array_elements(v_state->'tables') t),'[]'::jsonb));
  END IF;
 END IF;
 RETURN jsonb_build_object('ok',true,'contract_version',2,'enabled',public.fn_wheel_v2_enabled(),'award',v_award,'awards',awards,'game_state',v_state);
END $function$
;
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_choice_act(uuid,text,integer,integer)'::regprocedure)) IS DISTINCT FROM 'b1d7b0632f13bbb76e9dfa3e55156059' THEN RAISE EXCEPTION 'fn_choice_act preimage changed'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_choice_act(p_round_id uuid, p_action text, p_cell integer, p_expected_step integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE r public.diamond_choice_rounds; n integer; safe boolean; v_pay numeric:=0; v_cents numeric; v_floor numeric; v_roll numeric;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Play'); END IF;
 SELECT * INTO r FROM public.diamond_choice_rounds WHERE id=p_round_id AND user_id=auth.uid();
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','That Round Could Not Be Found'); END IF;
 -- Same config, pool, wallet, then round order as admission. The next state
 -- version is a compare-and-swap, so a delayed duplicate cannot reveal twice.
 PERFORM 1 FROM public.diamond_game_configs WHERE host_id=r.host_id AND game=r.game FOR UPDATE;
 PERFORM 1 FROM public.diamond_game_pools WHERE host_id=r.host_id AND game=r.game FOR UPDATE;
 PERFORM public.fn_diamond_game_cover_lock(r.host_id,r.host_kind);
 SELECT * INTO r FROM public.diamond_choice_rounds WHERE id=p_round_id FOR UPDATE;
 IF r.status<>'open' THEN RETURN public.fn_choice_result(r); END IF;
 n:=cardinality(r.picked);
 IF p_expected_step IS DISTINCT FROM n THEN RETURN public.fn_choice_result(r); END IF;
 IF public.fn_platform_frozen() THEN RETURN jsonb_build_object('ok',false,'error','The Platform Is In Its Maintenance Break'); END IF;
 IF p_action='pick' THEN
  IF p_cell IS NULL OR p_cell<0 OR p_cell>24 OR p_cell=ANY(r.picked) OR (r.game='crossing' AND p_cell<>n) THEN
   RETURN jsonb_build_object('ok',false,'error','Choose An Unopened Tile'); END IF;
  IF r.game='mines' THEN
   -- A round sealed under contract 4 deals its board here, around the first pick, so that pick is always a gem.
   IF n=0 AND r.payout_version>=4 AND cardinality(r.mine_cells)=0 THEN r.mine_cells:=public.fn_choice_board_v4(r.server_seed,r.client_seed,r.nonce,r.mode::integer,p_cell); END IF;
   safe:=NOT(p_cell=ANY(r.mine_cells));
  ELSIF r.payout_version=5 THEN safe:=(r.road_roll::numeric+1)<=public.fn_choice_road_probability_v5(r.prizes,n+1,r.minimum_payout_chips)*281474976710656;
  ELSE safe:=(r.road_roll::numeric+1)*(r.prizes[n+1]-r.minimum_payout_chips) <= (r.bet_chips*.8-r.minimum_payout_chips)*281474976710656; END IF;
  r.picked:=array_append(r.picked,p_cell); n:=n+1;
  IF NOT safe THEN r.status:='lost';
  ELSIF n=r.max_steps THEN r.status:='cashed'; END IF;
 ELSIF p_action='cashout' AND n>0 THEN r.status:='cashed';
 ELSE RETURN jsonb_build_object('ok',false,'error','Make Your First Move Before Cashing Out'); END IF;
 IF r.status='lost' THEN v_pay:=CASE WHEN r.payout_version=5 THEN public.fn_choice_loss_floor_v5(r.prizes,n-1,r.minimum_payout_chips) ELSE r.minimum_payout_chips END; END IF;
 IF r.status='cashed' THEN
  v_cents:=r.prizes[n]*100;
  v_floor:=floor(v_cents);
  -- An independent sealed draw rounds fractions only AFTER the stopping
  -- decision. Always rounding down would silently add another house edge.
  v_roll:=('x'||substr(encode(extensions.hmac(r.client_seed||':'||r.nonce||':rounding:'||n,r.server_seed,'sha256'),'hex'),1,12))::bit(48)::bigint;
  v_pay:=(v_floor+CASE WHEN (v_roll+1)<= (v_cents-v_floor)*281474976710656 THEN 1 ELSE 0 END)/100;
  IF v_pay>r.reserved_chips THEN RAISE EXCEPTION 'Prize Exceeds Its Reservation'; END IF;
 END IF;
 IF r.status<>'open' THEN
  IF v_pay>r.reserved_chips THEN RAISE EXCEPTION 'Prize Exceeds Its Reservation'; END IF;
  UPDATE public.diamond_game_pools SET reserved_chips=reserved_chips-r.reserved_chips,
   chips_paid=chips_paid+v_pay,updated_at=now() WHERE host_id=r.host_id AND game=r.game;
  IF v_pay>0 THEN
   PERFORM public.fn_diamond_game_pay_chips(r.game||'_prize',r.host_id,r.host_kind,r.club_id,r.user_id,v_pay,'choice-prize:'||r.id,
    'Diamond Game Prize',jsonb_build_object('game',r.game,'round_id',r.id,'host_id',r.host_id,'minimum_payout_chips',r.minimum_payout_chips,'result',r.status));
  END IF;
 END IF;
 UPDATE public.diamond_choice_rounds SET mine_cells=r.mine_cells,picked=r.picked,status=r.status,payout_chips=v_pay,
  settled_at=CASE WHEN r.status<>'open' THEN clock_timestamp() END WHERE id=r.id RETURNING * INTO r;
 RETURN public.fn_choice_result(r);
END $function$
;


COMMIT;
