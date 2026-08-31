-- Applied to production via Supabase MCP on 2026-08-31 (zero-drift directive).
-- This file is the byte-exact mirror of the applied migration.
-- ZERO-DRIFT PART 3b: the RPCs that already self-journal now declare
-- app.ledger_autoskip_clubs around their treasury writes (no double-posting),
-- and the rake/BBJ paths declare real categories + counterparties so their
-- auto-ledgered rows stop landing in the 'adjustment'/suspense plug.

-- 1. atomic_distribute_rake — declare rake context; skip auto-journal on the
--    treasury leg (it writes its own chip_ledger row inside the leg claim).
CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(p_table_id uuid, p_club_id uuid, p_hand_id uuid, p_hand_number integer, p_rake numeric, p_bbj numeric DEFAULT 0, p_pot numeric DEFAULT NULL::numeric, p_num_players integer DEFAULT (NULL::numeric)::integer, p_contributions jsonb DEFAULT NULL::jsonb, p_tournament_id uuid DEFAULT NULL::uuid, p_returned_uncalled jsonb DEFAULT NULL::jsonb, p_rake_method text DEFAULT 'DEALT_EQUAL'::text)
 RETURNS TABLE(applied boolean, already_processed boolean, recovered boolean, rake_record_id uuid, club_net_credit numeric, spendable_route text, spendable_amount numeric, union_id_out uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union_id     uuid;
  v_g_union      uuid;
  v_is_private   boolean := false;
  v_club_name    text;
  v_net          numeric;
  v_bbj          numeric := COALESCE(p_bbj, 0);
  v_rr_id        uuid;
  v_first_claim  boolean := false;
  v_recovered    boolean := false;
  v_leg_key      uuid;
  v_n            integer;
  v_cw_after     numeric;
  v_union_rake   numeric;
  v_route        text;
  v_method       text;
  v_alloc_sum    numeric;
  v_st           text;
  v_msg          text;
BEGIN
  IF p_club_id IS NULL OR p_rake IS NULL OR p_rake <= 0 THEN
    RETURN QUERY SELECT false, false, false, NULL::uuid, 0::numeric,
                        NULL::text, 0::numeric, NULL::uuid;
    RETURN;
  END IF;

  /* ZERO-DRIFT (2026-08-31): declare the ledger context for this transaction
     so every auto-journaled balance delta below is categorized as rake coming
     off the felt, not an anonymous adjustment against suspense. */
  PERFORM set_config('app.ledger_category', 'rake', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

  v_method := CASE WHEN p_rake_method = 'WEIGHTED_CONTRIBUTED'
                   THEN 'WEIGHTED_CONTRIBUTED' ELSE 'DEALT_EQUAL' END;

  v_net := p_rake - v_bbj;

  SELECT c.name INTO v_club_name FROM public.clubs c WHERE c.id = p_club_id;

  -- UNION LAW (Dan, restored 2026-08-30): route by the GAME's union stamp,
  -- not club membership. A private club game's rake NEVER touches the union.
  IF p_table_id IS NOT NULL THEN
    SELECT COALESCE(t.is_private, false), t.union_id
      INTO v_is_private, v_g_union
      FROM public.tables t WHERE t.id = p_table_id;
  END IF;
  IF p_tournament_id IS NOT NULL AND NOT v_is_private AND v_g_union IS NULL THEN
    SELECT COALESCE(tr.is_private, false), tr.union_id
      INTO v_is_private, v_g_union
      FROM public.tournaments tr WHERE tr.id = p_tournament_id;
  END IF;

  IF v_is_private THEN
    v_union_id := NULL;
  ELSE
    v_union_id := v_g_union;
    IF v_union_id IS NULL THEN
      SELECT c.union_id INTO v_union_id FROM public.clubs c WHERE c.id = p_club_id;
    END IF;
  END IF;

  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source,
    metadata, rake_method, returned_uncalled
  ) VALUES (
    p_hand_id, p_table_id, p_club_id, p_rake, v_bbj, p_pot,
    p_num_players, p_contributions, (p_tournament_id IS NOT NULL), p_tournament_id,
    'atomic_distribute_rake',
    jsonb_build_object('hand_number', p_hand_number, 'is_private', v_is_private),
    v_method, p_returned_uncalled
  )
  ON CONFLICT (hand_id) WHERE hand_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_rr_id;

  IF v_rr_id IS NOT NULL THEN
    v_first_claim := true;
  ELSE
    SELECT id INTO v_rr_id FROM public.rake_records
      WHERE hand_id = p_hand_id ORDER BY created_at LIMIT 1;
  END IF;

  IF v_first_claim AND p_hand_id IS NOT NULL
     AND p_contributions IS NOT NULL AND jsonb_typeof(p_contributions) = 'object' THEN
    INSERT INTO public.rake_attributions (
      hand_id, player_id, rake_amount, rake_record_id, table_id, club_id,
      gross_contribution, returned_uncalled, eligible_contribution,
      contribution_weight, weighted_rake_credit, bbj_attributed_contribution,
      rake_method
    )
    SELECT p_hand_id,
           a.user_id,
           a.credit,
           v_rr_id, p_table_id, p_club_id,
           (p_contributions ->> a.user_id::text)::numeric
             + COALESCE((p_returned_uncalled ->> a.user_id::text)::numeric, 0),
           COALESCE((p_returned_uncalled ->> a.user_id::text)::numeric, 0),
           (p_contributions ->> a.user_id::text)::numeric,
           a.weight,
           a.credit,
           COALESCE(b.credit, 0),
           v_method
      FROM public.fn_allocate_rake_credits(p_rake, p_contributions, v_method) a
      LEFT JOIN public.fn_allocate_rake_credits(v_bbj, p_contributions, v_method) b
        ON b.user_id = a.user_id
    ON CONFLICT (hand_id, player_id) DO NOTHING;

    SELECT COALESCE(SUM(a.credit), 0) INTO v_alloc_sum
      FROM public.fn_allocate_rake_credits(p_rake, p_contributions, v_method) a;
    IF v_alloc_sum <> round(p_rake, 2) AND v_alloc_sum <> 0 THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('critical', 'atomic_distribute_rake', 'RAKE_ALLOCATION_MISMATCH',
        jsonb_build_object('hand_id', p_hand_id, 'rake', p_rake,
          'allocated', v_alloc_sum, 'method', v_method));
    END IF;
  END IF;

  v_leg_key := COALESCE(p_hand_id, gen_random_uuid());
  PERFORM set_config('app.ledger_settlement', 'rake:' || v_leg_key::text, true);

  INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
  VALUES (v_leg_key, 'club_accumulator', p_club_id, v_union_id, v_net)
  ON CONFLICT (leg_key, leg) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    UPDATE public.club_wallets
       SET period_rake_collected     = period_rake_collected     + p_rake,
           period_bbj_contribution   = period_bbj_contribution   + v_bbj,
           lifetime_rake_collected   = lifetime_rake_collected   + p_rake,
           lifetime_bbj_contribution = lifetime_bbj_contribution + v_bbj,
           chip_balance              = chip_balance + v_net,
           updated_at                = NOW()
     WHERE club_id = p_club_id
     RETURNING chip_balance INTO v_cw_after;

    IF v_cw_after IS NULL THEN
      INSERT INTO public.club_wallets (
        club_id, chip_balance, period_rake_collected, period_bbj_contribution,
        lifetime_rake_collected, lifetime_bbj_contribution
      ) VALUES (
        p_club_id, v_net, p_rake, v_bbj, p_rake, v_bbj
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
      p_club_id, 'rake_in', v_net, v_cw_after, p_hand_id,
      'Rake collected (hand ' || COALESCE('#' || p_hand_number::text, 'unknown') ||
        ', BBJ contribution ' || v_bbj::text || ')'
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
      -- UNION LAW (restored 2026-08-30): RAKE TREASURY ONLY. chip_balance
      -- (Union Bank) is deliberately NOT touched.
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
      /* ZERO-DRIFT: this leg writes its own chip_ledger row below; suppress
         the clubs auto-journal for this one statement. */
      PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
      UPDATE public.clubs
         SET chip_treasury = COALESCE(chip_treasury, 0) + p_rake,
             total_rake    = COALESCE(total_rake, 0) + p_rake,
             updated_at    = NOW()
       WHERE id = p_club_id;
      PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

      /* JOURNAL THE TREASURY LEG (2026-08-31). Inside the leg_key first-claim
         guard, so a replayed hand credits once and journals once. Never blocks. */
      BEGIN
        INSERT INTO public.chip_ledger
          (performed_by, from_type, from_entity_id, to_type, to_entity_id,
           amount, category, club_id, table_id, hand_id, tournament_id, description)
        VALUES (
          COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
          'table_stack',   p_table_id,
          'club_treasury', p_club_id,
          p_rake, 'rake', p_club_id, p_table_id, p_hand_id, p_tournament_id,
          'Rake to club treasury, hand ' || COALESCE('#' || p_hand_number::text, 'unknown')
            || ' (atomic_distribute_rake)');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        BEGIN
          INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
          VALUES (p_club_id, NULL, p_rake, v_st, 'atomic_distribute_rake: ' || v_msg);
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END;

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,
                      v_net, v_route, p_rake, v_union_id;
END;
$function$;

-- 2. credit_club_rake_to_treasury — same autoskip bracket around its update.
CREATE OR REPLACE FUNCTION public.credit_club_rake_to_treasury(p_club_id uuid, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_st  text;
  v_msg text;
BEGIN
  IF p_club_id IS NULL OR p_amount IS NULL OR p_amount = 0 THEN
    RETURN;
  END IF;

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE public.clubs
     SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount,
         total_rake    = COALESCE(total_rake, 0) + p_amount,
         updated_at    = now()
   WHERE id = p_club_id;
  PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

  /* Rake comes off the felt and lands in the treasury. amount > 0 is a CHECK
     on chip_ledger, so a negative p_amount (a correction) is journaled with
     its sides swapped rather than dropped. Never blocks the credit. */
  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, description)
    VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      CASE WHEN p_amount > 0 THEN 'table_stack'   ELSE 'club_treasury' END,
      CASE WHEN p_amount > 0 THEN NULL            ELSE p_club_id       END,
      CASE WHEN p_amount > 0 THEN 'club_treasury' ELSE 'table_stack'   END,
      CASE WHEN p_amount > 0 THEN p_club_id       ELSE NULL            END,
      abs(p_amount), 'rake', p_club_id,
      'Rake credited to club treasury (credit_club_rake_to_treasury)');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
      VALUES (p_club_id, NULL, p_amount, v_st,
              'credit_club_rake_to_treasury: ' || v_msg);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;
END;
$function$;

-- 3. fn_horse_fund_from_treasury — autoskip bracket around treasury debit.
CREATE OR REPLACE FUNCTION public.fn_horse_fund_from_treasury(p_table_id uuid, p_user_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_treasury numeric;
  v_new_stack numeric;
  v_st text;
  v_msg text;
BEGIN
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'table, user and positive amount required');
  END IF;

  SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  IF NOT public.fn_actor_can_manage_club_treasury(v_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to fund from club treasury');
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM clubs WHERE id = v_club_id FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury',
                              'treasury', v_treasury, 'needed', p_amount);
  END IF;

  UPDATE table_seats
  SET stack = COALESCE(stack, 0) + p_amount
  WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
  RETURNING stack INTO v_new_stack;

  IF v_new_stack IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no active seat for user at table');
  END IF;

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount, updated_at = NOW()
  WHERE id = v_club_id;
  PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_club_id, NULL, p_user_id, p_amount,
    'horse_treasury_funding', 'Horse buy-in/rebuy funded from club treasury',
    v_treasury - p_amount, NOW()
  );

  /* THE TREASURY GETS A LEDGER ROW (2026-08-31). Never blocks the money. */
  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, table_id, description)
    VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      'club_treasury', v_club_id,
      'table_stack',   p_table_id,
      p_amount, 'horse_funding', v_club_id, p_table_id,
      'Buy-in/rebuy funded from club treasury (fn_horse_fund_from_treasury)');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
      VALUES (v_club_id, p_user_id, -p_amount, v_st,
              'fn_horse_fund_from_treasury: ' || v_msg);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;

  RETURN jsonb_build_object('success', true, 'new_stack', v_new_stack,
                            'treasury_after', v_treasury - p_amount);
