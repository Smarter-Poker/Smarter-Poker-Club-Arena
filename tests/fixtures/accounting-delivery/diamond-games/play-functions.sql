-- Captured installed game functions, September 17. Real dependencies for isolated denomination qualification.
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

CREATE OR REPLACE FUNCTION public.fn_diamond_round_chip_cents(p_exact numeric, p_server text, p_message text)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE cents numeric:=p_exact*100; roll numeric;
BEGIN
 IF p_exact<0 THEN RAISE EXCEPTION 'A Prize Cannot Be Negative'; END IF;
 roll:=('x'||substr(encode(extensions.hmac(p_message,p_server,'sha256'),'hex'),1,12))::bit(48)::bigint;
 RETURN (floor(cents)+CASE WHEN (roll+1)<= (cents-floor(cents))*281474976710656::numeric THEN 1 ELSE 0 END)/100;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_diamond_bonus_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF TG_OP='UPDATE' AND OLD.result IS NULL AND NEW.result IS NOT NULL
  AND to_jsonb(OLD)-ARRAY['result','total_diamonds']=to_jsonb(NEW)-ARRAY['result','total_diamonds'] THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'A Saved Bonus Cannot Be Rewritten';
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_diamond_bonus_start(p_club_id uuid, p_game text, p_base_diamonds integer, p_double boolean, p_commit_id uuid, p_client_seed text, p_mode text DEFAULT NULL::text, p_denom integer DEFAULT NULL::integer, p_table_version integer DEFAULT NULL::integer, p_auto_cashout_cents integer DEFAULT NULL::integer, p_max_steps integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
END $function$
;


DO $$ DECLARE sig text; BEGIN
 FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('fn_diamond_bonus_start','fn_diamond_game_admit','fn_diamond_game_cap_cents','fn_diamond_game_take_bet','fn_diamond_round_chip_cents') LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO service_role';
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION fn_diamond_bonus_start(uuid,text,integer,boolean,uuid,text,text,integer,integer,integer,integer) TO authenticated;
