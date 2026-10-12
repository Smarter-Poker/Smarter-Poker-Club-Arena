-- 20261012050006_donkey_cross_flips_a_fair_coin_every_street.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Owner request 2026-10-11 (Dan, verbatim): "DONKEY CROSS ALWAYS RUNS THE
-- DONKEY OVER ON THE 2ND STREET. IT NEEDS TO LITERALLY BE A 50/50 CHANCE TO
-- CROSS THE NEXT STREET. 'A VIRTUAL COIN' MUST FLIP THAT IS TRULY RANDOM TO BE
-- SAFE OR SMASH FOR EACH STREET EVERY TIME. AND WHEN A USER 'BOOKS THE WIN' IT
-- SHOULD SHOW THEM HOW FAR THEY 'WOULD OF GOTTEN'."
-- Money ruling the same night: "Smaller prizes, keep 80%".
--
-- CONTRACT 6, DONKEY CROSS ONLY. Diamond Mines keeps contract 5 untouched.
--
--  1. THE COIN. Street k of a round is decided by its own coin:
--       hmac(client_seed||':'||nonce||':street:'||k, server_seed)
--     SAFE when the first byte of that HMAC is below 128 (the first hex
--     character is 0-7), SMASH otherwise (8-f). 128 of 256 byte values: exactly
--     50/50, every street, street one included, each street on its own message
--     so no coin says anything about another. The server seed is committed by
--     its hash before the player picks a seed, so nobody can steer a coin.
--  2. THE LADDER, from the round's own floor L and stake B:
--       prize_1     = 1.6B - L           (half of 1.6B - L plus half of L = 0.80B)
--       prize_(k+1) = 2 prize_k - Loss(k), Loss(k) = greatest(L, half prize_k
--                     rounded up to the cent): exactly contract 5's loss rule
--     so booking after ANY street is worth exactly 0.80B, and the top is capped
--     at 20B (worth less than 0.80B). At most 20 streets (the table's limit).
--     Standard (L = B/2): 1.10x 1.65x 2.47x 3.70x 5.55x 8.32x 12.48x 18.72x 20x.
--     Super with Double Diamonds (L = 2B/3): 0.93x 1.20x 1.73x ... 19.74x 20x.
--     fn_diamond_game_cap_cents and the top-prize reservation truncate it
--     exactly as before.
--  3. THE REVEAL. A finished contract-6 round's proof carries every street's
--     coin and road_end: the street the donkey would have reached (the first
--     smash after the cash-out point, or the end of the road).
--  4. THE REPLAY. fn_diamond_bonus_replay computed road_end with the contract-4
--     formula for every round, so a contract-5 replay named the wrong street
--     (and the client refused it). Each contract now has its own branch.
--
-- Sealed rounds: fn_choice_act keeps the contract 4 and 5 branches byte for
-- byte, so every open v4/v5 round settles exactly as it was dealt.
--
-- RELEASE ORDER: publish the client that reads contract 6 FIRST; install this
-- after it is live. No engine change. A client that cannot read 6 refuses a
-- contract-6 receipt ("The Game Response Could Not Be Verified").
-- @live-proof: md5(pg_get_functiondef('public.fn_choice_road_coin_v6(text,text,bigint,integer)'::regprocedure))='cca63c5fec6f593d381a551dc6c99434'
-- @live-proof: md5(pg_get_functiondef('public.fn_choice_road_coins_v6(text,text,bigint,integer)'::regprocedure))='4fc81afaeca028a79fc5dec73703de05'
-- @live-proof: md5(pg_get_functiondef('public.fn_choice_road_end_v6(boolean[])'::regprocedure))='922310515c68397433fd5429b7ae051e'
-- @live-proof: md5(pg_get_functiondef('public.fn_choice_road_prizes_v6(numeric,numeric)'::regprocedure))='8a8276d07873e558d321166935568fb4'
-- @live-proof: md5(pg_get_functiondef('public.fn_choice_prizes_v6(text,text,numeric,numeric)'::regprocedure))='876f738d26b6c445f4ce0602963d0bc0'
-- @live-proof: md5(pg_get_functiondef('public.fn_choice_start(uuid,text,text,integer,uuid,text,integer)'::regprocedure))='4c14dc8ad4666cf07a47bc9a44957e75'
-- @live-proof: md5(pg_get_functiondef('public.fn_choice_act(uuid,text,integer,integer)'::regprocedure))='ea185d0371c163f96497ad3e57f8c49f'
-- @live-proof: md5(pg_get_functiondef('public.fn_choice_result(diamond_choice_rounds)'::regprocedure))='b6992f97ffd69b3532e5d1409d450193'
-- @live-proof: md5(pg_get_functiondef('public.fn_choice_state(uuid,text,text,integer)'::regprocedure))='cf90feb39dcea44efec07e10ef5afda5'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)'::regprocedure))='2c458d77055bad763d2a3255036977af'
-- @live-proof: md5(pg_get_functiondef('public.fn_diamond_bonus_replay(uuid)'::regprocedure))='6bd8e9bb51e3d47ce8f078a7573eed41'
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='90s';
-- Every door replaced below, and the loss rule it reuses, is the exact body
-- read from production on 2026-10-12 (00:20 UTC). Anything else aborts.
DO $guard$
DECLARE pre record;
BEGIN
 FOR pre IN SELECT * FROM (VALUES
  ('public.fn_choice_start(uuid,text,text,integer,uuid,text,integer)','e7d64de5795704bc19226857fe27bc40'),
  ('public.fn_choice_act(uuid,text,integer,integer)','746d3945a7912a68856d125802087796'),
  ('public.fn_choice_result(diamond_choice_rounds)','7ba40c68622df3ca6011e186bf74bab3'),
  ('public.fn_choice_state(uuid,text,text,integer)','f0399f4676fc48e51b2033f62ccd4e4f'),
  ('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)','69d54f1fa2888a25b27b0ac0f914c589'),
  ('public.fn_diamond_bonus_replay(uuid)','0f8a416e05bb7dda955a9f468bb96e29'),
  ('public.fn_choice_loss_floor_v5(numeric[],integer,numeric)','0148240902ba12addea66c61b8803589'),
  ('public.fn_choice_prizes_v5(text,text,numeric,numeric)','3a8e05e61d655710838589b696a4e201'),
  ('public.fn_choice_road_probability_v5(numeric[],integer,numeric)','4720717acc762bce235788e08236123b'),
  ('public.fn_choice_immutable()','5de220dbe64fffdd0e472198b03f110e')
 ) v(sig,md5) LOOP
  IF to_regprocedure(pre.sig) IS NULL OR md5(pg_get_functiondef(to_regprocedure(pre.sig))) IS DISTINCT FROM pre.md5 THEN
   RAISE EXCEPTION 'Donkey Cross Coin Preimage Changed: %',pre.sig; END IF;
 END LOOP;
 IF to_regprocedure('public.fn_choice_road_coin_v6(text,text,bigint,integer)') IS NOT NULL THEN
  RAISE EXCEPTION 'Contract 6 Is Already Installed'; END IF;
