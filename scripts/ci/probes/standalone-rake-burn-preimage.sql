-- Read-only production catalogue, 2026-09-12 00:46-00:53 UTC.
-- Exact installed function bodies for the isolated rake destination regression.
-- This is a test preimage; never apply it to a deployed database.

-- atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text) body_md5=56fe5715421d7e35bc386a669bb483a2
CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(p_table_id uuid, p_club_id uuid, p_hand_id uuid, p_hand_number integer, p_rake numeric, p_bbj numeric DEFAULT 0, p_pot numeric DEFAULT NULL::numeric, p_num_players integer DEFAULT (NULL::numeric)::integer, p_contributions jsonb DEFAULT NULL::jsonb, p_tournament_id uuid DEFAULT NULL::uuid, p_returned_uncalled jsonb DEFAULT NULL::jsonb, p_rake_method text DEFAULT 'DEALT_EQUAL'::text)
 RETURNS TABLE(applied boolean, already_processed boolean, recovered boolean, rake_record_id uuid, club_net_credit numeric, spendable_route text, spendable_amount numeric, union_id_out uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
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
  v_dup_id       uuid;
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
  -- PHASE 6.4 (2026-09-05): the rake's legs name the hand when it is known.
  PERFORM set_config('app.ledger_hand_id', COALESCE(p_hand_id::text, ''), true);

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

  /* A HAND THAT CANNOT NAME ITSELF BY ID STILL NAMES ITSELF BY TABLE AND
     NUMBER (2026-09-06). Both idempotency guards below key on p_hand_id, and
     both are disabled when it is NULL: ON CONFLICT (hand_id) WHERE hand_id IS
     NOT NULL matches nothing, and v_leg_key fell back to a FRESH RANDOM uuid,
     so rake_distribution_legs could not dedupe either. The engine calls this
     before logHandHistory has produced a hand row and again after, and the
     second call was treated as a new hand: a duplicate rake_records row, and
     a second increment of the club wallet's period and lifetime rake. 4,452
     such rows exist, 2026-04-16 to 2026-09-05, carrying 16,426.46 of rake and
     2,068.82 of BBJ contribution that no hand ever dropped - measured against
     hand_history and bbj_contributions, which agree with the LINKED rows alone
     in 283 of the 284 cases where the hand still exists.

     So: ask hand_history for the id first, and if it genuinely is not there
     yet, key on what the caller always knows - the table and the hand number. */
  IF p_hand_id IS NULL AND p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
    SELECT h.id INTO p_hand_id
      FROM public.hand_history h
     WHERE h.table_id = p_table_id
       AND h.hand_number = p_hand_number
     ORDER BY h.created_at DESC
     LIMIT 1;
    -- Phase 6.4: the legs name the hand as soon as we know it.
    PERFORM set_config('app.ledger_hand_id', COALESCE(p_hand_id::text, ''), true);
  END IF;

  IF p_hand_id IS NULL AND p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
    SELECT rr.id INTO v_dup_id
      FROM public.rake_records rr
     WHERE rr.table_id = p_table_id
       AND rr.hand_id IS NULL
       AND (rr.metadata->>'hand_number') = p_hand_number::text
       AND rr.created_at > now() - interval '2 days'
     ORDER BY rr.created_at
     LIMIT 1;
    IF v_dup_id IS NOT NULL THEN
      RETURN QUERY SELECT false, true, false, v_dup_id, 0::numeric,
                          NULL::text, 0::numeric, v_union_id;
      RETURN;
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
           v_rr_id, p_table_id,
           COALESCE((SELECT ts.club_id FROM public.table_seats ts
                      WHERE ts.table_id = p_table_id AND ts.user_id = a.user_id
                      ORDER BY ts.joined_at DESC NULLS LAST LIMIT 1), p_club_id),
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

  /* THE LEG KEY IS DERIVED, NEVER RANDOM (2026-09-06). A random key made
     rake_distribution_legs' ON CONFLICT (leg_key, leg) unreachable, so the
     club wallet's period and lifetime rake were incremented again for a hand
     already counted. When the hand has no id, the key is the table and the
     hand number - the same hand always produces the same key. */
  v_leg_key := COALESCE(
    p_hand_id,
    CASE WHEN p_table_id IS NOT NULL AND p_hand_number IS NOT NULL
         THEN md5('rake:' || p_table_id::text || ':' || p_hand_number::text)::uuid
    END,
    gen_random_uuid());
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
           chip_balance              = chip_balance,  -- 2026-09-02 ruling: the club share is paid weekly from the rake treasury, not per hand
           updated_at                = NOW()
     WHERE club_id = p_club_id
     RETURNING chip_balance INTO v_cw_after;

    IF v_cw_after IS NULL THEN
      INSERT INTO public.club_wallets (
        club_id, chip_balance, period_rake_collected, period_bbj_contribution,
        lifetime_rake_collected, lifetime_bbj_contribution
      ) VALUES (
        p_club_id, 0, p_rake, v_bbj, p_rake, v_bbj
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
         guard, so a replayed hand credits once and journals once. Journal failure rolls back this distribution. */
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
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,
                      v_net, v_route, p_rake, v_union_id;
END;
$function$;

-- credit_club_rake_to_treasury(uuid,numeric) body_md5=472e935f96e8efd1f7cef768e3276f86
CREATE OR REPLACE FUNCTION public.credit_club_rake_to_treasury(p_club_id uuid, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_st  text;
  v_msg text;
  v_from_type   text := 'table_stack';
  v_from_entity uuid := NULL;
BEGIN
  IF p_club_id IS NULL OR p_amount IS NULL OR p_amount = 0 THEN
    RETURN;
  END IF;

  /* CHIP STANDARD (2026-09-04): a caller that declared where the rake comes
     from is believed. fn_settle_tournament_rake declares prize_liability +
     the tournament; cash rake declares nothing and keeps the felt. Before
     this, every standalone-club tournament settlement journalled its rake
     as leaving table_stack - 1,178.96 an hour the felt never paid. */
  IF COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), '') <> '' THEN
    v_from_type := current_setting('app.ledger_counterparty', true);
    BEGIN
      v_from_entity := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_from_entity := NULL;
    END;
  END IF;

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE public.clubs
     SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount,
         total_rake    = COALESCE(total_rake, 0) + p_amount,
         updated_at    = now()
   WHERE id = p_club_id;
  PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

  /* Rake comes off its declared source and lands in the treasury. amount > 0
     is a CHECK on chip_ledger, so a negative p_amount (a correction) is
     journaled with its sides swapped rather than dropped. Journal failure rolls back the credit. */
  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, description)
    VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      CASE WHEN p_amount > 0 THEN v_from_type    ELSE 'club_treasury' END,
      CASE WHEN p_amount > 0 THEN v_from_entity  ELSE p_club_id       END,
      CASE WHEN p_amount > 0 THEN 'club_treasury' ELSE v_from_type    END,
      CASE WHEN p_amount > 0 THEN p_club_id       ELSE v_from_entity  END,
      abs(p_amount), 'rake', p_club_id,
      'Rake credited to club treasury (credit_club_rake_to_treasury)');
  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