END;
$function$;

-- 4. fn_horse_seat_from_treasury — same bracket.
CREATE OR REPLACE FUNCTION public.fn_horse_seat_from_treasury(p_table_id uuid, p_user_id uuid, p_seat_number integer, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_treasury numeric;
  v_st text;
  v_msg text;
BEGIN
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_seat_number IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'table, user, seat and positive amount required');
  END IF;

  SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  IF NOT public.fn_actor_can_manage_club_treasury(v_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to seat from club treasury');
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM clubs WHERE id = v_club_id FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury',
                              'treasury', v_treasury, 'needed', p_amount);
  END IF;

  BEGIN
    INSERT INTO table_seats (table_id, user_id, seat_number, stack, is_sitting_out)
    VALUES (p_table_id, p_user_id, p_seat_number, p_amount, false);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'seat already taken');
  END;

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount, updated_at = NOW()
  WHERE id = v_club_id;
  PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_club_id, NULL, p_user_id, p_amount,
    'horse_treasury_funding', 'Horse seated + funded from club treasury',
    v_treasury - p_amount, NOW()
  );

  /* Journaled for the same reason as fn_horse_fund_from_treasury. Never blocks. */
  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, table_id, description)
    VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      'club_treasury', v_club_id,
      'table_stack',   p_table_id,
      p_amount, 'horse_funding', v_club_id, p_table_id,
      'Seated + funded from club treasury (fn_horse_seat_from_treasury)');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
      VALUES (v_club_id, p_user_id, -p_amount, v_st,
              'fn_horse_seat_from_treasury: ' || v_msg);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;

  RETURN jsonb_build_object('success', true, 'treasury_after', v_treasury - p_amount);