END $guard$;

-- 1. THE COIN: one street, one HMAC, one byte. Safe below 128 (hex 0-7).
CREATE FUNCTION public.fn_choice_road_coin_v6(p_server_seed text,p_client_seed text,p_nonce bigint,p_street integer)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=public,extensions AS $function$
 SELECT get_byte(extensions.hmac(p_client_seed||':'||p_nonce||':street:'||p_street,p_server_seed,'sha256'),0)<128
$function$;
-- Every street's coin of a road, street one first.
CREATE FUNCTION public.fn_choice_road_coins_v6(p_server_seed text,p_client_seed text,p_nonce bigint,p_streets integer)
RETURNS boolean[] LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $function$
 SELECT COALESCE(array_agg(public.fn_choice_road_coin_v6(p_server_seed,p_client_seed,p_nonce,k) ORDER BY k),'{}'::boolean[])
 FROM generate_series(1,p_streets) k
$function$;
-- How far the donkey gets: the safe coins before the first smash, or the whole road.
CREATE FUNCTION public.fn_choice_road_end_v6(p_coins boolean[])
RETURNS integer LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $function$
 SELECT COALESCE((SELECT min(k)-1 FROM generate_subscripts(p_coins,1) k WHERE NOT p_coins[k]),cardinality(p_coins))