END;
$function$;

-- fn_settle_tournament_rake(uuid,text) body_md5=0e7baa1bfeb2a2d0fed749a52f32d520
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_rake(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record; v_union uuid; v_net numeric; v_dest text; v_res jsonb;
  v_claimed integer; v_prior record; v_att jsonb; v_att_ok boolean := false;
  v_att_err text; v_users integer; v_members integer; v_done boolean := false;
  v_attempt integer := 0; v_attempts integer := 0; v_state text;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_global();
  SELECT t.id, t.status, t.club_id, t.name, t.current_players
    INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR NO KEY UPDATE;
  /* NO KEY UPDATE, not UPDATE (20260906): a cash hand's rake_records row
     references this tournament and takes KEY SHARE on it, which FOR UPDATE
     refused and NO KEY UPDATE admits. Settlement is still serialised against
     itself. */
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF upper(COALESCE(v_t.status, '')) NOT IN ('COMPLETING', 'COMPLETED', 'CANCELLED', 'CANCELED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_terminal', 'status', v_t.status);
  END IF;

  INSERT INTO public.tournament_rake_settlements (tournament_id, club_id, amount, destination, source)
  VALUES (p_tournament_id, v_t.club_id, 0, 'pending', COALESCE(p_source, 'engine'))
  ON CONFLICT (tournament_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT amount, destination, settled_at INTO v_prior
      FROM public.tournament_rake_settlements WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'already_settled', true,
      'amount', v_prior.amount, 'destination', v_prior.destination,
      'settled_at', v_prior.settled_at);
  END IF;

  -- DIAMOND PHASE 8: a Diamond event's fee sits in its custody rows, not in
  -- rake_records; it goes to the house, and then the emptied custody closes.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    v_res := public.fn_poker_diamond_tournament_settle_fee(p_tournament_id, COALESCE(p_source, 'engine'));
    v_net := COALESCE((v_res->>'amount')::numeric, 0);
    UPDATE public.tournament_rake_settlements
       SET amount = v_net,
           destination = CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END,
           settled_at = now(), attributed_at = now(), attributed_users = 0
     WHERE tournament_id = p_tournament_id;
    v_res := public.fn_poker_diamond_tournament_close_custody(p_tournament_id);
    RETURN jsonb_build_object('ok', true, 'amount', v_net,
      'destination', CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END,
      'attributed', true, 'attributed_users', 0, 'members', 0, 'asset', 'diamonds',
      'custody_closed', v_res->>'closed', 'custody_still_held', v_res->>'still_held');
  END IF;
  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_net
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;

  IF v_net <= 0 OR v_t.club_id IS NULL THEN
    UPDATE public.tournament_rake_settlements
       SET amount = GREATEST(v_net, 0),
           destination = CASE WHEN v_t.club_id IS NULL THEN 'no_club' ELSE 'none' END,
           settled_at = now(),
           attributed_at = now(),
           attributed_users = 0
     WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'amount', GREATEST(v_net, 0), 'destination', 'none');
  END IF;

  SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = v_t.club_id;

  /* ONE LOCK ORDER WITH atomic_distribute_rake (20260906). The cash path
     locks club_wallets FIRST and then union_wallets or clubs. This function
     credited the union wallet (or the club treasury) first and touched
     club_wallets last - the mirror image - and the two met in the middle 249
     times a day. Taking the club_wallets row here, before either credit, puts
     both writers in the same order: club_wallets -> union_wallets | clubs. */
  PERFORM 1 FROM public.club_wallets WHERE club_id = v_t.club_id FOR NO KEY UPDATE;

  -- ZERO-DRIFT phase 2: banked tournament rake = 'rake' vs the tournament.
  PERFORM set_config('app.ledger_category', 'rake', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

  IF v_union IS NOT NULL THEN
    v_res := public.increment_union_wallet(
      v_union, v_net, v_t.club_id,
      'Tournament rake: ' || COALESCE(v_t.name, 'tournament')
        || ' (' || COALESCE(v_t.current_players, 0) || ' entries)'
        || ' [tournament ' || p_tournament_id || ']');
    IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'fn_settle_tournament_rake: union wallet credit failed for %: %',
        p_tournament_id, v_res;
    END IF;
    v_dest := 'union:' || v_union;
  ELSE
    PERFORM public.credit_club_rake_to_treasury(v_t.club_id, v_net);
    v_dest := 'club_treasury:' || v_t.club_id;
  END IF;

  UPDATE public.club_wallets
     SET period_rake_collected   = COALESCE(period_rake_collected, 0) + v_net,
         lifetime_rake_collected = COALESCE(lifetime_rake_collected, 0) + v_net,
         updated_at = now()
   WHERE club_id = v_t.club_id;

  /* ATTRIBUTION, RETRIED INSIDE THIS TRANSACTION (2026-09-09 - see header).
     Each attempt is its own subtransaction: a deadlock or a lock timeout
     inside it rolls back only the attempt, never the settle above. The two
     SQLSTATEs retried are the two that are transient by construction; any
     other error fails once and alerts exactly as before. */
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      v_att := public.fn_attribute_tournament_rake(p_tournament_id);
      v_att_ok := COALESCE((v_att->>'ok')::boolean, false);
      v_att_err := CASE WHEN v_att_ok THEN NULL
                        ELSE COALESCE(v_att->>'reason', 'attribution returned ok=false') END;
      EXIT;
    EXCEPTION
      WHEN deadlock_detected OR lock_not_available THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
        IF v_attempt >= 4 THEN
          v_att_err := SQLERRM || ' (after ' || v_attempt || ' attempts)';
          v_att := jsonb_build_object('ok', false, 'reason', v_att_err);
          INSERT INTO public.financial_alerts (severity, source, message, context)
          VALUES ('warning', 'fn_settle_tournament_rake',
                  'Rake settled but attribution failed: ' || v_att_err,
                  jsonb_build_object('tournament_id', p_tournament_id, 'net', v_net,
                                     'sqlstate', v_state, 'attempts', v_attempt));
          EXIT;
        END IF;
        PERFORM pg_sleep(CASE v_attempt WHEN 1 THEN 0.1 WHEN 2 THEN 0.3 ELSE 0.6 END);
      WHEN OTHERS THEN
        v_att_err := SQLERRM;
        v_att := jsonb_build_object('ok', false, 'reason', v_att_err);
        INSERT INTO public.financial_alerts (severity, source, message, context)
        VALUES ('warning', 'fn_settle_tournament_rake',
                'Rake settled but attribution failed: ' || v_att_err,
                jsonb_build_object('tournament_id', p_tournament_id, 'net', v_net,
                                   'attempts', v_attempt));
        EXIT;
    END;
  END LOOP;
  v_attempts := v_attempt;

  v_users   := COALESCE((v_att->>'attributed_users')::int, 0);
  v_members := COALESCE((v_att->>'members')::int, 0);

  /* ZERO IS NOT SUCCESS. Banked rake that credited nobody, while there were
     players to credit, is a FAILURE: it stays in the repair queue
     (attributed_at IS NULL) instead of being stamped as done. A settlement
     with no members is terminal - retrying it forever would pin the head of
     that queue, which is the failure mode the Heads-Up back-pay hit. */
  v_done := v_att_ok AND (v_users > 0 OR v_members = 0);
  IF v_att_ok AND v_users = 0 AND v_members > 0 THEN
    v_att_err := 'attributed_nobody';
  END IF;

  UPDATE public.tournament_rake_settlements
     SET amount = v_net, union_id = v_union, destination = v_dest, settled_at = now(),
         attributed_at = CASE WHEN v_done THEN now() ELSE NULL END,
         attributed_users = v_users,
         attribution_error = v_att_err
   WHERE tournament_id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'amount', v_net, 'destination', v_dest,
                            'attributed', v_done,
                            'attributed_users', v_users, 'members', v_members,
                            'attribution_attempts', v_attempts);
