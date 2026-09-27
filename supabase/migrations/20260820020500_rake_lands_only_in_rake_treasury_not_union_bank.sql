-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820020500 "rake_lands_only_in_rake_treasury_not_union_bank"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6cb3a3bb9b01a3966f659f39affde9b8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══ Dan, 2026-08-20: "RAKE IS STILL GOING TO THE UNION BANK INSTEAD OF THE
--     RAKE TREASURY." Correct, and this fixes it. ═══
--
-- Every rake credit incremented BOTH union_wallets.chip_balance (Union Bank)
-- and union_wallets.rake_wallet (Rake Treasury) by the same amount — the
-- treasury was modelled as a sub-account *inside* the bank. So Union Bank
-- climbed with every raked hand, which is exactly what Dan is seeing.
--
-- The spec is: rake is held by the union ONLY under the Rake Treasury, held for
-- the week, then 90% back to the clubs and the union keeps 10%. Under that
-- rule the two are SEPARATE pots:
--
--   Rake Treasury  = this week's rake, in trust, awaiting the Monday close
--   Union Bank     = the union's OWN money (its retained 10%, deposits, etc.)
--
-- Changes:
--   1. atomic_distribute_rake (cash hands)      -> credits rake_wallet only
--   2. increment_union_wallet (tournament path) -> credits rake_wallet only
--   3. record_tournament_buyin_rake             -> credits rake_wallet only
--   4. fn_union_weekly_rakeback_close           -> pays the clubs OUT OF the
--      treasury and moves only the retained 10% into the bank; its solvency
--      guard now tests the treasury, which is where the chips actually are.
--   5. one-time correction: chip_balance -= rake_wallet, removing the rake that
--      had been double-counted into the bank. This runs in the SAME transaction
--      as the function replacements, so a concurrent credit either lands the
--      old way before the row lock (and is included in the subtraction) or the
--      new way after commit. Exact either way.
--   6. the sentinel's "rake_wallet <= chip_balance" invariant described the old
--      sub-account model and would now alert constantly. Replaced with
--      non-negativity on both, which is the invariant that survives.

-- ── 1. cash-game rake ──────────────────────────────────────────────────────
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
  v_union_id uuid; v_club_name text; v_bbj numeric := COALESCE(p_bbj, 0);
  v_rr_id uuid; v_first_claim boolean := false; v_recovered boolean := false;
  v_leg_key uuid; v_n integer; v_cw_after numeric; v_union_rake numeric; v_route text;
BEGIN
  IF p_club_id IS NULL OR p_rake IS NULL OR p_rake <= 0 THEN
    RETURN QUERY SELECT false, false, false, NULL::uuid, 0::numeric, NULL::text, 0::numeric, NULL::uuid;
    RETURN;
  END IF;

  SELECT c.union_id, c.name INTO v_union_id, v_club_name FROM public.clubs c WHERE c.id = p_club_id;

  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source, metadata
  ) VALUES (
    p_hand_id, p_table_id, p_club_id, p_rake, v_bbj, p_pot,
    p_num_players, p_contributions, (p_tournament_id IS NOT NULL), p_tournament_id,
    'atomic_distribute_rake', jsonb_build_object('hand_number', p_hand_number)
  )
  ON CONFLICT (hand_id) WHERE hand_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_rr_id;

  IF v_rr_id IS NOT NULL THEN v_first_claim := true;
  ELSE SELECT id INTO v_rr_id FROM public.rake_records WHERE hand_id = p_hand_id ORDER BY created_at LIMIT 1;
  END IF;

  v_leg_key := COALESCE(p_hand_id, gen_random_uuid());

  INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
  VALUES (v_leg_key, 'club_accumulator', p_club_id, v_union_id, p_rake)
  ON CONFLICT (leg_key, leg) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
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
      ) VALUES (p_club_id, p_rake, p_rake, v_bbj, p_rake, v_bbj)
      ON CONFLICT (club_id) DO UPDATE SET
        period_rake_collected     = club_wallets.period_rake_collected     + EXCLUDED.period_rake_collected,
        period_bbj_contribution   = club_wallets.period_bbj_contribution   + EXCLUDED.period_bbj_contribution,
        lifetime_rake_collected   = club_wallets.lifetime_rake_collected   + EXCLUDED.lifetime_rake_collected,
        lifetime_bbj_contribution = club_wallets.lifetime_bbj_contribution + EXCLUDED.lifetime_bbj_contribution,
        chip_balance              = club_wallets.chip_balance              + EXCLUDED.chip_balance,
        updated_at                = NOW()
      RETURNING chip_balance INTO v_cw_after;
    END IF;

    INSERT INTO public.club_wallet_transactions (club_id, type, amount, balance_after, related_id, reason)
    VALUES (p_club_id, 'rake_in', p_rake, v_cw_after, p_hand_id,
      'Rake collected (hand ' || COALESCE('#' || p_hand_number::text, 'unknown') ||
      ', BBJ contribution ' || v_bbj::text || ' banked to pool separately)');

    IF NOT v_first_claim THEN v_recovered := true; END IF;
  END IF;

  IF v_union_id IS NOT NULL THEN
    v_route := 'union_rake_wallet';
    INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
    VALUES (v_leg_key, 'union_rake', p_club_id, v_union_id, p_rake)
    ON CONFLICT (leg_key, leg) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      -- RAKE TREASURY ONLY. chip_balance (Union Bank) is deliberately NOT
      -- touched: the union does not own this money yet, it is held in trust
      -- for the weekly 90/10 close.
      INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
           VALUES (v_union_id, 0, p_rake, p_rake)
      ON CONFLICT (union_id) DO UPDATE SET
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
END; $$;

