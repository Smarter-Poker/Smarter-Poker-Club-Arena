-- Exact read-only current function preimages, September17. Only isolated fixture input.
SET check_function_bodies=off;
CREATE OR REPLACE FUNCTION public.fn_choice_result(r diamond_choice_rounds)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT jsonb_build_object('ok',true,'id',r.id,'game',r.game,'club_id',r.club_id,'status',r.status,'mode',r.mode,
 'bet_diamonds',r.bet_diamonds,'bet_chips',r.bet_chips,'picked',to_jsonb(r.picked),'max_steps',r.max_steps,
 'prizes',to_jsonb(r.prizes),'payout_chips',r.payout_chips,'server_seed_hash',r.server_seed_hash,
 'client_seed',r.client_seed,'nonce',r.nonce,'commit_id',r.commit_id,
 'diamonds_per_chip',r.diamonds_per_chip,'proof',CASE WHEN r.status<>'open' THEN jsonb_build_object('game',r.game,'server_seed',r.server_seed,
 'server_seed_hash',r.server_seed_hash,'client_seed',r.client_seed,'nonce',r.nonce,
 'mines',CASE WHEN r.game='mines' THEN r.mode::integer ELSE 0 END,'mine_cells',to_jsonb(r.mine_cells),'road_roll',r.road_roll::text) END)