END;
$function$;

-- 5. bbj_record_contribution — declare bbj_contribution context so the pool
--    auto-journal rows carry the right category and the felt counterparty.
CREATE OR REPLACE FUNCTION public.bbj_record_contribution(p_pool_id uuid, p_hand_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_amount numeric DEFAULT 0, p_main_portion numeric DEFAULT 0, p_backup_portion numeric DEFAULT 0, p_promo_portion numeric DEFAULT 0, p_big_blind numeric DEFAULT 2.00, p_hand_number integer DEFAULT NULL::integer, p_club_id uuid DEFAULT NULL::uuid)
 RETURNS bbj_contributions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_contribution bbj_contributions;
    v_prev_cum numeric;
    v_next_cum numeric;
    v_main     numeric;
    v_backup   numeric;
    v_promo    numeric;
BEGIN
    IF p_hand_id IS NULL THEN
        IF p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id
               AND hand_id IS NULL
               AND table_id = p_table_id
               AND hand_number = p_hand_number
             ORDER BY created_at
             LIMIT 1;
        ELSE
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id
               AND hand_id IS NULL
               AND table_id IS NOT DISTINCT FROM p_table_id
               AND hand_number IS NOT DISTINCT FROM p_hand_number
             ORDER BY created_at
             LIMIT 1;
        END IF;

        IF v_contribution.id IS NOT NULL THEN
            RETURN v_contribution;
        END IF;
    END IF;

    SELECT COALESCE(alloc_cum_amount, 0) INTO v_prev_cum
      FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'bbj_record_contribution: pool % not found', p_pool_id;
    END IF;

    v_next_cum := v_prev_cum + COALESCE(p_amount, 0);
    v_main   := round(v_next_cum * 0.50, 2) - round(v_prev_cum * 0.50, 2);
    v_backup := (round(v_next_cum * 0.75, 2) - round(v_next_cum * 0.50, 2))
              - (round(v_prev_cum * 0.75, 2) - round(v_prev_cum * 0.50, 2));
    v_promo  := COALESCE(p_amount, 0) - v_main - v_backup;

    INSERT INTO bbj_contributions (
        pool_id, hand_id, table_id, club_id, amount,
        main_portion, backup_portion, promo_portion, big_blind, hand_number
    ) VALUES (
        p_pool_id, p_hand_id, p_table_id, p_club_id, p_amount,
        v_main, v_backup, v_promo, p_big_blind, p_hand_number
    )
    ON CONFLICT (pool_id, hand_id) WHERE hand_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_contribution;

    IF v_contribution.id IS NULL THEN
        IF p_hand_id IS NOT NULL THEN
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id AND hand_id = p_hand_id
             LIMIT 1;
        ELSIF p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id AND hand_id IS NULL
               AND table_id = p_table_id AND hand_number = p_hand_number
             LIMIT 1;
        ELSE
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id AND hand_id IS NULL
             LIMIT 1;
        END IF;
        RETURN v_contribution;
    END IF;

    /* ZERO-DRIFT (2026-08-31): the pool credit below auto-journals via
       trg_ca_autoledger; declare what it is. */
    PERFORM set_config('app.ledger_category', 'bbj_contribution', true);
    PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

    UPDATE bbj_pools
    SET
        main_balance      = main_balance   + v_main,
        backup_balance    = backup_balance + v_backup,
        promo_balance     = promo_balance  + v_promo,
        total_contributed = total_contributed + p_amount,
        alloc_cum_amount  = v_next_cum,
        hands_contributed = COALESCE(hands_contributed, 0) + 1,
        updated_at        = now()
    WHERE id = p_pool_id;

    RETURN v_contribution;
