-- ============================================================================
-- 20260830112000_spin_draw_settle_concurrency_hardening.sql
-- TIER: 3 | AFFECTS: fn_spin_draw_multiplier, fn_spin_settle_game,
--                    fn_spin_seed_instalment (recorded verbatim for replay).
-- Applied to production via the Supabase MCP on 2026-08-30.
--
-- THREE FIXES FROM THE 2026-08-30 SPINS AUDIT:
--
-- 1. REPLAYABILITY. The instalment-plan bodies of fn_spin_seed_instalment and
--    fn_spin_settle_game existed only in production; a fresh replay of the
--    migration set installed the retired lump-sum settle from
--    20260823140500 and then failed 20260823200000's guard. This migration
--    IS the repo record of the live bodies (plus fixes 2-3 below).
--
-- 2. CONCURRENT DRAW GATE. fn_spin_draw_multiplier read the pool balance
--    with no lock and no view of sibling draws, so N simultaneous spins on
--    one pool could each pass the affordability gate against the same
--    balance. Now: the pool row is locked FOR UPDATE (draws serialize with
--    each other and with settles) and prizes drawn-but-not-yet-settled in
--    the last 24h are subtracted from the spendable balance.
--
-- 3. SETTLE RETURNS THE BOOKED TRUTH. A crash between settle and the
--    tournament-row write left spin_multiplier NULL; the restart redrew and
--    fn_spin_settle_game answered bare 'already_settled', so the game could
--    pay a different prize than the ledger booked. The already_settled
--    branch now returns the multiplier and drawn prize it originally booked
--    so the engine can adopt them (engine change ships alongside in
--    TournamentManagerBase.ts).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_spin_seed_instalment(p_balance numeric, p_outstanding numeric, p_floor numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN COALESCE(p_outstanding,0) <= 0 OR COALESCE(p_floor,0) <= 0 THEN 0
    WHEN COALESCE(p_balance,0) < p_floor * 1.25 THEN 0
    WHEN (p_balance - p_floor) <= 0 THEN 0
    ELSE (
      SELECT CASE WHEN v >= 1 THEN v ELSE 0 END
      FROM (SELECT round(LEAST(p_outstanding, (p_balance - p_floor) * 0.5), 2) AS v) q
    )
  END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_spin_draw_multiplier(p_club_id uuid, p_buy_in numeric, p_tiers jsonb, p_rake_rate numeric DEFAULT 0.08, p_seats integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_bal numeric := 0; v_stake numeric := 0; v_contrib numeric := 0;
  v_eligible jsonb := '[]'::jsonb; v_tier jsonb;
  v_total numeric := 0; v_roll numeric; v_acc numeric := 0;
  v_pick numeric := NULL; v_locked jsonb := '[]'::jsonb;
  v_prize numeric; v_thr numeric; v_owner uuid;
  v_pending numeric := 0;
BEGIN
  v_owner := public.fn_spin_reserve_pool(p_club_id);

  -- FOR UPDATE: concurrent draws on the same pool serialize here (and with
  -- fn_spin_settle_game, which locks the same row), so two spins can no
  -- longer pass the affordability gate against the same chips.
  SELECT balance, GREATEST(highest_stake, COALESCE(p_buy_in,0))
    INTO v_bal, v_stake FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  -- Prizes already drawn against this pool but not yet settled: their spin
  -- rows carry a multiplier while no jackpot_draw ledger row exists yet.
  -- Bounded to 24h; anything older is the sweep's business, and the settle
  -- normally follows its draw within milliseconds.
  SELECT COALESCE(sum(round(t.buy_in_amount * t.spin_multiplier, 2)), 0)
    INTO v_pending
    FROM public.tournaments t
   WHERE t.variant = 'spin'
     AND t.spin_multiplier IS NOT NULL
     AND t.created_at > now() - interval '24 hours'
     AND t.status NOT IN ('COMPLETED','CANCELLED','CANCELED')
     AND public.fn_spin_reserve_pool(t.club_id) = v_owner
     AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                     WHERE l.tournament_id = t.id AND l.kind = 'jackpot_draw');
  v_bal := v_bal - v_pending;

  v_contrib := round(COALESCE(p_buy_in,0) * COALESCE(p_seats,3)
                     * (1 - COALESCE(p_rake_rate,0.08)), 2);

  FOR v_tier IN SELECT * FROM jsonb_array_elements(p_tiers) LOOP
    v_prize := (v_tier->>'multiplier')::numeric * COALESCE(p_buy_in,0);
    v_thr   := COALESCE((v_tier->>'reserveThresholdX')::numeric, 0);

    IF (v_bal + v_contrib) < v_prize THEN
      v_locked := v_locked || jsonb_build_object(
        'multiplier', (v_tier->>'multiplier')::numeric,
        'reason', 'unaffordable',
        'unlocksAt', round(v_prize - v_contrib, 2));
    ELSIF v_thr > 0 AND v_bal < (v_tier->>'multiplier')::numeric * v_stake * v_thr THEN
      v_locked := v_locked || jsonb_build_object(
        'multiplier', (v_tier->>'multiplier')::numeric,
        'reason', 'threshold',
        'unlocksAt', round((v_tier->>'multiplier')::numeric * v_stake * v_thr, 2));
    ELSE
      v_eligible := v_eligible || v_tier;
      v_total := v_total + COALESCE((v_tier->>'freq')::numeric, 0);
    END IF;
  END LOOP;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_eligible_tiers',
      'reserve_balance', v_bal, 'locked', v_locked, 'owner_id', v_owner);
  END IF;

  v_roll := (('x' || encode(extensions.gen_random_bytes(6),'hex'))::bit(48)::bigint)::numeric
            / 281474976710656::numeric * v_total;

  FOR v_tier IN SELECT * FROM jsonb_array_elements(v_eligible) LOOP
    v_acc := v_acc + COALESCE((v_tier->>'freq')::numeric,0);
    IF v_roll < v_acc THEN v_pick := (v_tier->>'multiplier')::numeric; EXIT; END IF;
  END LOOP;
  IF v_pick IS NULL THEN
    v_pick := (v_eligible -> (jsonb_array_length(v_eligible)-1) ->> 'multiplier')::numeric;
  END IF;

  RETURN jsonb_build_object('ok', true, 'multiplier', v_pick,
    'reserve_balance', v_bal, 'highest_stake', v_stake,
    'contribution', v_contrib, 'locked', v_locked, 'owner_id', v_owner,
    'eligible_count', jsonb_array_length(v_eligible));
