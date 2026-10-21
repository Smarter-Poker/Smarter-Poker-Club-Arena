CREATE OR REPLACE FUNCTION public.fn_complete_club_opening_setup(p_club_id uuid, p_operation_id uuid, p_tagline text, p_rake_percent numeric, p_rake_cap_bb numeric, p_bbj_enabled boolean, p_bbj_seed numeric, p_spins_enabled boolean, p_spin_seed numeric, p_spin_max_stake numeric, p_promo_enabled boolean, p_promo_type text, p_promo_name text, p_promo_description text, p_promo_budget numeric, p_leaderboard_rewards_enabled boolean, p_leaderboard_metric text, p_leaderboard_prize_budget numeric, p_leaderboard_overlay_enabled boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_club public.clubs%ROWTYPE;
  v_existing public.club_opening_setups%ROWTYPE;
  v_rake numeric := round(COALESCE(p_rake_percent, -1), 2);
  v_cap numeric := round(COALESCE(p_rake_cap_bb, -1), 2);
  v_bbj_seed numeric := round(COALESCE(p_bbj_seed, 0), 2);
  v_spin_seed numeric := round(COALESCE(p_spin_seed, 0), 2);
  v_promo_budget numeric := round(COALESCE(p_promo_budget, 0), 2);
  v_leaderboard_budget numeric := round(COALESCE(p_leaderboard_prize_budget, 0), 2);
  v_spin_required numeric := 0;
  v_other_allocation numeric := 0;
  v_total_allocation numeric := 0;
  v_spin_result jsonb := '{}'::jsonb;
  v_pool_id uuid;
  v_bbj_after numeric := 0;
  v_promo_after numeric := 0;
  v_promotion_id uuid;
  v_leaderboard_result jsonb := '{}'::jsonb;
  v_program_version integer := 0;
  v_leaderboard_overlay boolean := COALESCE(p_leaderboard_rewards_enabled, false)
    AND COALESCE(p_leaderboard_overlay_enabled, false);
  v_bank_after numeric := 0;
  v_result jsonb;
  v_tagline text := left(regexp_replace(btrim(COALESCE(p_tagline, '')), '\s+', ' ', 'g'), 72);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication Required';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'Operation ID Is Required';
  END IF;

  SELECT * INTO v_club FROM public.clubs WHERE id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club Not Found';
  END IF;

  -- ONLY THE OWNER CAN COMPLETE IT, AND EVERYONE ELSE IS REFUSED HERE
  -- (2026-09-23). Every setup publishes a leaderboard program, and
  -- publication accepts only the club's owner or co-owner. The
  -- platform-admin branch that used to pass this check could never commit:
  -- it activated Spins and debited the Club Bank, then the publish refused
  -- it with 42501 and rolled all of it back. A co-owner never passed here.
  -- The one actor who can complete the whole setup is the owner, so the
  -- owner is the rule, and the refusal comes before anything moves.
  IF v_club.owner_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only The Club Owner Can Complete Opening Setup'
      USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_club.is_union, false) OR v_club.union_id IS NOT NULL THEN
    RAISE EXCEPTION 'Union-Owned Economics Must Be Configured By The Union Lead';
  END IF;

  IF char_length(v_tagline) < 3 THEN
    RAISE EXCEPTION 'Write A Custom Club Tag Line Before Completing Setup';
  END IF;
  IF v_tagline ILIKE '%all fish of all shapes and sizes are welcome%'
     AND v_club.club_id <> 25450 THEN
    RAISE EXCEPTION 'That Tag Line Belongs To Shark Club';
  END IF;

  SELECT * INTO v_existing
  FROM public.club_opening_setups
  WHERE club_id = p_club_id
  FOR UPDATE;

  IF FOUND THEN
    v_result := jsonb_build_object(
      'success', true,
      'already_completed', true,
      'club_id', p_club_id,
      'club_bank_after', v_club.chip_treasury,
      'completed_at', v_existing.completed_at,
      'operation_id', v_existing.last_operation_id
    );
    RETURN v_result;
  END IF;

  IF COALESCE(p_leaderboard_overlay_enabled, false) THEN
    RAISE EXCEPTION 'LEADERBOARD_PROMO_ONLY|Club Bank Overlay Is Not Allowed For Leaderboard Prizes'
      USING ERRCODE = '22023';
  END IF;

  IF v_rake <> -1 AND (v_rake < 0 OR v_rake > 10) THEN
    RAISE EXCEPTION 'Rake Must Use The House Schedule Or Be Between 0 And 10 Percent';
  END IF;
  IF v_cap <> -1 AND (v_cap < 0 OR v_cap > 10) THEN
    RAISE EXCEPTION 'Rake Cap Must Use The House Schedule Or Be Between 0 And 10 Big Blinds';
  END IF;

  IF p_bbj_enabled AND v_bbj_seed < 100 THEN
    RAISE EXCEPTION 'BBJ Requires A Minimum 100-Chip Seed';
  END IF;
  IF NOT p_bbj_enabled THEN
    v_bbj_seed := 0;
  END IF;

  IF p_spins_enabled THEN
    IF p_spin_max_stake NOT IN (1, 2, 3, 5, 10, 20, 50, 100) THEN
      RAISE EXCEPTION 'Spin Maximum Stake Is Not A Supported Board Stake';
    END IF;
    v_spin_required := public.fn_spin_required_seed(p_spin_max_stake);
    IF v_spin_seed < GREATEST(100, v_spin_required) THEN
      RAISE EXCEPTION 'Spin Seed Must Be At Least % Chips For The Selected Board',
        GREATEST(100, v_spin_required);
    END IF;
  ELSE
    v_spin_seed := 0;
  END IF;

  IF p_promo_enabled THEN
    IF p_promo_type NOT IN ('leaderboard', 'rake_race', 'milestone', 'mystery', 'high_hand') THEN
      RAISE EXCEPTION 'Promotion Type Is Not Supported';
    END IF;
    IF length(btrim(COALESCE(p_promo_name, ''))) < 3 THEN
      RAISE EXCEPTION 'Promotion Name Must Be At Least 3 Characters';
    END IF;
    IF v_promo_budget < 100 THEN
      RAISE EXCEPTION 'A New Promotion Requires A Minimum 100-Chip Budget';
    END IF;
  ELSE
    v_promo_budget := 0;
  END IF;

  IF p_leaderboard_metric NOT IN ('profit', 'hands_played', 'tournaments_won', 'roi') THEN
    RAISE EXCEPTION 'Leaderboard Metric Is Not Supported';
  END IF;
  IF p_leaderboard_rewards_enabled THEN
    IF v_leaderboard_budget < 100 THEN
      RAISE EXCEPTION 'A Prize Leaderboard Requires A Minimum 100-Chip Budget';
    END IF;
  ELSE
    v_leaderboard_budget := 0;
  END IF;

  v_other_allocation := v_bbj_seed + v_promo_budget + v_leaderboard_budget;
  v_total_allocation := v_other_allocation + v_spin_seed;
  IF COALESCE(v_club.chip_treasury, 0) < v_total_allocation THEN
    RAISE EXCEPTION 'Club Bank Has % Chips But Setup Requires %',
      COALESCE(v_club.chip_treasury, 0), v_total_allocation;
  END IF;

  -- Spin activation owns its wallet debit, reserve credit, repayment metadata,
  -- and reserve ledger. Calling it inside this function keeps all setup steps
  -- in the same database transaction.
  IF p_spins_enabled THEN
    v_spin_result := public.fn_spin_activate(
      p_club_id,
      v_spin_seed,
      p_spin_max_stake,
      'chip_treasury',
      v_actor
    );
    IF NOT COALESCE((v_spin_result ->> 'ok')::boolean, false) THEN
      RAISE EXCEPTION 'Spin Setup Failed: %', COALESCE(v_spin_result ->> 'reason', 'Unknown Reason');
    END IF;

    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (
      p_club_id, p_operation_id, 'spin_reserve', v_spin_seed,
      COALESCE((v_spin_result ->> 'balance')::numeric, v_spin_seed), v_actor
    );
  END IF;

  PERFORM set_config('app.ledger_category', 'club_opening_allocation', true);
  PERFORM set_config('app.ledger_counterparty', 'opening_setup', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_club_id::text, true);

  UPDATE public.clubs
  SET chip_treasury = COALESCE(chip_treasury, 0) - v_other_allocation,
      promo_balance = COALESCE(promo_balance, 0) + v_promo_budget + v_leaderboard_budget,
      tagline = v_tagline,
      default_rake_percent = v_rake,
      rake_cap = v_cap,
      bbj_enabled = p_bbj_enabled,
      bbj_rake_enabled = p_bbj_enabled,
      spins_enabled = p_spins_enabled,
      spins_preseed_amount = v_spin_seed,
      spins_wallet_funding = 'CHIP_TREASURY',
      updated_at = now()
  WHERE id = p_club_id
  RETURNING chip_treasury, promo_balance INTO v_bank_after, v_promo_after;

  IF p_bbj_enabled THEN
    SELECT pool.id INTO v_pool_id
    FROM public.bbj_pools pool
    WHERE pool.club_id = p_club_id AND pool.union_id IS NULL
    ORDER BY (pool.status = 'active') DESC, pool.created_at
    LIMIT 1
    FOR UPDATE;

    IF v_pool_id IS NULL THEN
      INSERT INTO public.bbj_pools
        (club_id, main_balance, backup_balance, promo_balance, pool_amount, status)
      VALUES (p_club_id, v_bbj_seed, 0, 0, 0, 'active')
      RETURNING id, main_balance INTO v_pool_id, v_bbj_after;
    ELSE
      UPDATE public.bbj_pools
      SET main_balance = main_balance + v_bbj_seed,
          status = 'active',
          updated_at = now()
      WHERE id = v_pool_id
      RETURNING main_balance INTO v_bbj_after;
    END IF;

    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (p_club_id, p_operation_id, 'bbj_main', v_bbj_seed, v_bbj_after, v_actor);
  END IF;

  IF p_promo_enabled THEN
    INSERT INTO public.promotions (
      club_id, name, description, type, start_date, end_date, status,
      prize_pool, requirements, opt_in_required
    ) VALUES (
      p_club_id,
      left(btrim(p_promo_name), 80),
      left(btrim(COALESCE(p_promo_description, '')), 500),
      p_promo_type,
      now(),
      now() + interval '30 days',
      'active',
      v_promo_budget,
      'Created During Club Opening Setup',
      true
    ) RETURNING id INTO v_promotion_id;

    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (p_club_id, p_operation_id, 'promo_wallet', v_promo_budget, v_promo_after, v_actor);
  END IF;

  -- New prize allocation is held in actual Promo; no new opening seed.
  INSERT INTO public.club_opening_setups (
    club_id, owner_id, rake_mode, rake_percent, rake_cap_bb,
    bbj_enabled, bbj_seeded_amount,
    spins_enabled, spin_seeded_amount, spin_max_stake,
    promo_enabled, promo_budget, promotion_id,
    leaderboard_rewards_enabled, leaderboard_metric, leaderboard_prize_budget,
    leaderboard_seed_remaining,
    last_operation_id
  ) VALUES (
    p_club_id, v_club.owner_id,
    CASE WHEN v_rake = -1 AND v_cap = -1 THEN 'house_schedule' ELSE 'custom' END,
    v_rake, v_cap,
    p_bbj_enabled, v_bbj_seed,
    p_spins_enabled, v_spin_seed, CASE WHEN p_spins_enabled THEN p_spin_max_stake ELSE 0 END,
    p_promo_enabled, v_promo_budget, v_promotion_id,
    p_leaderboard_rewards_enabled, p_leaderboard_metric, v_leaderboard_budget,
    0,
    p_operation_id
  );

  -- The program's current version, read under the club lock taken above.
  -- Publication locks this same club row, so nothing can publish between
  -- this read and the publish below. The hard-coded 0 this replaces refused
  -- (40001) every club that already had a program, even for Display Only.
  SELECT COALESCE(max(program.version), 0)
    INTO v_program_version
    FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = p_club_id;

  -- Leaderboards always receive an explicit program. Display-only is the
  -- safe launch default; a paid program publishes a balanced weekly
  -- top-three plan that sums exactly to the new actual Promo allocation.
  -- New Club Bank overlays are refused before allocations.
  v_leaderboard_result := public.fn_publish_leaderboard_reward_program(
    p_club_id,
    p_leaderboard_rewards_enabled,
    p_leaderboard_metric,
    CASE WHEN p_leaderboard_rewards_enabled THEN jsonb_build_array(
      jsonb_build_object('rank', 1, 'amount', round(v_leaderboard_budget * 0.50, 2)),
      jsonb_build_object('rank', 2, 'amount', round(v_leaderboard_budget * 0.30, 2)),
      jsonb_build_object('rank', 3, 'amount', v_leaderboard_budget
        - round(v_leaderboard_budget * 0.50, 2)
        - round(v_leaderboard_budget * 0.30, 2))
    ) ELSE '[]'::jsonb END,
    '[]'::jsonb,
    'balanced',
    v_program_version,
    p_operation_id,
    v_leaderboard_overlay
  );

  IF p_leaderboard_rewards_enabled THEN
    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (
      p_club_id, p_operation_id, 'leaderboard_prizes',
      v_leaderboard_budget, v_promo_after, v_actor
    );
  END IF;


  v_result := jsonb_build_object(
    'success', true,
    'already_completed', false,
    'club_id', p_club_id,
    'club_bank_after', v_bank_after,
    'allocated', v_total_allocation,
    'bbj_seeded', v_bbj_seed,
    'spin_seeded', v_spin_seed,
    'promo_budget', v_promo_budget,
    'promotion_id', v_promotion_id,
    'leaderboard_rewards_enabled', p_leaderboard_rewards_enabled,
    'leaderboard_prize_budget', v_leaderboard_budget,
    'leaderboard_overlay_enabled', v_leaderboard_overlay,
    'leaderboard', v_leaderboard_result,
    'spin', v_spin_result,
    'operation_id', p_operation_id
  );
  RETURN v_result;
END;
$function$