$function$
;
REVOKE ALL ON FUNCTION public.fn_choice_result(diamond_choice_rounds) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_choice_result(diamond_choice_rounds) TO service_role;
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
 UPDATE public.diamond_game_pools SET rounds=rounds+1,intake_diamonds=intake_diamonds+p_bet,
  reserved_chips=reserved_chips+v_reserve,updated_at=now() WHERE host_id=adm.o_host AND game=p_game;
 UPDATE public.diamond_game_commits SET consumed_by=v_id WHERE id=p_commit_id;
 INSERT INTO public.diamond_choice_rounds(id,host_id,host_kind,club_id,user_id,game,mode,bet_diamonds,bet_chips,diamonds_per_chip,
  commit_id,server_seed,server_seed_hash,client_seed,nonce,mine_cells,road_roll,max_steps,prizes,reserved_chips,is_fixture)
 VALUES(v_id,adm.o_host,adm.o_kind,p_club_id,v_user,p_game,p_mode,p_bet,adm.o_bet_chips,adm.o_rate,p_commit_id,
  (adm.o_commit).server_seed,(adm.o_commit).server_seed_hash,p_client_seed,adm.o_nonce,v_cells,v_roll,p_max_steps,v_prizes,v_reserve,adm.o_fixture) RETURNING * INTO r;
 RETURN public.fn_choice_result(r);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_choice_start(uuid,text,text,integer,uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_choice_start(uuid,text,text,integer,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_choice_start(uuid,text,text,integer,uuid,text,integer) TO authenticated;
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
  -- The curve reached the crash point: nothing.
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
REVOKE ALL ON FUNCTION public.fn_crash_decide(crash_rounds,boolean,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_crash_decide(crash_rounds,boolean,text,integer) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_crash_round_result(r crash_rounds)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'ok', true, 'game', 'crash', 'round_id', r.id, 'club_id', r.club_id, 'host_id', r.host_id,
    'status', r.status, 'bet_diamonds', r.bet_diamonds, 'bet_chips', r.bet_chips,
    'diamonds_per_chip', r.diamonds_per_chip,
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
REVOKE ALL ON FUNCTION public.fn_crash_round_result(crash_rounds) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_crash_round_result(crash_rounds) TO service_role;
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
REVOKE ALL ON FUNCTION public.fn_crash_start(uuid,uuid,text,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_crash_start(uuid,uuid,text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_crash_start(uuid,uuid,text,integer,integer) TO service_role;
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
REVOKE ALL ON FUNCTION public.fn_diamond_game_admit(text,uuid,uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_admit(text,uuid,uuid,text,integer) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_cap_cents(p_cfg diamond_game_configs, p_pool diamond_game_pools, p_bank numeric, p_bet_chips numeric, p_ceiling_cents integer)
 RETURNS integer
 LANGUAGE plpgsql
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
REVOKE ALL ON FUNCTION public.fn_diamond_game_cap_cents(diamond_game_configs,diamond_game_pools,numeric,numeric,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_cap_cents(diamond_game_configs,diamond_game_pools,numeric,numeric,integer) TO service_role;
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
REVOKE ALL ON FUNCTION public.fn_diamond_game_state(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_state(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_state(uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_take_bet(p_user uuid, p_bet integer, p_purchased_only boolean, p_type text, p_description text, p_reference text, p_meta jsonb, p_owner uuid, p_owner_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_deduct jsonb; v_credit jsonb; v_remaining integer; v_take integer; v_lot record;
BEGIN
  -- THE BET GOES TO THE HOST'S OWNER (Dan 2026-09-10: "all diamonds 'taken in' get
  -- credited to the union owners wallet, or the club owners wallet"). Two legs, one
  -- transaction, both transfers: the player's diamonds leave as a transfer to the owner
  -- (source diamond_game, the recipient in the metadata), and the owner's wallet takes
  -- them as a transfer. Nothing is retired and nothing is minted.
  IF p_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'This Host Has No Owner Wallet To Pay');
  END IF;
  v_deduct := public.deduct_diamonds(p_user, p_bet, p_description, p_type, 'diamond_game',
                p_meta || jsonb_build_object('recipient_id', p_owner, 'bet_type', p_type), p_reference, 0);
  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN v_deduct;
  END IF;
  IF COALESCE((v_deduct->>'idempotent')::boolean, false) THEN
    RETURN v_deduct;
  END IF;
  IF p_purchased_only THEN
    v_remaining := p_bet;
    FOR v_lot IN SELECT * FROM public.diamond_purchase_lots l
                  WHERE l.user_id = p_user AND l.frozen_at IS NULL
                    AND (l.issued - l.consumed - l.refunded) > 0
                  ORDER BY l.created_at, l.id FOR UPDATE LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := LEAST(v_remaining, v_lot.issued - v_lot.consumed - v_lot.refunded);
      UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
      v_remaining := v_remaining - v_take;
    END LOOP;
    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'diamond games: purchased lots could not cover the bet (% short) after the availability check passed', v_remaining;
    END IF;
  END IF;
  v_credit := public.add_diamonds_to_balance(p_owner, p_bet, 'transfer', p_owner_note, p_reference || ':intake', p_user);
  IF COALESCE((v_credit->>'success')::boolean, false) = false THEN
    RAISE EXCEPTION 'diamond games: the bet could not be credited to the host owner (%): %', p_reference, v_credit->>'error';
  END IF;
  RETURN v_deduct || jsonb_build_object('owner_id', p_owner, 'owner_balance', v_credit->'new_balance');
END $function$
;
REVOKE ALL ON FUNCTION public.fn_diamond_game_take_bet(uuid,integer,boolean,text,text,text,jsonb,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_take_bet(uuid,integer,boolean,text,text,text,jsonb,uuid,text) TO service_role;
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
       AND NOT COALESCE(s.is_welcome, false) AND s.bonus_ticket_id IS NULL
       AND (s.created_at AT TIME ZONE 'America/Chicago')::date
           = (now() AT TIME ZONE 'America/Chicago')::date), 0)
  + COALESCE((SELECT sum(r.bet_diamonds)::numeric FROM public.diamond_game_round_book r
    WHERE r.host_id=p_host AND r.user_id=p_user
    AND (r.created_at AT TIME ZONE 'America/Chicago')::date=(now() AT TIME ZONE 'America/Chicago')::date),0);
$function$
;
REVOKE ALL ON FUNCTION public.fn_diamond_games_spent_today(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_games_spent_today(uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_plinko_bonus_run(p_club uuid, p_commit uuid, p_seed text, p_total integer, p_denom integer, p_table integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE adm record; t public.plinko_tables; cap integer; idx integer; bit_idx integer; path integer; slot integer;
 balls jsonb[]:='{}'; hash bytea; mult integer; prize numeric; paid numeric:=0; debit jsonb; receipt record;
 v_id uuid; v_count integer; result jsonb;
BEGIN
 IF p_denom IS NULL OR p_denom NOT IN (1,2,4,5,10,20,25,50,100) OR p_total%p_denom<>0 THEN
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
  SELECT * INTO receipt FROM public.fn_diamond_game_pay_chips('plinko_prize',adm.o_host,adm.o_kind,p_club,auth.uid(),paid,
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
END $function$
;
REVOKE ALL ON FUNCTION public.fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_wheel_spin_core(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_welcome boolean, p_bonus_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  c_two48 constant numeric := 281474976710656;   -- 2^48
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
BEGIN
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
    IF prior.club_id IS DISTINCT FROM p_club_id OR prior.client_seed IS DISTINCT FROM v_client
       OR prior.is_welcome IS DISTINCT FROM p_welcome OR prior.bonus_ticket_id IS DISTINCT FROM p_bonus_ticket_id THEN
      RETURN jsonb_build_object('ok',false,'error','That Spin Request Does Not Match Its Receipt');
    END IF;
    RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', true);
  END IF;

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
    IF prior.user_id IS DISTINCT FROM v_user OR prior.club_id IS DISTINCT FROM p_club_id
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

  SELECT x.* INTO a FROM public.fn_wheel_segments_audit(cfg.segment_version) x;
  IF a.weight_total IS DISTINCT FROM 100000 OR a.spec_rtp IS DISTINCT FROM 0.800000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Prize Table Failed Its Audit. The Wheel Is Closed Until It Is Fixed');
  END IF;
  SELECT (CASE WHEN p_welcome OR p_bonus_ticket_id IS NOT NULL THEN 100 ELSE cfg.spin_price_diamonds END) / v.spin_price_diamonds INTO v_mult
    FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  IF p_bonus_ticket_id IS NOT NULL AND cfg.spin_price_diamonds<>100 THEN RETURN jsonb_build_object('ok',false,'error','The 100 Diamond Reward Table Is Unavailable'); END IF;
  v_price  := CASE WHEN p_welcome OR p_bonus_ticket_id IS NOT NULL THEN 100 ELSE cfg.spin_price_diamonds END;
  IF v_mult IS NULL OR v_mult<1 THEN RETURN jsonb_build_object('ok',false,'error','The 100 Diamond Reward Table Is Unavailable'); END IF;
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
    SELECT r.o_spent, r.o_top INTO v_welcome_spent, v_welcome_top
      FROM public.fn_wheel_welcome_room(v_host) r;
    IF v_welcome_spent + v_welcome_top > cfg.welcome_budget_chips THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Spins Here Are Gone For Now');
    END IF;
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
  SELECT c.o_promo, c.o_bank, c.o_cover INTO v_promo, v_bank_only, v_bank
    FROM public.fn_diamond_game_cover_lock(v_host, v_kind) c;
  SELECT COALESCE(p.diamonds, 0) INTO v_owner_dia FROM public.profiles p WHERE p.id = v_owner;

  -- ── eligibility: the affordability gate ────────────────────────────────────
  FOR seg IN SELECT * FROM public.wheel_segments g WHERE g.version = cfg.segment_version ORDER BY g.ord LOOP
    IF seg.kind = 'chips' THEN
      -- There is no welcome branch here any more. The budget was asked about
      -- the WHOLE table before the spin was allowed, so on a welcome spin every
      -- tier is affordable by construction and none of them may be locked for
      -- being expensive. The exposure gate below is the paid wheel's alone: a
      -- welcome spin took nothing in, so it may not lean on what the paid game
      -- took in either.
      IF NOT p_welcome AND pool.chips_paid + seg.amount * v_mult > v_intake_chips + cfg.exposure_allowance_chips THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'exposure',
                      'unlocks_at', round(pool.chips_paid + seg.amount * v_mult - cfg.exposure_allowance_chips, 2));
        CONTINUE;
      END IF;
      IF v_bank < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'cover', 'unlocks_at', round(seg.amount * v_mult, 2));
        CONTINUE;
      END IF;
    ELSIF seg.kind = 'diamonds' THEN
      -- THE PAID WHEEL'S FLOAT IS NOT THE GIFT'S TO SPEND (audit 2026-09-11).
      -- A welcome diamond prize comes from the owner and is charged to the
      -- welcome budget, which was checked just above. Gating it on the paid
      -- float as well locked tiers a club had every right to give away, and
      -- draining that float for it made the paid wheel pay for the welcome.
      IF NOT p_welcome AND pool.diamond_float + v_dia_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'diamond_float',
                      'unlocks_at', round(seg.amount * v_mult - v_dia_now, 0));
        CONTINUE;
      END IF;
      IF v_owner_dia + v_dia_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'owner_diamonds',
                      'unlocks_at', round(seg.amount * v_mult, 0));
        CONTINUE;
      END IF;
    END IF;
    v_eligible := v_eligible || seg.ord;
    v_total := v_total + seg.weight;
  END LOOP;
  IF p_bonus_ticket_id IS NOT NULL AND jsonb_array_length(v_locked)>0 THEN
    RETURN jsonb_build_object('ok',false,'error','The Host Must Cover The Whole Bonus Spin Table','locked',v_locked);
  END IF;
  IF v_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No Prize Can Be Paid Right Now. Try Again Shortly', 'locked', v_locked);
  END IF;

  -- ── the roll: committed seed, player seed, per-player nonce ────────────────
  SELECT count(*) + 1 INTO v_nonce FROM public.wheel_spins s WHERE s.user_id = v_user;
  v_hmac := extensions.hmac(convert_to(v_client || ':' || v_nonce::text, 'UTF8'),
                            convert_to(cm.server_seed, 'UTF8'), 'sha256');
  v_roll  := (('x' || encode(substring(v_hmac from 1 for 6), 'hex'))::bit(48)::bigint)::numeric;
  v_point := floor(v_roll * v_total / c_two48);
  v_acc := 0;
  FOR seg IN SELECT * FROM public.wheel_segments g
              WHERE g.version = cfg.segment_version AND g.ord = ANY (v_eligible) ORDER BY g.ord LOOP
    v_acc := v_acc + seg.weight;
    IF v_point < v_acc THEN v_pick := seg; v_found := true; EXIT; END IF;
  END LOOP;
  IF NOT v_found THEN
    SELECT * INTO v_pick FROM public.wheel_segments g
     WHERE g.version = cfg.segment_version AND g.ord = v_eligible[array_length(v_eligible, 1)];
  END IF;

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

  -- ── 2. the prize ───────────────────────────────────────────────────────────
  IF v_pick.kind = 'chips' THEN
    v_prize_chips := round(v_pick.amount * v_mult, 2);
    v_value_chips := v_prize_chips;
    IF v_bank < v_prize_chips THEN
      RAISE EXCEPTION 'fn_wheel_spin_core: the host cover % is below the prize % after the gate passed', v_bank, v_prize_chips;
    END IF;
    -- ONE PAYER FOR EVERY CHIP THE DIAMOND GAMES PAY. The promo wallet goes
    -- first and the host's own bank covers whatever is left (Dan 2026-09-10),
    -- journaled from the paying side so each row names the column the chips
    -- left, and the member side stands down so nothing is journaled twice.
    SELECT * INTO v_pay FROM public.fn_diamond_game_pay_chips(
      'wheel_prize', v_host, v_kind, p_club_id, v_user, v_prize_chips,
      'wheel-prize:' || v_spin_id::text,
      format('Diamond Wheel: %s', v_pick.label),
      jsonb_build_object('spin_id', v_spin_id, 'host_id', v_host, 'host_kind', v_kind,
                         'segment_version', cfg.segment_version, 'ord', v_pick.ord,
                         'welcome', p_welcome,'bonus_ticket_id',p_bonus_ticket_id,
                         'entry_funded_by',CASE WHEN p_bonus_ticket_id IS NOT NULL THEN 'mint' ELSE 'player' END));
    v_member_after := v_pay.member_after;
    v_bank_after   := v_pay.cover_after;
    v_promo        := v_pay.promo_after;
    v_bank_only    := v_pay.bank_after;
    v_bank := v_bank_after;
  ELSIF v_pick.kind = 'diamonds' THEN
    v_prize_dia := (v_pick.amount * v_mult)::integer;
    v_value_chips := round(v_prize_dia::numeric / v_rate, 4);
    -- The diamond prize is paid BY THE HOST'S OWNER, out of what the wheel took
    -- in (Dan 2026-09-10). Two transfer legs, one transaction; nothing is issued.
    PERFORM public.fn_diamond_game_pay_diamonds(v_owner, v_user, v_prize_dia,
              format('Diamond Wheel: %s', v_pick.label), 'wheel:' || v_spin_id::text || ':prize');
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
                       - CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,
         diamonds_paid = diamonds_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,
         -- constrained_spins is a rate over `spins`, and a welcome spin is not
         -- one of those, so counting it here made the operator's lock rate able
         -- to exceed 1 (audit 2026-09-11).
         constrained_spins = constrained_spins
                           + CASE WHEN NOT p_welcome AND jsonb_array_length(v_locked) > 0 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = v_host
   RETURNING * INTO pool;
  IF pool.chips_paid > round(pool.intake_diamonds::numeric / v_rate, 2) + cfg.exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin_core: chips_paid % would exceed the chips taken in % + allowance % - the gate was bypassed',
      pool.chips_paid, round(pool.intake_diamonds::numeric / v_rate, 2), cfg.exposure_allowance_chips;
  END IF;
  -- The window is what is bounded now, not the lifetime total, and the row for
  -- THIS spin is not written until a few lines below - so the assertion is made
  -- on the figure the gate used plus what this spin just paid. Both were read
  -- under the config lock, so no other spin on this host can have moved them.
  IF p_welcome AND v_welcome_spent + v_value_chips > cfg.welcome_budget_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin_core: the welcome window has paid % against a budget of % - the gate was bypassed',
      v_welcome_spent + v_value_chips, cfg.welcome_budget_chips;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  IF v_member_after IS NULL THEN
    SELECT COALESCE(m.chip_balance, 0) INTO v_member_after FROM public.club_members m
     WHERE m.club_id = p_club_id AND m.user_id = v_user LIMIT 1;
  END IF;

  INSERT INTO public.wheel_spins
    (id, host_id, host_kind, club_id, user_id, segment_version, spin_price_diamonds, multiplier, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, roll, weight_total, eligible_ords, locked,
     outcome_ord, outcome_kind, outcome_amount, prize_value_chips, chips_minted, diamond_accrual,
     pool_chips_minted_after, pool_chips_paid_after, pool_diamond_float_after, diamonds_after, member_chips_after,
     is_fixture, is_welcome, bonus_ticket_id)
  VALUES
    (v_spin_id, v_host, v_kind, p_club_id, v_user, cfg.segment_version,
     CASE WHEN p_welcome THEN 0 ELSE v_price END, v_mult, v_rate,
     cm.id, cm.server_seed_hash, cm.server_seed, v_client, v_nonce, v_roll, v_total, v_eligible, v_locked,
     v_pick.ord, v_pick.kind, v_pick.amount * v_mult, v_value_chips, 0, v_dia_now,
     pool.chips_minted, pool.chips_paid, pool.diamond_float, v_dia_after, v_member_after,
     v_is_fixture, p_welcome, p_bonus_ticket_id)
  RETURNING * INTO prior;
  UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;

  IF p_bonus_ticket_id IS NOT NULL THEN
    UPDATE public.diamond_bonus_spin_tickets SET redeemed_spin_id=v_spin_id,redeemed_at=transaction_timestamp()
     WHERE id=p_bonus_ticket_id;
  END IF;
  RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', false);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_wheel_spin_core(uuid,uuid,text,boolean,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin_core(uuid,uuid,text,boolean,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_wheel_spin_result(s wheel_spins)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'ok', true, 'welcome', COALESCE(s.is_welcome, false),
    'daily_bonus',s.bonus_ticket_id IS NOT NULL,'bonus_ticket_id',s.bonus_ticket_id,
    'player_cost_diamonds',CASE WHEN s.is_welcome OR s.bonus_ticket_id IS NOT NULL THEN 0 ELSE s.spin_price_diamonds END,
    'entry_value_diamonds',CASE WHEN s.is_welcome OR s.bonus_ticket_id IS NOT NULL THEN 100 ELSE s.spin_price_diamonds END,
    'entry_funded_by',CASE WHEN s.bonus_ticket_id IS NOT NULL THEN 'mint' WHEN s.is_welcome THEN 'welcome' ELSE 'player' END,
    'spin_id', s.id, 'club_id', s.club_id, 'host_id', s.host_id,
    'segment_version', s.segment_version, 'spin_price_diamonds', s.spin_price_diamonds,
    'diamonds_per_chip', s.diamonds_per_chip,
    'outcome', jsonb_build_object('ord', s.outcome_ord, 'kind', s.outcome_kind, 'amount', s.outcome_amount,
                                  'label', (SELECT g.label FROM public.wheel_segments g
                                             WHERE g.version = s.segment_version AND g.ord = s.outcome_ord),
                                  'value_chips', s.prize_value_chips),
    'fairness', jsonb_build_object('commit_id', s.commit_id, 'server_seed_hash', s.server_seed_hash,
                                   'server_seed', s.server_seed, 'client_seed', s.client_seed,
                                   'nonce', s.nonce, 'roll', s.roll, 'weight_total', s.weight_total,
                                   'eligible_ords', to_jsonb(s.eligible_ords), 'locked', s.locked),
    'balances', jsonb_build_object('diamonds', s.diamonds_after, 'member_chips', s.member_chips_after),
    'pool', jsonb_build_object('chips_paid', s.pool_chips_paid_after,
                               'diamond_float', s.pool_diamond_float_after),
    'created_at', s.created_at);
$function$
;
REVOKE ALL ON FUNCTION public.fn_wheel_spin_result(wheel_spins) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin_result(wheel_spins) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin_result(wheel_spins) TO authenticated;
SET check_function_bodies=on;

