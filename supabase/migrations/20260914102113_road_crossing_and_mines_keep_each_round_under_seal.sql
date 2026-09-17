-- Version reserved by scripts/new-migration.mjs.
-- New choice games share the existing diamond transfer and host prize doors.
-- No result is selected by a browser. A started round keeps its board, limit,
-- commitment, and reserves until it is settled. No polling job is required.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';
ALTER TABLE public.diamond_game_configs DROP CONSTRAINT diamond_game_configs_game_check;
ALTER TABLE public.diamond_game_configs ADD CONSTRAINT diamond_game_configs_game_check CHECK (game IN ('plinko','crash','crossing','mines'));
ALTER TABLE public.diamond_game_commits DROP CONSTRAINT diamond_game_commits_game_check;
ALTER TABLE public.diamond_game_commits ADD CONSTRAINT diamond_game_commits_game_check CHECK (game IN ('plinko','crash','crossing','mines'));

CREATE TABLE public.diamond_choice_rounds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 host_id uuid NOT NULL, host_kind text NOT NULL, club_id uuid NOT NULL, user_id uuid NOT NULL,
 game text NOT NULL CHECK (game IN ('crossing','mines')),
 mode text NOT NULL, bet_diamonds integer NOT NULL CHECK (bet_diamonds > 0),
 bet_chips numeric(14,2) NOT NULL CHECK (bet_chips > 0), diamonds_per_chip integer NOT NULL,
 commit_id uuid NOT NULL UNIQUE REFERENCES public.diamond_game_commits(id),
 server_seed text NOT NULL, server_seed_hash text NOT NULL, client_seed text NOT NULL, nonce bigint NOT NULL,
 mine_cells integer[] NOT NULL DEFAULT '{}', road_roll bigint NOT NULL DEFAULT 0,
 picked integer[] NOT NULL DEFAULT '{}',
 max_steps integer NOT NULL CHECK (max_steps BETWEEN 1 AND 20),
 prizes numeric[] NOT NULL, reserved_chips numeric(14,2) NOT NULL CHECK (reserved_chips >= 0),
 is_fixture boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','cashed','lost')),
 payout_chips numeric(14,2) NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
 FOREIGN KEY (host_id, game) REFERENCES public.diamond_game_configs(host_id, game)
);
CREATE UNIQUE INDEX diamond_choice_one_open ON public.diamond_choice_rounds(host_id,user_id,game) WHERE status='open';
CREATE INDEX diamond_choice_history ON public.diamond_choice_rounds(user_id,host_id,game,created_at DESC);
ALTER TABLE public.diamond_choice_rounds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.diamond_choice_rounds FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE ON public.diamond_choice_rounds TO service_role;
COMMENT ON TABLE public.diamond_choice_rounds IS 'Private fixed boards and road outcomes. Browser access only through owner-scoped RPCs. Seeds and hidden cells remain sealed until settlement.';

CREATE FUNCTION public.fn_choice_choose(n integer,k integer) RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE v numeric:=1; i integer;
BEGIN
 IF k<0 OR k>n THEN RETURN 0; END IF;
 FOR i IN 1..LEAST(k,n-k) LOOP v:=v*(n-i+1)/i; END LOOP;
 RETURN round(v);
END $$;
CREATE FUNCTION public.fn_choice_ladder(p_mode text) RETURNS integer[] LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT CASE p_mode
 WHEN 'steady' THEN ARRAY[110,135,170,215,275,355,460,600,800,1100,1600,2400]
 WHEN 'bold' THEN ARRAY[150,220,330,500,800,1300,2200,4000,7500,15000]
 WHEN 'extreme' THEN ARRAY[200,400,800,1600,3200,6400,12800,25600] END
$$;
CREATE FUNCTION public.fn_choice_prizes(p_game text,p_mode text,p_bet numeric) RETURNS numeric[] LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE out numeric[]:='{}'; ladder integer[]; m integer; k integer;
BEGIN
 IF p_game='crossing' THEN
  ladder:=public.fn_choice_ladder(p_mode);
  IF ladder IS NULL THEN RAISE EXCEPTION 'Choose A Road Difficulty'; END IF;
  FOR k IN 1..cardinality(ladder) LOOP out:=array_append(out,p_bet*ladder[k]/100); END LOOP;
 ELSIF p_game='mines' AND p_mode IN ('5','10','15') THEN
  m:=p_mode::integer;
  FOR k IN 1..25-m LOOP out:=array_append(out,p_bet*0.8*public.fn_choice_choose(25,k)/public.fn_choice_choose(25-m,k)); END LOOP;
 ELSE RAISE EXCEPTION 'Choose A Game Setting'; END IF;
 RETURN out;
END $$;
CREATE FUNCTION public.fn_choice_board(p_server text,p_client text,p_nonce bigint,p_mines integer) RETURNS integer[] LANGUAGE plpgsql IMMUTABLE SET search_path=public,extensions AS $$
DECLARE cells integer[]:=ARRAY(SELECT generate_series(0,24)); i integer; j integer; temp integer; cursor integer:=0; v bigint; lim bigint; out integer[];
BEGIN
 IF p_mines NOT IN (5,10,15) THEN RAISE EXCEPTION 'Choose A Mine Count'; END IF;
 FOR i IN REVERSE 25..2 LOOP
  lim:=(4294967296::bigint/i)*i;
  LOOP
   v:=('x'||substr(encode(extensions.hmac(p_client||':'||p_nonce||':board:'||cursor,p_server,'sha256'),'hex'),1,8))::bit(32)::bigint;
   cursor:=cursor+1; EXIT WHEN v<lim;
  END LOOP;
  j:=(v%i)::integer+1; temp:=cells[i]; cells[i]:=cells[j]; cells[j]:=temp;
 END LOOP;
 SELECT array_agg(x ORDER BY x) INTO out FROM unnest(cells[1:p_mines]) x;
 RETURN out;
END $$;
CREATE FUNCTION public.fn_choice_result(r public.diamond_choice_rounds) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT jsonb_build_object('ok',true,'id',r.id,'game',r.game,'club_id',r.club_id,'status',r.status,'mode',r.mode,
 'bet_diamonds',r.bet_diamonds,'bet_chips',r.bet_chips,'picked',to_jsonb(r.picked),'max_steps',r.max_steps,
 'prizes',to_jsonb(r.prizes),'payout_chips',r.payout_chips,'server_seed_hash',r.server_seed_hash,
 'client_seed',r.client_seed,'nonce',r.nonce,'commit_id',r.commit_id,
 'diamonds_per_chip',r.diamonds_per_chip,'proof',CASE WHEN r.status<>'open' THEN jsonb_build_object('game',r.game,'server_seed',r.server_seed,
 'server_seed_hash',r.server_seed_hash,'client_seed',r.client_seed,'nonce',r.nonce,
 'mines',CASE WHEN r.game='mines' THEN r.mode::integer ELSE 0 END,'mine_cells',to_jsonb(r.mine_cells),'road_roll',r.road_roll::text) END)
$$;

