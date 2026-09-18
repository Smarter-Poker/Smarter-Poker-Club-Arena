-- Preserve server crash/auto/cap precedence and every existing money leg.
-- Old clients/ticks retain the three-argument function. New clicks bind their displayed multiplier.
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
CREATE OR REPLACE FUNCTION public.fn_crash_decide(p_round crash_rounds,p_cashout boolean,p_by text)
RETURNS crash_rounds LANGUAGE sql SET search_path=public AS $fn$
 SELECT public.fn_crash_decide(p_round,p_cashout,p_by,NULL::integer)
$fn$;
CREATE OR REPLACE FUNCTION public.fn_crash_cashout(p_round_id uuid, p_multiplier_cents integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  r public.crash_rounds;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Play');
  END IF;
  IF p_multiplier_cents IS NULL OR p_multiplier_cents < 101 THEN
    RETURN jsonb_build_object('ok',false,'error','Cash Out Starts At 1.01x');
  END IF;
  SELECT * INTO r FROM public.crash_rounds WHERE id = p_round_id;
  IF r.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Round Could Not Be Found');
  END IF;
  IF r.user_id <> v_user AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Round Belongs To Another Player');
  END IF;
  IF r.status <> 'open' THEN
    RETURN public.fn_crash_round_result(r);
  END IF;
  IF public.fn_platform_frozen() THEN
    -- The clock is frozen with the platform: the round waits, nothing is decided.
    RETURN public.fn_crash_round_result(r) || jsonb_build_object('frozen', true);
  END IF;
  -- The host lock serialises settlement with new rounds on the same pool.
  PERFORM 1 FROM public.diamond_game_configs WHERE host_id = r.host_id AND game = 'crash' FOR UPDATE;
  SELECT * INTO r FROM public.crash_rounds WHERE id = p_round_id FOR UPDATE;
  r := public.fn_crash_decide(r, true, 'player', p_multiplier_cents);
  RETURN public.fn_crash_round_result(r);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_crash_decide(crash_rounds,boolean,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_crash_decide(crash_rounds,boolean,text,integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_crash_cashout(uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_crash_cashout(uuid,integer) TO authenticated,service_role;