END; $function$;

CREATE OR REPLACE FUNCTION public.fn_spin_settle_game(p_tournament_id uuid, p_club_id uuid, p_buy_in numeric, p_seats integer, p_multiplier numeric, p_rake_rate numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_collected numeric; v_rake numeric; v_reserve_in numeric;
  v_prize numeric; v_bal numeric; v_available numeric;
  v_shortfall numeric := 0; v_drawn numeric;
  v_owner uuid; v_kind text; v_seed numeric; v_wallet text;
  v_floor numeric; v_instalment numeric := 0;
  v_seed_returned numeric := 0; v_wallet_after numeric := NULL;
  v_booked_mult numeric; v_booked_drawn numeric;
BEGIN
  IF COALESCE(p_buy_in,0) <= 0 OR COALESCE(p_seats,0) <= 0 OR COALESCE(p_multiplier,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;

  v_owner := public.fn_spin_reserve_pool(p_club_id);

  SELECT balance INTO v_bal
    FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
             WHERE tournament_id = p_tournament_id AND kind IN ('contribution','jackpot_draw')) THEN
    -- Return the multiplier and prize this settlement ORIGINALLY booked, so
    -- a restarted engine that redrew after a crash can adopt the booked
    -- truth instead of paying a prize the ledger never saw.
    SELECT l.multiplier, -l.amount INTO v_booked_mult, v_booked_drawn
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id AND l.kind = 'jackpot_draw'
     ORDER BY l.created_at ASC LIMIT 1;
    IF v_booked_mult IS NULL THEN
      SELECT l.multiplier INTO v_booked_mult
        FROM public.spin_reserve_ledger l
       WHERE l.tournament_id = p_tournament_id AND l.kind = 'contribution'
       ORDER BY l.created_at ASC LIMIT 1;
    END IF;
    RETURN jsonb_build_object('ok', true, 'reason', 'already_settled',
      'multiplier', v_booked_mult, 'pool_covered', v_booked_drawn);
  END IF;

  v_collected  := round(p_buy_in * p_seats, 2);
  v_rake       := round(v_collected * COALESCE(p_rake_rate, 0.08), 2);
  v_reserve_in := round(v_collected - v_rake, 2);
  v_prize      := round(p_buy_in * p_multiplier, 2);

  UPDATE public.spin_bonus_pools
     SET balance = balance + v_reserve_in,
         total_deposited = total_deposited + v_reserve_in,
         spin_count = spin_count + 1,
         highest_stake = GREATEST(highest_stake, p_buy_in),
         updated_at = now()
   WHERE club_id = v_owner RETURNING balance INTO v_available;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'spin pool row missing for owner % settling tournament %',
      v_owner, p_tournament_id;
  END IF;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (v_owner, p_tournament_id, 'contribution', v_reserve_in, v_available,
          p_multiplier, p_buy_in, p_seats, v_rake,
          CASE WHEN v_owner = p_club_id THEN 'buy-ins less fixed rake'
               ELSE format('buy-ins less fixed rake (club %s)', p_club_id) END);

  IF v_prize > v_available THEN
    v_shortfall := round(v_prize - v_available, 2);
    v_drawn := v_available;
  ELSE
    v_drawn := v_prize;
  END IF;

  UPDATE public.spin_bonus_pools
     SET balance = balance - v_drawn,
         total_drawn = total_drawn + v_drawn,
         bonus_count = bonus_count + CASE WHEN p_multiplier >= 10 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE club_id = v_owner RETURNING balance INTO v_bal;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (v_owner, p_tournament_id, 'jackpot_draw', -v_drawn, v_bal,
          p_multiplier, p_buy_in, p_seats, v_rake,
          CASE WHEN v_shortfall > 0
               THEN format('prize pool (pool covered %s of %s)', v_drawn, v_prize)
               ELSE 'prize pool' END);

  IF v_shortfall > 0 THEN
    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, note)
    VALUES (v_owner, p_tournament_id, 'adjustment', 0, v_bal,
            p_multiplier, p_buy_in, p_seats,
            format('SHORTFALL %s covered by operator - pool was too thin for a %sx. Seed it.',
                   v_shortfall, p_multiplier));
  END IF;

  IF v_rake > 0 AND p_club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, p_club_id, v_rake, v_collected, p_seats, 0, true,
            p_tournament_id, 'fn_spin_settle_game',
            jsonb_build_object('kind','spin_rake','multiplier',p_multiplier,
                               'buy_in',p_buy_in,'rake_rate',p_rake_rate,
                               'shortfall',v_shortfall,'reserve_owner',v_owner));
  END IF;

  -- THE REPAYMENT PLAN - one instalment per settle, at most.
  SELECT seeded_amount, seed_source_wallet, owner_kind, required_seed_at_activation
    INTO v_seed, v_wallet, v_kind, v_floor
    FROM public.spin_bonus_pools WHERE club_id = v_owner;

  v_instalment := public.fn_spin_seed_instalment(v_bal, COALESCE(v_seed,0), COALESCE(v_floor,0));

  IF v_instalment > 0 AND v_wallet IS NOT NULL THEN
    v_wallet_after := public.fn_spin_move_owner_wallet(v_owner, v_kind, v_wallet, v_instalment);

    IF v_wallet_after IS NOT NULL THEN
      UPDATE public.spin_bonus_pools
         SET balance              = balance - v_instalment,
             seeded_amount        = seeded_amount - v_instalment,
             seed_returned_amount = seed_returned_amount + v_instalment,
             seed_returned_at     = now(),
             required_seed_at_activation =
               CASE WHEN seeded_amount - v_instalment <= 0 THEN 0
                    ELSE required_seed_at_activation END,
             updated_at           = now()
       WHERE club_id = v_owner RETURNING balance INTO v_bal;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'spin pool row vanished for owner % after repaying % to %',
          v_owner, v_instalment, v_wallet;
      END IF;

      v_seed_returned := v_instalment;

      INSERT INTO public.spin_reserve_ledger
        (club_id, tournament_id, kind, amount, balance_after, note)
      VALUES (v_owner, p_tournament_id, 'seed_return', -v_instalment, v_bal,
              format('seed instalment to %s %s - 50%% of %s above a floor of %s; %s still owed',
                     v_kind, v_wallet, round(v_bal + v_instalment - v_floor, 2), v_floor,
                     GREATEST(COALESCE(v_seed,0) - v_instalment, 0)));
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in, 'prize_pool', v_prize,
    'pool_covered', v_drawn, 'operator_shortfall', v_shortfall,
    'balance', v_bal, 'seed_returned', v_seed_returned,
    'seed_outstanding', GREATEST(COALESCE(v_seed,0) - v_seed_returned, 0),
    'owner_id', v_owner, 'source_wallet_after', v_wallet_after);
END;
$function$;

-- Definer Authorization (added same day, applied as 20260830114000): the
-- settle moves pool money and is the ENGINE's alone.
REVOKE ALL ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric) TO service_role;