END;
$function$;

-- fn_ca_issuance_leg_is_registered() body_md5=c1d8a753e3f9b70d417c6106d4364668
CREATE OR REPLACE FUNCTION public.fn_ca_issuance_leg_is_registered()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
  v_pol public.ca_mint_policy%ROWTYPE;
  v_24h numeric;
BEGIN
  IF NEW.from_type = ANY (v_outside) AND NOT (NEW.to_type = ANY (v_outside))
     AND NEW.category <> 'correction' THEN
    SELECT * INTO v_pol FROM public.ca_mint_policy WHERE id = 1;
    IF NEW.amount > v_pol.per_operation_cap_chips THEN
      RAISE EXCEPTION 'issuance refused: % chips in one leg is over the per-operation ceiling of % (ca_mint_policy; raise it with a reason through fn_ca_mint_policy_set before a deliberate batch)',
        NEW.amount, v_pol.per_operation_cap_chips USING ERRCODE = 'P0403';
    END IF;
    v_24h := public.fn_ca_mint_issued_24h('chips', NEW.id) + NEW.amount;
    IF v_24h > v_pol.rolling_24h_cap_chips THEN
      RAISE EXCEPTION 'issuance refused: this leg would bring the last 24 hours to % chips, over the rolling ceiling of % (ca_mint_policy; raise it with a reason through fn_ca_mint_policy_set before a deliberate batch)',
        v_24h, v_pol.rolling_24h_cap_chips USING ERRCODE = 'P0403';
    END IF;
  END IF;
  PERFORM public.fn_ca_register_issuance_leg(NEW.id);
  RETURN NULL;
