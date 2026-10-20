BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF md5(pg_get_functiondef('public.fn_crash_decide(public.crash_rounds,boolean,text,integer)'::regprocedure))
       NOT IN ('a7edd547abe848646bd0584198f06263')
     OR md5(pg_get_functiondef('public.fn_crash_round_result(public.crash_rounds)'::regprocedure))
       NOT IN ('2f6f9eff944e0a3d679b52c33169215b')
     OR md5(pg_get_functiondef('public.fn_crash_settle_decided(uuid)'::regprocedure))
       NOT IN ('67d298efb55632524e248b99153b98b6') THEN
    RAISE EXCEPTION 'the crash clock migration was written against bodies production no longer runs';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_crash_flight_ms(p_started timestamptz, p_at timestamptz)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH frozen AS (
    SELECT t.freeze_started_at AS s,
           t.freeze_started_at + make_interval(secs => t.frozen_seconds::double precision) AS e
      FROM public.engine_maintenance_thaws t
     WHERE t.freeze_started_at < p_at
       AND t.freeze_started_at > p_started - INTERVAL '1 day'
    UNION ALL
    SELECT x.s, p_at
      FROM (SELECT COALESCE(b.break_started_at, b.announced_at + INTERVAL '2 minutes') AS s
              FROM public.engine_maintenance_break b
             WHERE b.enforce_freeze) x
     WHERE x.s < p_at
       AND NOT EXISTS (SELECT 1 FROM public.engine_maintenance_thaws t WHERE t.freeze_started_at = x.s)
  )
  SELECT GREATEST(0::numeric,
           floor(extract(epoch FROM (p_at - p_started)) * 1000)
           - COALESCE(sum(GREATEST(0::numeric,
               extract(epoch FROM (LEAST(f.e, p_at) - GREATEST(f.s, p_started))) * 1000)), 0)
         )::bigint
    FROM frozen f
$function$;

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
  -- THE FLIGHT CLOCK STOPS FOR THE BREAK (2026-10-20). Wall time since
  -- started_at minus every platform freeze the round sat through.
  v_elapsed_ms := public.fn_crash_flight_ms(r.started_at, clock_timestamp());
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
  ELSIF p_cashout AND v_now_cents >= (CASE WHEN r.payout_version >= 5 THEN 126 WHEN r.payout_version >= 4 THEN 111 ELSE 101 END) THEN
    -- Honor the displayed hundredth, never a later, inflated receipt-time multiplier.
    -- The server has already checked the sealed crash; client timestamps cannot revive a loss.
    IF p_displayed_cents IS NOT NULL AND (p_displayed_cents < (CASE WHEN r.payout_version >= 5 THEN 126 WHEN r.payout_version >= 4 THEN 111 ELSE 101 END) OR p_displayed_cents > v_now_cents) THEN
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
END $function$;

CREATE OR REPLACE FUNCTION public.fn_crash_round_result(r crash_rounds)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  SELECT public.fn_wheel_award_receipt(r.commit_id)||jsonb_build_object(
    'ok', true, 'game', 'crash', 'round_id', r.id, 'club_id', r.club_id, 'host_id', r.host_id,
    'status', r.status, 'bet_diamonds', r.bet_diamonds, 'bet_chips', r.bet_chips,
    'diamonds_per_chip', r.diamonds_per_chip,
    'minimum_payout_chips',r.minimum_payout_chips,'payout_version',COALESCE(r.payout_version,CASE WHEN r.minimum_payout_chips<=0 THEN 1 WHEN r.minimum_payout_chips=public.fn_diamond_bonus_minimum(r.bet_chips,2) THEN 3 ELSE 2 END),'cashout_floor_cents',CASE WHEN r.payout_version>=5 THEN 126 WHEN r.payout_version>=4 THEN 111 ELSE 101 END,'crash_floor_cents',CASE WHEN r.payout_version>=5 THEN 125 WHEN r.payout_version>=4 THEN 110 ELSE 100 END,
    'crash_return_ppm',CASE WHEN r.payout_version>=5 THEN public.fn_crash_return_ppm_v5(r.bet_chips,r.minimum_payout_chips) ELSE 800000 END,
    'cap_cents', r.cap_cents, 'growth_k', r.growth_k, 'auto_cashout_cents', r.auto_cashout_cents,
    'started_at', r.started_at, 'server_now', clock_timestamp(),
    'elapsed_ms', CASE WHEN r.status = 'open'
                       THEN public.fn_crash_flight_ms(r.started_at, clock_timestamp())
                       ELSE r.elapsed_ms END,
    'multiplier_now_cents', CASE WHEN r.status = 'open'
                       THEN public.fn_crash_multiplier_cents(r.growth_k,
                              public.fn_crash_flight_ms(r.started_at, clock_timestamp()), r.cap_cents) END,
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_crash_settle_decided(p_host uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE r public.crash_rounds; v_n integer := 0; v_after public.crash_rounds;
BEGIN
  FOR r IN SELECT * FROM public.crash_rounds c
            WHERE c.host_id = p_host AND c.status = 'open'
              AND public.fn_crash_flight_ms(c.started_at, clock_timestamp())
                  >= ((ln(c.cap_cents::numeric / 100) / c.growth_k) + 0.05) * 1000
            ORDER BY c.started_at FOR UPDATE LOOP
    v_after := public.fn_crash_decide(r, false, 'time');
    IF v_after.status <> 'open' THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END $function$;

REVOKE ALL ON FUNCTION public.fn_crash_flight_ms(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_crash_flight_ms(timestamptz, timestamptz) TO service_role;

COMMIT;