$function$;
-- 2. THE LADDER, derived from the round's own floor. Exact numerics: the
-- cash-out rounding draw settles any fraction of a cent without bias.
CREATE FUNCTION public.fn_choice_road_prizes_v6(p_bet numeric,p_floor numeric)
RETURNS numeric[] LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $function$
DECLARE v_out numeric[]:='{}'; v_top numeric; v_next numeric;
BEGIN
 IF p_bet IS NULL OR p_bet<=0 OR p_floor IS NULL OR p_floor<0 OR p_floor*5>=p_bet*4 THEN RAISE EXCEPTION 'The Floor Beats The Edge'; END IF;
 v_top:=p_bet*20;
 -- A fair coin on street one pays this or the floor: worth exactly 0.80B.
 v_next:=p_bet*1.6-p_floor;
 LOOP
  IF v_next>=v_top THEN v_out:=array_append(v_out,v_top); EXIT; END IF;
  v_out:=array_append(v_out,v_next);
  EXIT WHEN cardinality(v_out)=20;
  -- A fair coin on the next street keeps the stop worth exactly the same.
  v_next:=2*v_next-public.fn_choice_loss_floor_v5(v_out,cardinality(v_out),p_floor);
 END LOOP;
 RETURN v_out;
END $function$;
-- The prize ladder a NEW round is dealt: the coin road, or contract 5's mines.
CREATE FUNCTION public.fn_choice_prizes_v6(p_game text,p_mode text,p_bet numeric,p_floor numeric)
RETURNS numeric[] LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $function$
BEGIN
 IF p_game='crossing' THEN
  IF p_mode IS DISTINCT FROM 'road' THEN RAISE EXCEPTION 'Choose A Road Difficulty'; END IF;
  RETURN public.fn_choice_road_prizes_v6(p_bet,p_floor);
 END IF;
 RETURN public.fn_choice_prizes_v5(p_game,p_mode,p_bet,p_floor);