END;
$function$;

-- fn_ca_noncirculating_chip_stores() body_md5=6f8ab0521ef43f137a39059498111300
CREATE OR REPLACE FUNCTION public.fn_ca_noncirculating_chip_stores()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY['system_mint', 'system_burn', 'issuance_reserve', 'chip_retirement']::text[];
$function$;

-- fn_ca_register_issuance_leg(uuid) body_md5=530dfe266e19c7e80477707fc21f0bee
CREATE OR REPLACE FUNCTION public.fn_ca_register_issuance_leg(p_ledger_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  l record; v_action text; v_holder_type text; v_holder uuid; v_label text;
  v_before numeric; v_after numeric; v_supply numeric; v_reason text; v_op text;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
BEGIN
  SELECT * INTO l FROM public.chip_ledger WHERE id = p_ledger_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.chip_ledger_id = l.id) THEN
    RETURN false;
  END IF;
  IF l.category = 'correction' AND l.metadata->>'posted_via' = 'fn_ca_post_correction' THEN
    RETURN false;  -- a correction moves no balance (a_correction_is_not_a_mint)
  END IF;
  IF l.from_type = ANY (v_outside) AND NOT (l.to_type = ANY (v_outside)) THEN
    v_action := 'mint'; v_holder := l.to_entity_id;
    v_holder_type := CASE l.to_type
      WHEN 'club_treasury' THEN 'club' WHEN 'club_wallet' THEN 'club'
      WHEN 'union_bank' THEN 'union' WHEN 'union_wallet' THEN 'union'
      WHEN 'player_wallet' THEN 'player' WHEN 'promo_wallet' THEN 'player'
      ELSE 'circulation' END;
  ELSIF l.to_type = ANY (v_outside) AND NOT (l.from_type = ANY (v_outside)) THEN
    v_action := 'burn'; v_holder := l.from_entity_id;
    v_holder_type := CASE l.from_type
      WHEN 'club_treasury' THEN 'club' WHEN 'club_wallet' THEN 'club'
      WHEN 'union_bank' THEN 'union' WHEN 'union_wallet' THEN 'union'
      WHEN 'player_wallet' THEN 'player' WHEN 'promo_wallet' THEN 'player'
      ELSE 'circulation' END;
  ELSE
    RETURN false;  -- store to store, or circulating to circulating
  END IF;
  -- The autoledger stamps a union wallet's row with the union id; a union is
  -- also a row in clubs (is_union), so resolve by what the id actually is.
  IF v_holder_type = 'club' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_holder AND COALESCE(c.is_union, false)) THEN
    v_holder_type := 'union';
  END IF;
  IF v_holder IS NULL THEN
    v_holder_type := 'circulation';
  END IF;
  IF v_holder_type = 'circulation' THEN
    v_holder := '00000000-0000-0000-0000-00000000c1c0';  -- the circulation sentinel (the house is ...d1a0)
  END IF;
  v_label := CASE v_holder_type
    WHEN 'club'   THEN (SELECT c.name FROM public.clubs c WHERE c.id = v_holder)
    WHEN 'union'  THEN COALESCE((SELECT u.name FROM public.unions u WHERE u.id = v_holder), (SELECT c.name FROM public.clubs c WHERE c.id = v_holder))
    WHEN 'player' THEN (SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text) FROM public.profiles p WHERE p.id = v_holder)
    ELSE 'circulation' END;
  -- A leg written by hand (a linked compensating entry) carries no balances;
  -- the register still wants a pair, so the pair is the amount itself.
  /* A door that wrote its own register row but did not link the leg
     (fn_ca_burn looks the leg up by a shape it does not always match):
     adopt that row rather than write a second one. Same action, holder,
     amount, asset, within five seconds of the leg, not yet linked. */
  UPDATE public.ca_mint_ledger m
     SET chip_ledger_id = l.id
   WHERE m.id = (SELECT m2.id FROM public.ca_mint_ledger m2
                  WHERE m2.chip_ledger_id IS NULL AND m2.asset = 'chips' AND m2.action = v_action
                    AND m2.amount = l.amount AND m2.holder_id = v_holder
                    AND m2.created_at BETWEEN l.created_at - interval '5 seconds' AND l.created_at + interval '5 seconds'
                  ORDER BY m2.created_at LIMIT 1);
  IF FOUND THEN RETURN false; END IF;
  v_before := COALESCE(CASE WHEN v_action = 'mint' THEN l.pre_to_balance ELSE l.pre_from_balance END, 0);
  v_after  := COALESCE(CASE WHEN v_action = 'mint' THEN l.post_to_balance ELSE l.post_from_balance END,
                       v_before + CASE WHEN v_action = 'mint' THEN l.amount ELSE -l.amount END);
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
       + CASE WHEN v_action = 'mint' THEN l.amount ELSE -l.amount END
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = 'chips';
  v_op := 'ledger:' || l.id::text;
  v_reason := left(COALESCE(NULLIF(btrim(l.description), ''), l.category) || ' (' || l.category
              || CASE WHEN l.idempotency_key IS NOT NULL THEN ', key ' || l.idempotency_key ELSE '' END
              || '; registered from the journal leg)', 500);
  IF length(btrim(v_reason)) < 10 THEN v_reason := v_reason || ' - registered from the journal'; END IF;
  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason, performed_by, performed_by_label, db_role, chip_ledger_id, created_at)
  VALUES (v_op, v_action, 'chips', v_holder_type, v_holder, v_label, l.amount,
          v_before, v_after, v_supply, v_reason, l.performed_by, COALESCE(l.actor_service, l.db_role), l.db_role, l.id, l.created_at)
  ON CONFLICT (op_id) DO NOTHING;
  RETURN true;
