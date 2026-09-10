-- PROPOSAL ONLY. Execute with receipt DDL and source activation in ONE bounded transaction.
DO $pin$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=
 'public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure)
 IS DISTINCT FROM '56fe5715421d7e35bc386a669bb483a2' THEN
  RAISE EXCEPTION 'Actual cash bank owner changed';
 END IF;
END $pin$;
CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(p_table_id uuid, p_club_id uuid, p_hand_id uuid, p_hand_number integer, p_rake numeric, p_bbj numeric DEFAULT 0, p_pot numeric DEFAULT NULL::numeric, p_num_players integer DEFAULT (NULL::numeric)::integer, p_contributions jsonb DEFAULT NULL::jsonb, p_tournament_id uuid DEFAULT NULL::uuid, p_returned_uncalled jsonb DEFAULT NULL::jsonb, p_rake_method text DEFAULT 'DEALT_EQUAL'::text)
 RETURNS TABLE(applied boolean, already_processed boolean, recovered boolean, rake_record_id uuid, club_net_credit numeric, spendable_route text, spendable_amount numeric, union_id_out uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_source public.ca_cash_commission_sources%ROWTYPE;
  v_receipt public.ca_cash_bank_receipts%ROWTYPE;
  v_captured boolean := false;
  v_envelope jsonb;
  v_bank_tx uuid;
  v_bank_ledger uuid;
  v_bank_at timestamptz;
  v_bank_before numeric;
  v_bank_after numeric;
  v_lock_club uuid;
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
  IF p_hand_id IS NULL AND p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
   SELECT id INTO p_hand_id FROM public.hand_history
   WHERE table_id=p_table_id AND hand_number=p_hand_number ORDER BY created_at DESC LIMIT 1;
  END IF;
  IF EXISTS(SELECT 1 FROM public.ca_cash_commission_sources
   WHERE table_id=p_table_id AND hand_number=p_hand_number AND hand_id IS DISTINCT FROM p_hand_id) THEN
   RAISE EXCEPTION 'Captured cash bank cannot resolve its accepted hand identity';
  END IF;
  SELECT * INTO v_source FROM public.ca_cash_commission_sources WHERE hand_id=p_hand_id;
  v_captured:=FOUND;
  IF v_captured THEN
   SELECT h.post_commit_payload->'rake' INTO v_envelope
   FROM public.hand_atomic_commits h JOIN public.ca_cash_commission_authority a ON a.singleton
   WHERE h.hand_id=p_hand_id AND h.commission_capture_version=a.contract_version
    AND a.contract_version=1 AND h.post_commit_payload_hash=v_source.accepted_payload_hash;
   IF NOT FOUND OR p_table_id IS DISTINCT FROM v_source.table_id
    OR p_club_id IS DISTINCT FROM v_source.requested_club_id
    OR p_hand_number IS DISTINCT FROM v_source.hand_number
    OR p_rake IS DISTINCT FROM v_source.rake_total
    OR coalesce(p_bbj,0) IS DISTINCT FROM (v_envelope->>'bbj')::numeric
    OR p_pot IS DISTINCT FROM (v_envelope->>'pot')::numeric
    OR p_num_players IS DISTINCT FROM (v_envelope->>'num_players')::integer
    OR p_contributions IS DISTINCT FROM v_source.contributions
    OR p_returned_uncalled IS DISTINCT FROM v_source.returned_uncalled
    OR p_rake_method IS DISTINCT FROM v_source.rake_method
    OR p_tournament_id IS NOT NULL THEN
     RAISE EXCEPTION 'Cash bank arguments conflict with accepted source';
   END IF;
   -- Shared club admission precedes this bank's hand and wallet locks.
   FOR v_lock_club IN
    SELECT club_id FROM (
     SELECT v_source.requested_club_id AS club_id UNION
     SELECT booked_club_id FROM public.ca_cash_commission_facts WHERE hand_id=p_hand_id
    ) c WHERE club_id IS NOT NULL ORDER BY club_id
   LOOP
    PERFORM pg_advisory_xact_lock(hashtext('club-arena:rakeback-payer'),hashtext(v_lock_club::text));
   END LOOP;
   PERFORM public.fn_ca_cash_bank_admission(p_hand_id,p_table_id,p_hand_number::text);
   SELECT * INTO v_receipt FROM public.ca_cash_bank_receipts WHERE hand_id=p_hand_id;
   IF FOUND THEN
    PERFORM public.fn_ca_assert_cash_bank_receipt(p_hand_id);
    RETURN QUERY SELECT false,true,false,v_receipt.rake_record_id,v_receipt.club_net_credit,
     v_receipt.funding_route,v_receipt.credited_amount,v_receipt.funding_union_id;
    RETURN;
   END IF;
   IF EXISTS(SELECT 1 FROM public.rake_records WHERE hand_id=p_hand_id
      OR (table_id=p_table_id AND metadata->>'hand_number'=p_hand_number::text))
    OR EXISTS(SELECT 1 FROM public.rake_distribution_legs WHERE leg_key IN
      (v_source.bank_leg_key,md5('rake:'||p_table_id::text||':'||p_hand_number::text)::uuid)) THEN
    RAISE EXCEPTION 'Captured cash bank refuses preexisting unacknowledged funding';
   END IF;
  END IF;
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

  IF v_captured THEN
   v_union_id:=v_source.funding_union_id;
   v_is_private:=(v_source.funding_context->>'is_private')::boolean;
  ELSE
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
           CASE WHEN v_captured THEN
            (SELECT f.booked_club_id FROM public.ca_cash_commission_facts f
             WHERE f.hand_id=p_hand_id AND f.player_id=a.user_id)
           ELSE COALESCE((SELECT ts.club_id FROM public.table_seats ts
                      WHERE ts.table_id = p_table_id AND ts.user_id = a.user_id
                      ORDER BY ts.joined_at DESC NULLS LAST LIMIT 1), p_club_id) END,
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
  -- A prior spendable route cannot be changed into a second credit, including
  -- legacy replays. Refusal leaves prior history untouched.
  IF EXISTS(SELECT 1 FROM public.rake_distribution_legs l WHERE l.leg_key=v_leg_key
   AND l.leg IN ('union_rake','chip_treasury')
   AND (l.leg IS DISTINCT FROM CASE WHEN v_union_id IS NULL THEN 'chip_treasury' ELSE 'union_rake' END
    OR l.union_id IS DISTINCT FROM v_union_id OR l.club_id IS DISTINCT FROM p_club_id
    OR l.amount IS DISTINCT FROM p_rake)) THEN
   RAISE EXCEPTION 'Cash bank replay conflicts with original spendable leg';
  END IF;

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
      SELECT coalesce(rake_wallet,0) INTO v_bank_before FROM public.union_wallets
       WHERE union_id=v_union_id FOR UPDATE;
      IF NOT FOUND THEN v_bank_before:=0; END IF;
      INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
           VALUES (v_union_id, 0, p_rake, p_rake)
      ON CONFLICT (union_id) DO UPDATE SET
           rake_wallet          = public.union_wallets.rake_wallet + p_rake,
           total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + p_rake,
           updated_at           = NOW()
      RETURNING rake_wallet INTO v_union_rake;
      IF NOT FOUND OR v_union_rake IS DISTINCT FROM v_bank_before+p_rake THEN
       RAISE EXCEPTION 'Cash bank Union destination credit did not apply exactly once';
      END IF;

      INSERT INTO public.union_wallet_transactions (
        union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes
      ) VALUES (
        v_union_id, p_club_id, p_rake, 'rake', 'rake_wallet', 'credit', v_union_rake,
        'Cash game rake: hand #' || COALESCE(p_hand_number::text, '?') ||
          ' (' || COALESCE(v_club_name, 'club') || ')'
      ) RETURNING id,created_at INTO v_bank_tx,v_bank_at;

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
      SELECT coalesce(chip_treasury,0) INTO STRICT v_bank_before FROM public.clubs
       WHERE id=p_club_id FOR UPDATE;
      PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
      UPDATE public.clubs
         SET chip_treasury = COALESCE(chip_treasury, 0) + p_rake,
             total_rake    = COALESCE(total_rake, 0) + p_rake,
             updated_at    = NOW()
       WHERE id = p_club_id RETURNING chip_treasury INTO v_bank_after;
      IF NOT FOUND OR v_bank_after IS DISTINCT FROM v_bank_before+p_rake THEN
       RAISE EXCEPTION 'Cash bank club destination credit did not apply exactly once';
      END IF;
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
            || ' (atomic_distribute_rake)')
        RETURNING id,created_at INTO v_bank_ledger,v_bank_at;
      EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  END IF;

  IF v_captured THEN
   IF NOT v_first_claim OR v_recovered OR v_bank_at IS NULL
    OR (v_bank_tx IS NULL AND v_bank_ledger IS NULL)
    OR v_route IS DISTINCT FROM v_source.funding_route THEN
    RAISE EXCEPTION 'Captured cash bank did not produce a complete new credit';
   END IF;
   INSERT INTO public.ca_cash_bank_receipts(hand_id,contract_version,accepted_payload_hash,
    rake_record_id,leg_key,leg,requested_club_id,funding_union_id,funding_route,credited_amount,
    bbj_contribution,club_net_credit,union_wallet_transaction_id,chip_ledger_id,bank_credit_at)
   VALUES(p_hand_id,1,v_source.accepted_payload_hash,v_rr_id,v_leg_key,
    CASE WHEN v_union_id IS NULL THEN 'chip_treasury' ELSE 'union_rake' END,p_club_id,v_union_id,
    v_route,p_rake,v_bbj,v_net,v_bank_tx,v_bank_ledger,v_bank_at);
   PERFORM public.fn_ca_assert_cash_bank_receipt(p_hand_id);
  END IF;
  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,
                      v_net, v_route, p_rake, v_union_id;
END;
$function$;