END;
$function$;
-- ---------------------------------------------------------------------------
-- AND THE GRANTS PRODUCTION ALREADY HAS (added by the agent landing this
-- bundle, after check-definer-authorization blocked the push).
--
-- Four SECURITY DEFINER functions this migration re-declares WRITE MONEY and
-- never ask who is calling: atomic_distribute_rake (rake and BBJ),
-- fn_horse_fund_from_treasury, fn_horse_seat_from_treasury (treasury movers)
-- and bbj_record_contribution.
--
-- Live, all four are already closed - anon false, authenticated false,
-- service_role true. The guard is flagging REPLAY, and on that it is exactly
-- right: CREATE OR REPLACE in a fresh database grants EXECUTE to PUBLIC, so
-- replaying this file alone would hand four treasury writers to any browser
-- role. Their callers are the engine and cron, both service_role.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.atomic_distribute_rake(p_table_id uuid, p_club_id uuid, p_hand_id uuid, p_hand_number integer, p_rake numeric, p_bbj numeric, p_pot numeric, p_num_players integer, p_contributions jsonb, p_tournament_id uuid, p_returned_uncalled jsonb, p_rake_method text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bbj_record_contribution(p_pool_id uuid, p_hand_id uuid, p_table_id uuid, p_amount numeric, p_main_portion numeric, p_backup_portion numeric, p_promo_portion numeric, p_big_blind numeric, p_hand_number integer, p_club_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_horse_fund_from_treasury(p_table_id uuid, p_user_id uuid, p_amount numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_horse_seat_from_treasury(p_table_id uuid, p_user_id uuid, p_seat_number integer, p_amount numeric) FROM PUBLIC, anon, authenticated;