END;
$function$;

-- fn_ca_escrow_apply(uuid,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric) body_md5=e084726dde176e51a8b1b0d64b0c2f0b
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_apply(p_tournament_id uuid, p_what text, p_gross_in numeric DEFAULT 0, p_fee_entries_in numeric DEFAULT 0, p_satellite_fee_in numeric DEFAULT 0, p_bounty_in numeric DEFAULT 0, p_overlay_in numeric DEFAULT 0, p_satellite_in numeric DEFAULT 0, p_prize_out numeric DEFAULT 0, p_bounty_out numeric DEFAULT 0, p_fee_out numeric DEFAULT 0, p_refund numeric DEFAULT 0, p_reserve_out numeric DEFAULT 0, p_reserve_in numeric DEFAULT 0)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v public.tournament_escrow%ROWTYPE;
  v_spin boolean; e record; v_sat_fee numeric;
  v_prize_in numeric; v_tot numeric; r_p numeric := 0; r_b numeric := 0; r_f numeric := 0;
  v_outflow boolean := COALESCE(p_prize_out, 0) > 0 OR COALESCE(p_bounty_out, 0) > 0 OR COALESCE(p_fee_out, 0) > 0 OR COALESCE(p_refund, 0) > 0;
  r_out numeric := 0; r_in numeric := 0;
  v_sp_prize numeric; v_sp_bounty numeric;