CREATE FUNCTION public.fn_choice_start(p_club_id uuid,p_game text,p_mode text,p_bet integer,p_commit_id uuid,p_client_seed text,p_max_steps integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
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
 UPDATE public.diamond_game_pools SET rounds=rounds+1,intake_diamonds=intake_diamonds+p_bet,
  reserved_chips=reserved_chips+v_reserve,updated_at=now() WHERE host_id=adm.o_host AND game=p_game;
 UPDATE public.diamond_game_commits SET consumed_by=v_id WHERE id=p_commit_id;
 INSERT INTO public.diamond_choice_rounds(id,host_id,host_kind,club_id,user_id,game,mode,bet_diamonds,bet_chips,diamonds_per_chip,
  commit_id,server_seed,server_seed_hash,client_seed,nonce,mine_cells,road_roll,max_steps,prizes,reserved_chips,is_fixture)
 VALUES(v_id,adm.o_host,adm.o_kind,p_club_id,v_user,p_game,p_mode,p_bet,adm.o_bet_chips,adm.o_rate,p_commit_id,
  (adm.o_commit).server_seed,(adm.o_commit).server_seed_hash,p_client_seed,adm.o_nonce,v_cells,v_roll,p_max_steps,v_prizes,v_reserve,adm.o_fixture) RETURNING * INTO r;
 RETURN public.fn_choice_result(r);
END $$;

CREATE FUNCTION public.fn_choice_act(p_round_id uuid,p_action text,p_cell integer,p_expected_step integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
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
  ELSE safe:=(r.road_roll::numeric+1)*(public.fn_choice_ladder(r.mode))[n+1] <= 80::numeric*281474976710656; END IF;
  r.picked:=array_append(r.picked,p_cell); n:=n+1;
  IF NOT safe THEN r.status:='lost';
  ELSIF n=r.max_steps THEN r.status:='cashed'; END IF;
 ELSIF p_action='cashout' AND n>0 THEN r.status:='cashed';
 ELSE RETURN jsonb_build_object('ok',false,'error','Make Your First Move Before Cashing Out'); END IF;
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
  UPDATE public.diamond_game_pools SET reserved_chips=reserved_chips-r.reserved_chips,
   chips_paid=chips_paid+v_pay,updated_at=now() WHERE host_id=r.host_id AND game=r.game;
  IF v_pay>0 THEN
   PERFORM public.fn_diamond_game_pay_chips('promo',r.host_id,r.host_kind,r.club_id,r.user_id,v_pay,'choice-prize:'||r.id,
    'Diamond Game Prize',jsonb_build_object('game',r.game,'round_id',r.id,'host_id',r.host_id));
  END IF;
 END IF;
 UPDATE public.diamond_choice_rounds SET picked=r.picked,status=r.status,payout_chips=v_pay,
  settled_at=CASE WHEN r.status<>'open' THEN clock_timestamp() END WHERE id=r.id RETURNING * INTO r;
 RETURN public.fn_choice_result(r);
END $$;

CREATE FUNCTION public.fn_choice_state(p_club_id uuid,p_game text,p_mode text,p_bet integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
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
  prizes:=public.fn_choice_prizes(p_game,p_mode,p_bet::numeric/rate);
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
END $$;

-- Consent follows the wallet owner, not whichever administrator opens a club.
CREATE TABLE public.diamond_spins_owner_consents (
 host_id uuid NOT NULL,
 owner_id uuid NOT NULL,
 host_kind text NOT NULL CHECK(host_kind IN ('club','union')),
 terms_version text NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 terms_text text NOT NULL,
 PRIMARY KEY(host_id,owner_id,terms_version)
);
ALTER TABLE public.diamond_spins_owner_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.diamond_spins_owner_consents FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.diamond_spins_owner_consents TO service_role;
CREATE FUNCTION public.fn_diamond_spins_consent_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN RAISE EXCEPTION 'An Owner Agreement Is A Permanent Receipt' USING ERRCODE='integrity_constraint_violation'; END $$;
REVOKE ALL ON FUNCTION public.fn_diamond_spins_consent_immutable() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spins_consent_immutable() TO service_role;
CREATE TRIGGER diamond_spins_consent_immutable BEFORE UPDATE OR DELETE ON public.diamond_spins_owner_consents
 FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_spins_consent_immutable();

CREATE FUNCTION public.fn_diamond_spins_owner_agreed(p_host uuid,p_kind text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.diamond_spins_owner_consents c
  WHERE c.host_id=p_host AND c.host_kind=p_kind
   AND c.owner_id=public.fn_diamond_game_owner(p_host,p_kind)
   AND c.terms_version='diamond-spins-2026-09-14-v1');
$$;

CREATE FUNCTION public.fn_diamond_spins_owner_terms(p_club_id uuid,p_agree boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE h uuid; k text; v_owner uuid; receipt public.diamond_spins_owner_consents;
 terms text:='I Authorize Diamond Spins For This Host. Player Diamond Entries Go To My Owner Diamond Wallet. Chip Prizes Use The BBJ-Funded Promo Wallet First, With The Union Main Bank Covering Any Shortfall, Or The Club Main Bank For A Standalone Club. My Owner Diamond Wallet Pays For Awarded Throwables, Time Banks, Rabbit Hunts, Eligible One-Day VIP Cards, And VIP Diamond Multiplier Rewards At Their Recorded Diamond Cost. A Reward Must Be Funded Before It Is Awarded.';
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In First'); END IF;
 SELECT host_id,host_kind INTO h,k FROM public.fn_wheel_host(p_club_id);
 IF h IS NULL THEN RETURN jsonb_build_object('ok',false,'error','That Club Could Not Be Found'); END IF;
 v_owner:=public.fn_diamond_game_owner(h,k);
 IF v_owner IS NULL THEN RETURN jsonb_build_object('ok',false,'error','The Host Wallet Owner Is Not Set'); END IF;
 IF auth.uid() IS DISTINCT FROM v_owner AND NOT public.fn_wheel_can_operate(h,k,auth.uid()) THEN
  RETURN jsonb_build_object('ok',false,'error','Only This Host Can Read Its Agreement'); END IF;
 IF p_agree IS TRUE THEN
  IF auth.uid() IS DISTINCT FROM v_owner THEN
   RETURN jsonb_build_object('ok',false,'error','The Wallet Owner Must Accept This Agreement'); END IF;
  INSERT INTO public.diamond_spins_owner_consents(host_id,host_kind,owner_id,terms_version,terms_text)
   VALUES(h,k,v_owner,'diamond-spins-2026-09-14-v1',terms) ON CONFLICT DO NOTHING;
 END IF;
 SELECT * INTO receipt FROM public.diamond_spins_owner_consents c WHERE c.host_id=h
  AND c.owner_id=v_owner AND c.terms_version='diamond-spins-2026-09-14-v1';
 RETURN jsonb_build_object('ok',true,'host_id',h,'host_kind',k,'is_owner',auth.uid()=v_owner,
  'accepted',receipt.host_id IS NOT NULL,'accepted_at',receipt.accepted_at,'terms',terms,
  'terms_version','diamond-spins-2026-09-14-v1');
END $$;
REVOKE ALL ON FUNCTION public.fn_diamond_spins_owner_agreed(uuid,text),public.fn_diamond_spins_owner_terms(uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spins_owner_agreed(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spins_owner_terms(uuid,boolean) TO authenticated,service_role;


CREATE OR REPLACE FUNCTION public.fn_diamond_game_commit(p_game text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_seed text; v_hash text; v_id uuid; v_exp timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Play');
  END IF;
  IF p_game IS NULL OR p_game NOT IN ('plinko', 'crash', 'crossing', 'mines') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Game Does Not Exist');
  END IF;
  DELETE FROM public.diamond_game_commits WHERE user_id = v_user AND game = p_game AND consumed_by IS NULL;
  v_seed := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(v_seed, 'sha256'), 'hex');
  INSERT INTO public.diamond_game_commits (user_id, game, server_seed, server_seed_hash)
  VALUES (v_user, p_game, v_seed, v_hash) RETURNING id, expires_at INTO v_id, v_exp;
  RETURN jsonb_build_object('ok', true, 'commit_id', v_id, 'server_seed_hash', v_hash, 'expires_at', v_exp);
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_diamond_game_admit(p_game text, p_club_id uuid, p_commit_id uuid, p_client_seed text, p_bet integer, OUT err jsonb, OUT o_host uuid, OUT o_kind text, OUT o_cfg diamond_game_configs, OUT o_pool diamond_game_pools, OUT o_bank numeric, OUT o_promo numeric, OUT o_bank_only numeric, OUT o_rate integer, OUT o_bet_chips numeric, OUT o_owner uuid, OUT o_nonce bigint, OUT o_commit diamond_game_commits, OUT o_diamonds numeric, OUT o_fixture boolean)
 RETURNS record
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_today integer; v_last timestamptz;
  v_purchased integer; v_spendable integer;
  v_label text := CASE p_game WHEN 'plinko' THEN 'Diamond Plinko' WHEN 'crash' THEN 'Diamond Crash' WHEN 'mines' THEN 'Diamond Mines' ELSE 'Road Crossing' END;
BEGIN
  err := NULL;
  IF v_user IS NULL THEN
    err := jsonb_build_object('ok', false, 'error', 'Sign In To Play'); RETURN;
  END IF;
  SELECT h.host_id, h.host_kind INTO o_host, o_kind FROM public.fn_wheel_host(p_club_id) h;
  IF o_host IS NULL THEN
    err := jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found'); RETURN;
  END IF;
  o_rate := public.fn_ca_bridge_rate();
  IF o_rate IS NULL OR o_rate <= 0 THEN
    err := jsonb_build_object('ok', false, 'error', 'The Bridge Rate Is Not Set'); RETURN;
  END IF;
  IF length(COALESCE(p_client_seed, '')) < 1 THEN
    err := jsonb_build_object('ok', false, 'error', 'A Client Seed Is Required'); RETURN;
  END IF;
  IF public.fn_platform_frozen() THEN
    err := jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Play Again In A Few Minutes'); RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = p_game AND f.cleared_at IS NULL) THEN
    err := jsonb_build_object('ok', false, 'error', v_label || ' Is Paused'); RETURN;
  END IF;

  SELECT * INTO o_cfg FROM public.diamond_game_configs c WHERE c.host_id = o_host AND c.game = p_game FOR UPDATE;
  IF o_cfg.host_id IS NULL OR NOT o_cfg.enabled THEN
    err := jsonb_build_object('ok', false, 'error', v_label || ' Is Not Open Here'); RETURN;
  END IF;
  INSERT INTO public.diamond_game_pools (host_id, game) VALUES (o_host, p_game) ON CONFLICT (host_id, game) DO NOTHING;
  IF p_game = 'crash' THEN
    PERFORM public.fn_crash_settle_decided(o_host);
  END IF;
  SELECT * INTO o_pool FROM public.diamond_game_pools p WHERE p.host_id = o_host AND p.game = p_game FOR UPDATE;

  IF p_bet IS NULL OR p_bet < 25 OR p_bet > 5000 OR (p_bet > 2500 AND NOT EXISTS (SELECT 1 FROM public.diamond_bonus_entries e WHERE e.commit_id=p_commit_id AND e.user_id=v_user AND e.game=p_game AND e.club_id=p_club_id AND e.total_diamonds=p_bet AND e.added_diamonds=e.base_diamonds AND e.result IS NULL)) THEN
    err := jsonb_build_object('ok', false, 'error',
      'Choose 25 To 2,500 Diamonds, With One Optional Double Down'); RETURN;
  END IF;
  o_bet_chips := round(p_bet::numeric / o_rate, 2);
  o_owner := public.fn_diamond_game_owner(o_host, o_kind);
  IF o_owner IS NULL THEN
    err := jsonb_build_object('ok', false, 'error', 'This Host Has No Owner Wallet To Pay'); RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.diamond_spins_owner_consents consent WHERE consent.host_id=o_host AND consent.host_kind=o_kind AND consent.owner_id=o_owner AND consent.terms_version='diamond-spins-2026-09-14-v1') THEN err:=jsonb_build_object('ok',false,'error','The Host Wallet Owner Must Accept Diamond Spins Before Play Opens'); RETURN; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = v_user
                    AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
    err := jsonb_build_object('ok', false, 'error', 'Join The Club Before You Play'); RETURN;
  END IF;
  o_fixture := public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user);
  IF o_fixture AND NOT o_cfg.allow_fixture_accounts THEN
    err := jsonb_build_object('ok', false, 'error', 'Certification Accounts Do Not Play This Game'); RETURN;
  END IF;
  SELECT * INTO o_commit FROM public.diamond_game_commits c
   WHERE c.id = p_commit_id AND c.user_id = v_user AND c.game = p_game AND c.consumed_by IS NULL FOR UPDATE;
  IF o_commit.id IS NULL THEN
    err := jsonb_build_object('ok', false, 'error', 'That Ticket Is Not Yours Or Was Already Used. Open The Game Again'); RETURN;
  END IF;
  IF o_commit.expires_at < now() THEN
    err := jsonb_build_object('ok', false, 'error', 'That Ticket Expired. Open The Game Again'); RETURN;
  END IF;

  IF p_game IN ('crossing','mines') THEN
    SELECT count(*)::integer, max(c.created_at) INTO v_today, v_last
      FROM public.diamond_choice_rounds c WHERE c.user_id=v_user AND c.host_id=o_host AND c.game=p_game
      AND (c.created_at AT TIME ZONE 'America/Chicago')::date=(now() AT TIME ZONE 'America/Chicago')::date;
    SELECT count(*)+1 INTO o_nonce FROM public.diamond_choice_rounds c WHERE c.user_id=v_user AND c.game=p_game;
  ELSIF p_game = 'plinko' THEN
    SELECT count(*)::integer, max(d.created_at) INTO v_today, v_last
      FROM public.plinko_drops d
     WHERE d.user_id = v_user AND d.host_id = o_host
       AND (d.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
    SELECT count(*) + 1 INTO o_nonce FROM public.plinko_drops d WHERE d.user_id = v_user;
  ELSE
    SELECT count(*)::integer, max(c.created_at) INTO v_today, v_last
      FROM public.crash_rounds c
     WHERE c.user_id = v_user AND c.host_id = o_host
       AND (c.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
    SELECT count(*) + 1 INTO o_nonce FROM public.crash_rounds c WHERE c.user_id = v_user;
  END IF;
  SELECT v_today+count(*)::integer,GREATEST(v_last,max(e.created_at)) INTO v_today,v_last
    FROM public.diamond_bonus_entries e WHERE e.user_id=v_user AND e.host_id=o_host AND e.game='plinko' AND p_game='plinko'
      AND e.result IS NOT NULL AND (e.created_at AT TIME ZONE 'America/Chicago')::date=(now() AT TIME ZONE 'America/Chicago')::date;
  IF p_game='plinko' THEN SELECT o_nonce+count(*) INTO o_nonce FROM public.diamond_bonus_entries e WHERE e.user_id=v_user AND e.game='plinko' AND e.result IS NOT NULL; END IF;
  IF v_today >= o_cfg.max_rounds_per_player_per_day THEN
    err := jsonb_build_object('ok', false, 'error', format('You Have Reached Today''s Limit Of %s Rounds', o_cfg.max_rounds_per_player_per_day)); RETURN;
  END IF;
  IF v_last IS NOT NULL AND now() - v_last < make_interval(secs => o_cfg.min_seconds_between_rounds) THEN
    err := jsonb_build_object('ok', false, 'error', 'One Moment Between Rounds'); RETURN;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO o_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN o_cfg.purchased_only THEN LEAST(o_diamonds, v_purchased)::integer ELSE o_diamonds::integer END;
  IF v_spendable < p_bet THEN
    err := jsonb_build_object('ok', false,
      'error', CASE WHEN o_cfg.purchased_only AND o_diamonds >= p_bet
                    THEN 'This Game Takes Purchased Diamonds Only'
                    ELSE 'Not Enough Diamonds For That Bet' END,
      'diamonds', o_diamonds, 'spendable', v_spendable, 'bet_diamonds', p_bet); RETURN;
  END IF;

  -- The host's PROMO wallet pays first and its own chip bank stands behind it
  -- (Dan 2026-09-10: "the back up is the union or club main bank, if the promo
  -- pool runs dry"). Both are on one row per host shape, so one lock takes the
  -- pair, and o_bank - the figure every cap and gate in these games is measured
  -- against - is the two together.
  SELECT c.o_promo, c.o_bank, c.o_cover
    INTO o_promo, o_bank_only, o_bank
    FROM public.fn_diamond_game_cover_lock(o_host, o_kind) c;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_diamond_game_cap_cents(p_cfg diamond_game_configs, p_pool diamond_game_pools, p_bank numeric, p_bet_chips numeric, p_ceiling_cents integer)
 RETURNS integer
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'public'
AS $function$
DECLARE
  -- THE HOST IS THE HOUSE (Dan 2026-09-10). Nothing is minted any more: the bet's
  -- diamonds go to the host's owner, and the prize comes out of the host's PROMO
  -- wallet (p_bank is that wallet now). The law "never pay out more than taken in"
  -- is kept as arithmetic on what was taken in: paid + reserved may not exceed the
  -- chip value of every diamond the game has taken (plus this bet) plus the host's
  -- allowance, and the promo wallet must hold the prize.
  v_intake numeric := COALESCE(p_pool.intake_diamonds, 0) / public.fn_ca_bridge_rate() + p_bet_chips;
  v_headroom numeric; v_bank_room numeric; v_cap numeric;
BEGIN
  v_headroom  := v_intake + p_cfg.exposure_allowance_chips
               - COALESCE(p_pool.chips_paid, 0) - COALESCE(p_pool.reserved_chips, 0);
  v_bank_room := COALESCE(p_bank, 0) - COALESCE((SELECT sum(p.reserved_chips) FROM public.diamond_game_pools p WHERE p.host_id=p_cfg.host_id),0);
  v_cap := LEAST(p_ceiling_cents::numeric,
                 floor(p_cfg.cap_fraction * v_headroom / p_bet_chips * 100),
                 floor(v_bank_room / p_bet_chips * 100));
  RETURN GREATEST(0, v_cap)::integer;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_plinko_drop(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_table_version integer, p_bet_diamonds integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  prior public.plinko_drops;
  adm record;
  t public.plinko_tables%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_hmac bytea; v_path integer := 0; v_slot integer := 0; i integer;
  v_cap integer; v_table_mult integer; v_mult integer; v_payout numeric;
  v_deduct jsonb; v_bank numeric; v_member_after numeric; v_bank_after numeric;
  v_intake_chips numeric;
  v_dia_after numeric;
  pool public.diamond_game_pools%ROWTYPE;
  d public.plinko_drops;
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
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Drop');
  END IF;
  SELECT * INTO prior FROM public.plinko_drops WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Drop Belongs To Another Player');
    END IF;
    RETURN public.fn_plinko_drop_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO adm FROM public.fn_diamond_game_admit('plinko', p_club_id, p_commit_id, p_client_seed, p_bet_diamonds);
  IF adm.err IS NOT NULL THEN RETURN adm.err; END IF;

  SELECT * INTO t FROM public.plinko_tables WHERE version = p_table_version AND activated_at IS NOT NULL;
  IF t.version IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Plinko Table Is Not Active');
  END IF;

  -- ── the cap, before the ball drops ─────────────────────────────────────────
  v_cap := public.fn_diamond_game_cap_cents(adm.o_cfg, adm.o_pool, adm.o_bank, adm.o_bet_chips, LEAST(t.max_multiplier_cents, (adm.o_cfg).max_multiplier_cents));
  IF v_cap < t.max_multiplier_cents THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Club Cannot Cover A Win At That Bet Right Now. Try A Smaller Bet',
                              'cap_cents', v_cap);
  END IF;

  -- ── the roll: sixteen bits, one per row ────────────────────────────────────
  v_hmac := extensions.hmac(convert_to(p_client_seed || ':' || adm.o_nonce::text, 'UTF8'),
                            convert_to((adm.o_commit).server_seed, 'UTF8'), 'sha256');
  FOR i IN 0..15 LOOP
    IF get_bit(v_hmac, i) = 1 THEN
      v_path := v_path | (1 << i);
      v_slot := v_slot + 1;
    END IF;
  END LOOP;
  v_table_mult := t.multipliers_cents[v_slot + 1];
  v_mult := v_table_mult;
  v_payout := public.fn_diamond_round_chip_cents(adm.o_bet_chips * v_mult / 100, (adm.o_commit).server_seed, p_client_seed || ':' || adm.o_nonce || ':rounding');

  -- ── 1. the bet is paid for, and the host's owner is paid it ────────────────
  v_deduct := public.fn_diamond_game_take_bet(v_user, p_bet_diamonds, (adm.o_cfg).purchased_only, 'plinko_drop',
                format('Diamond Plinko Drop (%s Diamonds, %s)', p_bet_diamonds, t.name),
                'plinko:' || v_id::text,
                jsonb_build_object('drop_id', v_id, 'club_id', p_club_id, 'host_id', adm.o_host,
                                   'commit_id', p_commit_id, 'table_version', t.version),
                adm.o_owner,
                format('Diamond Plinko Intake (%s Diamonds)', p_bet_diamonds));
  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For That Bet', 'detail', v_deduct->>'error');
  END IF;

  -- ── 2. nothing is minted: the prize comes out of the promo wallet ──────────
  v_bank := adm.o_bank;

  -- ── 3. the payout ──────────────────────────────────────────────────────────
  IF v_payout > 0 THEN
    IF v_bank < v_payout THEN
      RAISE EXCEPTION 'fn_plinko_drop: host bank % below the payout % after the cap passed', v_bank, v_payout;
    END IF;
    SELECT x.bank_after, x.member_after INTO v_bank_after, v_member_after
      FROM public.fn_diamond_game_prize_leg('plinko', adm.o_host, adm.o_kind, p_club_id, v_user, v_payout,
             'plinko-prize:' || v_id::text,
             format('Diamond Plinko: %s.%sx on %s', v_mult / 100, lpad((v_mult % 100)::text, 2, '0'), t.name),
             jsonb_build_object('drop_id', v_id, 'host_id', adm.o_host, 'host_kind', adm.o_kind,
                                'table_version', t.version, 'slot', v_slot, 'multiplier_cents', v_mult, 'capped', v_mult < v_table_mult)) x;
  ELSE
    SELECT COALESCE(cm.chip_balance, 0) INTO v_member_after FROM public.club_members cm
     WHERE cm.club_id = p_club_id AND cm.user_id = v_user LIMIT 1;
  END IF;

  -- ── 4. the pool remembers ──────────────────────────────────────────────────
  UPDATE public.diamond_game_pools
     SET rounds = rounds + 1,
         intake_diamonds = intake_diamonds + p_bet_diamonds,
         chips_paid = chips_paid + v_payout,
         constrained_rounds = constrained_rounds + CASE WHEN v_cap < LEAST(t.max_multiplier_cents, (adm.o_cfg).max_multiplier_cents) THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = adm.o_host AND game = 'plinko'
   RETURNING * INTO pool;
  v_intake_chips := round(pool.intake_diamonds::numeric / adm.o_rate, 2);
  IF pool.chips_paid + pool.reserved_chips > v_intake_chips + (adm.o_cfg).exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_plinko_drop: chips_paid % would exceed the chips taken in % + allowance % - the cap was bypassed',
      pool.chips_paid, v_intake_chips, (adm.o_cfg).exposure_allowance_chips;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  UPDATE public.diamond_game_commits SET consumed_by = v_id WHERE id = p_commit_id;

  INSERT INTO public.plinko_drops
    (id, host_id, host_kind, club_id, user_id, table_version, bet_diamonds, bet_chips, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, hmac_hex, path_bits, slot,
     table_multiplier_cents, cap_multiplier_cents, multiplier_cents, capped, payout_chips, chips_minted,
     pool_chips_minted_after, pool_chips_paid_after, diamonds_after, member_chips_after, is_fixture)
  VALUES
    (v_id, adm.o_host, adm.o_kind, p_club_id, v_user, t.version, p_bet_diamonds, adm.o_bet_chips, adm.o_rate,
     p_commit_id, (adm.o_commit).server_seed_hash, (adm.o_commit).server_seed, p_client_seed, adm.o_nonce, encode(v_hmac, 'hex'), v_path, v_slot,
     v_table_mult, v_cap, v_mult, v_mult < v_table_mult, v_payout, 0,
     pool.chips_minted, pool.chips_paid, v_dia_after, v_member_after, adm.o_fixture)
  RETURNING * INTO d;
  RETURN public.fn_plinko_drop_result(d);
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_crash_decide(p_round crash_rounds, p_cashout boolean, p_by text)
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
  -- The curve reached the crash point: nothing.
  ELSIF (r.crash_cents = 100 AND v_now_cents >= 100) OR v_now_cents > r.crash_cents THEN
    v_result := 'crashed'; v_at_cents := NULL;
  ELSIF p_cashout AND v_now_cents >= 101 THEN
    v_result := 'cashed'; v_at_cents := v_now_cents;
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
    IF v_payout > r.reserved_chips THEN
      RAISE EXCEPTION 'fn_crash_decide: payout % exceeds the round''s reservation % (cap %)', v_payout, r.reserved_chips, r.cap_cents;
    END IF;
    SELECT x.bank_after, x.member_after INTO v_bank_after, v_member_after
      FROM public.fn_diamond_game_prize_leg('crash', r.host_id, r.host_kind, r.club_id, r.user_id, v_payout,
             'crash-prize:' || r.id::text,
             format('Diamond Crash: cashed out at %s.%sx', v_at_cents / 100, lpad((v_at_cents % 100)::text, 2, '0')),
             jsonb_build_object('round_id', r.id, 'host_id', r.host_id, 'host_kind', r.host_kind,
                                'cashout_cents', v_at_cents, 'crash_cents', r.crash_cents, 'auto', r.auto_cashout_cents IS NOT NULL AND v_at_cents = r.auto_cashout_cents)) x;
  END IF;

  UPDATE public.diamond_game_pools
     SET chips_paid = chips_paid + v_payout,
         updated_at = now()
   WHERE host_id = r.host_id AND game = 'crash'
   RETURNING * INTO pool;
  v_intake_chips := round(pool.intake_diamonds::numeric / public.fn_ca_bridge_rate(), 2);
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
  v_crash := public.fn_crash_point_cents(v_roll);

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
         intake_diamonds = intake_diamonds + p_bet_diamonds,
         reserved_chips = reserved_chips + v_reserve,
         constrained_rounds = constrained_rounds + CASE WHEN v_cap < (adm.o_cfg).max_multiplier_cents THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = adm.o_host AND game = 'crash'
   RETURNING * INTO pool;
  v_intake_chips := round(pool.intake_diamonds::numeric / adm.o_rate, 2);
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
     auto_cashout_cents, reserved_chips, chips_minted, diamonds_after, member_chips_after, is_fixture, started_at)
  VALUES
    (v_id, adm.o_host, adm.o_kind, p_club_id, v_user, p_bet_diamonds, adm.o_bet_chips, adm.o_rate,
     p_commit_id, (adm.o_commit).server_seed_hash, (adm.o_commit).server_seed, p_client_seed, adm.o_nonce, v_roll, v_crash, v_cap, (adm.o_cfg).growth_k,
     p_auto_cashout_cents, v_reserve, 0, v_dia_after, v_member_chips, adm.o_fixture, clock_timestamp())
  RETURNING * INTO r;
  RETURN public.fn_crash_round_result(r);
END $function$
;

CREATE FUNCTION public.fn_choice_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.status='open' AND
 (to_jsonb(NEW)-ARRAY['picked','status','payout_chips','settled_at']) =
 (to_jsonb(OLD)-ARRAY['picked','status','payout_chips','settled_at']) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'A Sealed Game Round Cannot Be Rewritten';
END $$;
CREATE TRIGGER diamond_choice_immutable BEFORE UPDATE OR DELETE ON public.diamond_choice_rounds
 FOR EACH ROW EXECUTE FUNCTION public.fn_choice_immutable();

-- Existing bank writers also respect accepted game promises. This observes
-- the same locked wallet row they update; it does not introduce a second bank.
CREATE FUNCTION public.fn_diamond_game_reserved_cover_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE host uuid; cover numeric; old_cover numeric; held numeric;
BEGIN
 IF TG_TABLE_NAME='clubs' THEN
  host:=NEW.id; cover:=GREATEST(COALESCE(NEW.promo_balance,0),0)+GREATEST(COALESCE(NEW.chip_treasury,0),0);
  old_cover:=GREATEST(COALESCE(OLD.promo_balance,0),0)+GREATEST(COALESCE(OLD.chip_treasury,0),0);
 ELSE
  host:=NEW.union_id; cover:=GREATEST(COALESCE(NEW.promo_wallet,0),0)+GREATEST(COALESCE(NEW.chip_balance,0),0);
  old_cover:=GREATEST(COALESCE(OLD.promo_wallet,0),0)+GREATEST(COALESCE(OLD.chip_balance,0),0);
 END IF;
 IF cover>=old_cover THEN RETURN NEW; END IF;
 SELECT COALESCE(sum(reserved_chips),0) INTO held FROM public.diamond_game_pools WHERE host_id=host;
 IF cover<held THEN RAISE EXCEPTION 'These Chips Are Reserved For Open Game Rounds'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER diamond_game_club_reserves BEFORE UPDATE OF promo_balance,chip_treasury ON public.clubs
 FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_game_reserved_cover_guard();
CREATE TRIGGER diamond_game_union_reserves BEFORE UPDATE OF promo_wallet,chip_balance ON public.union_wallets
 FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_game_reserved_cover_guard();

INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
 ('clubs','diamond_game_club_reserves','Protect accepted Diamond Spins chip promises across all four games; promo first and standalone main bank together must cover open reservations.'),
 ('union_wallets','diamond_game_union_reserves','Protect accepted Diamond Spins chip promises across all four games; BBJ-funded promo first and union main bank together must cover open reservations.')
 ON CONFLICT(table_name,trigger_name) DO NOTHING;

-- New doors begin closed. Installation tests precede host activation.
INSERT INTO public.diamond_game_configs(host_id,game,host_kind,enabled,bet_options,min_bet_diamonds,max_bet_diamonds,
 purchased_only,allow_fixture_accounts,exposure_allowance_chips,max_multiplier_cents)
 SELECT host_id,g,host_kind,false,bet_options,min_bet_diamonds,max_bet_diamonds,
 purchased_only,allow_fixture_accounts,exposure_allowance_chips,25600
 FROM public.diamond_game_configs CROSS JOIN unnest(ARRAY['crossing','mines']) g WHERE game='crash';
INSERT INTO public.diamond_game_pools(host_id,game) SELECT host_id,game FROM public.diamond_game_configs
 WHERE game IN ('crossing','mines');
REVOKE ALL ON FUNCTION public.fn_choice_choose(integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_choose(integer,integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_choice_ladder(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_ladder(text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_choice_prizes(text,text,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_prizes(text,text,numeric) TO service_role;
REVOKE ALL ON FUNCTION public.fn_choice_board(text,text,bigint,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_board(text,text,bigint,integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_choice_result(public.diamond_choice_rounds) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_result(public.diamond_choice_rounds) TO service_role;
REVOKE ALL ON FUNCTION public.fn_choice_immutable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_immutable() TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_reserved_cover_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_reserved_cover_guard() TO service_role;
REVOKE ALL ON FUNCTION public.fn_choice_start(uuid,text,text,integer,uuid,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_start(uuid,text,text,integer,uuid,text,integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_choice_act(uuid,text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_act(uuid,text,integer,integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_choice_state(uuid,text,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_state(uuid,text,text,integer) TO authenticated, service_role;

-- The request retains the base entry and one optional equal top-up. The
-- resulting game owns one committed outcome; a retry never pays twice.
CREATE TABLE public.diamond_bonus_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES public.profiles(id),
 club_id uuid NOT NULL REFERENCES public.clubs(id),
 host_id uuid NOT NULL, host_kind text NOT NULL CHECK(host_kind IN ('club','union')),
 game text NOT NULL CHECK(game IN ('plinko','crash','crossing','mines')),
 commit_id uuid NOT NULL UNIQUE REFERENCES public.diamond_game_commits(id),
 base_diamonds integer NOT NULL CHECK(base_diamonds BETWEEN 25 AND 2500),
 added_diamonds integer NOT NULL CHECK(added_diamonds=0 OR added_diamonds=base_diamonds),
 total_diamonds integer GENERATED ALWAYS AS (base_diamonds+added_diamonds) STORED,
 request jsonb NOT NULL, result jsonb, is_fixture boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX diamond_bonus_history ON public.diamond_bonus_entries(user_id,host_id,game,created_at DESC);
ALTER TABLE public.diamond_bonus_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.diamond_bonus_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE ON public.diamond_bonus_entries TO service_role;

CREATE FUNCTION public.fn_diamond_round_chip_cents(p_exact numeric,p_server text,p_message text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=public,extensions AS $$
DECLARE cents numeric:=p_exact*100; roll numeric;
BEGIN
 IF p_exact<0 THEN RAISE EXCEPTION 'A Prize Cannot Be Negative'; END IF;
 roll:=('x'||substr(encode(extensions.hmac(p_message,p_server,'sha256'),'hex'),1,12))::bit(48)::bigint;
 RETURN (floor(cents)+CASE WHEN (roll+1)<= (cents-floor(cents))*281474976710656::numeric THEN 1 ELSE 0 END)/100;
END $$;

CREATE FUNCTION public.fn_plinko_bonus_run(p_club uuid,p_commit uuid,p_seed text,p_total integer,p_denom integer,p_table integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,extensions AS $$
DECLARE adm record; t public.plinko_tables; cap integer; idx integer; bit_idx integer; path integer; slot integer;
 balls jsonb[]:='{}'; hash bytea; mult integer; prize numeric; paid numeric:=0; debit jsonb; receipt record;
 v_id uuid; v_count integer; result jsonb;
BEGIN
 IF p_denom IS NULL OR p_denom NOT IN (1,5,10,25,50,100) OR p_total%p_denom<>0 THEN
  RETURN jsonb_build_object('ok',false,'error','Choose A Drop Value That Uses Every Diamond'); END IF;
 SELECT e.id INTO v_id FROM public.diamond_bonus_entries e WHERE e.commit_id=p_commit AND e.user_id=auth.uid() AND e.result IS NULL;
 IF v_id IS NULL THEN RAISE EXCEPTION 'A Bonus Entry Is Required'; END IF;
 SELECT * INTO adm FROM public.fn_diamond_game_admit('plinko',p_club,p_commit,p_seed,p_total);
 IF adm.err IS NOT NULL THEN RETURN adm.err; END IF;
 SELECT * INTO t FROM public.plinko_tables WHERE version=p_table AND activated_at IS NOT NULL;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','Choose An Available Plinko Table'); END IF;
 -- Cover the whole selected table for every ball before any outcome is drawn.
 -- One locked transaction pays the completed batch; animation cannot alter it.
 cap:=public.fn_diamond_game_cap_cents(adm.o_cfg,adm.o_pool,adm.o_bank,adm.o_bet_chips,LEAST(t.max_multiplier_cents,(adm.o_cfg).max_multiplier_cents));
 IF cap<t.max_multiplier_cents OR (p_total/p_denom)*ceil(p_denom::numeric/adm.o_rate*t.max_multiplier_cents)/100 > adm.o_bet_chips*cap/100 THEN RETURN jsonb_build_object('ok',false,'error','The Host Cannot Cover This Bonus. Choose A Smaller Entry'); END IF;
 v_count:=p_total/p_denom;
 FOR idx IN 0..v_count-1 LOOP
  hash:=extensions.hmac(p_seed||':'||adm.o_nonce||':drop:'||idx,(adm.o_commit).server_seed,'sha256');
  path:=0; slot:=0;
  FOR bit_idx IN 0..15 LOOP IF get_bit(hash,bit_idx)=1 THEN path:=path|(1<<bit_idx); slot:=slot+1; END IF; END LOOP;
  mult:=t.multipliers_cents[slot+1];
  prize:=public.fn_diamond_round_chip_cents(p_denom::numeric/adm.o_rate*mult/100,(adm.o_commit).server_seed,p_seed||':'||adm.o_nonce||':rounding:'||idx);
  paid:=paid+prize;
  balls:=array_append(balls,jsonb_build_object('index',idx,'path_bits',path,'slot',slot,'multiplier_cents',mult,'payout_chips',prize));
 END LOOP;
 debit:=public.fn_diamond_game_take_bet(auth.uid(),p_total,(adm.o_cfg).purchased_only,'plinko_drop',
  'Diamond Spins Plinko Bonus','plinko-bonus:'||v_id,
  jsonb_build_object('bonus_id',v_id,'club_id',p_club,'host_id',adm.o_host,'commit_id',p_commit),adm.o_owner,'Diamond Spins Plinko Intake');
 IF COALESCE((debit->>'success')::boolean,false) IS NOT TRUE THEN RETURN jsonb_build_object('ok',false,'error','Not Enough Diamonds For This Bonus'); END IF;
 IF paid>0 THEN
  SELECT * INTO receipt FROM public.fn_diamond_game_pay_chips('promo',adm.o_host,adm.o_kind,p_club,auth.uid(),paid,
   'plinko-bonus-prize:'||v_id,'Diamond Spins Plinko Bonus',jsonb_build_object('bonus_id',v_id,'drops',v_count));
 END IF;
 UPDATE public.diamond_game_pools SET rounds=rounds+1,intake_diamonds=intake_diamonds+p_total,
  chips_paid=chips_paid+paid,updated_at=now() WHERE host_id=adm.o_host AND game='plinko';
 UPDATE public.diamond_game_commits SET consumed_by=v_id WHERE id=p_commit;
 result:=jsonb_build_object('ok',true,'id',v_id,'game','plinko','club_id',p_club,'bet_diamonds',p_total,
  'diamonds_per_drop',p_denom,'diamonds_per_chip',adm.o_rate,'table_version',t.version,'table_name',t.name,
  'multipliers_cents',to_jsonb(t.multipliers_cents),'drops',to_jsonb(balls),'payout_chips',paid,
  'server_seed_hash',(adm.o_commit).server_seed_hash,'server_seed',(adm.o_commit).server_seed,
  'client_seed',p_seed,'nonce',adm.o_nonce,'commit_id',p_commit);
 RETURN result;
END $$;

CREATE FUNCTION public.fn_diamond_bonus_start(p_club_id uuid,p_game text,p_base_diamonds integer,p_double boolean,
 p_commit_id uuid,p_client_seed text,p_mode text DEFAULT NULL,p_denom integer DEFAULT NULL,
 p_table_version integer DEFAULT NULL,p_auto_cashout_cents integer DEFAULT NULL,p_max_steps integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE v_user uuid:=auth.uid(); prior public.diamond_bonus_entries; wanted jsonb; v_host uuid; v_kind text;
 v_result jsonb; total integer; existing_crash public.crash_rounds; existing_choice public.diamond_choice_rounds;
BEGIN
 IF v_user IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Play'); END IF;
 IF p_game IS NULL OR p_game NOT IN ('plinko','crash','crossing','mines') OR p_base_diamonds IS NULL OR
  p_base_diamonds NOT BETWEEN 25 AND 2500 OR p_double IS NULL OR p_commit_id IS NULL OR
  p_client_seed IS NULL OR length(p_client_seed) NOT BETWEEN 1 AND 64 THEN
  RETURN jsonb_build_object('ok',false,'error','Choose An Entry From 25 To 2,500 Diamonds'); END IF;
 total:=p_base_diamonds*CASE WHEN p_double THEN 2 ELSE 1 END;
 wanted:=jsonb_build_object('club',p_club_id,'game',p_game,'base',p_base_diamonds,'double',p_double,
  'seed',p_client_seed,'mode',p_mode,'denom',p_denom,'table',p_table_version,'auto',p_auto_cashout_cents,'steps',p_max_steps);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_commit_id::text,94613));
 SELECT * INTO prior FROM public.diamond_bonus_entries WHERE commit_id=p_commit_id;
 IF FOUND THEN
  IF prior.user_id IS DISTINCT FROM v_user OR prior.request IS DISTINCT FROM wanted THEN
   RETURN jsonb_build_object('ok',false,'error','This Ticket Belongs To Different Bonus Settings'); END IF;
  IF p_game='crash' THEN
   SELECT * INTO existing_crash FROM public.crash_rounds WHERE commit_id=p_commit_id;
   v_result:=public.fn_crash_round_result(existing_crash);
  ELSIF p_game IN ('crossing','mines') THEN
   SELECT * INTO existing_choice FROM public.diamond_choice_rounds WHERE commit_id=p_commit_id;
   v_result:=public.fn_choice_result(existing_choice);
  ELSE v_result:=prior.result; END IF;
  RETURN v_result||jsonb_build_object('bonus',jsonb_build_object('id',prior.id,'base_diamonds',prior.base_diamonds,'added_diamonds',prior.added_diamonds,'total_diamonds',prior.total_diamonds),'replayed',true);
 END IF;
 SELECT host_id,host_kind INTO v_host,v_kind FROM public.fn_wheel_host(p_club_id);
 IF v_host IS NULL THEN RETURN jsonb_build_object('ok',false,'error','That Club Could Not Be Found'); END IF;
 -- A caught refusal rolls back the entry and every inner money leg together.
 BEGIN
  INSERT INTO public.diamond_bonus_entries(user_id,club_id,host_id,host_kind,game,commit_id,base_diamonds,added_diamonds,request,is_fixture)
   VALUES(v_user,p_club_id,v_host,v_kind,p_game,p_commit_id,p_base_diamonds,total-p_base_diamonds,wanted,
    public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user)) RETURNING * INTO prior;
  IF p_game='plinko' THEN v_result:=public.fn_plinko_bonus_run(p_club_id,p_commit_id,p_client_seed,total,p_denom,p_table_version);
  ELSIF p_game='crash' THEN v_result:=public.fn_crash_start(p_club_id,p_commit_id,p_client_seed,total,p_auto_cashout_cents);
  ELSE v_result:=public.fn_choice_start(p_club_id,p_game,p_mode,total,p_commit_id,p_client_seed,p_max_steps); END IF;
  IF v_result->>'ok'='true' AND (COALESCE(v_result->>'commit_id',v_result#>>'{fairness,commit_id}') IS DISTINCT FROM p_commit_id::text OR v_result->>'club_id' IS DISTINCT FROM p_club_id::text OR (v_result->>'bet_diamonds')::integer IS DISTINCT FROM total) THEN
   RAISE EXCEPTION USING MESSAGE='Resume Your Existing Round First', ERRCODE='PDB01';
  END IF;
  IF v_result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING MESSAGE=COALESCE(v_result->>'error','The Bonus Could Not Start'), ERRCODE='PDB01'; END IF;
  v_result:=v_result||jsonb_build_object('bonus',jsonb_build_object('id',prior.id,'base_diamonds',p_base_diamonds,'added_diamonds',total-p_base_diamonds,'total_diamonds',total));
  UPDATE public.diamond_bonus_entries SET result=v_result WHERE id=prior.id;
  RETURN v_result;
 EXCEPTION WHEN SQLSTATE 'PDB01' THEN RETURN jsonb_build_object('ok',false,'error',SQLERRM);
 END;
END $$;

CREATE FUNCTION public.fn_diamond_bonus_latest(p_club_id uuid,p_game text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE h uuid; k text; r public.diamond_bonus_entries; v_latest_result jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Play'); END IF;
 SELECT host_id,host_kind INTO h,k FROM public.fn_wheel_host(p_club_id);
 SELECT * INTO r FROM public.diamond_bonus_entries WHERE user_id=auth.uid() AND club_id=p_club_id AND host_id=h AND game=p_game
  AND result IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1;
 v_latest_result:=r.result;
 IF r.id IS NOT NULL AND p_game='crash' THEN
  SELECT public.fn_crash_round_result(c)||jsonb_build_object('bonus',r.result->'bonus') INTO v_latest_result
   FROM public.crash_rounds c WHERE c.commit_id=r.commit_id AND c.user_id=auth.uid() AND c.club_id=p_club_id;
 ELSIF r.id IS NOT NULL AND p_game IN ('crossing','mines') THEN
  SELECT public.fn_choice_result(c)||jsonb_build_object('bonus',r.result->'bonus') INTO v_latest_result FROM public.diamond_choice_rounds c WHERE c.commit_id=r.commit_id AND c.user_id=auth.uid() AND c.club_id=p_club_id;
 END IF;
 RETURN jsonb_build_object('ok',true,'result',v_latest_result);
END $$;
REVOKE ALL ON FUNCTION public.fn_diamond_round_chip_cents(numeric,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_round_chip_cents(numeric,text,text),public.fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_start(uuid,text,integer,boolean,uuid,text,text,integer,integer,integer,integer),public.fn_diamond_bonus_latest(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_start(uuid,text,integer,boolean,uuid,text,text,integer,integer,integer,integer),public.fn_diamond_bonus_latest(uuid,text) TO authenticated,service_role;

CREATE FUNCTION public.fn_diamond_bonus_state(p_club_id uuid,p_game text,p_total integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE state jsonb; cfg public.diamond_game_configs; pool public.diamond_game_pools; h uuid; k text; cap integer; chips numeric;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Play'); END IF;
 IF p_game IS NULL OR p_game NOT IN ('plinko','crash') OR p_total IS NULL OR p_total NOT BETWEEN 25 AND 5000 THEN
  RETURN jsonb_build_object('ok',false,'error','Choose A Valid Bonus Entry'); END IF;
 state:=public.fn_diamond_game_state(p_club_id,p_game);
 IF state->>'ok' IS DISTINCT FROM 'true' OR state->>'available' IS DISTINCT FROM 'true' THEN RETURN state; END IF;
 SELECT host_id,host_kind INTO h,k FROM public.fn_wheel_host(p_club_id);
 SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id=h AND game=p_game;
 SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id=h AND game=p_game;
 chips:=p_total::numeric/public.fn_ca_bridge_rate();
 cap:=public.fn_diamond_game_cap_cents(cfg,pool,public.fn_diamond_game_cover(h,k),chips,cfg.max_multiplier_cents);
 RETURN state||jsonb_build_object('bets',jsonb_build_array(jsonb_build_object('bet_diamonds',p_total,'bet_chips',chips,'cap_cents',cap,'playable',cap>=101)));
END $$;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_state(uuid,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_state(uuid,text,integer) TO authenticated,service_role;

CREATE FUNCTION public.fn_diamond_bonus_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.result IS NULL AND NEW.result IS NOT NULL
  AND to_jsonb(OLD)-ARRAY['result','total_diamonds']=to_jsonb(NEW)-ARRAY['result','total_diamonds'] THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'A Saved Bonus Cannot Be Rewritten';
END $$;
CREATE TRIGGER diamond_bonus_immutable BEFORE UPDATE OR DELETE ON public.diamond_bonus_entries
 FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_bonus_immutable();
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_immutable() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_immutable() TO service_role;

UPDATE public.diamond_game_configs SET min_bet_diamonds=25,max_bet_diamonds=5000,bet_options=ARRAY[25,50,100,250,500,1000,2500,5000],purchased_only=false WHERE game IN ('plinko','crash','crossing','mines');

CREATE OR REPLACE FUNCTION public.fn_diamond_games_entry(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  v_rate integer := public.fn_ca_bridge_rate();
  v_wheel boolean := false; v_plinko boolean := false; v_crash boolean := false; v_crossing boolean := false; v_mines boolean := false; v_available boolean; v_bust boolean := false;
  v_price integer; v_min integer;
  v_diamonds numeric := 0; v_member boolean := false; v_member_chips numeric;
  v_free boolean := false; v_frozen boolean;
  v_day date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Play');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;

  IF v_rate IS NULL OR v_rate <= 0 THEN RETURN jsonb_build_object('ok',false,'error','The Bridge Rate Is Not Set'); END IF;
  SELECT COALESCE(w.enabled, false), w.spin_price_diamonds INTO v_wheel, v_price
    FROM public.wheel_configs w WHERE w.host_id = v_host;
  SELECT COALESCE(bool_or(c.enabled AND public.fn_diamond_spins_owner_agreed(v_host,v_kind) AND NOT EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope=c.game AND f.cleared_at IS NULL) AND c.game = 'plinko'), false),
         COALESCE(bool_or(c.enabled AND public.fn_diamond_spins_owner_agreed(v_host,v_kind) AND NOT EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope=c.game AND f.cleared_at IS NULL) AND c.game = 'crash'), false),
         COALESCE(bool_or(c.enabled AND public.fn_diamond_spins_owner_agreed(v_host,v_kind) AND NOT EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope=c.game AND f.cleared_at IS NULL) AND c.game = 'crossing'), false),
         COALESCE(bool_or(c.enabled AND public.fn_diamond_spins_owner_agreed(v_host,v_kind) AND NOT EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope=c.game AND f.cleared_at IS NULL) AND c.game = 'mines'), false),
         MIN(c.min_bet_diamonds) FILTER (WHERE c.enabled AND public.fn_diamond_spins_owner_agreed(v_host,v_kind))
    INTO v_plinko, v_crash, v_crossing, v_mines, v_min
    FROM public.diamond_game_configs c WHERE c.host_id = v_host AND c.game IN ('plinko', 'crash', 'crossing', 'mines');

  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  SELECT true, cm.chip_balance INTO v_member, v_member_chips
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_user
     AND COALESCE(cm.status, 'active') IN ('active', 'approved') LIMIT 1;

  -- THE WELCOME SPIN IS ONCE, EVER (Dan 2026-09-10), so the door asks whether
  -- this member has ever taken one here, not whether they took one today, and
  -- whether the host has budget left to give another away.
  IF v_wheel THEN
    -- THE SAME QUESTION THE DOOR ASKS (2026-09-11). This used to say the spin
    -- was ready whenever the budget exceeded what had been spent, which is not
    -- the rule: a welcome spin is the whole wheel or it is not offered, so the
    -- window has to cover the TOP PRIZE, not merely be non-empty. A player was
    -- being shown "Welcome Spin Ready" on four surfaces and then refused at the
    -- door. One helper answers it for all three callers now.
    SELECT COALESCE(w.welcome_spin_enabled, false)
       AND (SELECT r.o_open FROM public.fn_wheel_welcome_room(v_host) r)
       AND NOT EXISTS (SELECT 1 FROM public.wheel_spins s
                        WHERE s.host_id = v_host AND s.user_id = v_user AND s.is_welcome)
      INTO v_free FROM public.wheel_configs w WHERE w.host_id = v_host;
  END IF;
  v_frozen := public.fn_platform_frozen();

  v_available := (COALESCE(v_wheel,false) OR COALESCE(v_plinko,false) OR COALESCE(v_crash,false) OR COALESCE(v_crossing,false) OR COALESCE(v_mines,false)) AND COALESCE(v_member,false) AND NOT v_frozen;
  -- A zero stack during an active hand is not a bust. The lobby may offer
  -- this prompt only after the player has left all occupied seats.
  v_bust := v_available AND v_member_chips=0 AND v_diamonds>=25
    AND NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.user_id=v_user AND s.left_at IS NULL);
  RETURN jsonb_build_object(
    'bust_prompt', COALESCE(v_bust,false),
    'ok', true,
    'host_id', v_host, 'host_kind', v_kind, 'club_id', p_club_id,
    'diamonds_per_chip', v_rate,
    'games', jsonb_build_object('wheel', COALESCE(v_wheel, false),
                                'plinko', COALESCE(v_plinko, false),
                                'crash', COALESCE(v_crash, false), 'crossing', COALESCE(v_crossing, false), 'mines', COALESCE(v_mines, false)),
    'open', COALESCE(v_wheel, false) OR COALESCE(v_plinko, false) OR COALESCE(v_crash, false) OR COALESCE(v_crossing, false) OR COALESCE(v_mines, false),
    'available', (COALESCE(v_wheel, false) OR COALESCE(v_plinko, false) OR COALESCE(v_crash, false) OR COALESCE(v_crossing, false) OR COALESCE(v_mines, false))
                 AND COALESCE(v_member, false) AND NOT v_frozen,
    'spin_price_diamonds', v_price,
    'min_bet_diamonds', v_min,
    'entry_diamonds', LEAST(COALESCE(v_price, 2147483647), COALESCE(v_min, 2147483647)),
    'diamonds', v_diamonds,
    'chips_from_diamonds', round(v_diamonds / v_rate, 2),
    'is_member', COALESCE(v_member, false),
    'member_chips', v_member_chips,
    'free_spin_ready', COALESCE(v_free, false),
    'welcome_spin_ready', COALESCE(v_free, false),
    'frozen', v_frozen);
END $function$
;


-- A private read model counts each paid entry once, regardless of ball count.
CREATE VIEW public.diamond_game_round_book AS
 SELECT id,host_id,club_id,user_id,'plinko'::text game,bet_diamonds,bet_chips,payout_chips,
 created_at,created_at settled_at,'cashed'::text status,is_fixture,multiplier_cents::numeric,table_version,capped constrained
 FROM public.plinko_drops
 UNION ALL
 SELECT id,host_id,club_id,user_id,'crash',bet_diamonds,bet_chips,payout_chips,started_at,settled_at,status,is_fixture,
 cashout_cents::numeric,NULL::integer,false FROM public.crash_rounds
 UNION ALL
 SELECT id,host_id,club_id,user_id,game,bet_diamonds,bet_chips,payout_chips,created_at,settled_at,status,is_fixture,
 CASE WHEN status='cashed' THEN payout_chips/bet_chips*100 END,NULL::integer,false FROM public.diamond_choice_rounds
 UNION ALL
 SELECT id,host_id,club_id,user_id,game,total_diamonds,total_diamonds::numeric/(result->>'diamonds_per_chip')::integer,
 (result->>'payout_chips')::numeric,created_at,created_at,'cashed',is_fixture,NULL::numeric,(result->>'table_version')::integer,false
 FROM public.diamond_bonus_entries WHERE game='plinko' AND result IS NOT NULL;
REVOKE ALL ON public.diamond_game_round_book FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.diamond_game_round_book TO service_role;

ALTER TABLE public.ca_payout_freeze DROP CONSTRAINT IF EXISTS ca_payout_freeze_scope_check;
ALTER TABLE public.ca_payout_freeze ADD CONSTRAINT ca_payout_freeze_scope_check
 CHECK(scope IN ('tournament_payouts','bbj_payouts','diamond_issuance','diamond_tournament_payouts','arena_withdrawals','wheel','plinko','crash','crossing','mines'));
ALTER TABLE public.diamond_game_configs ALTER COLUMN min_bet_diamonds SET DEFAULT 25;
ALTER TABLE public.diamond_game_configs ALTER COLUMN max_bet_diamonds SET DEFAULT 5000;
ALTER TABLE public.diamond_game_configs ALTER COLUMN bet_options SET DEFAULT ARRAY[25,50,100,250,500,1000,2500,5000];
ALTER TABLE public.diamond_game_configs ALTER COLUMN purchased_only SET DEFAULT false;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_state(p_club_id uuid, p_game text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.diamond_game_configs%ROWTYPE;
  pool public.diamond_game_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_bank numeric := 0;
  v_diamonds numeric := 0; v_purchased integer := 0; v_spendable integer := 0;
  v_today integer := 0; v_last timestamptz; v_wait integer := 0;
  v_member boolean := false; v_member_chips numeric;
  v_frozen boolean;
  v_bets jsonb; v_tables jsonb; v_open jsonb;
  r public.crash_rounds;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Play');
  END IF;
  IF p_game IS NULL OR p_game NOT IN ('plinko', 'crash', 'crossing', 'mines') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Game Does Not Exist');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = v_host AND game = p_game;
  IF cfg.host_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'available', false, 'reason', 'not_configured',
                              'game', p_game, 'host_id', v_host, 'host_kind', v_kind);
  END IF;

  -- Time settles what it has decided before anybody reads the headroom.
  IF p_game = 'crash' THEN
    PERFORM 1 FROM public.diamond_game_configs WHERE host_id = v_host AND game = 'crash' FOR UPDATE;
    PERFORM public.fn_crash_settle_decided(v_host);
    SELECT * INTO r FROM public.crash_rounds c WHERE c.host_id = v_host AND c.club_id=p_club_id AND c.user_id = v_user AND c.status = 'open'
     ORDER BY c.started_at DESC LIMIT 1;
    IF r.id IS NOT NULL THEN
      v_open := public.fn_crash_round_result(r);
    END IF;
  END IF;
  SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id = v_host AND game = p_game;

  -- The bank a prize comes out of is the host's PROMO WALLET (Dan 2026-09-10).
  -- Cover: the promo wallet the payouts come out of first, and the host's own
  -- chip bank standing behind it (Dan 2026-09-10).
  v_bank := public.fn_diamond_game_cover(v_host, v_kind);

  -- Every bet option with the cap the pool can promise on it right now.
  SELECT jsonb_agg(jsonb_build_object(
           'bet_diamonds', b, 'bet_chips', round(b::numeric / v_rate, 2),
           'cap_cents', public.fn_diamond_game_cap_cents(cfg, pool, v_bank, b::numeric / v_rate, cfg.max_multiplier_cents),
           'playable', public.fn_diamond_game_cap_cents(cfg, pool, v_bank, b::numeric / v_rate, cfg.max_multiplier_cents) >= 101)
         ORDER BY b)
    INTO v_bets
    FROM unnest(cfg.bet_options) b
   WHERE b BETWEEN cfg.min_bet_diamonds AND cfg.max_bet_diamonds;

  IF p_game = 'plinko' THEN
    SELECT jsonb_agg(jsonb_build_object(
             'version', t.version, 'name', t.name, 'rows', t.board_rows,
             'multipliers_cents', to_jsonb(t.multipliers_cents),
             'max_multiplier_cents', t.max_multiplier_cents,
             'sd_chips', t.sd_chips)
           ORDER BY t.version)
      INTO v_tables
      FROM public.plinko_tables t WHERE t.activated_at IS NOT NULL;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;

  SELECT count(*)::integer,max(created_at) INTO v_today,v_last FROM public.diamond_game_round_book
   WHERE host_id=v_host AND user_id=v_user AND game=p_game
   AND (created_at AT TIME ZONE 'America/Chicago')::date=(now() AT TIME ZONE 'America/Chicago')::date;
  IF v_last IS NOT NULL THEN
    v_wait := GREATEST(0, cfg.min_seconds_between_rounds - floor(extract(epoch FROM (now() - v_last)))::integer);
  END IF;
  SELECT true, COALESCE(cm.chip_balance, 0) INTO v_member, v_member_chips
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_user
     AND COALESCE(cm.status, 'active') IN ('active', 'approved') LIMIT 1;
  v_frozen := public.fn_platform_frozen()
           OR EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = p_game AND f.cleared_at IS NULL);

  RETURN jsonb_build_object(
    'ok', true, 'available', cfg.enabled AND public.fn_diamond_spins_owner_agreed(v_host,v_kind), 'game', p_game, 'host_id', v_host, 'host_kind', v_kind, 'club_id', p_club_id,
    'config', jsonb_build_object(
      'diamonds_per_chip', v_rate, 'min_bet_diamonds', cfg.min_bet_diamonds, 'max_bet_diamonds', cfg.max_bet_diamonds,
      'exposure_allowance_chips', cfg.exposure_allowance_chips, 'cap_fraction', cfg.cap_fraction,
      'max_multiplier_cents', cfg.max_multiplier_cents, 'growth_k', cfg.growth_k,
      'purchased_only', cfg.purchased_only, 'max_rounds_per_player_per_day', cfg.max_rounds_per_player_per_day,
      'min_seconds_between_rounds', cfg.min_seconds_between_rounds),
    'bets', COALESCE(v_bets, '[]'::jsonb),
    'tables', COALESCE(v_tables, '[]'::jsonb),
    'open_round', v_open,
    'pool', jsonb_build_object(
      'rounds', COALESCE(pool.rounds, 0), 'intake_diamonds', COALESCE(pool.intake_diamonds, 0),
      'chips_paid', COALESCE(pool.chips_paid, 0),
      'reserved_chips', COALESCE(pool.reserved_chips, 0),
      'intake_chips', round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2),
      'promo_wallet_chips', public.fn_diamond_game_promo(v_host, v_kind),
      'bank_chips', public.fn_diamond_game_bank(v_host, v_kind),
      'cover_chips', v_bank,
      'headroom_chips', round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2) + cfg.exposure_allowance_chips - COALESCE(pool.chips_paid, 0) - COALESCE(pool.reserved_chips, 0),
      'realized_rtp', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
                           THEN round(COALESCE(pool.chips_paid, 0) / (pool.intake_diamonds::numeric / v_rate), 4) END),
    'player', jsonb_build_object(
      'diamonds', v_diamonds, 'purchased_available', v_purchased, 'spendable', v_spendable,
      'rounds_today', v_today, 'seconds_until_next', v_wait,
      -- The same one figure the wheel shows, from the same helper.
      'diamonds_today', public.fn_diamond_games_spent_today(v_host, v_user),
      'is_member', COALESCE(v_member, false), 'member_chips', v_member_chips),
    'frozen', v_frozen);
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_set_config(p_club_id uuid, p_game text, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.diamond_game_configs%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_bad integer;
BEGIN
  IF v_user IS NULL AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;
  IF p_game IS NULL OR p_game NOT IN ('plinko', 'crash', 'crossing', 'mines') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Game Does Not Exist');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host Owner Or An Admin May Change This Game');
  END IF;

  SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = v_host AND game = p_game FOR UPDATE;
  IF cfg.host_id IS NULL THEN
    INSERT INTO public.diamond_game_configs (host_id, game, host_kind, updated_by)
    VALUES (v_host, p_game, v_kind, v_user) RETURNING * INTO cfg;
    INSERT INTO public.diamond_game_pools (host_id, game) VALUES (v_host, p_game) ON CONFLICT (host_id, game) DO NOTHING;
  END IF;

  IF p_patch ? 'min_bet_diamonds' THEN cfg.min_bet_diamonds := (p_patch->>'min_bet_diamonds')::integer; END IF;
  IF p_patch ? 'max_bet_diamonds' THEN cfg.max_bet_diamonds := (p_patch->>'max_bet_diamonds')::integer; END IF;
  IF p_patch ? 'bet_options' THEN
    SELECT array_agg(x::integer ORDER BY x::integer) INTO cfg.bet_options FROM jsonb_array_elements_text(p_patch->'bet_options') x;
  END IF;
  IF p_patch ? 'exposure_allowance_chips' THEN cfg.exposure_allowance_chips := round((p_patch->>'exposure_allowance_chips')::numeric, 2); END IF;
  IF p_patch ? 'cap_fraction' THEN cfg.cap_fraction := round((p_patch->>'cap_fraction')::numeric, 3); END IF;
  IF p_patch ? 'max_multiplier_cents' THEN cfg.max_multiplier_cents := (p_patch->>'max_multiplier_cents')::integer; END IF;
  IF p_patch ? 'growth_k' THEN cfg.growth_k := round((p_patch->>'growth_k')::numeric, 4); END IF;
  IF p_patch ? 'purchased_only' THEN cfg.purchased_only := (p_patch->>'purchased_only')::boolean; END IF;
  IF p_patch ? 'allow_fixture_accounts' THEN cfg.allow_fixture_accounts := (p_patch->>'allow_fixture_accounts')::boolean; END IF;
  IF p_patch ? 'max_rounds_per_player_per_day' THEN cfg.max_rounds_per_player_per_day := (p_patch->>'max_rounds_per_player_per_day')::integer; END IF;
  IF p_patch ? 'min_seconds_between_rounds' THEN cfg.min_seconds_between_rounds := (p_patch->>'min_seconds_between_rounds')::integer; END IF;
  IF p_patch ? 'enabled' THEN cfg.enabled := (p_patch->>'enabled')::boolean; END IF;
  IF cfg.enabled AND NOT public.fn_diamond_spins_owner_agreed(v_host,v_kind) THEN RETURN jsonb_build_object('ok',false,'error','The Host Wallet Owner Must Accept Diamond Spins Before Play Opens'); END IF;

  IF cfg.min_bet_diamonds<>25 OR cfg.max_bet_diamonds<>5000 OR cfg.purchased_only THEN RETURN jsonb_build_object('ok',false,'error','Diamond Spins Use Earned Or Purchased Diamonds, With Entries From 25 To 2,500 And One Optional Double Down'); END IF;
  IF cfg.bet_options IS NULL OR array_length(cfg.bet_options, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'At Least One Bet Size Is Required');
  END IF;
  SELECT count(*) INTO v_bad FROM unnest(cfg.bet_options) b
   WHERE b < cfg.min_bet_diamonds OR b > cfg.max_bet_diamonds;
  IF v_bad > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Every Bet Size Must Be Inside The Diamond Limits');
  END IF;
  IF cfg.enabled AND p_game = 'plinko' AND NOT EXISTS (
       SELECT 1 FROM public.plinko_tables t, public.fn_plinko_table_audit(t.version) a
        WHERE t.activated_at IS NOT NULL AND a.spec_rtp = 0.800000) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No Plinko Table Passes Its Payout Audit. The Game Cannot Be Enabled');
  END IF;

  UPDATE public.diamond_game_configs
     SET enabled = cfg.enabled, min_bet_diamonds = cfg.min_bet_diamonds, max_bet_diamonds = cfg.max_bet_diamonds,
         bet_options = cfg.bet_options, exposure_allowance_chips = cfg.exposure_allowance_chips,
         cap_fraction = cfg.cap_fraction, max_multiplier_cents = cfg.max_multiplier_cents, growth_k = cfg.growth_k,
         purchased_only = cfg.purchased_only, allow_fixture_accounts = cfg.allow_fixture_accounts,
         max_rounds_per_player_per_day = cfg.max_rounds_per_player_per_day,
         min_seconds_between_rounds = cfg.min_seconds_between_rounds,
         updated_at = now(), updated_by = v_user
   WHERE host_id = v_host AND game = p_game
   RETURNING * INTO cfg;
  RETURN jsonb_build_object('ok', true, 'config', to_jsonb(cfg));
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_diamond_games_spent_today(p_host uuid, p_user uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((
    SELECT sum(s.spin_price_diamonds)::numeric
      FROM public.wheel_spins s
     WHERE s.host_id = p_host AND s.user_id = p_user
       AND NOT COALESCE(s.is_welcome, false)
       AND (s.created_at AT TIME ZONE 'America/Chicago')::date
           = (now() AT TIME ZONE 'America/Chicago')::date), 0)
  + COALESCE((SELECT sum(r.bet_diamonds)::numeric FROM public.diamond_game_round_book r
    WHERE r.host_id=p_host AND r.user_id=p_user
    AND (r.created_at AT TIME ZONE 'America/Chicago')::date=(now() AT TIME ZONE 'America/Chicago')::date),0);
$function$
;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_pnl(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  v_rate integer := public.fn_ca_bridge_rate();
  v_windows jsonb;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host''s Owners And Admins Read This');
  END IF;

  WITH ev AS (
    SELECT 'wheel'::text AS game, s.created_at AS at,
           CASE WHEN s.is_welcome THEN 0 ELSE s.spin_price_diamonds END::numeric AS intake_dia,
           CASE WHEN s.is_welcome THEN 0
                WHEN s.outcome_kind = 'chips' THEN COALESCE(s.outcome_amount, 0) ELSE 0 END AS chips_out,
           CASE WHEN s.is_welcome THEN 0
                WHEN s.outcome_kind = 'diamonds' THEN COALESCE(s.outcome_amount, 0) ELSE 0 END AS dia_out,
           CASE WHEN s.is_welcome THEN COALESCE(s.prize_value_chips, 0) ELSE 0 END AS welcome_chips
      FROM public.wheel_spins s
     WHERE s.host_id = v_host AND NOT COALESCE(s.is_fixture, false)
    UNION ALL
    SELECT r.game,r.created_at,r.bet_diamonds::numeric,r.payout_chips,0,0 FROM public.diamond_game_round_book r
    WHERE r.host_id=v_host AND NOT r.is_fixture AND r.status<>'open'
  ), w(lbl, ord, since) AS (
    VALUES ('24 Hours', 1, now() - interval '24 hours'),
           ('7 Days',   2, now() - interval '7 days'),
           ('30 Days',  3, now() - interval '30 days'),
           ('All Time', 4, '-infinity'::timestamptz)
  ), per_game AS (
    SELECT w.lbl, w.ord, ev.game,
           count(*)::integer AS rounds,
           sum(ev.intake_dia) AS intake_dia,
           sum(ev.chips_out) AS chips_out,
           sum(ev.dia_out) AS dia_out,
           sum(ev.welcome_chips) AS welcome_chips
      FROM w JOIN ev ON ev.at >= w.since
     GROUP BY w.lbl, w.ord, ev.game
  ), per_window AS (
    SELECT w.lbl, w.ord,
           COALESCE(count(ev.*), 0)::integer AS rounds,
           COALESCE(sum(ev.intake_dia), 0) AS intake_dia,
           COALESCE(sum(ev.chips_out), 0) AS chips_out,
           COALESCE(sum(ev.dia_out), 0) AS dia_out,
           COALESCE(sum(ev.welcome_chips), 0) AS welcome_chips
      FROM w LEFT JOIN ev ON ev.at >= w.since
     GROUP BY w.lbl, w.ord
  )
  SELECT jsonb_agg(
           jsonb_build_object(
             'window', p.lbl,
             'rounds', p.rounds,
             'intake_diamonds', p.intake_dia,
             'intake_chips', round(p.intake_dia / v_rate, 2),
             'chips_paid', round(p.chips_out, 2),
             'diamonds_paid', p.dia_out,
             'welcome_chips', round(p.welcome_chips, 2),
             'net_chips', round(p.intake_dia / v_rate - p.chips_out - p.dia_out / v_rate - p.welcome_chips, 2),
             'games', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                         'game', g.game,
                         'rounds', g.rounds,
                         'intake_diamonds', g.intake_dia,
                         'chips_paid', round(g.chips_out, 2),
                         'diamonds_paid', g.dia_out,
                         'net_chips', round(g.intake_dia / v_rate - g.chips_out - g.dia_out / v_rate - g.welcome_chips, 2))
                       ORDER BY g.game)
                  FROM per_game g WHERE g.lbl = p.lbl), '[]'::jsonb))
           ORDER BY p.ord)
    INTO v_windows
    FROM per_window p;

  RETURN jsonb_build_object('ok', true, 'host_id', v_host, 'host_kind', v_kind,
                            'diamonds_per_chip', v_rate,
                            'windows', COALESCE(v_windows, '[]'::jsonb));
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_players(p_club_id uuid, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  v_rate integer := public.fn_ca_bridge_rate();
  v_spin_cap integer; v_round_cap integer;
  v_rows jsonb; v_n integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host''s Owners And Admins Read This');
  END IF;
  SELECT max_spins_per_player_per_day INTO v_spin_cap FROM public.wheel_configs WHERE host_id = v_host;
  SELECT max(max_rounds_per_player_per_day) INTO v_round_cap FROM public.diamond_game_configs WHERE host_id = v_host;

  WITH ev AS (
    -- The day the CAPS are counted on, so the console and the door agree about
    -- when the day turns.
    SELECT s.user_id, 'wheel'::text AS game, 1 AS spins, 0 AS rounds,
           CASE WHEN s.is_welcome THEN 0 ELSE s.spin_price_diamonds END::numeric AS spent_dia,
           CASE WHEN s.outcome_kind = 'chips' THEN COALESCE(s.outcome_amount, 0) ELSE 0 END AS won_chips,
           CASE WHEN s.outcome_kind = 'diamonds' THEN COALESCE(s.outcome_amount, 0) ELSE 0 END AS won_dia
      FROM public.wheel_spins s
     WHERE s.host_id = v_host AND NOT COALESCE(s.is_fixture, false)
       AND (s.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date
    UNION ALL
    SELECT r.user_id,r.game,0,1,r.bet_diamonds::numeric,r.payout_chips,0 FROM public.diamond_game_round_book r
    WHERE r.host_id=v_host AND NOT r.is_fixture
    AND (r.created_at AT TIME ZONE 'America/Chicago')::date=(now() AT TIME ZONE 'America/Chicago')::date
  ), agg AS (
    SELECT user_id,
           sum(spins)::integer AS spins,
           sum(rounds)::integer AS rounds,
           sum(spent_dia) AS spent_dia,
           sum(won_chips) AS won_chips,
           sum(won_dia) AS won_dia
      FROM ev GROUP BY user_id
  )
  SELECT jsonb_agg(r ORDER BY (r->>'spent_diamonds')::numeric DESC) INTO v_rows
    FROM (
      SELECT jsonb_build_object(
               'user_id', a.user_id,
               'name', public.fn_player_display_name(a.user_id),
               'spins', a.spins,
               'rounds', a.rounds,
               'spins_cap', COALESCE(v_spin_cap, 0),
               'rounds_cap', COALESCE(v_round_cap, 0),
               'at_spin_cap', COALESCE(v_spin_cap, 0) > 0 AND a.spins >= v_spin_cap,
               'at_round_cap', EXISTS (SELECT 1 FROM ev e JOIN public.diamond_game_configs c ON c.host_id=v_host AND c.game=e.game WHERE e.user_id=a.user_id GROUP BY e.game,c.max_rounds_per_player_per_day HAVING count(*)>=c.max_rounds_per_player_per_day),
               'spent_diamonds', a.spent_dia,
               'spent_chips', round(a.spent_dia / v_rate, 2),
               'won_chips', round(a.won_chips, 2),
               'won_diamonds', a.won_dia,
               -- What the player is up or down, from the player's side.
               'net_chips', round(a.won_chips + a.won_dia / v_rate - a.spent_dia / v_rate, 2)) AS r
        FROM agg a
       ORDER BY a.spent_dia DESC
       LIMIT v_n
    ) t;

  RETURN jsonb_build_object('ok', true, 'host_id', v_host, 'host_kind', v_kind,
                            'diamonds_per_chip', v_rate,
                            'spins_cap', COALESCE(v_spin_cap, 0),
                            'rounds_cap', COALESCE(v_round_cap, 0),
                            'players', COALESCE(v_rows, '[]'::jsonb));
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_floor(p_club_id uuid, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_host uuid;
  v_lim integer;
  v_wins jsonb;
  v_points jsonb;
  v_top jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To See The Floor');
  END IF;
  SELECT h.host_id INTO v_host FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  v_lim := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);

  WITH rounds AS (
    SELECT 'wheel'::text AS game, s.created_at AS at, s.user_id,
           s.outcome_kind::text AS kind, s.outcome_amount::numeric AS amount,
           s.prize_value_chips::numeric AS value_chips, NULL::integer AS multiplier_cents
      FROM public.wheel_spins s
     WHERE s.host_id = v_host AND s.outcome_kind <> 'nothing' AND NOT COALESCE(s.is_fixture, false)
    UNION ALL
    SELECT r.game,r.settled_at,r.user_id,'chips',r.payout_chips,r.payout_chips,r.multiplier_cents
    FROM public.diamond_game_round_book r WHERE r.host_id=v_host AND NOT r.is_fixture AND r.status='cashed' AND r.payout_chips>0
  ), recent AS (
    SELECT * FROM rounds ORDER BY at DESC LIMIT v_lim
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'game', r.game,
           'at', r.at,
           'kind', r.kind,
           'amount', r.amount,
           'value_chips', r.value_chips,
           'multiplier_cents', r.multiplier_cents,
           'name', COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), 'Player'),
           'avatar', NULLIF(pr.arena_avatar_url, ''),
           'mine', r.user_id = auth.uid()
         ) ORDER BY r.at DESC), '[]'::jsonb)
    INTO v_wins
    FROM recent r
    LEFT JOIN public.profiles pr ON pr.id = r.user_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'crash_cents', x.crash_cents,
           'cashed', x.status = 'cashed',
           'at', x.settled_at
         ) ORDER BY x.settled_at DESC), '[]'::jsonb)
    INTO v_points
    FROM (SELECT c.crash_cents, c.status, c.settled_at
            FROM public.crash_rounds c
           WHERE c.host_id = v_host AND c.status <> 'open' AND NOT COALESCE(c.is_fixture, false)
           ORDER BY c.settled_at DESC
           LIMIT 20) x;

  -- the week's biggest: the same rounds, the last seven days, by what they paid
  WITH rounds AS (
    SELECT 'wheel'::text AS game, s.created_at AS at, s.user_id,
           s.outcome_kind::text AS kind, s.outcome_amount::numeric AS amount,
           s.prize_value_chips::numeric AS value_chips, NULL::integer AS multiplier_cents
      FROM public.wheel_spins s
     WHERE s.host_id = v_host AND s.outcome_kind <> 'nothing' AND NOT COALESCE(s.is_fixture, false)
       AND s.created_at >= now() - interval '7 days'
    UNION ALL
    SELECT r.game,r.settled_at,r.user_id,'chips',r.payout_chips,r.payout_chips,r.multiplier_cents
    FROM public.diamond_game_round_book r WHERE r.host_id=v_host AND NOT r.is_fixture AND r.status='cashed' AND r.payout_chips>0 AND r.settled_at>=now()-interval '7 days'
  ), biggest AS (
    SELECT * FROM rounds ORDER BY value_chips DESC, at DESC LIMIT 5
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'game', b.game,
           'at', b.at,
           'kind', b.kind,
           'amount', b.amount,
           'value_chips', b.value_chips,
           'multiplier_cents', b.multiplier_cents,
           'name', COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), 'Player'),
           'avatar', NULLIF(pr.arena_avatar_url, ''),
           'mine', b.user_id = auth.uid()
         ) ORDER BY b.value_chips DESC, b.at DESC), '[]'::jsonb)
    INTO v_top
    FROM biggest b
    LEFT JOIN public.profiles pr ON pr.id = b.user_id;

  RETURN jsonb_build_object('ok', true, 'host_id', v_host, 'wins', v_wins, 'crash_points', v_points,
                            'top_week', v_top);
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_metrics(p_club_id uuid, p_game text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.diamond_game_configs%ROWTYPE;
  pool public.diamond_game_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_windows jsonb; v_bank numeric; v_open integer := 0;
  v_invariant_ok boolean;
BEGIN
  IF p_game IS NULL OR p_game NOT IN ('plinko', 'crash', 'crossing', 'mines') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Game Does Not Exist');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found'); END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host Owner Or An Admin May Read These Metrics');
  END IF;
  SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = v_host AND game = p_game;
  SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id = v_host AND game = p_game;
  IF cfg.host_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'configured', false, 'game', p_game, 'host_id', v_host, 'host_kind', v_kind);
  END IF;
  -- The bank behind the payouts is the host's PROMO WALLET (Dan 2026-09-10).
  v_bank := public.fn_diamond_game_cover(v_host, v_kind);

  SELECT count(*) INTO v_open FROM public.diamond_game_round_book WHERE host_id=v_host AND game=p_game AND status='open';
  -- A player's adaptive stopping target is not known on losing rounds. Report
  -- the settled books without inventing a variance or a drift verdict.
  SELECT jsonb_agg(jsonb_build_object('window',lbl,'rounds',n,'intake_chips',intake,'paid_chips',paid,
   'realized_rtp',CASE WHEN intake>0 THEN round(paid/intake,4) END,'z',NULL,'constrained',constrained,'drift',NULL) ORDER BY lbl)
   INTO v_windows FROM (
    SELECT lbl,count(r.id) n,COALESCE(sum(r.bet_chips),0) intake,COALESCE(sum(r.payout_chips),0) paid,
     count(r.id) FILTER(WHERE r.constrained) constrained
    FROM (VALUES('1h',interval '1 hour'),('24h',interval '24 hours'),('7d',interval '7 days')) win(lbl,span)
    LEFT JOIN public.diamond_game_round_book r ON r.host_id=v_host AND r.game=p_game AND NOT r.is_fixture
      AND r.status<>'open' AND r.created_at>=now()-win.span GROUP BY lbl) x;

  v_invariant_ok := pool.host_id IS NULL
                 OR (pool.chips_paid + pool.reserved_chips
                       <= round(pool.intake_diamonds::numeric / v_rate, 2) + cfg.exposure_allowance_chips);
  IF NOT v_invariant_ok THEN
    BEGIN
      PERFORM public.fn_ca_raise_drift_incident(
        p_source => p_game || '_invariant', p_classification => 'unauthorized_adjustment', p_severity => 'critical',
        p_dedupe_key => p_game || ':invariant:' || v_host::text,
        p_discrepancy => pool.chips_paid + pool.reserved_chips - round(pool.intake_diamonds::numeric / v_rate, 2) - cfg.exposure_allowance_chips,
        p_expected => round(pool.intake_diamonds::numeric / v_rate, 2) + cfg.exposure_allowance_chips, p_actual => pool.chips_paid + pool.reserved_chips,
        p_layer => 'settlement', p_entity_type => 'diamond_game_pool', p_entity_id => v_host,
        p_union_id => CASE WHEN v_kind = 'union' THEN v_host END,
        p_club_id => CASE WHEN v_kind = 'club' THEN v_host END,
        p_suspected_cause => 'Diamond ' || p_game || ' paid or reserved more chips than it took in plus the allowance; the per-round cap was bypassed',
        p_metadata => to_jsonb(pool));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'owner_agreed', public.fn_diamond_spins_owner_agreed(v_host,v_kind), 'configured', true, 'game', p_game, 'host_id', v_host, 'host_kind', v_kind,
    'config', to_jsonb(cfg),
    'pool', to_jsonb(pool),
    'cover_chips', COALESCE(v_bank, 0),
    'promo_chips', public.fn_diamond_game_promo(v_host, v_kind),
    'bank_chips', public.fn_diamond_game_bank(v_host, v_kind),
    'open_rounds', v_open,
    'intake_chips', round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2),
    'owner_id', public.fn_diamond_game_owner(v_host, v_kind),
    'owner_diamonds', (SELECT COALESCE(p.diamonds, 0) FROM public.profiles p WHERE p.id = public.fn_diamond_game_owner(v_host, v_kind)),
    'exposure_chips', COALESCE(pool.chips_paid, 0) + COALESCE(pool.reserved_chips, 0) - round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2),
    'exposure_headroom_chips', cfg.exposure_allowance_chips - (COALESCE(pool.chips_paid, 0) + COALESCE(pool.reserved_chips, 0) - round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2)),
    'realized_rtp_lifetime', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
        THEN round(pool.chips_paid / (pool.intake_diamonds::numeric / v_rate), 4) END,
    'house_take_lifetime_chips', CASE WHEN pool.host_id IS NOT NULL
        THEN round(pool.intake_diamonds::numeric / v_rate - pool.chips_paid, 2) END,
    'constrained_rate', CASE WHEN COALESCE(pool.rounds, 0) > 0 THEN round(pool.constrained_rounds::numeric / pool.rounds, 4) END,
    'invariant_ok', v_invariant_ok,
    'windows', COALESCE(v_windows, '[]'::jsonb),
    'tables', CASE WHEN p_game = 'plinko' THEN
        (SELECT jsonb_agg(jsonb_build_object('version', t.version, 'name', t.name, 'spec_rtp', t.spec_rtp,
                                             'sd_chips', t.sd_chips, 'hit_rate', t.hit_rate, 'max_multiplier_cents', t.max_multiplier_cents,
                                             'activated_at', t.activated_at) ORDER BY t.version)
           FROM public.plinko_tables t) END);
END $function$
;


CREATE FUNCTION public.fn_diamond_game_quote_max(p_game text,p_bet numeric,p_cap integer)
RETURNS numeric LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE best numeric:=0; mode text; prize numeric;
BEGIN
 IF p_game='plinko' THEN
  SELECT COALESCE(max(p_bet*max_multiplier_cents/100),0) INTO best FROM public.plinko_tables WHERE activated_at IS NOT NULL AND max_multiplier_cents<=p_cap;
 ELSIF p_game='crash' THEN IF p_cap>=101 THEN best:=ceil(p_bet*p_cap)/100; END IF;
 ELSE
  FOREACH mode IN ARRAY CASE WHEN p_game='mines' THEN ARRAY['5','10','15'] ELSE ARRAY['steady','bold','extreme'] END LOOP
   FOREACH prize IN ARRAY public.fn_choice_prizes(p_game,mode,p_bet) LOOP
    IF ceil(prize*100)/100<=p_bet*p_cap/100 THEN best:=GREATEST(best,ceil(prize*100)/100); END IF;
   END LOOP;
  END LOOP;
 END IF;
 RETURN best;
END $$;
REVOKE ALL ON FUNCTION public.fn_diamond_game_quote_max(text,numeric,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_quote_max(text,numeric,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_diamond_game_room(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  v_rate integer := public.fn_ca_bridge_rate();
  v_cover numeric; v_promo numeric; v_bank numeric;
  v_owner uuid; v_owner_dia numeric;
  cfg public.diamond_game_configs%ROWTYPE;
  pool public.diamond_game_pools%ROWTYPE;
  wcfg public.wheel_configs%ROWTYPE;
  v_games jsonb := '[]'::jsonb;
  v_g text; v_min_chips numeric; v_max_chips numeric;
  v_cap_max integer; v_cap_min integer; v_cap_free integer; v_state text;
  v_mult integer := 1; v_top_chip numeric := 0; v_top_dia numeric := 0;
  v_wheel jsonb;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host''s Owners And Admins Read This');
  END IF;

  v_promo := public.fn_diamond_game_promo(v_host, v_kind);
  v_bank  := public.fn_diamond_game_bank(v_host, v_kind);
  v_cover := public.fn_diamond_game_cover(v_host, v_kind);
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);
  SELECT COALESCE(p.diamonds, 0) INTO v_owner_dia FROM public.profiles p WHERE p.id = v_owner;

  FOREACH v_g IN ARRAY ARRAY['plinko', 'crash', 'crossing', 'mines'] LOOP
    SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = v_host AND game = v_g;
    CONTINUE WHEN cfg.host_id IS NULL;
    SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id = v_host AND game = v_g;
    v_max_chips := cfg.max_bet_diamonds::numeric / v_rate;
    v_min_chips := GREATEST(cfg.min_bet_diamonds, 1)::numeric / v_rate;
    -- The same function the door uses, so the console cannot say one thing
    -- while the game does another.
    v_cap_max := public.fn_diamond_game_cap_cents(cfg, pool, v_cover, v_max_chips, cfg.max_multiplier_cents);
    v_cap_min := public.fn_diamond_game_cap_cents(cfg, pool, v_cover, v_min_chips, cfg.max_multiplier_cents);
    -- TWO DIFFERENT CEILINGS, AND ONLY ONE OF THEM IS THE OPERATOR'S TO FIX.
    -- fn_diamond_game_cap_cents takes the LEAST of the configured ceiling, the
    -- intake headroom and the cover. Asking it again with a bank nothing could
    -- exhaust isolates the first two, so the console can say which is binding:
    --   the INTAKE headroom means the game has not taken enough in yet to risk
    --   a payout that size, which is the never-pay-more-than-taken-in law
    --   working exactly as intended and nothing to act on;
    --   the COVER means the promo wallet and the bank cannot carry the win,
    --   which is the operator's to fix and the only thing worth a warning.
    -- Reporting them as one number would tell an owner to move chips they do
    -- not need to move.
    v_cap_free := public.fn_diamond_game_cap_cents(cfg, pool, 1000000000000, v_max_chips, cfg.max_multiplier_cents);
    v_state := CASE
      WHEN NOT cfg.enabled OR NOT public.fn_diamond_spins_owner_agreed(v_host,v_kind) THEN 'closed'
      WHEN public.fn_diamond_game_quote_max(v_g,v_min_chips,v_cap_min)<=0 THEN 'stopped'
      WHEN v_cap_max < v_cap_free THEN 'thin'
      ELSE 'open' END;
    v_games := v_games || jsonb_build_object(
      'game', v_g,
      'enabled', cfg.enabled AND public.fn_diamond_spins_owner_agreed(v_host,v_kind),
      'state', v_state,
      'max_bet_diamonds', cfg.max_bet_diamonds,
      'max_win_chips', public.fn_diamond_game_quote_max(v_g,v_max_chips,v_cap_max),
      'intake_win_chips', public.fn_diamond_game_quote_max(v_g,v_max_chips,v_cap_free),
      'ceiling_win_chips', public.fn_diamond_game_quote_max(v_g,v_max_chips,cfg.max_multiplier_cents),
      'capped_by_cover', v_cap_max < v_cap_free,
      'capped_by_intake', v_cap_free < cfg.max_multiplier_cents,
      'reserved_chips', COALESCE(pool.reserved_chips, 0));
  END LOOP;

  SELECT * INTO wcfg FROM public.wheel_configs WHERE host_id = v_host;
  IF wcfg.host_id IS NOT NULL THEN
    SELECT COALESCE(wcfg.spin_price_diamonds / v.spin_price_diamonds, 1) INTO v_mult
      FROM public.wheel_segment_versions v WHERE v.version = wcfg.segment_version;
    v_mult := COALESCE(v_mult, 1);
    SELECT COALESCE(max(CASE WHEN g.kind = 'chips' THEN g.amount::numeric * v_mult ELSE 0 END), 0),
           COALESCE(max(CASE WHEN g.kind = 'diamonds' THEN g.amount::numeric * v_mult ELSE 0 END), 0)
      INTO v_top_chip, v_top_dia
      FROM public.wheel_segments g WHERE g.version = wcfg.segment_version;
    v_wheel := jsonb_build_object(
      'game', 'wheel',
      'enabled', wcfg.enabled,
      -- The wheel does not cap a multiplier; it locks the tiers it cannot pay.
      -- It can therefore go thin in a way no chip reading would show: on the
      -- OWNER'S diamonds, which is what its diamond prizes come out of.
      'state', CASE
        WHEN NOT wcfg.enabled THEN 'closed'
        WHEN v_cover < v_top_chip AND v_owner_dia < v_top_dia THEN 'stopped'
        WHEN v_cover < v_top_chip OR v_owner_dia < v_top_dia THEN 'thin'
        ELSE 'open' END,
      'top_chip_prize_chips', round(v_top_chip, 2),
      'top_diamond_prize_diamonds', v_top_dia,
      'chip_prize_covered', v_cover >= v_top_chip,
      'diamond_prize_covered', v_owner_dia >= v_top_dia,
      'spin_price_diamonds', wcfg.spin_price_diamonds);
    v_games := v_games || v_wheel;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'host_id', v_host, 'host_kind', v_kind, 'diamonds_per_chip', v_rate,
    'cover_chips', round(v_cover, 2),
    'promo_chips', round(v_promo, 2),
    'bank_chips', round(v_bank, 2),
    'owner_diamonds', v_owner_dia,
    'games', v_games);
END $function$
;


REVOKE ALL ON FUNCTION public.fn_diamond_game_pnl(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_game_pnl(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_pnl(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_pnl(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_room(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_game_room(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_room(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_room(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_players(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_game_players(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_players(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_players(uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_floor(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_game_floor(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_floor(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_floor(uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_metrics(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_game_metrics(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_metrics(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_metrics(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_set_config(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_game_set_config(uuid, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_set_config(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_set_config(uuid, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_games_entry(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_games_entry(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_games_entry(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_games_entry(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_state(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_game_state(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_state(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_state(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_games_spent_today(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_diamond_games_spent_today(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_diamond_games_spent_today(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_games_spent_today(uuid, uuid) TO service_role;
CREATE INDEX IF NOT EXISTS wheel_spins_host_user_time ON public.wheel_spins(host_id,user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS plinko_drops_host_user_time ON public.plinko_drops(host_id,user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS crash_rounds_host_user_time ON public.crash_rounds(host_id,user_id,started_at DESC);

NOTIFY pgrst, 'reload schema';
COMMIT;
