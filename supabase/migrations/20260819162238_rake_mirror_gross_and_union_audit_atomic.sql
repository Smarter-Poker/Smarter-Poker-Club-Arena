-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819162238 "rake_mirror_gross_and_union_audit_atomic"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9fcbd7ac618a027538cc52865f528d61 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- LINE-BY-LINE AUDIT 2026-08-19 (rake/BBJ pass 2), DEFECTS #4 + #5:
--
-- #4  atomic_distribute_rake computed v_net := p_rake - v_bbj and credited the
--     club_wallets accounting mirror only v_net. That formula assumed p_rake
--     was GROSS (rake including the BBJ fee) — it is not: the engine's
--     computeRakeAndBBJ returns rake and bbjFee as SEPARATE, ADDITIVE pot
--     deductions (guard: `rake + bbjFee > pot`), and hand_history stores them
--     separately. So the mirror under-counted every BBJ hand by the BBJ fee.
--     Verified: no code reads club_wallets.chip_balance today (dashboard-only
--     mirror), so no chips moved wrongly — the COUNTER was wrong. Fixed to
--     credit p_rake, and the historical under-count is backfilled from the
--     lifetime_bbj_contribution counter the same rows maintained.
--
-- #5  Tournament completion credited the union wallet via increment_union_wallet
--     and then inserted the union_wallet_transactions audit row in a SEPARATE
--     client write, with balance_after set to the wallet's chip_balance instead
--     of the rake_wallet it describes. A failed second write silently shrank
--     the weekly-rakeback basis (which sums the audit rows). Fixed by teaching
--     increment_union_wallet to write the audit row ATOMICALLY when the caller
--     passes club/notes context. Old 2-arg calls behave exactly as before.

-- #4a: formula fix (full replacement; only the club-mirror leg changed).
CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(
  p_table_id uuid, p_club_id uuid, p_hand_id uuid, p_hand_number integer,
  p_rake numeric, p_bbj numeric DEFAULT 0, p_pot numeric DEFAULT NULL::numeric,
  p_num_players integer DEFAULT NULL::integer, p_contributions jsonb DEFAULT NULL::jsonb,
  p_tournament_id uuid DEFAULT NULL::uuid
) RETURNS TABLE(applied boolean, already_processed boolean, recovered boolean,
                rake_record_id uuid, club_net_credit numeric, spendable_route text,
                spendable_amount numeric, union_id_out uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_union_id     uuid;
  v_club_name    text;
  v_bbj          numeric := COALESCE(p_bbj, 0);
  v_rr_id        uuid;
  v_first_claim  boolean := false;
  v_recovered    boolean := false;
  v_leg_key      uuid;
  v_n            integer;
  v_cw_after     numeric;
  v_union_rake   numeric;
  v_route        text;
BEGIN
  IF p_club_id IS NULL OR p_rake IS NULL OR p_rake <= 0 THEN
    RETURN QUERY SELECT false, false, false, NULL::uuid, 0::numeric,
                        NULL::text, 0::numeric, NULL::uuid;
    RETURN;
  END IF;

  SELECT c.union_id, c.name INTO v_union_id, v_club_name
    FROM public.clubs c WHERE c.id = p_club_id;

  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source, metadata
  ) VALUES (
    p_hand_id, p_table_id, p_club_id, p_rake, v_bbj, p_pot,
    p_num_players, p_contributions, (p_tournament_id IS NOT NULL), p_tournament_id,
    'atomic_distribute_rake',
    jsonb_build_object('hand_number', p_hand_number)
  )
  ON CONFLICT (hand_id) WHERE hand_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_rr_id;

  IF v_rr_id IS NOT NULL THEN
    v_first_claim := true;
  ELSE
    SELECT id INTO v_rr_id FROM public.rake_records
      WHERE hand_id = p_hand_id ORDER BY created_at LIMIT 1;
  END IF;

  v_leg_key := COALESCE(p_hand_id, gen_random_uuid());

  INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
  VALUES (v_leg_key, 'club_accumulator', p_club_id, v_union_id, p_rake)
  ON CONFLICT (leg_key, leg) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    -- AUDIT FIX #4: the mirror is credited the RAKE (p_rake). p_rake never
    -- contained the BBJ fee — that is p_bbj, tracked in its own counters and
    -- banked into bbj_pools by bbj_record_contribution.
    UPDATE public.club_wallets
       SET period_rake_collected     = period_rake_collected     + p_rake,
           period_bbj_contribution   = period_bbj_contribution   + v_bbj,
           lifetime_rake_collected   = lifetime_rake_collected   + p_rake,
           lifetime_bbj_contribution = lifetime_bbj_contribution + v_bbj,
           chip_balance              = chip_balance + p_rake,
           updated_at                = NOW()
     WHERE club_id = p_club_id
     RETURNING chip_balance INTO v_cw_after;

    IF v_cw_after IS NULL THEN
      INSERT INTO public.club_wallets (
        club_id, chip_balance, period_rake_collected, period_bbj_contribution,
        lifetime_rake_collected, lifetime_bbj_contribution
      ) VALUES (
        p_club_id, p_rake, p_rake, v_bbj, p_rake, v_bbj
      )
      ON CONFLICT (club_id) DO UPDATE SET
        period_rake_collected     = club_wallets.period_rake_collected     + EXCLUDED.period_rake_collected,
        period_bbj_contribution   = club_wallets.period_bbj_contribution   + EXCLUDED.period_bbj_contribution,
        lifetime_rake_collected   = club_wallets.lifetime_rake_collected   + EXCLUDED.lifetime_rake_collected,
        lifetime_bbj_contribution = club_wallets.lifetime_bbj_contribution + EXCLUDED.lifetime_bbj_contribution,
        chip_balance              = club_wallets.chip_balance              + EXCLUDED.chip_balance,
        updated_at                = NOW()
      RETURNING chip_balance INTO v_cw_after;
    END IF;

    INSERT INTO public.club_wallet_transactions (
      club_id, type, amount, balance_after, related_id, reason
    ) VALUES (
      p_club_id, 'rake_in', p_rake, v_cw_after, p_hand_id,
      'Rake collected (hand ' || COALESCE('#' || p_hand_number::text, 'unknown') ||
        ', BBJ contribution ' || v_bbj::text || ' banked to pool separately)'
    );

    IF NOT v_first_claim THEN v_recovered := true; END IF;
  END IF;

  IF v_union_id IS NOT NULL THEN
    v_route := 'union_rake_wallet';
    INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
    VALUES (v_leg_key, 'union_rake', p_club_id, v_union_id, p_rake)
    ON CONFLICT (leg_key, leg) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
           VALUES (v_union_id, p_rake, p_rake, p_rake)
      ON CONFLICT (union_id) DO UPDATE SET
           chip_balance         = public.union_wallets.chip_balance + p_rake,
           rake_wallet          = public.union_wallets.rake_wallet + p_rake,
           total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + p_rake,
           updated_at           = NOW()
      RETURNING rake_wallet INTO v_union_rake;

      INSERT INTO public.union_wallet_transactions (
        union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes
      ) VALUES (
        v_union_id, p_club_id, p_rake, 'rake', 'rake_wallet', 'credit', v_union_rake,
        'Cash game rake: hand #' || COALESCE(p_hand_number::text, '?') ||
          ' (' || COALESCE(v_club_name, 'club') || ')'
      );

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  ELSE
    v_route := 'club_chip_treasury';
    INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
    VALUES (v_leg_key, 'chip_treasury', p_club_id, NULL, p_rake)
    ON CONFLICT (leg_key, leg) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      UPDATE public.clubs
         SET chip_treasury = COALESCE(chip_treasury, 0) + p_rake,
             total_rake    = COALESCE(total_rake, 0) + p_rake,
             updated_at    = NOW()
       WHERE id = p_club_id;

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,
                      p_rake, v_route, p_rake, v_union_id;