END $function$;
REVOKE ALL ON FUNCTION public.fn_choice_road_coin_v6(text,text,bigint,integer),public.fn_choice_road_coins_v6(text,text,bigint,integer),
 public.fn_choice_road_end_v6(boolean[]),public.fn_choice_road_prizes_v6(numeric,numeric),public.fn_choice_prizes_v6(text,text,numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_road_coin_v6(text,text,bigint,integer),public.fn_choice_road_coins_v6(text,text,bigint,integer),
 public.fn_choice_road_end_v6(boolean[]),public.fn_choice_road_prizes_v6(numeric,numeric),public.fn_choice_prizes_v6(text,text,numeric,numeric) TO service_role;

-- The opener: a new crossing round is contract 6, a new mines round contract 5.
-- No road roll is drawn for contract 6; every street flips its own coin.
CREATE OR REPLACE FUNCTION public.fn_choice_start(p_club_id uuid, p_game text, p_mode text, p_bet integer, p_commit_id uuid, p_client_seed text, p_max_steps integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE adm record; r public.diamond_choice_rounds; v_prizes numeric[]; cap integer; lim integer:=0; k integer;
 v_reserve numeric; v_bet jsonb; v_user uuid:=auth.uid(); v_id uuid:=gen_random_uuid(); v_cells integer[]:='{}'; v_floor numeric;
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
 v_prizes:=public.fn_choice_prizes_v6(p_game,p_mode,adm.o_bet_chips,v_floor);
 cap:=public.fn_diamond_game_cap_cents(adm.o_cfg,adm.o_pool,adm.o_bank,adm.o_bet_chips,(adm.o_cfg).max_multiplier_cents);
 FOR k IN 1..cardinality(v_prizes) LOOP
  EXIT WHEN ceil(v_prizes[k]*100)/100 > adm.o_bet_chips*cap/100;
  lim:=k;
 END LOOP;
 IF p_max_steps IS NULL OR p_max_steps<1 OR p_max_steps>lim THEN
  RETURN jsonb_build_object('ok',false,'error','The Round Limit Changed. Refresh Before You Play'); END IF;
 v_prizes:=v_prizes[1:p_max_steps];
 v_reserve:=ceil(v_prizes[p_max_steps]*100)/100;
 -- The mines board is dealt at the first pick, from this sealed seed and that pick,
 -- so the first tile is always a gem. The road flips a sealed coin per street.
 v_bet:=public.fn_diamond_game_take_bet(v_user,p_bet,(adm.o_cfg).purchased_only,p_game||'_bet',
  public.fn_diamond_game_debit_text(p_game,p_bet),'choice:'||v_id,jsonb_build_object('round_id',v_id,'game',p_game,'host_id',adm.o_host,'club_id',p_club_id)||public.fn_diamond_game_debit_meta(p_bet),adm.o_owner,public.fn_diamond_game_debit_text(p_game,p_bet,true));
 IF COALESCE((v_bet->>'success')::boolean,false)=false THEN RETURN jsonb_build_object('ok',false,'error','The Bet Could Not Be Paid'); END IF;
 UPDATE public.diamond_game_pools SET rounds=rounds+1,intake_diamonds=intake_diamonds+public.fn_wheel_bonus_player_debit(p_bet),
  reserved_chips=reserved_chips+v_reserve,updated_at=now() WHERE host_id=adm.o_host AND game=p_game;
 UPDATE public.diamond_game_commits SET consumed_by=v_id WHERE id=p_commit_id;
 INSERT INTO public.diamond_choice_rounds(id,host_id,host_kind,club_id,user_id,game,mode,bet_diamonds,bet_chips,diamonds_per_chip,
  commit_id,server_seed,server_seed_hash,client_seed,nonce,mine_cells,road_roll,max_steps,prizes,reserved_chips,is_fixture,minimum_payout_chips,payout_version)
 VALUES(v_id,adm.o_host,adm.o_kind,p_club_id,v_user,p_game,p_mode,p_bet,adm.o_bet_chips,adm.o_rate,p_commit_id,
  (adm.o_commit).server_seed,(adm.o_commit).server_seed_hash,p_client_seed,adm.o_nonce,v_cells,0,p_max_steps,v_prizes,v_reserve,adm.o_fixture,v_floor,
  CASE WHEN p_game='crossing' THEN 6 ELSE 5 END) RETURNING * INTO r;
 RETURN public.fn_choice_result(r);
END $function$
;

-- The mover: contract 6 asks the street's own coin. Contracts 4 and 5 are unchanged.
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
  ELSIF r.payout_version=6 THEN safe:=public.fn_choice_road_coin_v6(r.server_seed,r.client_seed,r.nonce,n+1);
  ELSIF r.payout_version=5 THEN safe:=(r.road_roll::numeric+1)<=public.fn_choice_road_probability_v5(r.prizes,n+1,r.minimum_payout_chips)*281474976710656;
  ELSE safe:=(r.road_roll::numeric+1)*(r.prizes[n+1]-r.minimum_payout_chips) <= (r.bet_chips*.8-r.minimum_payout_chips)*281474976710656; END IF;
  r.picked:=array_append(r.picked,p_cell); n:=n+1;
  IF NOT safe THEN r.status:='lost';
  ELSIF n=r.max_steps THEN r.status:='cashed'; END IF;
 ELSIF p_action='cashout' AND n>0 THEN r.status:='cashed';
 ELSE RETURN jsonb_build_object('ok',false,'error','Make Your First Move Before Cashing Out'); END IF;
 IF r.status='lost' THEN v_pay:=CASE WHEN r.payout_version IN (5,6) THEN public.fn_choice_loss_floor_v5(r.prizes,n-1,r.minimum_payout_chips) ELSE r.minimum_payout_chips END; END IF;
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

-- The receipt: a finished contract-6 road reveals every coin and how far it ran.
-- An open round has no proof at all, so no coin is ever shown before it is played.
CREATE OR REPLACE FUNCTION public.fn_choice_result(r diamond_choice_rounds)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.fn_wheel_award_receipt(r.commit_id)||jsonb_build_object('ok',true,'id',r.id,'game',r.game,'club_id',r.club_id,'status',r.status,'mode',r.mode,
 'bet_diamonds',r.bet_diamonds,'bet_chips',r.bet_chips,'picked',to_jsonb(r.picked),'max_steps',r.max_steps,
 'prizes',to_jsonb(r.prizes),'payout_chips',r.payout_chips,
 'minimum_payout_chips',r.minimum_payout_chips,'payout_version',COALESCE(r.payout_version,CASE WHEN r.minimum_payout_chips<=0 THEN 1 WHEN r.minimum_payout_chips=public.fn_diamond_bonus_minimum(r.bet_chips,2) THEN 3 ELSE 2 END),'server_seed_hash',r.server_seed_hash,
 'client_seed',r.client_seed,'nonce',r.nonce,'commit_id',r.commit_id,
 'diamonds_per_chip',r.diamonds_per_chip,'proof',CASE WHEN r.status<>'open' THEN jsonb_build_object('game',r.game,'server_seed',r.server_seed,
 'server_seed_hash',r.server_seed_hash,'client_seed',r.client_seed,'nonce',r.nonce,
 'mines',CASE WHEN r.game='mines' THEN r.mode::integer ELSE 0 END,'mine_cells',to_jsonb(r.mine_cells),'road_roll',r.road_roll::text,'first_pick',CASE WHEN r.game='mines' THEN r.picked[1] END,'payout_version',COALESCE(r.payout_version,CASE WHEN r.minimum_payout_chips<=0 THEN 1 WHEN r.minimum_payout_chips=public.fn_diamond_bonus_minimum(r.bet_chips,2) THEN 3 ELSE 2 END))
 ||CASE WHEN r.game='crossing' AND r.payout_version=6 THEN (SELECT jsonb_build_object('coins',to_jsonb(x.c),'road_end',public.fn_choice_road_end_v6(x.c))
   FROM (SELECT public.fn_choice_road_coins_v6(r.server_seed,r.client_seed,r.nonce,r.max_steps) c) x) ELSE '{}'::jsonb END END)
$function$
;

-- The quote: the ladder and street limit a new round of this stake is dealt.
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
  prizes:=public.fn_choice_prizes_v6(p_game,public.fn_choice_mode(p_game),p_bet::numeric/rate,public.fn_diamond_bonus_floor(p_bet::numeric/rate,1,p_bet,rate));
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
 'payout_version',CASE WHEN p_game='crossing' THEN 6 ELSE 5 END,'open_round',opened,'history',hist);
END $function$
;

-- The award quote: the same ladder and contract, before Start.
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
   'payout_version',CASE WHEN p_game='crossing' THEN 6 WHEN p_game='mines' THEN 5 ELSE 4 END,'paid_diamonds',v_paid,'cashout_floor_cents',111,'crash_floor_cents',110,
   'plinko_denominations',(SELECT COALESCE(jsonb_agg(DISTINCT d ORDER BY d),'[]'::jsonb) FROM unnest(ARRAY[1,2,4,5,10,20,25,50,100,250,500,total]) d WHERE total%d=0 AND total/d BETWEEN 1 AND 100));

  IF p_game IN('crossing','mines') THEN
   prizes:=public.fn_choice_prizes_v6(p_game,public.fn_choice_mode(p_game),total::numeric/rate,v_floor);
   FOR k IN 1..cardinality(prizes) LOOP EXIT WHEN ceil(prizes[k]*100)/100>total::numeric/rate*cap/100;lim:=k;END LOOP;
   v_state:=v_state||jsonb_build_object('max_steps',lim,'prizes',to_jsonb(COALESCE(prizes[1:lim],'{}'::numeric[])));
  ELSIF p_game='plinko' THEN
   v_state:=jsonb_set(v_state,'{tables}',COALESCE((SELECT jsonb_agg(t||jsonb_build_object('available',(t->>'max_multiplier_cents')::integer<=cap)) FROM jsonb_array_elements(v_state->'tables') t),'[]'::jsonb));
  END IF;
 END IF;
 RETURN jsonb_build_object('ok',true,'contract_version',2,'enabled',public.fn_wheel_v2_enabled(),'award',v_award,'awards',awards,'game_state',v_state);
