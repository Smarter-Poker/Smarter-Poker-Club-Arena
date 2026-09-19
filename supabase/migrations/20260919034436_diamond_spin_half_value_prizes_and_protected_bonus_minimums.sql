-- Half-value inventory/diamond prizes; guaranteed bonus minimums on new rounds.
-- Historical receipts/open rounds keep their original sealed prizes and zero minimum.
-- Minimum L=ceil(0.10*entry_chips*100)/100 includes the full Double Down entry.
-- Mines prizes: L+(0.8*B-L)/survival. Crossing/Crash survival:
-- (0.8*B-L)/(target_prize-L). Every available stopping target retains expectation0.8B.
-- Whole-diamond awards use an independent sealed rounding draw: half of odd
-- stakes is represented without systematically increasing/decreasing value.
-- Wheel: .4*.8+.02*4+.05*.5+.05+.02*2+.022*3+.438*.5=.80.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $preimages$ DECLARE expected record; BEGIN
 FOR expected IN SELECT * FROM (VALUES
 ('fn_diamond_game_append_only()','b918953252b0cced598b2382027081a0'),
 ('fn_choice_prizes(text,text,numeric)','bafc99f2c4b73d2d33107a98d3babbb2'),
 ('fn_choice_start(uuid,text,text,integer,uuid,text,integer)','9f5f648d3534054e3492a2c70cc2d8e0'),
 ('fn_choice_result(diamond_choice_rounds)','d6b450bb44dbb17d788e0f504a644496'),
 ('fn_choice_act(uuid,text,integer,integer)','49bf3e2448ecc526cb433f8d3a030495'),
 ('fn_crash_start(uuid,uuid,text,integer,integer)','205c283c1c0395daddc2d52ace717e05'),
 ('fn_crash_round_result(crash_rounds)','d0d7a23017a49a8b68c2b1d58ca75b26'),
 ('fn_crash_decide(crash_rounds,boolean,text,integer)','9ad5b165fc981fe14609225932dc4793'),
 ('fn_wheel_v3_model()','460b95706679c93556a85abef82fce11'),
 ('fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)','e84e46139211c4b06526330f83577941'),
 ('fn_wheel_state_v2(uuid,integer)','f3d8a951e76f3444ddd488c3fb6eee23')
 ) x(signature,body_hash) LOOP
  IF md5(pg_get_functiondef(to_regprocedure('public.'||expected.signature))) IS DISTINCT FROM expected.body_hash THEN
   RAISE EXCEPTION 'Diamond Payout Preimage Changed: %',expected.signature; END IF;
 END LOOP;