END;
$$;

-- #4b: one-time mirror backfill — undo the historical BBJ subtraction.
UPDATE public.club_wallets
   SET chip_balance = chip_balance + COALESCE(lifetime_bbj_contribution, 0),
       updated_at = NOW()
 WHERE COALESCE(lifetime_bbj_contribution, 0) > 0;

-- #5: atomic audit row inside increment_union_wallet (optional context args;
-- 2-arg legacy calls keep the exact old behavior).
CREATE OR REPLACE FUNCTION public.increment_union_wallet(
  p_union_id uuid,
  p_amount numeric,
  p_club_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_amount numeric;
  v_new_chip numeric;
  v_new_rake numeric;
BEGIN
  IF p_union_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_union_id required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'zero_amount');
  END IF;
  v_amount := round(p_amount, 2);

  INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
       VALUES (p_union_id, v_amount, v_amount, v_amount)
  ON CONFLICT (union_id) DO UPDATE SET
       chip_balance         = public.union_wallets.chip_balance + v_amount,
       rake_wallet          = public.union_wallets.rake_wallet + v_amount,
       total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + v_amount,
       updated_at           = NOW()
  RETURNING chip_balance, rake_wallet INTO v_new_chip, v_new_rake;

  IF p_notes IS NOT NULL OR p_club_id IS NOT NULL THEN
    INSERT INTO public.union_wallet_transactions
      (union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes)
    VALUES
      (p_union_id, p_club_id, v_amount, 'rake', 'rake_wallet', 'credit', v_new_rake,
       COALESCE(p_notes, 'Union rake credit'));
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'union_id', p_union_id,
    'amount', v_amount,
    'new_chip_balance', v_new_chip,
    'new_rake_wallet',  v_new_rake
  );
END $$;
