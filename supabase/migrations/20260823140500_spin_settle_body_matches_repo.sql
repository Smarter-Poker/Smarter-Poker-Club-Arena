-- ============================================================================
-- MAKE PRODUCTION'S SETTLE BODY MATCH THE MIGRATION FILE
--
-- 20260823140000 was applied with the explanatory comments inside
-- fn_spin_settle_game stripped out. That was not a style choice, it was forced:
-- that version's own assertion grepped the function body for the word
-- "ceiling_amount", and pg_get_functiondef returns COMMENTS as well as code --
-- so the paragraph explaining why the ceiling was retired would have tripped
-- the assertion on its own explanation.
--
-- The assertion in that file now matches the SWEEP'S SIGNATURE
-- (surplus_returned = surplus_returned) rather than the noun, so the comments
-- can live in the body where they earn their keep. This replays the function
-- exactly as the repo file has it, so the migration file and the live database
-- are the same text.
--
-- BEHAVIOUR IS IDENTICAL. Comments only. The assertions below prove both halves:
-- the sweep is gone, and the commented version is what landed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_spin_settle_game(
  p_tournament_id uuid, p_club_id uuid, p_buy_in numeric,
  p_seats integer, p_multiplier numeric, p_rake_rate numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_collected numeric; v_rake numeric; v_reserve_in numeric;
  v_prize numeric; v_bal numeric; v_available numeric;
  v_shortfall numeric := 0; v_drawn numeric;
  v_owner uuid; v_kind text; v_seed numeric; v_wallet text;
  v_required numeric; v_collected_play numeric; v_max_stake numeric;
  v_seed_returned numeric := 0; v_wallet_after numeric := NULL;
BEGIN
  IF COALESCE(p_buy_in,0) <= 0 OR COALESCE(p_seats,0) <= 0 OR COALESCE(p_multiplier,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;
  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
             WHERE tournament_id = p_tournament_id AND kind IN ('contribution','jackpot_draw')) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_settled');
  END IF;

  v_collected  := round(p_buy_in * p_seats, 2);
  v_rake       := round(v_collected * COALESCE(p_rake_rate, 0.08), 2);
  v_reserve_in := round(v_collected - v_rake, 2);
  v_prize      := round(p_buy_in * p_multiplier, 2);

  v_owner := public.fn_spin_reserve_pool(p_club_id);

  SELECT balance INTO v_bal
    FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  UPDATE public.spin_bonus_pools
     SET balance = balance + v_reserve_in,
         total_deposited = total_deposited + v_reserve_in,
         spin_count = spin_count + 1,
         highest_stake = GREATEST(highest_stake, p_buy_in),
         updated_at = now()
   WHERE club_id = v_owner RETURNING balance INTO v_available;

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

  -- Rake belongs to the PLAYING club, not the pool owner. Unchanged: this is
  -- the revenue line Dan means by "RAKE GOES INTO THE RAKE TREASURY".
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

  -- ── THE SEED COMES BACK ─────────────────────────────────────────────────
  -- Dan: the seed is "RETURNED ONCE ENOUGH IS COLLECTED". Enough means play
  -- alone has collected at least what the seed was required to be, so the pool
  -- now stands on its own. total_deposited only ever accumulates from
  -- settlement and never from a seed, so the seed is never repaid out of itself.
  --
  -- WHAT REPLACED THE CEILING. This used to sweep everything above
  -- ceiling_amount back to the operator on every settle. Dan: "YES IT RETURNS
  -- EVERYTHING IT COLLECTS... BUT IT NEEDS TO COLLECT FIRST TO DISTRIBUTE."
  -- The pool is not a revenue account -- it is the float the multipliers are
  -- paid from, and capping it just re-locks the top tiers after a big hit.
  SELECT seeded_amount, seed_source_wallet, owner_kind, total_deposited, offered_max_stake
    INTO v_seed, v_wallet, v_kind, v_collected_play, v_max_stake
    FROM public.spin_bonus_pools WHERE club_id = v_owner;

  v_required := public.fn_spin_required_seed(v_max_stake);

  -- TWO conditions, and both are load-bearing:
  --
  --   v_collected_play >= v_required  play has genuinely generated at least
  --                                   the seed's worth, so the seed is never
  --                                   repaid out of itself.
  --   v_bal - v_seed   >= v_required  and after handing it back the pool STILL
  --                                   holds that much on its own.
  --
  -- The second is the one that is easy to leave out and wrong to. total_deposited
  -- is cumulative forever, so on any pool that has run for a while the first
  -- condition is true immediately -- and repaying on that alone would drain the
  -- float the instant it qualified. Measured against the live house pool at the
  -- time of writing: balance 24,964.26 with a 20,000 seed would have dropped to
  -- 4,964.26, which cannot cover a single 100x at a stake of 100, so the top of
  -- the ladder would have re-locked the moment the operator got their money back.
  --
  -- v_wallet IS NOT NULL is a deliberate refusal to guess. The one pool that
  -- predates this migration carries a 20,000 seed from before any source was
  -- recorded; it stays outstanding rather than being repaid to a wallet chosen
  -- by inference. Money does not move on a guess.
  IF COALESCE(v_seed,0) > 0 AND v_wallet IS NOT NULL AND v_required > 0
     AND v_collected_play >= v_required
     AND (v_bal - v_seed) >= v_required
  THEN
    v_wallet_after := public.fn_spin_move_owner_wallet(v_owner, v_kind, v_wallet, v_seed);

    IF v_wallet_after IS NOT NULL THEN
      UPDATE public.spin_bonus_pools
         SET balance              = balance - v_seed,
             seeded_amount        = 0,
             seed_returned_amount = seed_returned_amount + v_seed,
             seed_returned_at     = now(),
             updated_at           = now()
       WHERE club_id = v_owner RETURNING balance INTO v_bal;

      v_seed_returned := v_seed;

      INSERT INTO public.spin_reserve_ledger
        (club_id, tournament_id, kind, amount, balance_after, note)
      VALUES (v_owner, p_tournament_id, 'seed_return', -v_seed, v_bal,
              format('seed repaid to %s %s - play collected %s, pool still holds %s against a required seed of %s',
                     v_kind, v_wallet, v_collected_play, v_bal, v_required));
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in, 'prize_pool', v_prize,
    'pool_covered', v_drawn, 'operator_shortfall', v_shortfall,
    'balance', v_bal, 'seed_returned', v_seed_returned,
    'owner_id', v_owner, 'source_wallet_after', v_wallet_after);
END;
$fn$;

-- ── LOCK THE MONEY MOVERS AWAY FROM CLIENTS ────────────────────────────────

REVOKE ALL ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric) FROM anon, authenticated;

DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='fn_spin_settle_game'
                AND pg_get_functiondef(p.oid) ILIKE '%surplus_returned = surplus_returned%') THEN
    RAISE EXCEPTION 'fn_spin_settle_game still sweeps surplus to the operator';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='fn_spin_settle_game'
                AND pg_get_functiondef(p.oid) ILIKE '%THE SEED COMES BACK%') THEN
    RAISE EXCEPTION 'settle body did not take the commented version';
  END IF;
END $assert$;