BEGIN
  SELECT * INTO v FROM public.tournament_escrow WHERE tournament_id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT (COALESCE(t.variant, '') = 'spin' OR COALESCE(t.is_premium_spin, false)) INTO v_spin
      FROM public.tournaments t WHERE t.id = p_tournament_id;
    IF NOT FOUND THEN
      RETURN;
    END IF;
    SELECT * INTO e FROM public.fn_ca_tournament_escrow(p_tournament_id);
    SELECT COALESCE(sum(rr.rake_amount), 0) INTO v_sat_fee FROM public.rake_records rr
     WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament AND rr.source = 'fn_award_satellite_seat';
    v_prize_in := e.prize_in; v_tot := e.prize_in + e.satellite_in + e.bounty_in + e.fee_in;
    IF v_tot > 0 THEN
      r_p := round(e.refund_out * (e.prize_in + e.satellite_in) / v_tot, 2);
      r_b := round(e.refund_out * e.bounty_in / v_tot, 2);
    ELSE
      r_p := e.refund_out;
    END IF;
    r_f := round(e.refund_out - r_p - r_b, 2);
    /* PHASE 5.2: a spin's prize bank also moves through the reserve.
       2026-09-07: read from spin_reserve_ledger, not from the chip_ledger
       spin_entry / spin_prize legs it used to read. Those legs are the DERIVED
       record and one pair of them went missing: on 2026-09-06 at 12:50:38 both
       legs of tournament afa045db landed as `adjustment` rows into
       settlement_suspense with a NULL entity, their intended category
       surviving only inside the description text. The escrow therefore never
       learned that 60.00 had been drawn for a 60.00 prize, and
       fn_settle_tournament_obligation refused the winner's last 4.80 as
       escrow_short - for a day, with an open critical alert nobody could act
       on. spin_reserve_ledger is the record the pool balance itself moved by;
       it cannot be missing while the money has moved. Verified across 18,318
       escrow rows: 0 disagree with it, 1 was missing the legs entirely. */
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.kind = 'contribution'), 0),
           COALESCE(-sum(l.amount) FILTER (WHERE l.kind = 'jackpot_draw'), 0)
      INTO r_out, r_in
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id
       AND l.kind IN ('contribution', 'jackpot_draw');
    INSERT INTO public.tournament_escrow
      (tournament_id, enforced, gross_in, fee_entries_in, satellite_fee_in, bounty_in, overlay_in, satellite_in,
       prize_out, bounty_out, fee_out, refund_prize, refund_bounty, refund_fee, reserve_out, reserve_in,
       prize_balance, bounty_balance, fee_balance, opened_from)
    VALUES
      (p_tournament_id, true,
       round(e.prize_in + e.bounty_in + (e.fee_in - v_sat_fee), 2), round(e.fee_in - v_sat_fee, 2), round(v_sat_fee, 2),
       e.bounty_in, e.overlay_in, e.satellite_in, e.prize_out, e.bounty_out, e.fee_out, r_p, r_b, r_f, round(r_out, 2), round(r_in, 2),
       round(e.prize_balance - r_out + r_in, 2), e.bounty_balance, e.fee_balance,
       'shadow at first sight (' || p_what || ')')
    ON CONFLICT (tournament_id) DO NOTHING;
    RETURN;
  END IF;

  IF COALESCE(p_refund, 0) > 0 THEN
    v_prize_in := v.gross_in - v.fee_entries_in - v.bounty_in + v.satellite_in;
    v_tot := v.gross_in + v.satellite_in + v.satellite_fee_in;
    IF v_tot > 0 THEN
      r_p := round(p_refund * v_prize_in / v_tot, 2);
      r_b := round(p_refund * v.bounty_in / v_tot, 2);
    ELSE
      SELECT s.prize, s.bounty INTO v_sp_prize, v_sp_bounty
        FROM public.tournaments t2
        CROSS JOIN LATERAL public.fn_tournament_entry_split(t2.buy_in_amount, t2.buy_in_fee, t2.bounty_amount,
               COALESCE(t2.is_bounty, false) OR COALESCE(t2.is_pko, false) OR COALESCE(t2.is_mystery_bounty, false)) s
       WHERE t2.id = p_tournament_id;
      IF COALESCE(v_sp_prize, 0) + COALESCE(v_sp_bounty, 0) > 0 THEN
        r_p := round(p_refund * v_sp_prize / (v_sp_prize + v_sp_bounty + (SELECT COALESCE(t3.buy_in_fee, 0) FROM public.tournaments t3 WHERE t3.id = p_tournament_id)), 2);
        r_b := round(p_refund * v_sp_bounty / (v_sp_prize + v_sp_bounty + (SELECT COALESCE(t3.buy_in_fee, 0) FROM public.tournaments t3 WHERE t3.id = p_tournament_id)), 2);
      ELSE
        r_p := p_refund;
      END IF;
    END IF;
    r_f := round(p_refund - r_p - r_b, 2);
  END IF;

  UPDATE public.tournament_escrow
     SET gross_in = gross_in + COALESCE(p_gross_in, 0),
         fee_entries_in = fee_entries_in + COALESCE(p_fee_entries_in, 0),
         satellite_fee_in = satellite_fee_in + COALESCE(p_satellite_fee_in, 0),
         bounty_in = bounty_in + COALESCE(p_bounty_in, 0),
         overlay_in = overlay_in + COALESCE(p_overlay_in, 0),
         satellite_in = satellite_in + COALESCE(p_satellite_in, 0),
         prize_out = prize_out + COALESCE(p_prize_out, 0),
         bounty_out = bounty_out + COALESCE(p_bounty_out, 0),
         fee_out = fee_out + COALESCE(p_fee_out, 0),
         refund_prize = refund_prize + r_p, refund_bounty = refund_bounty + r_b, refund_fee = refund_fee + r_f,
         reserve_out = reserve_out + COALESCE(p_reserve_out, 0), reserve_in = reserve_in + COALESCE(p_reserve_in, 0),
         updated_at = now()
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_escrow
     SET prize_balance  = round((gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in - reserve_out + reserve_in - prize_out - refund_prize, 2),
         bounty_balance = round(bounty_in - bounty_out - refund_bounty, 2),
         fee_balance    = round(fee_entries_in + satellite_fee_in - fee_out - refund_fee, 2)
   WHERE tournament_id = p_tournament_id
   RETURNING * INTO v;

  IF v.enforced AND v_outflow
     AND (v.prize_balance < -0.005 OR v.bounty_balance < -0.005 OR v.fee_balance < -0.005) THEN
    RAISE EXCEPTION 'escrow_short: tournament % cannot pay this % - it would leave prize %, bounty %, fee % (chip standard Phase 5.1: an event pays only what it holds)',
      p_tournament_id, p_what, v.prize_balance, v.bounty_balance, v.fee_balance
      USING ERRCODE = 'P0403';
  END IF;
END;
$function$;

-- fn_ca_lock_settlement_lane_global() body_md5=343015440ea5c84ee4ca7ae583c73d30
CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_global()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- G then B. Terminal / rare authorities: serialised against every other
  -- authority AND against every hand settlement, as on 2026-09-09.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:hand-settlement-barrier:v1', 0));
END;
$function$;

-- increment_union_wallet(uuid,numeric,uuid,text) body_md5=ff44560c11de265a32c84e0b5237db63
CREATE OR REPLACE FUNCTION public.increment_union_wallet(p_union_id uuid, p_amount numeric, p_club_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_amount numeric; v_new_rake numeric;
BEGIN
  IF p_union_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'p_union_id required'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('success', true, 'skipped', 'zero_amount'); END IF;
  v_amount := round(p_amount, 2);

  -- ZERO-DRIFT phase 2: declare the ledger category unless the caller
  -- already set one in this transaction (caller context is richer).
  IF COALESCE(current_setting('app.ledger_category', true), '') = '' THEN
    PERFORM set_config('app.ledger_category', 'rake', true);
    PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
  END IF;

  -- Rake Treasury only - see rake_lands_only_in_rake_treasury_not_union_bank.
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
END $function$;

-- fn_ca_autoledger() body_md5=936fc64feb1ee48cd7d4ea0ac8d2c121
CREATE OR REPLACE FUNCTION public.fn_ca_autoledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  spec text; col text; acct text;
  o jsonb; nn jsonb;
  d numeric; oldv numeric; newv numeric;
  cat text; cp text; cpid uuid;
  v_club uuid; v_union uuid; v_entity uuid;
  actor uuid;
  v_st text; v_msg text;
BEGIN
  IF current_setting('app.ledger_autoskip_' || TG_TABLE_NAME, true) = '1' THEN
    RETURN NEW;
  END IF;

  o  := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  nn := to_jsonb(NEW);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');
  cp  := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN cpid := NULL;
  END;
  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  v_club := CASE
    WHEN TG_TABLE_NAME = 'clubs' THEN (nn->>'id')::uuid
    WHEN nn ? 'club_id' THEN NULLIF(nn->>'club_id','')::uuid
    ELSE NULL END;
  v_union := CASE
    WHEN TG_TABLE_NAME = 'unions' THEN (nn->>'id')::uuid
    WHEN nn ? 'union_id' THEN NULLIF(nn->>'union_id','')::uuid
    ELSE NULL END;
  v_entity := CASE
    WHEN TG_TABLE_NAME = 'agents' THEN NULLIF(nn->>'user_id','')::uuid
    WHEN TG_TABLE_NAME = 'club_members' THEN NULLIF(nn->>'user_id','')::uuid
    ELSE COALESCE(NULLIF(nn->>'id','')::uuid, v_club, v_union) END;

  FOR i IN 0 .. TG_NARGS - 1 LOOP
    spec := TG_ARGV[i];
    col  := split_part(spec, '=', 1);
    acct := split_part(spec, '=', 2);
    oldv := COALESCE(NULLIF(o->>col,'')::numeric, 0);
    newv := COALESCE(NULLIF(nn->>col,'')::numeric, 0);
    d := round(newv - oldv, 2);
    CONTINUE WHEN d = 0;

    BEGIN
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, union_id, description,
         pre_from_balance, post_from_balance, pre_to_balance, post_to_balance)
      VALUES (actor,
        CASE WHEN d > 0 THEN cp   ELSE acct END,
        CASE WHEN d > 0 THEN cpid ELSE v_entity END,
        CASE WHEN d > 0 THEN NULL ELSE TG_TABLE_NAME || '.' || col END,
        CASE WHEN d > 0 THEN acct ELSE cp END,
        CASE WHEN d > 0 THEN v_entity ELSE cpid END,
        CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE NULL END,
        abs(d), cat, v_club, v_union,
        'auto-ledgered ' || TG_TABLE_NAME || '.' || col || ' delta ' || d::text,
        CASE WHEN d < 0 THEN oldv END, CASE WHEN d < 0 THEN newv END,
        CASE WHEN d > 0 THEN oldv END, CASE WHEN d > 0 THEN newv END);
    EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;
  END LOOP;

  RETURN NEW;
END $function$;

-- fn_ca_escrow_on_rake_settlement() body_md5=62a7f693920a379fb7acec3430cbd384
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_rake_settlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.settled_at IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.settled_at IS NOT NULL THEN RETURN NULL; END IF;
  PERFORM public.fn_ca_escrow_apply(NEW.tournament_id, 'fee settlement', p_fee_out => round(COALESCE(NEW.amount, 0), 2));
  RETURN NULL;
END;
$function$;

