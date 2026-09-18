-- Exact installed Crash dependencies; captured September 17 for the isolated fixture.
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
CREATE OR REPLACE FUNCTION public.fn_crash_multiplier_cents(p_k numeric, p_elapsed_ms bigint, p_cap_cents integer)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT LEAST(p_cap_cents::numeric,
               floor(exp(LEAST(p_k * GREATEST(p_elapsed_ms, 0)::numeric / 1000, 12::numeric)) * 100))::integer;
$function$
;
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
CREATE OR REPLACE FUNCTION public.fn_crash_settle(p_round_id uuid, p_cashout boolean)
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
  r := public.fn_crash_decide(r, COALESCE(p_cashout, false), CASE WHEN COALESCE(p_cashout, false) THEN 'player' ELSE 'tick' END);
  RETURN public.fn_crash_round_result(r);
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_prize_leg(p_game text, p_host uuid, p_kind text, p_club uuid, p_user uuid, p_amount numeric, p_key text, p_note text, p_meta jsonb, OUT bank_after numeric, OUT member_after numeric)
 RETURNS record
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pay record;
BEGIN
  IF COALESCE(p_amount, 0) <= 0 THEN
    RETURN;
  END IF;
  SELECT * INTO v_pay FROM public.fn_diamond_game_pay_chips(
    p_game || '_prize', p_host, p_kind, p_club, p_user, p_amount, p_key, p_note, p_meta);
  bank_after   := v_pay.cover_after;
  member_after := v_pay.member_after;
END $function$
;
DO $$ DECLARE sig text; BEGIN
 FOR sig IN SELECT oid::regprocedure::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('fn_crash_multiplier_cents','fn_crash_round_result','fn_diamond_game_prize_leg','fn_crash_decide','fn_crash_settle') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated'; EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO service_role';
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION fn_crash_settle(uuid,boolean) TO authenticated;