END $function$
;

-- The replay: each road contract computes its own road_end. Contract 6 adds the
-- coins and the street multipliers the scene paints; older payloads are unchanged.
CREATE OR REPLACE FUNCTION public.fn_diamond_bonus_replay(p_bonus_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE e public.diamond_bonus_entries; c public.crash_rounds; d public.diamond_choice_rounds;
 v_data jsonb; v_payout numeric; v_completed timestamptz; v_road_end integer; v_coins boolean[];
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To See Your Replays'); END IF;
 SELECT * INTO e FROM public.diamond_bonus_entries WHERE id=p_bonus_id AND user_id=auth.uid();
 IF e.id IS NULL OR e.result IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Replay Not Found'); END IF;
 IF e.game='plinko' THEN
  v_data:=jsonb_build_object('multipliers_cents',e.result->'multipliers_cents','drops',e.result->'drops',
   'diamonds_per_drop',e.result->'diamonds_per_drop','table_name',e.result->'table_name');
  v_payout:=(e.result->>'payout_chips')::numeric; v_completed:=e.created_at;
 ELSIF e.game='crash' THEN
  SELECT * INTO c FROM public.crash_rounds WHERE commit_id=e.commit_id AND user_id=e.user_id;
  IF c.id IS NULL OR c.status='open' THEN RETURN jsonb_build_object('ok',false,'error','Finish This Bonus Before Replaying It'); END IF;
  v_data:=jsonb_build_object('status',c.status,'growth_k',c.growth_k,'cap_cents',c.cap_cents,
   'elapsed_ms',c.elapsed_ms,'cashout_cents',c.cashout_cents,'crash_cents',c.crash_cents,
   'auto_cashout_cents',c.auto_cashout_cents);
  v_payout:=c.payout_chips; v_completed:=c.settled_at;
 ELSIF e.game IN ('crossing','mines') THEN
  SELECT * INTO d FROM public.diamond_choice_rounds WHERE commit_id=e.commit_id AND user_id=e.user_id;
  IF d.id IS NULL OR d.status='open' THEN RETURN jsonb_build_object('ok',false,'error','Finish This Bonus Before Replaying It'); END IF;
  IF e.game='crossing' AND d.payout_version=6 THEN
   v_coins:=public.fn_choice_road_coins_v6(d.server_seed,d.client_seed,d.nonce,d.max_steps);
   v_road_end:=public.fn_choice_road_end_v6(v_coins);
  ELSIF e.game='crossing' AND d.payout_version=5 THEN
   SELECT count(*) INTO v_road_end FROM generate_series(1,cardinality(d.prizes)) n
    WHERE (d.road_roll::numeric+1)<=public.fn_choice_road_probability_v5(d.prizes,n,d.minimum_payout_chips)*281474976710656;
  ELSIF e.game='crossing' THEN
   SELECT count(*) INTO v_road_end FROM unnest(d.prizes) p
    WHERE (d.road_roll::numeric+1)*(p-d.minimum_payout_chips)<=(d.bet_chips*.8-d.minimum_payout_chips)*281474976710656;
  END IF;
  v_data:=jsonb_build_object('status',d.status,'mode',d.mode,'picked',to_jsonb(d.picked),
   'prizes',to_jsonb(d.prizes),'mine_cells',to_jsonb(d.mine_cells),'road_end',v_road_end);
  IF v_coins IS NOT NULL THEN
   v_data:=v_data||jsonb_build_object('payout_version',6,'coins',to_jsonb(v_coins),
    'street_multipliers',(SELECT jsonb_agg(round(p/d.bet_chips,4) ORDER BY o) FROM unnest(d.prizes) WITH ORDINALITY u(p,o)));
  END IF;
  v_payout:=d.payout_chips; v_completed:=d.settled_at;
 ELSE RETURN jsonb_build_object('ok',false,'error','Replay Not Found'); END IF;
 RETURN jsonb_build_object('ok',true,'replay',jsonb_build_object('version',1,'game',e.game,
  'diamonds',e.total_diamonds,'boost',coalesce((e.result#>>'{bonus,boost_multiplier}')::integer,1),
  'completed_at',v_completed,'payout_chips',v_payout,'data',v_data));
END $function$
;

-- Read the contract back from what was just installed, against the owner's
-- numbers, before anything commits.
DO $readback$
DECLARE p numeric[]; k integer; ev numeric; chance numeric; paid numeric; loss numeric; coins boolean[]; safe integer:=0; i integer;
BEGIN
 -- The standard ladder shown to Dan for a one-chip award (floor half): to the cent.
 p:=public.fn_choice_road_prizes_v6(1,0.5);
 IF p IS DISTINCT FROM ARRAY[1.1,1.65,2.47,3.7,5.55,8.32,12.48,18.72,20]::numeric[] THEN RAISE EXCEPTION 'Standard coin ladder not as designed: %',p; END IF;
 -- Super with Double Diamonds (floor two thirds of the stake): 10 streets to 20x.
 p:=public.fn_choice_road_prizes_v6(75,50);
 IF cardinality(p)<>10 OR p[1]<>70 OR p[10]<>1500 THEN RAISE EXCEPTION 'Super coin ladder not as designed: %',p; END IF;
 -- Every stop is worth at most 0.80 of the stake, exactly 0.80 below the top.
 FOREACH ev IN ARRAY ARRAY[1,25,50,75,0.26,0.75]::numeric[] LOOP
  FOR loss IN SELECT unnest(ARRAY[ceil(ev*50)/100,ceil(ev*200/3)/100]) LOOP
   p:=public.fn_choice_road_prizes_v6(ev,loss); chance:=1; paid:=0;
   FOR k IN 1..cardinality(p) LOOP
    paid:=paid+chance/2*public.fn_choice_loss_floor_v5(p,k-1,loss); chance:=chance/2;
    IF paid+chance*p[k]>ev*0.8 OR (k<cardinality(p) AND paid+chance*p[k]<>ev*0.8) THEN RAISE EXCEPTION 'Stop % of a % stake is not worth 0.80',k,ev; END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 -- The coin is the first HMAC byte, and street one is a coin too.
 IF public.fn_choice_road_coin_v6('s','c',1,1) IS DISTINCT FROM (get_byte(extensions.hmac('c:1:street:1','s','sha256'),0)<128) THEN RAISE EXCEPTION 'Coin domain changed'; END IF;
 FOR i IN 1..4096 LOOP IF public.fn_choice_road_coin_v6('readback','seed',i,1+i%10) THEN safe:=safe+1; END IF; END LOOP;
 IF abs(safe-2048)>4*32 THEN RAISE EXCEPTION 'The coin is not fair: % safe of 4096',safe; END IF;
 coins:=ARRAY[true,true,false,true]; IF public.fn_choice_road_end_v6(coins)<>2 OR public.fn_choice_road_end_v6(ARRAY[true,true]::boolean[])<>2 OR public.fn_choice_road_end_v6('{}'::boolean[])<>0 THEN RAISE EXCEPTION 'Road end not as designed'; END IF;
 -- Mines is untouched.
 IF public.fn_choice_prizes_v6('mines','6',25,12.5) IS DISTINCT FROM public.fn_choice_prizes_v5('mines','6',25,12.5) THEN RAISE EXCEPTION 'Mines changed'; END IF;
END $readback$;

COMMIT;