END $preimages$;
ALTER TABLE public.diamond_choice_rounds ADD COLUMN minimum_payout_chips numeric(14,2) NOT NULL DEFAULT 0 CHECK(minimum_payout_chips>=0 AND minimum_payout_chips<bet_chips);
ALTER TABLE public.crash_rounds ADD COLUMN minimum_payout_chips numeric(14,2) NOT NULL DEFAULT 0 CHECK(minimum_payout_chips>=0 AND minimum_payout_chips<bet_chips);
CREATE FUNCTION public.fn_diamond_bonus_minimum(p_bet numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path=public AS $$ SELECT ceil(p_bet*10)/100 $$;
CREATE FUNCTION public.fn_crash_point_cents(p_roll numeric,p_bet numeric,p_minimum numeric) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT GREATEST(100,floor(100*(p_minimum+(p_bet*.8-p_minimum)*281474976710656/(p_roll+1))/p_bet))::bigint
$$;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_minimum(numeric),public.fn_crash_point_cents(numeric,numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_minimum(numeric),public.fn_crash_point_cents(numeric,numeric,numeric) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_choice_prizes(p_game text, p_mode text, p_bet numeric)
 RETURNS numeric[]
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE out numeric[]:='{}'; ladder integer[]; m integer; k integer;
BEGIN
 IF p_game='crossing' THEN
  ladder:=public.fn_choice_ladder(p_mode);
  IF ladder IS NULL THEN RAISE EXCEPTION 'Choose A Road Difficulty'; END IF;
  FOR k IN 1..cardinality(ladder) LOOP out:=array_append(out,p_bet*ladder[k]/100); END LOOP;
 ELSIF p_game='mines' AND p_mode IN ('5','10','15') THEN
  m:=p_mode::integer;
  FOR k IN 1..25-m LOOP out:=array_append(out,public.fn_diamond_bonus_minimum(p_bet)+(p_bet*0.8-public.fn_diamond_bonus_minimum(p_bet))*public.fn_choice_choose(25,k)/public.fn_choice_choose(25-m,k)); END LOOP;
 ELSE RAISE EXCEPTION 'Choose A Game Setting'; END IF;
 RETURN out;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_choice_start(p_club_id uuid, p_game text, p_mode text, p_bet integer, p_commit_id uuid, p_client_seed text, p_max_steps integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE adm record; r public.diamond_choice_rounds; v_prizes numeric[]; cap integer; lim integer:=0; k integer;
 v_reserve numeric; v_bet jsonb; v_user uuid:=auth.uid(); v_id uuid:=gen_random_uuid(); v_roll bigint:=0; v_cells integer[]:='{}';
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
 SELECT * INTO adm FROM public.fn_diamond_game_admit(p_game,p_club_id,p_commit_id,p_client_seed,p_bet);
 IF adm.err IS NOT NULL THEN RETURN adm.err; END IF;
 SELECT * INTO r FROM public.diamond_choice_rounds WHERE host_id=adm.o_host AND user_id=v_user AND game=p_game AND status='open';
 IF FOUND THEN RETURN jsonb_build_object('ok',false,'error','Resume Your Open Round First'); END IF;
 v_prizes:=public.fn_choice_prizes(p_game,p_mode,adm.o_bet_chips);
 cap:=public.fn_diamond_game_cap_cents(adm.o_cfg,adm.o_pool,adm.o_bank,adm.o_bet_chips,(adm.o_cfg).max_multiplier_cents);
 FOR k IN 1..cardinality(v_prizes) LOOP
  EXIT WHEN ceil(v_prizes[k]*100)/100 > adm.o_bet_chips*cap/100;
  lim:=k;
 END LOOP;
 IF p_max_steps IS NULL OR p_max_steps<1 OR p_max_steps>lim THEN
  RETURN jsonb_build_object('ok',false,'error','The Round Limit Changed. Refresh Before You Play'); END IF;
 v_prizes:=v_prizes[1:p_max_steps];
 v_reserve:=ceil(v_prizes[p_max_steps]*100)/100;
 IF p_game='mines' THEN v_cells:=public.fn_choice_board((adm.o_commit).server_seed,p_client_seed,adm.o_nonce,p_mode::integer);
 ELSE v_roll:=('x'||substr(encode(extensions.hmac(p_client_seed||':'||adm.o_nonce||':road',(adm.o_commit).server_seed,'sha256'),'hex'),1,12))::bit(48)::bigint; END IF;
 v_bet:=public.fn_diamond_game_take_bet(v_user,p_bet,(adm.o_cfg).purchased_only,p_game||'_bet',
  'Diamond Game Bet','choice:'||v_id,jsonb_build_object('round_id',v_id,'game',p_game,'host_id',adm.o_host,'club_id',p_club_id),adm.o_owner,'Diamond Game Intake');
 IF COALESCE((v_bet->>'success')::boolean,false)=false THEN RETURN jsonb_build_object('ok',false,'error','The Bet Could Not Be Paid'); END IF;
 UPDATE public.diamond_game_pools SET rounds=rounds+1,intake_diamonds=intake_diamonds+public.fn_wheel_bonus_player_debit(p_bet),
  reserved_chips=reserved_chips+v_reserve,updated_at=now() WHERE host_id=adm.o_host AND game=p_game;
 UPDATE public.diamond_game_commits SET consumed_by=v_id WHERE id=p_commit_id;
 INSERT INTO public.diamond_choice_rounds(id,host_id,host_kind,club_id,user_id,game,mode,bet_diamonds,bet_chips,diamonds_per_chip,
  commit_id,server_seed,server_seed_hash,client_seed,nonce,mine_cells,road_roll,max_steps,prizes,reserved_chips,is_fixture,minimum_payout_chips)
 VALUES(v_id,adm.o_host,adm.o_kind,p_club_id,v_user,p_game,p_mode,p_bet,adm.o_bet_chips,adm.o_rate,p_commit_id,
  (adm.o_commit).server_seed,(adm.o_commit).server_seed_hash,p_client_seed,adm.o_nonce,v_cells,v_roll,p_max_steps,v_prizes,v_reserve,adm.o_fixture,public.fn_diamond_bonus_minimum(adm.o_bet_chips)) RETURNING * INTO r;
 RETURN public.fn_choice_result(r);
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_choice_result(r diamond_choice_rounds)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT public.fn_wheel_award_receipt(r.commit_id)||jsonb_build_object('ok',true,'id',r.id,'game',r.game,'club_id',r.club_id,'status',r.status,'mode',r.mode,
 'bet_diamonds',r.bet_diamonds,'bet_chips',r.bet_chips,'picked',to_jsonb(r.picked),'max_steps',r.max_steps,
 'prizes',to_jsonb(r.prizes),'payout_chips',r.payout_chips,
 'minimum_payout_chips',r.minimum_payout_chips,'payout_version',CASE WHEN r.minimum_payout_chips>0 THEN 2 ELSE 1 END,'server_seed_hash',r.server_seed_hash,
 'client_seed',r.client_seed,'nonce',r.nonce,'commit_id',r.commit_id,
 'diamonds_per_chip',r.diamonds_per_chip,'proof',CASE WHEN r.status<>'open' THEN jsonb_build_object('game',r.game,'server_seed',r.server_seed,
 'server_seed_hash',r.server_seed_hash,'client_seed',r.client_seed,'nonce',r.nonce,
 'mines',CASE WHEN r.game='mines' THEN r.mode::integer ELSE 0 END,'mine_cells',to_jsonb(r.mine_cells),'road_roll',r.road_roll::text) END)
$function$
;

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
  IF r.game='mines' THEN safe:=NOT(p_cell=ANY(r.mine_cells));
  ELSE safe:=(r.road_roll::numeric+1)*(r.prizes[n+1]-r.minimum_payout_chips) <= (r.bet_chips*.8-r.minimum_payout_chips)*281474976710656; END IF;
  r.picked:=array_append(r.picked,p_cell); n:=n+1;
  IF NOT safe THEN r.status:='lost';
  ELSIF n=r.max_steps THEN r.status:='cashed'; END IF;
 ELSIF p_action='cashout' AND n>0 THEN r.status:='cashed';
 ELSE RETURN jsonb_build_object('ok',false,'error','Make Your First Move Before Cashing Out'); END IF;
 IF r.status='lost' THEN v_pay:=r.minimum_payout_chips; END IF;
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
 UPDATE public.diamond_choice_rounds SET picked=r.picked,status=r.status,payout_chips=v_pay,
  settled_at=CASE WHEN r.status<>'open' THEN clock_timestamp() END WHERE id=r.id RETURNING * INTO r;
 RETURN public.fn_choice_result(r);
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_crash_start(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_bet_diamonds integer, p_auto_cashout_cents integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  prior public.crash_rounds;
  adm record;
  v_id uuid := gen_random_uuid();
  v_hmac bytea; v_roll numeric; v_crash bigint; v_cap integer;
  v_reserve numeric; v_deduct jsonb; v_dia_after numeric; v_member_chips numeric;
  v_intake_chips numeric;
  pool public.diamond_game_pools%ROWTYPE;
  r public.crash_rounds;
BEGIN
  -- A SIGNED-OUT CALLER IS NOT A PLAYER (2026-09-09).
  --
  -- This RPC is granted to `anon`, and it had no sign-in guard while its
  -- siblings (fn_wheel_commit, fn_wheel_spin, fn_wheel_set_config) all do. On
  -- its own that is only defence in depth - but the ownership check below read
  -- `user_id IS DISTINCT FROM v_user`, and with v_user NULL that comparison is NULL, which is
  -- not TRUE, so the refusal did not fire and execution fell through to return
  -- the round. A logged-out caller holding a commit_id could read another
  -- player's result. Three-valued logic, in a money game. Every such
  -- comparison in this body is now IS DISTINCT FROM as well.
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Play');
  END IF;
  SELECT * INTO prior FROM public.crash_rounds WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Round Belongs To Another Player');
    END IF;
    RETURN public.fn_crash_round_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO adm FROM public.fn_diamond_game_admit('crash', p_club_id, p_commit_id, p_client_seed, p_bet_diamonds);
  IF adm.err IS NOT NULL THEN RETURN adm.err; END IF;

  -- One open round per player per host: finish it first (a refresh resumes it).
  SELECT * INTO prior FROM public.crash_rounds c WHERE c.host_id = adm.o_host AND c.user_id = v_user AND c.status = 'open'
   ORDER BY c.started_at DESC LIMIT 1;
  IF prior.id IS NOT NULL THEN
    RETURN public.fn_crash_round_result(prior) || jsonb_build_object('resumed', true);
  END IF;

  v_cap := public.fn_diamond_game_cap_cents(adm.o_cfg, adm.o_pool, adm.o_bank, adm.o_bet_chips, (adm.o_cfg).max_multiplier_cents);
  IF v_cap < 101 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Club Cannot Cover A Win At That Bet Right Now. Try A Smaller Bet',
                              'cap_cents', v_cap);
  END IF;
  IF p_auto_cashout_cents IS NOT NULL AND (p_auto_cashout_cents < 101 OR p_auto_cashout_cents > v_cap) THEN
    RETURN jsonb_build_object('ok', false, 'error', format('Auto Cash Out Must Be Between 1.01x And %s.%sx', v_cap / 100, lpad((v_cap % 100)::text, 2, '0')),
                              'cap_cents', v_cap);
  END IF;
  v_reserve := ceil(adm.o_bet_chips * v_cap)/100;

  -- ── the roll: the crash point, sealed in the row ───────────────────────────
  v_hmac := extensions.hmac(convert_to(p_client_seed || ':' || adm.o_nonce::text, 'UTF8'),
                            convert_to((adm.o_commit).server_seed, 'UTF8'), 'sha256');
  v_roll  := (('x' || encode(substring(v_hmac from 1 for 6), 'hex'))::bit(48)::bigint)::numeric;
  v_crash := public.fn_crash_point_cents(v_roll,adm.o_bet_chips,public.fn_diamond_bonus_minimum(adm.o_bet_chips));

  -- ── 1. the bet is paid for ─────────────────────────────────────────────────
  v_deduct := public.fn_diamond_game_take_bet(v_user, p_bet_diamonds, (adm.o_cfg).purchased_only, 'crash_bet',
                format('Diamond Crash Bet (%s Diamonds)', p_bet_diamonds),
                'crash:' || v_id::text,
                jsonb_build_object('round_id', v_id, 'club_id', p_club_id, 'host_id', adm.o_host, 'commit_id', p_commit_id),
                adm.o_owner,
                format('Diamond Crash Intake (%s Diamonds)', p_bet_diamonds));
  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For That Bet', 'detail', v_deduct->>'error');
  END IF;

  -- ── 2. nothing is minted; the payout is reserved against the promo wallet ──
  UPDATE public.diamond_game_pools
     SET rounds = rounds + 1,
         intake_diamonds = intake_diamonds + public.fn_wheel_bonus_player_debit(p_bet_diamonds),
         reserved_chips = reserved_chips + v_reserve,
         constrained_rounds = constrained_rounds + CASE WHEN v_cap < (adm.o_cfg).max_multiplier_cents THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = adm.o_host AND game = 'crash'
   RETURNING * INTO pool;
  v_intake_chips := round((pool.intake_diamonds+pool.wheel_allocated_diamonds)::numeric / adm.o_rate, 2);
  IF pool.chips_paid + pool.reserved_chips > v_intake_chips + (adm.o_cfg).exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_crash_start: reserved % + paid % would exceed the chips taken in % + allowance % - the cap was bypassed',
      pool.reserved_chips, pool.chips_paid, v_intake_chips, (adm.o_cfg).exposure_allowance_chips;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  SELECT COALESCE(cm.chip_balance, 0) INTO v_member_chips FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_user LIMIT 1;
  UPDATE public.diamond_game_commits SET consumed_by = v_id WHERE id = p_commit_id;

  INSERT INTO public.crash_rounds
    (id, host_id, host_kind, club_id, user_id, bet_diamonds, bet_chips, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, roll, crash_cents, cap_cents, growth_k,
     auto_cashout_cents, reserved_chips, chips_minted, diamonds_after, member_chips_after, is_fixture, started_at, minimum_payout_chips)
  VALUES
    (v_id, adm.o_host, adm.o_kind, p_club_id, v_user, p_bet_diamonds, adm.o_bet_chips, adm.o_rate,
     p_commit_id, (adm.o_commit).server_seed_hash, (adm.o_commit).server_seed, p_client_seed, adm.o_nonce, v_roll, v_crash, v_cap, (adm.o_cfg).growth_k,
     p_auto_cashout_cents, v_reserve, 0, v_dia_after, v_member_chips, adm.o_fixture, clock_timestamp(), public.fn_diamond_bonus_minimum(adm.o_bet_chips))
  RETURNING * INTO r;
  RETURN public.fn_crash_round_result(r);
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_crash_round_result(r crash_rounds)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  SELECT public.fn_wheel_award_receipt(r.commit_id)||jsonb_build_object(
    'ok', true, 'game', 'crash', 'round_id', r.id, 'club_id', r.club_id, 'host_id', r.host_id,
    'status', r.status, 'bet_diamonds', r.bet_diamonds, 'bet_chips', r.bet_chips,
    'diamonds_per_chip', r.diamonds_per_chip,
    'minimum_payout_chips',r.minimum_payout_chips,'payout_version',CASE WHEN r.minimum_payout_chips>0 THEN 2 ELSE 1 END,
    'cap_cents', r.cap_cents, 'growth_k', r.growth_k, 'auto_cashout_cents', r.auto_cashout_cents,
    'started_at', r.started_at, 'server_now', clock_timestamp(),
    'elapsed_ms', CASE WHEN r.status = 'open'
                       THEN floor(extract(epoch FROM (clock_timestamp() - r.started_at)) * 1000)::bigint
                       ELSE r.elapsed_ms END,
    'multiplier_now_cents', CASE WHEN r.status = 'open'
                       THEN public.fn_crash_multiplier_cents(r.growth_k,
                              floor(extract(epoch FROM (clock_timestamp() - r.started_at)) * 1000)::bigint, r.cap_cents) END,
    'outcome', CASE WHEN r.status = 'open' THEN NULL ELSE jsonb_build_object(
      'status', r.status, 'cashout_cents', r.cashout_cents, 'crash_cents', r.crash_cents,
      'payout_chips', r.payout_chips, 'settled_by', r.settled_by, 'settled_at', r.settled_at) END,
    'fairness', jsonb_build_object('commit_id', r.commit_id, 'server_seed_hash', r.server_seed_hash,
                                   'client_seed', r.client_seed, 'nonce', r.nonce)
                || CASE WHEN r.status = 'open' THEN '{}'::jsonb
                        ELSE jsonb_build_object('server_seed', r.server_seed, 'roll', r.roll, 'crash_cents', r.crash_cents) END,
    'balances', jsonb_build_object('diamonds', r.diamonds_after, 'member_chips', r.member_chips_after),
    'pool', jsonb_build_object('chips_paid', r.pool_chips_paid_after),
    'created_at', r.created_at);
$function$
;

CREATE OR REPLACE FUNCTION public.fn_crash_decide(p_round crash_rounds, p_cashout boolean, p_by text, p_displayed_cents integer)
 RETURNS crash_rounds
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  r public.crash_rounds := p_round;
  v_elapsed_ms bigint;
  v_now_cents integer;
  v_result text;          -- 'cashed' | 'crashed' | NULL (still open)
  v_at_cents integer;
  v_payout numeric := 0;
  v_bank_after numeric; v_member_after numeric;
  pool public.diamond_game_pools%ROWTYPE;
  cfg public.diamond_game_configs%ROWTYPE;
  v_intake_chips numeric;
BEGIN
  IF r.status <> 'open' THEN
    RETURN r;
  END IF;
  v_elapsed_ms := floor(extract(epoch FROM (clock_timestamp() - r.started_at)) * 1000)::bigint;
  v_now_cents := public.fn_crash_multiplier_cents(r.growth_k, v_elapsed_ms, r.cap_cents);

  -- An auto target below the crash point is honoured the moment the curve
  -- passes it, whatever else happened since.
  IF r.auto_cashout_cents IS NOT NULL AND r.auto_cashout_cents <= r.crash_cents AND v_now_cents >= r.auto_cashout_cents THEN
    v_result := 'cashed'; v_at_cents := r.auto_cashout_cents;
  -- The curve reached the cap before the crash point: cashed at the cap.
  ELSIF r.crash_cents >= r.cap_cents AND v_now_cents >= r.cap_cents THEN
    v_result := 'cashed'; v_at_cents := r.cap_cents;
  -- The curve reached the crash point: settle its snapshotted minimum.
  ELSIF (r.crash_cents = 100 AND v_now_cents >= 100) OR v_now_cents > r.crash_cents THEN
    v_result := 'crashed'; v_at_cents := NULL;
  ELSIF p_cashout AND v_now_cents >= 101 THEN
    -- Honor the displayed hundredth, never a later, inflated receipt-time multiplier.
    -- The server has already checked the sealed crash; client timestamps cannot revive a loss.
    IF p_displayed_cents IS NOT NULL AND (p_displayed_cents < 101 OR p_displayed_cents > v_now_cents) THEN
      RAISE EXCEPTION 'The Requested Multiplier Is Not Available';
    END IF;
    v_result := 'cashed'; v_at_cents := COALESCE(p_displayed_cents,v_now_cents);
  ELSE
    RETURN r;
  END IF;

  SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = r.host_id AND game = 'crash';
  SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id = r.host_id AND game = 'crash' FOR UPDATE;

  -- Release this round's liability before its own payout; both roll back
  -- together if the wallet refuses. Other games' promises remain reserved.
  UPDATE public.diamond_game_pools SET reserved_chips=reserved_chips-r.reserved_chips
   WHERE host_id=r.host_id AND game='crash';

  IF v_result = 'cashed' THEN
    v_payout := public.fn_diamond_round_chip_cents(r.bet_chips * v_at_cents / 100, r.server_seed, r.client_seed || ':' || r.nonce || ':rounding:' || v_at_cents);
  ELSE
    v_payout := r.minimum_payout_chips;
  END IF;
  IF v_payout > 0 THEN
    IF v_payout > r.reserved_chips THEN
      RAISE EXCEPTION 'fn_crash_decide: payout % exceeds the round''s reservation % (cap %)', v_payout, r.reserved_chips, r.cap_cents;
    END IF;
    SELECT x.bank_after, x.member_after INTO v_bank_after, v_member_after
      FROM public.fn_diamond_game_prize_leg('crash', r.host_id, r.host_kind, r.club_id, r.user_id, v_payout,
             'crash-prize:' || r.id::text,
             CASE WHEN v_result='crashed' THEN 'Diamond Crash: Minimum Prize' ELSE format('Diamond Crash: cashed out at %s.%sx', v_at_cents / 100, lpad((v_at_cents % 100)::text, 2, '0')) END,
             jsonb_build_object('round_id', r.id, 'host_id', r.host_id, 'host_kind', r.host_kind,
                                'cashout_cents', v_at_cents, 'crash_cents', r.crash_cents,'minimum_payout_chips',r.minimum_payout_chips,'result',v_result, 'auto', r.auto_cashout_cents IS NOT NULL AND v_at_cents = r.auto_cashout_cents)) x;
  END IF;

  UPDATE public.diamond_game_pools
     SET chips_paid = chips_paid + v_payout,
         updated_at = now()
   WHERE host_id = r.host_id AND game = 'crash'
   RETURNING * INTO pool;
  v_intake_chips := round((pool.intake_diamonds+pool.wheel_allocated_diamonds)::numeric / public.fn_ca_bridge_rate(), 2);
  IF pool.chips_paid + pool.reserved_chips > v_intake_chips + cfg.exposure_allowance_chips + 0.000001 THEN
    RAISE EXCEPTION 'fn_crash_decide: chips_paid % + reserved % would exceed the chips taken in % + allowance % - the cap was bypassed',
      pool.chips_paid, pool.reserved_chips, v_intake_chips, cfg.exposure_allowance_chips;
  END IF;

  UPDATE public.crash_rounds
     SET status = v_result, settled_at = clock_timestamp(), settled_by = p_by,
         elapsed_ms = LEAST(v_elapsed_ms, 2147483647)::integer, cashout_cents = v_at_cents, payout_chips = v_payout,
         pool_chips_minted_after = pool.chips_minted, pool_chips_paid_after = pool.chips_paid,
         member_chips_after = COALESCE(v_member_after, member_chips_after)
   WHERE id = r.id
   RETURNING * INTO r;
  RETURN r;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_wheel_v3_model()
 RETURNS TABLE(ord smallint, label text, kind text, game text, multiplier numeric, weight integer)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT o::smallint,l,k,g,m,w FROM (VALUES
 (1,'Diamond Plinko','bonus','plinko',1::numeric,10000),
 (2,'1x Chips','chips',NULL,1,5000),
 (3,'Throwables','throwables',NULL,.5,14600),
 (4,'Diamond Crash','bonus','crash',1,10000),
 (5,'Diamonds','diamonds',NULL,.5,5000),
 (6,'Time Bank','time_bank',NULL,.5,14600),
 (7,'Donkey Cross','bonus','crossing',1,10000),
 (8,'2x Chips','chips',NULL,2,2000),
 (9,'Rabbit Hunt','rabbit_hunt',NULL,.5,14600),
 (10,'Diamond Mines','bonus','mines',1,10000),
 (11,'3x Chips','chips',NULL,3,2200),
 (12,'Upgrade','upgrade',NULL,2,2000)) x(o,l,k,g,m,w)
$function$
;

CREATE OR REPLACE FUNCTION public.fn_wheel_spin_v2(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_entry_diamonds integer, p_mode text DEFAULT 'paid'::text, p_bonus_ticket_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  c_two48 constant numeric := 281474976710656;   -- 2^48
  p_welcome boolean:=p_mode='welcome';
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  cm public.wheel_seed_commits%ROWTYPE;
  prior public.wheel_spins%ROWTYPE;
  a record;
  v_rate integer := public.fn_ca_bridge_rate();
  v_price integer; v_mult integer; v_intake numeric;
  v_dia_now numeric; v_intake_chips numeric;
  v_owner uuid; v_owner_dia numeric;
  v_bank numeric; v_bank_after numeric;
  v_promo numeric; v_bank_only numeric; v_pay record;
  v_client text := left(btrim(COALESCE(p_client_seed, '')), 64);
  v_nonce bigint; v_hmac bytea; v_roll numeric; v_point numeric;
  v_total integer := 0; v_acc integer := 0;
  v_eligible smallint[] := '{}'; v_locked jsonb := '[]'::jsonb;
  seg record; v_pick record; v_found boolean := false;
  v_value_chips numeric := 0; v_prize_chips numeric := 0; v_prize_dia integer := 0;
  v_today integer; v_last timestamptz;
  v_spendable integer; v_diamonds numeric; v_purchased integer;
  v_lot record; v_remaining integer; v_take integer;
  v_deduct jsonb; v_credit jsonb;
  v_member_after numeric; v_dia_after numeric;
  v_spin_id uuid := gen_random_uuid();
  v_is_fixture boolean := false;
  v_result jsonb;
  v_ticket public.diamond_bonus_spin_tickets;
  -- The welcome budget is a window, not a lifetime total, and a welcome spin is
  -- the whole wheel or it is not offered. Both figures are measured once, up
  -- front, under the config lock that serialises every spin on this host.
  v_welcome_spent numeric := 0; v_welcome_top numeric := 0;
  v_gcfg public.diamond_game_configs; v_gpool public.diamond_game_pools; v_caps jsonb:='{}';
  v_boost integer; v_budget integer; v_cap integer; v_hold numeric; v_reserved numeric;
  v_game text; v_award public.wheel_bonus_awards; v_secondary jsonb; v_secondary_segments jsonb; v_segments jsonb;
  v_second_hmac bytea; v_second_roll numeric; v_second_ord integer; v_outcome jsonb;
  v_second_point numeric; v_second_acc integer:=0; v_second_outcome jsonb;
  v_prize_multiplier numeric; v_prize_label text;
  v_feature text; v_cost integer:=0; v_unit integer; v_uses integer; v_remainder integer; v_grants jsonb:='[]';

BEGIN
  IF p_mode IS NULL OR p_mode NOT IN('paid','welcome','daily') OR p_entry_diamonds IS NULL OR p_entry_diamonds NOT BETWEEN 25 AND 2500
   OR (p_mode<>'paid' AND p_entry_diamonds<>100) OR (p_mode='daily')<>(p_bonus_ticket_id IS NOT NULL)
   OR p_commit_id IS NULL OR p_client_seed IS NULL OR length(p_client_seed) NOT BETWEEN 1 AND 64 OR p_client_seed<>btrim(p_client_seed) THEN
   RETURN jsonb_build_object('ok',false,'error','Choose A Valid Diamond Spins Entry'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_commit_id::text,94613));
  -- ── who and where ──────────────────────────────────────────────────────────
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bridge Rate Is Not Set');
  END IF;
  IF length(v_client) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A Client Seed Is Required');
  END IF;

  -- ── replay: a commit is spent once; the second call returns the first spin ─
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Spin Belongs To Another Player');
    END IF;
    IF prior.receipt_v2 IS NULL OR (prior.receipt_v2->>'entry_value_diamonds')::integer IS DISTINCT FROM p_entry_diamonds OR prior.club_id IS DISTINCT FROM p_club_id OR prior.client_seed IS DISTINCT FROM v_client
       OR prior.is_welcome IS DISTINCT FROM p_welcome OR prior.bonus_ticket_id IS DISTINCT FROM p_bonus_ticket_id THEN
      RETURN jsonb_build_object('ok',false,'error','That Spin Request Does Not Match Its Receipt');
    END IF;
    RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  IF NOT public.fn_wheel_v2_enabled() THEN RETURN jsonb_build_object('ok',false,'error','The New Wheel Is Not Open Yet'); END IF;

  IF p_bonus_ticket_id IS NOT NULL THEN
    IF p_welcome THEN RETURN jsonb_build_object('ok',false,'error','Choose One Free Spin Reward'); END IF;
    SELECT * INTO v_ticket FROM public.diamond_bonus_spin_tickets WHERE id=p_bonus_ticket_id FOR UPDATE;
    IF v_ticket.id IS NULL OR v_ticket.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok',false,'error','Claim This Bonus Spin In Daily Bonus First');
    END IF;
    IF v_ticket.redeemed_spin_id IS NOT NULL THEN
      SELECT * INTO prior FROM public.wheel_spins WHERE id=v_ticket.redeemed_spin_id;
      IF prior.user_id=v_user AND prior.club_id=p_club_id AND prior.commit_id=p_commit_id
         AND prior.client_seed=v_client AND prior.bonus_ticket_id=p_bonus_ticket_id AND NOT prior.is_welcome THEN
        RETURN public.fn_wheel_spin_result(prior)||jsonb_build_object('replayed',true);
      END IF;
      RETURN jsonb_build_object('ok',false,'error','That Bonus Spin Was Already Used');
    END IF;
    IF v_ticket.funded_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'error','That Bonus Spin Was Already Used');
    END IF;
  END IF;

  IF p_bonus_ticket_id IS NOT NULL THEN
    -- Match the canonical Mint's lock order before taking host/owner rows.
    PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:diamonds'));
  END IF;

  -- ── the freeze and the kill switch, before any money moves ─────────────────
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Spin Again In A Few Minutes');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'wheel' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Paused');
  END IF;

  -- ── the host, its table, its pool: one lock serialises every spin on it ────
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host FOR UPDATE;
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id=p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.receipt_v2 IS NULL OR (prior.receipt_v2->>'entry_value_diamonds')::integer IS DISTINCT FROM p_entry_diamonds OR prior.user_id IS DISTINCT FROM v_user OR prior.club_id IS DISTINCT FROM p_club_id
       OR prior.client_seed IS DISTINCT FROM v_client OR prior.is_welcome IS DISTINCT FROM p_welcome
       OR prior.bonus_ticket_id IS DISTINCT FROM p_bonus_ticket_id THEN
      RETURN jsonb_build_object('ok',false,'error','That Spin Request Does Not Match Its Receipt');
    END IF;
    RETURN public.fn_wheel_spin_result(prior)||jsonb_build_object('replayed',true);
  END IF;
  IF cfg.host_id IS NULL OR NOT cfg.enabled THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Not Open Here');
  END IF;
  INSERT INTO public.wheel_pools (host_id) VALUES (v_host) ON CONFLICT (host_id) DO NOTHING;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host FOR UPDATE;

  IF (SELECT sum(weight) FROM public.fn_wheel_v3_model())<>100000 OR (SELECT count(*) FROM public.fn_wheel_v3_model())<>12 THEN
   RAISE EXCEPTION 'The Wheel Model Is Invalid'; END IF;
  v_mult:=1; v_price:=p_entry_diamonds;
  v_segments:=public.fn_wheel_v3_segments(v_price,v_rate);
  v_intake := v_price::numeric / v_rate;
  -- THE HOST IS THE HOUSE (Dan 2026-09-10). Nothing is minted: the whole price
  -- is taken in by the host's owner, and the prize is paid out of what the host
  -- holds. The chip side is bounded by the chips this wheel has taken in (this
  -- spin included) plus the host's allowance; the diamond side by the diamonds
  -- it has taken in plus the seed the host put up. Both are "never more than
  -- taken in", stated on the money that actually moved.
  -- A WELCOME SPIN TAKES NOTHING IN (Dan 2026-09-10: the owner "simply receives
  -- no diamonds"). So it adds nothing to the float and nothing to the intake the
  -- paid game's invariant is stated on; its payout is charged to the welcome
  -- budget instead, a few lines below.
  v_dia_now      := CASE WHEN p_welcome THEN 0 ELSE v_price END;
  v_intake_chips := round((pool.intake_diamonds + v_dia_now)::numeric / v_rate, 2);
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'This Host Has No Owner Wallet To Pay');
  END IF;

  IF NOT public.fn_diamond_spins_owner_agreed(v_host,v_kind) THEN
   RETURN jsonb_build_object('ok',false,'error','The Host Wallet Owner Must Accept Diamond Spins Before Play Opens'); END IF;
  -- ── the player: member, not a fixture, inside the limits, able to pay ──────
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = v_user
                    AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Join The Club Before You Spin');
  END IF;
  v_is_fixture := public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user);
  IF v_is_fixture AND NOT cfg.allow_fixture_accounts THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Certification Accounts Do Not Spin This Wheel');
  END IF;

  -- ── the welcome spin: once per member, ever, and only out of a real budget ─
  IF p_welcome THEN
    IF NOT cfg.welcome_spin_enabled THEN
      RETURN jsonb_build_object('ok', false, 'error', 'There Is No Welcome Spin Here');
    END IF;
    IF COALESCE(cfg.welcome_budget_chips, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Spin Is Not Funded Here Yet');
    END IF;
    IF v_user = v_owner THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Host Does Not Take Its Own Welcome Spin');
    END IF;
    -- The unique index is what actually enforces this; the check is here to
    -- answer the player in words rather than with a constraint violation.
    IF EXISTS (SELECT 1 FROM public.wheel_spins s
                WHERE s.host_id = v_host AND s.user_id = v_user AND s.is_welcome) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'You Have Already Taken Your Welcome Spin Here');
    END IF;
    -- A WELCOME SPIN IS THE WHOLE WHEEL OR IT IS NOT OFFERED (2026-09-11).
    -- The budget used to be checked tier by tier, so as the spend approached it
    -- the top prizes locked one after another and the last new members to
    -- arrive were handed a visibly worse wheel than the first ones. A gift that
    -- gets meaner the longer you take to join is not the gift Dan described.
    -- So the budget is asked ONE question before anything is offered: can it
    -- still cover the biggest prize on this table? If it can, every tier is
    -- live. If it cannot, there is no welcome spin here until the window turns.
    -- ONE DEFINITION OF THE QUESTION (2026-09-11). The door, the page and the
    -- entry read all asked it, and the entry read asked a DIFFERENT one, so a
    -- player could be told "Welcome Spin Ready" and then be refused by the
    -- door. There is one helper now and three callers.
    v_welcome_spent:=public.fn_wheel_v2_welcome_spent(v_host);
  END IF;
  SELECT * INTO cm FROM public.wheel_seed_commits
   WHERE id = p_commit_id AND user_id = v_user AND consumed_by IS NULL FOR UPDATE;
  IF cm.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again');
  END IF;
  IF cm.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Expired. Open The Wheel Again');
  END IF;
  SELECT count(*)::integer, max(s.created_at) INTO v_today, v_last
    FROM public.wheel_spins s
   WHERE s.user_id = v_user AND s.host_id = v_host
     AND (s.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  IF v_today >= cfg.max_spins_per_player_per_day THEN
    RETURN jsonb_build_object('ok', false, 'error', format('You Have Reached Today''s Limit Of %s Spins', cfg.max_spins_per_player_per_day));
  END IF;
  IF v_last IS NOT NULL AND now() - v_last < make_interval(secs => cfg.min_seconds_between_spins) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'One Moment Between Spins');
  END IF;
  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;
  IF NOT p_welcome AND p_bonus_ticket_id IS NULL AND v_spendable < v_price THEN
    RETURN jsonb_build_object('ok', false,
      'error', CASE WHEN cfg.purchased_only AND v_diamonds >= v_price
                    THEN 'This Wheel Spins Purchased Diamonds Only'
                    ELSE 'Not Enough Diamonds For A Spin' END,
      'diamonds', v_diamonds, 'spendable', v_spendable, 'spin_price_diamonds', v_price);
  END IF;

  -- ── the host's cover and its owner's diamonds, locked ─────────────────────
  -- The promo wallet pays first and the host's own chip bank stands behind it
  -- (Dan 2026-09-10). v_bank is the two together: what a prize may draw on.
  -- Take game configuration and pools before the shared host wallet, matching game entry.
  PERFORM 1 FROM public.diamond_game_configs WHERE host_id=v_host ORDER BY game FOR UPDATE;
  PERFORM 1 FROM public.diamond_game_pools WHERE host_id=v_host ORDER BY game FOR UPDATE;
  SELECT c.o_promo, c.o_bank, c.o_cover INTO v_promo, v_bank_only, v_bank
    FROM public.fn_diamond_game_cover_lock(v_host, v_kind) c;
  SELECT COALESCE(p.diamonds, 0) INTO v_owner_dia FROM public.profiles p WHERE p.id = v_owner;

  SELECT COALESCE(sum(reserved_chips),0) INTO v_reserved FROM public.diamond_game_pools WHERE host_id=v_host;
  IF v_bank-v_reserved < ceil(v_price::numeric/v_rate*100*100)/100 OR v_owner_dia+v_dia_now<ceil(v_price*.5) OR (NOT p_welcome AND pool.diamond_float+v_dia_now<ceil(v_price*.5)) THEN
   RETURN jsonb_build_object('ok',false,'error','The Host Must Fund Every Prize Before A Spin'); END IF;
  IF p_welcome AND cfg.welcome_budget_chips-v_welcome_spent<100*v_price::numeric/v_rate THEN
   RETURN jsonb_build_object('ok',false,'error','The Welcome Spins Here Are Gone For Now'); END IF;
  -- Fixed odds require the entire 100x secondary prize to fit the configured
  -- exposure policy before reading the seed. Never silently remove a prize.
  IF NOT p_welcome AND pool.chips_paid+ceil(100*v_price::numeric/v_rate*100)/100>v_intake_chips+cfg.exposure_allowance_chips THEN
   RETURN jsonb_build_object('ok',false,'error','The Host Must Fund Every Prize Before A Spin'); END IF;
  IF (SELECT count(*) FROM public.fn_wheel_v3_upgrade_model())<>8 OR (SELECT sum(weight) FROM public.fn_wheel_v3_upgrade_model())<>100000 THEN
   RAISE EXCEPTION 'The Upgrade Model Is Invalid'; END IF;
  -- Every possible game/upgrade is admitted before looking at the random seed.
  -- All game locks use the same order; one admitted outcome reserves its promise.
  FOR v_game IN SELECT unnest(ARRAY['crash','crossing','mines','plinko']) LOOP
   SELECT * INTO v_gcfg FROM public.diamond_game_configs WHERE host_id=v_host AND game=v_game FOR UPDATE;
   IF NOT FOUND OR NOT v_gcfg.enabled OR (v_is_fixture AND NOT v_gcfg.allow_fixture_accounts) OR EXISTS(SELECT 1 FROM public.ca_payout_freeze WHERE scope=v_game AND cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'error','Every Bonus Game Must Be Open Before A Spin'); END IF;
   INSERT INTO public.diamond_game_pools(host_id,game) VALUES(v_host,v_game) ON CONFLICT DO NOTHING;
   SELECT * INTO v_gpool FROM public.diamond_game_pools WHERE host_id=v_host AND game=v_game FOR UPDATE;
   FOR v_boost IN 1..2 LOOP
    v_budget:=v_price*v_boost;
    v_cap:=public.fn_diamond_game_cap_cents(v_gcfg,v_gpool,v_bank,v_budget::numeric/v_rate,v_gcfg.max_multiplier_cents);
    IF p_welcome THEN v_cap:=LEAST(v_cap,floor((cfg.welcome_budget_chips-v_welcome_spent)/(v_budget::numeric/v_rate)*100)::integer); END IF;
    -- Steady20x covers base plus one original entry:40x ordinary,30x upgraded.
    IF v_cap<2000*(v_boost+1)/v_boost THEN RETURN jsonb_build_object('ok',false,'error','The Host Must Fund Every Bonus Before A Spin'); END IF;
    v_caps:=jsonb_set(v_caps,ARRAY[v_game||':'||v_boost],to_jsonb(v_cap));
   END LOOP;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM public.plinko_tables WHERE activated_at IS NOT NULL AND max_multiplier_cents<=2000) THEN
   RETURN jsonb_build_object('ok',false,'error','An Approved Plinko Table Must Be Open Before A Spin'); END IF;
  IF EXISTS(SELECT 1 FROM (VALUES('throwable',1),('rabbit_hunt',5),('time_bank_seconds',5)) expected(feature,cost)
    LEFT JOIN public.feature_pricing actual ON actual.feature=expected.feature
    WHERE actual.feature IS NULL OR actual.diamond_cost<>expected.cost OR actual.usage_type<>'per_use') THEN
   RETURN jsonb_build_object('ok',false,'error','The Reward Prices Changed. The Wheel Must Be Requalified'); END IF;
  SELECT count(*)+1 INTO v_nonce FROM public.wheel_spins WHERE user_id=v_user;
  v_hmac:=extensions.hmac(convert_to('wheel-v3:'||v_client||':'||v_nonce,'UTF8'),convert_to(cm.server_seed,'UTF8'),'sha256');
  v_roll:=(('x'||encode(substring(v_hmac from 1 for 6),'hex'))::bit(48)::bigint)::numeric;
  v_total:=100000; v_eligible:=ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[];
  v_point:=floor(v_roll*v_total/c_two48);
  FOR seg IN SELECT * FROM public.fn_wheel_v3_model() ORDER BY ord LOOP
   v_acc:=v_acc+seg.weight;
   IF v_point<v_acc THEN v_pick:=seg;v_found:=true;EXIT;END IF;
  END LOOP;
  IF NOT v_found THEN RAISE EXCEPTION 'The Wheel Draw Is Invalid'; END IF;
  SELECT value INTO v_outcome FROM jsonb_array_elements(v_segments) WHERE (value->>'ord')::integer=v_pick.ord;
  IF v_pick.kind='upgrade' THEN
   v_secondary_segments:=public.fn_wheel_v3_segments(v_price,v_rate,true);
   v_second_hmac:=extensions.hmac(convert_to('wheel-v3-upgrade:'||v_client||':'||v_nonce,'UTF8'),convert_to(cm.server_seed,'UTF8'),'sha256');
   v_second_roll:=(('x'||encode(substring(v_second_hmac from 1 for 6),'hex'))::bit(48)::bigint)::numeric;
   v_second_point:=floor(v_second_roll*100000/c_two48);
   FOR seg IN SELECT * FROM public.fn_wheel_v3_upgrade_model() ORDER BY ord LOOP
    v_second_acc:=v_second_acc+seg.weight;
    IF v_second_point<v_second_acc THEN v_second_ord:=seg.ord;EXIT;END IF;
   END LOOP;
   IF v_second_ord IS NULL THEN RAISE EXCEPTION 'The Upgrade Draw Is Invalid'; END IF;
   v_second_outcome:=v_secondary_segments->(v_second_ord-1);
   IF v_second_outcome->>'kind'='bonus' THEN v_game:=v_second_outcome->>'game';
   ELSE v_prize_multiplier:=(v_second_outcome->>'multiplier')::numeric;v_prize_label:=v_second_outcome->>'label'; END IF;
   v_secondary:=jsonb_build_object('segments',v_secondary_segments,'outcome',v_secondary_segments->(v_second_ord-1),
    'fairness',jsonb_build_object('commit_id',p_commit_id,'server_seed_hash',cm.server_seed_hash,'server_seed',cm.server_seed,'client_seed',v_client,'nonce',v_nonce,'roll',v_second_roll,'weight_total',100000,'eligible_ords',jsonb_build_array(1,2,3,4,5,6,7,8),'locked','[]'::jsonb,'domain','wheel-v3-upgrade'));
  ELSIF v_pick.kind='bonus' THEN v_game:=v_pick.game;
  ELSIF v_pick.kind='chips' THEN v_prize_multiplier:=v_pick.multiplier;v_prize_label:=v_pick.label; END IF;

  -- ── 1. the spin is paid for, unless it is the welcome ─────────────────────
  -- THE OWNER SIMPLY RECEIVES NO DIAMONDS (Dan 2026-09-10). Not a refund, not a
  -- credit and back out again: on a welcome spin no diamond moves anywhere. The
  -- player pays nothing, the owner takes nothing, and what the host gives up is
  -- exactly the spin price it would have been paid.
  IF p_bonus_ticket_id IS NOT NULL THEN
    BEGIN
      UPDATE public.diamond_bonus_spin_tickets SET club_id=p_club_id,host_id=v_host,host_kind=v_kind,
        owner_id=v_owner,commit_id=p_commit_id,client_seed=v_client,
        funded_at=transaction_timestamp(),mint_op_id='daily-bonus-spin:'||p_bonus_ticket_id::text
       WHERE id=p_bonus_ticket_id RETURNING * INTO v_ticket;
    EXCEPTION WHEN SQLSTATE 'PDS01' THEN
      RETURN jsonb_build_object('ok',false,'error',SQLERRM);
    END;
  ELSIF NOT p_welcome THEN
    v_deduct := public.deduct_diamonds(
      v_user, v_price,
      format('Diamond Wheel Spin (%s Diamonds)', v_price),
      'wheel_spin', 'wheel_spin',
      jsonb_build_object('spin_id', v_spin_id, 'club_id', p_club_id, 'host_id', v_host,
                         'commit_id', p_commit_id, 'segment_version', cfg.segment_version,
                         'recipient_id', v_owner),
      'wheel:' || v_spin_id::text, 0);
    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For A Spin',
                                'detail', v_deduct->>'error');
    END IF;
    -- The intake is the host owner's (Dan 2026-09-10): a transfer, not an issuance.
    v_credit := public.add_diamonds_to_balance(v_owner, v_price, 'transfer',
                  format('Diamond Wheel Intake (%s Diamonds)', v_price), 'wheel:' || v_spin_id::text || ':intake', v_user);
    IF COALESCE((v_credit->>'success')::boolean, false) = false THEN
      RAISE EXCEPTION 'fn_wheel_spin_core: the spin price could not be credited to the host owner: %', v_credit->>'error';
    END IF;
    IF cfg.purchased_only THEN
      v_remaining := v_price;
      FOR v_lot IN SELECT * FROM public.diamond_purchase_lots l
                    WHERE l.user_id = v_user AND l.frozen_at IS NULL
                      AND (l.issued - l.consumed - l.refunded) > 0
                    ORDER BY l.created_at, l.id FOR UPDATE LOOP
        EXIT WHEN v_remaining <= 0;
        v_take := LEAST(v_remaining, v_lot.issued - v_lot.consumed - v_lot.refunded);
        UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
        v_remaining := v_remaining - v_take;
      END LOOP;
      IF v_remaining > 0 THEN
        RAISE EXCEPTION 'fn_wheel_spin_core: purchased lots could not cover the spin (% short) after the availability check passed', v_remaining;
      END IF;
    END IF;
  END IF;

  IF v_prize_multiplier IS NOT NULL THEN
   v_prize_chips:=public.fn_diamond_round_chip_cents(v_price::numeric*v_prize_multiplier/v_rate,cm.server_seed,'wheel-v3-rounding:'||v_client||':'||v_nonce);
   v_value_chips:=v_prize_chips;
   SELECT * INTO v_pay FROM public.fn_diamond_game_pay_chips('wheel_prize',v_host,v_kind,p_club_id,v_user,v_prize_chips,
    'wheel-prize:'||v_spin_id,'Diamond Spins: '||v_prize_label,jsonb_build_object('spin_id',v_spin_id,'host_id',v_host,'host_kind',v_kind,'welcome',p_welcome,'bonus_ticket_id',p_bonus_ticket_id,'contract_version',3,'multiplier',v_prize_multiplier,'secondary_ord',v_second_ord));
   v_member_after:=v_pay.member_after;
   IF v_pick.kind='chips' THEN v_outcome:=v_outcome||jsonb_build_object('amount',v_prize_chips,'value_chips',v_prize_chips);
   ELSE v_secondary:=jsonb_set(v_secondary,'{outcome}',v_second_outcome||jsonb_build_object('amount',v_prize_chips,'value_chips',v_prize_chips)); END IF;
  ELSIF v_pick.kind='diamonds' THEN
   v_prize_dia:=(public.fn_diamond_round_chip_cents(v_price*.5/100,cm.server_seed,'wheel-v3-diamonds:'||v_client||':'||v_nonce)*100)::integer; v_value_chips:=v_prize_dia::numeric/v_rate;
   PERFORM public.fn_diamond_game_pay_diamonds(v_owner,v_user,v_prize_dia,'Diamond Spins: Diamonds','wheel:'||v_spin_id||':prize');
   v_outcome:=v_outcome||jsonb_build_object('amount',v_prize_dia,'value_chips',v_value_chips);
  ELSIF v_pick.kind IN('throwables','time_bank','rabbit_hunt') THEN
   v_feature:=CASE v_pick.kind WHEN 'throwables' THEN 'throwable' WHEN 'time_bank' THEN 'time_bank_seconds' ELSE 'rabbit_hunt' END;
   v_cost:=(public.fn_diamond_round_chip_cents(v_price*.5/100,cm.server_seed,'wheel-v3-consumable:'||v_client||':'||v_nonce)*100)::integer;
   SELECT diamond_cost INTO v_unit FROM public.feature_pricing WHERE feature=v_feature;
   v_uses:=v_cost/v_unit;v_remainder:=v_cost%v_unit;
   v_deduct:=public.add_diamonds_to_balance(v_owner,-v_cost,'deduction',
    'Diamond Spins: '||v_pick.label||' for '||v_user,'wheel:'||v_spin_id||':inventory',NULL);
   IF COALESCE((v_deduct->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'The Owner Reward Debit Failed'; END IF;
   INSERT INTO public.feature_purchases(user_id,feature,cost,usage_type,uses_remaining,source) VALUES(v_user,v_feature,v_uses*v_unit,'per_use',v_uses,'diamond_wheel');
   v_grants:=jsonb_build_array(jsonb_build_object('feature',v_feature,'uses',v_uses));
   IF v_remainder>0 THEN
    INSERT INTO public.feature_purchases(user_id,feature,cost,usage_type,uses_remaining,source) VALUES(v_user,'throwable',v_remainder,'per_use',v_remainder,'diamond_wheel');
    v_grants:=v_grants||jsonb_build_object('feature','throwable','uses',v_remainder);
   END IF;
   v_value_chips:=v_cost::numeric/v_rate;
   v_outcome:=v_outcome||jsonb_build_object('amount',v_uses,'value_chips',v_value_chips,'grants',v_grants);
  ELSE
   v_boost:=CASE WHEN v_pick.kind='upgrade' THEN 2 ELSE 1 END;v_budget:=v_price*v_boost;
   v_cap:=(v_caps->>(v_game||':'||v_boost))::integer;v_hold:=ceil(v_budget::numeric/v_rate*v_cap)/100;
   INSERT INTO public.wheel_bonus_awards(spin_id,user_id,club_id,host_id,host_kind,game,entry_diamonds,boost_multiplier,base_diamonds,cap_cents,reserved_chips)
   VALUES(v_spin_id,v_user,p_club_id,v_host,v_kind,v_game,v_price,v_boost,v_budget,v_cap,v_hold) RETURNING * INTO v_award;
   UPDATE public.diamond_game_pools SET wheel_allocated_diamonds=wheel_allocated_diamonds+v_budget,reserved_chips=reserved_chips+v_hold,updated_at=now() WHERE host_id=v_host AND game=v_game;
   -- The welcome budget reserves the full liability until the awarded round settles.
   v_value_chips:=v_hold;
  END IF;

  -- ── 4. the pool remembers, on the right side of the books ─────────────────
  -- A welcome payout NEVER enters chips_paid. chips_paid is bounded by what the
  -- paid game took in; the welcome is bounded by the budget the host declared.
  -- Two promises, kept apart, both checked below.
  UPDATE public.wheel_pools
     SET spins = spins + CASE WHEN p_welcome THEN 0 ELSE 1 END,
         welcome_spins = welcome_spins + CASE WHEN p_welcome THEN 1 ELSE 0 END,
         intake_diamonds = intake_diamonds + v_dia_now,
         chips_paid = chips_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_chips END,
         welcome_chips_paid = welcome_chips_paid + CASE WHEN p_welcome THEN v_value_chips ELSE 0 END,
         diamond_float = diamond_float + v_dia_now
                       - CASE WHEN p_welcome THEN 0 ELSE v_prize_dia+v_cost END,
         diamonds_paid = diamonds_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,
         -- constrained_spins is a rate over `spins`, and a welcome spin is not
         -- one of those, so counting it here made the operator's lock rate able
         -- to exceed 1 (audit 2026-09-11).
         constrained_spins = constrained_spins
                           + CASE WHEN NOT p_welcome AND jsonb_array_length(v_locked) > 0 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = v_host
   RETURNING * INTO pool;
  IF NOT p_welcome AND pool.chips_paid>pool.intake_diamonds/v_rate+cfg.exposure_allowance_chips THEN RAISE EXCEPTION 'The Wheel Exposure Limit Was Exceeded'; END IF;
  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  IF v_member_after IS NULL THEN
    SELECT COALESCE(m.chip_balance, 0) INTO v_member_after FROM public.club_members m
     WHERE m.club_id = p_club_id AND m.user_id = v_user LIMIT 1;
  END IF;

  v_result:=jsonb_build_object('ok',true,'contract_version',3,'welcome',p_welcome,'daily_bonus',p_mode='daily','bonus_ticket_id',p_bonus_ticket_id,
   'player_cost_diamonds',CASE WHEN p_mode='paid' THEN v_price ELSE 0 END,'entry_value_diamonds',v_price,
   'entry_funded_by',CASE p_mode WHEN 'daily' THEN 'mint' WHEN 'welcome' THEN 'welcome' ELSE 'player' END,
   'spin_id',v_spin_id,'club_id',p_club_id,'host_id',v_host,'segment_version',3,'spin_price_diamonds',CASE WHEN p_welcome THEN 0 ELSE v_price END,
   'diamonds_per_chip',v_rate,'segments',v_segments,'outcome',v_outcome,
   'fairness',jsonb_build_object('commit_id',p_commit_id,'server_seed_hash',cm.server_seed_hash,'server_seed',cm.server_seed,'client_seed',v_client,'nonce',v_nonce,'roll',v_roll,'weight_total',v_total,'eligible_ords',to_jsonb(v_eligible),'locked','[]'::jsonb,'domain','wheel-v3'),
   'balances',jsonb_build_object('diamonds',v_dia_after,'member_chips',v_member_after),'pool',jsonb_build_object('chips_paid',pool.chips_paid,'diamond_float',pool.diamond_float),'created_at',transaction_timestamp());
  IF v_award.id IS NOT NULL THEN v_result:=v_result||jsonb_build_object('bonus',jsonb_build_object('id',v_award.id,'game',v_award.game,'club_id',v_award.club_id,'base_diamonds',v_award.base_diamonds,'entry_diamonds',v_award.entry_diamonds,'boost_multiplier',v_award.boost_multiplier,'cap_cents',v_award.cap_cents)); END IF;
  IF v_secondary IS NOT NULL THEN v_result:=v_result||jsonb_build_object('secondary',v_secondary); END IF;
  INSERT INTO public.wheel_spins
    (id, host_id, host_kind, club_id, user_id, segment_version, spin_price_diamonds, multiplier, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, roll, weight_total, eligible_ords, locked,
     outcome_ord, outcome_kind, outcome_amount, prize_value_chips, chips_minted, diamond_accrual,
     pool_chips_minted_after, pool_chips_paid_after, pool_diamond_float_after, diamonds_after, member_chips_after,
     is_fixture, is_welcome, bonus_ticket_id,receipt_v2)
  VALUES
    (v_spin_id, v_host, v_kind, p_club_id, v_user, 3,
     CASE WHEN p_welcome THEN 0 ELSE v_price END, v_mult, v_rate,
     cm.id, cm.server_seed_hash, cm.server_seed, v_client, v_nonce, v_roll, v_total, v_eligible, v_locked,
     v_pick.ord, v_pick.kind, (v_outcome->>'amount')::numeric, v_value_chips, 0, v_dia_now,
     pool.chips_minted, pool.chips_paid, pool.diamond_float, v_dia_after, v_member_after,
     v_is_fixture, p_welcome, p_bonus_ticket_id,v_result)
  RETURNING * INTO prior;
  UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;

  IF p_bonus_ticket_id IS NOT NULL THEN
    UPDATE public.diamond_bonus_spin_tickets SET redeemed_spin_id=v_spin_id,redeemed_at=transaction_timestamp()
     WHERE id=p_bonus_ticket_id;
  END IF;
  RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', false);
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_wheel_state_v2(p_club_id uuid, p_entry_diamonds integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE s jsonb;h uuid;k text;cfg public.wheel_configs;gcfg public.diamond_game_configs;gp public.diamond_game_pools;
 rate integer;cover numeric;held numeric;owner uuid;owner_diamonds numeric;room numeric;v_game text;boost integer;cap integer;funded boolean:=true;reason text;awards jsonb;welcome boolean;max_funded integer;headroom numeric;minimum_cap integer;welcome_funded boolean:=true;welcome_cap integer;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Spin'); END IF;
 IF p_entry_diamonds IS NULL OR p_entry_diamonds NOT BETWEEN 25 AND 2500 THEN RETURN jsonb_build_object('ok',false,'error','Choose 25 To 2,500 Diamonds'); END IF;
 IF NOT public.fn_wheel_v2_enabled() THEN RETURN jsonb_build_object('ok',true,'contract_version',3,'enabled',false); END IF;
 s:=public.fn_wheel_state(p_club_id);
 IF s->>'ok' IS DISTINCT FROM 'true' THEN RETURN s; END IF;
 SELECT host_id,host_kind INTO h,k FROM public.fn_wheel_host(p_club_id);
 SELECT * INTO cfg FROM public.wheel_configs WHERE host_id=h;
 IF NOT FOUND THEN RETURN s||jsonb_build_object('contract_version',3,'enabled',true); END IF;
 rate:=public.fn_ca_bridge_rate();cover:=public.fn_diamond_game_cover(h,k);
 SELECT COALESCE(sum(reserved_chips),0) INTO held FROM public.diamond_game_pools WHERE host_id=h;
 owner:=public.fn_diamond_game_owner(h,k);SELECT COALESCE(diamonds,0) INTO owner_diamonds FROM public.profiles WHERE id=owner;
 max_funded:=GREATEST(0,LEAST(2500,floor((cover-held)*rate/100),floor((cfg.exposure_allowance_chips+COALESCE((s#>>'{pool,intake_diamonds}')::numeric,0)/rate-COALESCE((s#>>'{pool,chips_paid}')::numeric,0))*rate/99)))::integer;
 room:=cfg.welcome_budget_chips-public.fn_wheel_v2_welcome_spent(h);
 IF NOT public.fn_diamond_spins_owner_agreed(h,k) THEN funded:=false;welcome_funded:=false;reason:='The Host Wallet Owner Must Accept Diamond Spins Before Play Opens'; END IF;
 IF cover-held<ceil(p_entry_diamonds::numeric/rate*100*100)/100 OR COALESCE(owner_diamonds,0)+p_entry_diamonds<ceil(p_entry_diamonds*.5) OR COALESCE((s#>>'{pool,diamond_float}')::numeric,0)+p_entry_diamonds<ceil(p_entry_diamonds*.5) THEN funded:=false;reason:='The Host Must Fund Every Prize Before A Spin'; END IF;
 IF COALESCE((s#>>'{pool,chips_paid}')::numeric,0)+ceil(100*p_entry_diamonds::numeric/rate*100)/100>round((COALESCE((s#>>'{pool,intake_diamonds}')::numeric,0)+p_entry_diamonds)/rate,2)+cfg.exposure_allowance_chips THEN funded:=false;reason:='The Host Must Fund Every Prize Before A Spin'; END IF;
 FOR v_game IN SELECT unnest(ARRAY['crash','crossing','mines','plinko']) LOOP
  SELECT * INTO gcfg FROM public.diamond_game_configs WHERE host_id=h AND game=v_game;
  SELECT * INTO gp FROM public.diamond_game_pools WHERE host_id=h AND game=v_game;
  IF gcfg.host_id IS NULL OR NOT gcfg.enabled OR ((public.fn_ca_is_fixture_account(auth.uid()) OR public.fn_ca_is_cert_account(auth.uid())) AND NOT gcfg.allow_fixture_accounts) OR EXISTS(SELECT 1 FROM public.ca_payout_freeze WHERE scope=v_game AND cleared_at IS NULL) THEN funded:=false;welcome_funded:=false;max_funded:=0;reason:='Every Bonus Game Must Be Open Before A Spin';
  ELSE
   headroom:=(COALESCE(gp.intake_diamonds,0)+COALESCE(gp.wheel_allocated_diamonds,0))::numeric/rate+gcfg.exposure_allowance_chips-COALESCE(gp.chips_paid,0)-COALESCE(gp.reserved_chips,0);
   FOR boost IN 1..2 LOOP
    minimum_cap:=2000*(boost+1)/boost;
    welcome_cap:=LEAST(public.fn_diamond_game_cap_cents(gcfg,gp,cover,100*boost::numeric/rate,gcfg.max_multiplier_cents),floor(room/(100*boost::numeric/rate)*100)::integer);
    IF welcome_cap<minimum_cap THEN welcome_funded:=false; END IF;
    IF gcfg.max_multiplier_cents<minimum_cap THEN max_funded:=0;
    ELSE max_funded:=LEAST(max_funded,GREATEST(0,floor(rate*gcfg.cap_fraction*headroom/(minimum_cap::numeric/100-gcfg.cap_fraction)/boost))::integer); END IF;
    cap:=public.fn_diamond_game_cap_cents(gcfg,gp,cover,p_entry_diamonds*boost::numeric/rate,gcfg.max_multiplier_cents);
    IF cap<2000*(boost+1)/boost THEN funded:=false;reason:='The Host Must Fund Every Bonus Before A Spin'; END IF;
   END LOOP;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.plinko_tables WHERE activated_at IS NOT NULL AND max_multiplier_cents<=2000) THEN
  funded:=false;welcome_funded:=false;max_funded:=0;reason:='An Approved Plinko Table Must Be Open Before A Spin'; END IF;
 IF EXISTS(SELECT 1 FROM (VALUES('throwable',1),('rabbit_hunt',5),('time_bank_seconds',5)) expected(feature,cost)
  LEFT JOIN public.feature_pricing actual ON actual.feature=expected.feature
  WHERE actual.feature IS NULL OR actual.diamond_cost<>expected.cost OR actual.usage_type<>'per_use') THEN
  funded:=false;welcome_funded:=false;max_funded:=0;reason:='The Reward Prices Changed. The Wheel Must Be Requalified'; END IF;
 SELECT COALESCE(jsonb_agg(public.fn_wheel_bonus_public_award(a,false) ORDER BY a.created_at),'[]') INTO awards FROM public.wheel_bonus_awards a WHERE a.user_id=auth.uid() AND a.club_id=p_club_id AND a.status='pending';
 room:=cfg.welcome_budget_chips-public.fn_wheel_v2_welcome_spent(h);
 welcome:=cfg.enabled AND welcome_funded AND cfg.welcome_spin_enabled AND owner IS DISTINCT FROM auth.uid() AND room>=100*100::numeric/rate AND cover-held>=100*100::numeric/rate AND owner_diamonds>=50
  AND NOT EXISTS(SELECT 1 FROM public.wheel_spins WHERE host_id=h AND user_id=auth.uid() AND is_welcome);
 s:=jsonb_set(s,'{config}',(s->'config')-ARRAY['spec_rtp','chip_share','diamond_share','house_share','hit_rate']||jsonb_build_object('spin_price_diamonds',p_entry_diamonds,'spin_price_chips',p_entry_diamonds::numeric/rate,'segment_version',3,'multiplier',1,'min_entry',25,'max_entry',2500));
 RETURN s||jsonb_build_object('contract_version',3,'enabled',true,'available',COALESCE(cfg.enabled,false) AND funded,'reason',reason,
  'min_entry',25,'max_entry',2500,'max_funded_entry',max_funded,'segments',public.fn_wheel_v3_segments(p_entry_diamonds,rate),'upgrade_segments',public.fn_wheel_v3_segments(p_entry_diamonds,rate,true),'awards',awards,
  'welcome',jsonb_build_object('available',welcome,'eligible',welcome,'entry_diamonds',100));
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NULLIF(current_setting('app.ledger_maintenance', true), '') IS NOT NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_TABLE_NAME = 'crash_rounds' AND TG_OP = 'UPDATE' AND OLD.status = 'open' THEN
    IF NEW.minimum_payout_chips IS DISTINCT FROM OLD.minimum_payout_chips THEN
      RAISE EXCEPTION 'The Bonus Minimum Is Fixed When The Round Starts' USING ERRCODE='integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only: a settled round is a fact and is never edited or deleted', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $function$
;
COMMIT;