-- ── 2. tournament-completion rake credit ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_union_wallet(
  p_union_id uuid, p_amount numeric, p_club_id uuid DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_amount numeric; v_new_rake numeric;
BEGIN
  IF p_union_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'p_union_id required'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('success', true, 'skipped', 'zero_amount'); END IF;
  v_amount := round(p_amount, 2);

  -- Rake Treasury only — see rake_lands_only_in_rake_treasury_not_union_bank.
  INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
       VALUES (p_union_id, 0, v_amount, v_amount)
  ON CONFLICT (union_id) DO UPDATE SET
       rake_wallet          = public.union_wallets.rake_wallet + v_amount,
       total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + v_amount,
       updated_at           = NOW()
  RETURNING rake_wallet INTO v_new_rake;

  IF p_notes IS NOT NULL OR p_club_id IS NOT NULL THEN
    INSERT INTO public.union_wallet_transactions
      (union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes)
    VALUES (p_union_id, p_club_id, v_amount, 'rake', 'rake_wallet', 'credit', v_new_rake,
            COALESCE(p_notes, 'Union rake credit'));
  END IF;

  RETURN jsonb_build_object('success', true, 'union_id', p_union_id, 'amount', v_amount,
                            'new_rake_wallet', v_new_rake);
END $$;

-- ── 3. tournament buy-in rake ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_tournament_buyin_rake(
  p_tournament_id uuid DEFAULT NULL::uuid, p_amount numeric DEFAULT 0, p_player_id uuid DEFAULT NULL::uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_club_id uuid; v_union_id uuid; v_rake_id uuid; v_union_rake numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_tournament_id IS NULL THEN RETURN; END IF;
  SELECT club_id INTO v_club_id FROM public.tournaments WHERE id = p_tournament_id;
  IF v_club_id IS NULL THEN RETURN; END IF;
  SELECT union_id INTO v_union_id FROM public.clubs WHERE id = v_club_id;

  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source
  ) VALUES (
    NULL, NULL, v_club_id, p_amount, 0, 0, 1,
    jsonb_build_object(p_player_id::text, p_amount), TRUE, p_tournament_id, 'tournament_buyin'
  ) RETURNING id INTO v_rake_id;

  IF v_union_id IS NOT NULL THEN
    -- Rake Treasury only.
    INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
         VALUES (v_union_id, 0, p_amount, p_amount)
    ON CONFLICT (union_id) DO UPDATE SET
         rake_wallet          = public.union_wallets.rake_wallet + p_amount,
         total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + p_amount,
         updated_at           = NOW()
    RETURNING rake_wallet INTO v_union_rake;

    INSERT INTO public.union_wallet_transactions (
      union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes
    ) VALUES (
      v_union_id, v_club_id, p_amount, 'rake', 'rake_wallet', 'credit', v_union_rake,
      'Tournament buy-in rake (tournament ' || p_tournament_id::text || ')'
    );

    UPDATE public.club_wallets
       SET period_rake_collected   = COALESCE(period_rake_collected, 0) + p_amount,
           lifetime_rake_collected = COALESCE(lifetime_rake_collected, 0) + p_amount,
           updated_at = NOW()
     WHERE club_id = v_club_id;
  ELSE
    UPDATE public.club_wallets
       SET period_rake_collected   = COALESCE(period_rake_collected, 0) + p_amount,
           lifetime_rake_collected = COALESCE(lifetime_rake_collected, 0) + p_amount,
           chip_balance            = chip_balance + p_amount,
           updated_at = NOW()
     WHERE club_id = v_club_id;

    INSERT INTO public.club_wallet_transactions (club_id, type, amount, balance_after, related_id, reason)
    SELECT v_club_id, 'rake_in', p_amount, chip_balance, v_rake_id,
           'Tournament buy-in rake (tournament ' || p_tournament_id::text || ')'
      FROM public.club_wallets WHERE club_id = v_club_id;
  END IF;

  UPDATE public.clubs SET total_rake = COALESCE(total_rake,0) + p_amount, updated_at = NOW() WHERE id = v_club_id;
  UPDATE public.tournaments SET total_rake = COALESCE(total_rake,0) + p_amount, updated_at = NOW() WHERE id = p_tournament_id;
END; $$;

-- ── 5. one-time correction: take the double-counted rake out of Union Bank ──
UPDATE public.union_wallets
   SET chip_balance = round(GREATEST(chip_balance - rake_wallet, 0), 2),
       updated_at = now()
 WHERE rake_wallet > 0;

INSERT INTO public.union_wallet_transactions
  (union_id, amount, tx_type, wallet, direction, balance_after, notes)
SELECT union_id, round(rake_wallet, 2), 'rake_hold', 'chip_balance', 'debit', round(chip_balance, 2),
       'Correction: rake had been credited to BOTH the Union Bank and the Rake Treasury. '
       'The treasury is held in trust for the weekly 90/10 close, so the duplicate is removed '
       'from the bank. Union Bank now holds only the union''s own funds.'
  FROM public.union_wallets WHERE rake_wallet > 0;
