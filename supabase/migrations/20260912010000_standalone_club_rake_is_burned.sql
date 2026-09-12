-- Dan, 2026-09-11: standalone club rake is burned; union rake is retained.
-- Forward-only: no historical balances, ledgers, receipts or rakeback are rewritten.
-- Cash rake and BBJ are separate drops. Only p_rake is retired; BBJ is unchanged.
-- The old cash destination claim remains a compatibility receipt, not a credit.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $preimage$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'))
       IS DISTINCT FROM '56fe5715421d7e35bc386a669bb483a2' THEN
    RAISE EXCEPTION 'atomic_distribute_rake preimage changed; re-review rake burn migration';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.credit_club_rake_to_treasury(uuid,numeric)'))
       IS DISTINCT FROM '472e935f96e8efd1f7cef768e3276f86' THEN
    RAISE EXCEPTION 'credit_club_rake_to_treasury preimage changed; re-review rake burn migration';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.fn_settle_tournament_rake(uuid,text)'))
       IS DISTINCT FROM 'be08a61e1a867519048c4692b41ab1fd' THEN
    RAISE EXCEPTION 'fn_settle_tournament_rake preimage changed; re-review rake burn migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.chip_ledger'::regclass
       AND tgname = 'zz_ca_issuance_leg_is_registered' AND tgenabled = 'O'
       AND tgdeferrable AND tginitdeferred
       AND tgfoid = 'public.fn_ca_issuance_leg_is_registered()'::regprocedure
  ) OR NOT ('chip_retirement' = ANY(public.fn_ca_noncirculating_chip_stores())) THEN
    RAISE EXCEPTION 'rake retirement requires the enabled native supply register';
  END IF;
END;
$preimage$;

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
  v_prior        record;
  v_destination_count integer;
  v_receipt_key_count integer;
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

  IF p_rake::text IN ('NaN', 'Infinity', '-Infinity') OR p_rake <> round(p_rake, 2) THEN
    RAISE EXCEPTION 'rake must be finite whole cents' USING ERRCODE = '22023';
  END IF;
  IF p_hand_id IS NULL AND (p_table_id IS NULL OR p_hand_number IS NULL) THEN
    RAISE EXCEPTION 'rake requires a hand id or table and number' USING ERRCODE = '22023';
  END IF;
  -- Serialize the same logical hand even when its history id arrives later.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'rake:' || CASE WHEN p_table_id IS NOT NULL AND p_hand_number IS NOT NULL
      THEN p_table_id::text || ':' || p_hand_number::text ELSE p_hand_id::text END, 0));
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

  -- Reuse the original record after the hand-history id becomes available.
  -- The indexed leg lookup avoids scanning table history for each new hand.
  IF p_hand_id IS NOT NULL THEN
    SELECT * INTO v_prior FROM public.rake_records
     WHERE hand_id = p_hand_id ORDER BY created_at LIMIT 1 FOR UPDATE;
    IF FOUND THEN v_rr_id := v_prior.id; END IF;
  END IF;
  IF v_rr_id IS NULL AND p_table_id IS NOT NULL AND p_hand_number IS NOT NULL
     AND (p_hand_id IS NULL OR EXISTS (
       SELECT 1 FROM public.rake_distribution_legs
        WHERE leg_key = md5('rake:' || p_table_id::text || ':' || p_hand_number::text)::uuid)) THEN
    SELECT * INTO v_prior FROM public.rake_records rr
     WHERE rr.table_id = p_table_id AND rr.metadata->>'hand_number' = p_hand_number::text
     ORDER BY rr.created_at LIMIT 1 FOR UPDATE;
    IF FOUND THEN v_rr_id := v_prior.id; END IF;
  END IF;
  IF v_rr_id IS NULL THEN
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
    v_first_claim := v_rr_id IS NOT NULL;
    IF NOT v_first_claim THEN
      SELECT * INTO v_prior FROM public.rake_records
       WHERE hand_id = p_hand_id ORDER BY created_at LIMIT 1 FOR UPDATE;
      v_rr_id := v_prior.id;
    END IF;
  END IF;
  IF NOT v_first_claim THEN
    IF v_prior.club_id IS DISTINCT FROM p_club_id
       OR v_prior.table_id IS DISTINCT FROM p_table_id
       OR v_prior.rake_amount IS DISTINCT FROM p_rake
       OR v_prior.bbj_contribution IS DISTINCT FROM v_bbj
       OR v_prior.tournament_id IS DISTINCT FROM p_tournament_id
       OR (v_prior.hand_id IS NOT NULL AND p_hand_id IS NOT NULL
           AND v_prior.hand_id IS DISTINCT FROM p_hand_id)
       OR (v_prior.metadata ? 'hand_number'
           AND v_prior.metadata->>'hand_number' IS DISTINCT FROM p_hand_number::text) THEN
      RAISE EXCEPTION 'rake replay changed its financial identity' USING ERRCODE = '22023';
    END IF;
    p_hand_id := COALESCE(v_prior.hand_id, p_hand_id);
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

  -- New hands keep one table/number identity before and after history writes.
  -- Adopt a legacy UUID key if it already exists instead of creating a new leg.
  v_leg_key := CASE WHEN p_table_id IS NOT NULL AND p_hand_number IS NOT NULL
    THEN md5('rake:' || p_table_id::text || ':' || p_hand_number::text)::uuid
    ELSE p_hand_id END;
  SELECT count(DISTINCT leg_key) INTO v_receipt_key_count
    FROM public.rake_distribution_legs WHERE leg_key IN (v_leg_key, p_hand_id);
  IF v_receipt_key_count > 1 THEN
    RAISE EXCEPTION 'rake has conflicting hand identities' USING ERRCODE = '55000';
  ELSIF v_receipt_key_count = 1 THEN
    SELECT leg_key INTO v_leg_key FROM public.rake_distribution_legs
     WHERE leg_key IN (v_leg_key, p_hand_id) LIMIT 1;
  END IF;
  PERFORM set_config('app.ledger_settlement', 'rake:' || v_leg_key::text, true);

  -- A settled hand keeps its original destination after membership changes.
  -- The historical chip_treasury claim key also protects old credits from
  -- being burned again when this forward-only policy is installed.
  SELECT count(*) INTO v_destination_count FROM public.rake_distribution_legs
   WHERE leg_key = v_leg_key AND leg IN ('union_rake', 'chip_treasury');
  IF v_destination_count > 1 THEN
    RAISE EXCEPTION 'rake has conflicting destination receipts' USING ERRCODE = '55000';
  END IF;
  IF v_destination_count = 1 THEN
    SELECT l.leg, l.club_id, l.union_id INTO v_prior FROM public.rake_distribution_legs l
     WHERE l.leg_key = v_leg_key AND l.leg IN ('union_rake', 'chip_treasury');
    IF v_prior.club_id IS DISTINCT FROM p_club_id
       OR (v_prior.leg = 'union_rake' AND v_prior.union_id IS NULL)
       OR (v_prior.leg = 'chip_treasury' AND v_prior.union_id IS NOT NULL) THEN
      RAISE EXCEPTION 'rake destination receipt has invalid ownership' USING ERRCODE = '55000';
    END IF;
    v_union_id := v_prior.union_id;
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
    v_route := 'chip_retirement';
    -- Keep this claim name: existing treasury receipts remain completed.
    INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
    VALUES (v_leg_key, 'chip_treasury', p_club_id, NULL, p_rake)
    ON CONFLICT (leg_key, leg) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      UPDATE public.clubs
         SET total_rake = COALESCE(total_rake, 0) + p_rake, updated_at = NOW()
       WHERE id = p_club_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'rake club is missing' USING ERRCODE = '23503';
      END IF;

      -- The hand already deducted rake from the felt. Do not debit any
      -- wallet or treasury a second time. The enabled deferred issuance
      -- trigger registers this exact retirement leg in ca_mint_ledger.
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, to_type, to_entity_id,
         amount, category, club_id, table_id, hand_id, tournament_id,
         idempotency_key, description)
      VALUES (
        COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
        'table_stack', p_table_id, 'chip_retirement', NULL,
        p_rake, 'rake', p_club_id, p_table_id, p_hand_id, p_tournament_id,
        'rake:' || v_leg_key::text || ':standalone_burn',
        'Standalone club rake burned, hand ' || COALESCE('#' || p_hand_number::text, 'unknown')
          || ' (atomic_distribute_rake)');
      IF NOT v_first_claim THEN v_recovered := true; END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM public.chip_ledger
       WHERE idempotency_key = 'rake:' || v_leg_key::text || ':standalone_burn'
         AND to_type = 'chip_retirement'
    ) THEN
      -- Report the historical receipt honestly; it is not a new burn.
      v_route := 'club_chip_treasury';
    END IF;
  END IF;

  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,
                      CASE WHEN v_route = 'chip_retirement' THEN 0::numeric ELSE v_net END,
                      v_route, CASE WHEN v_route = 'chip_retirement' THEN 0::numeric ELSE p_rake END,
                      v_union_id;
END;
$function$;
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
  SELECT t.id, t.status, t.club_id, t.name, t.current_players, t.is_private, t.union_id
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

  -- Match the cash router's game ownership. Private games never credit a
  -- union; an existing union stamp survives later club membership changes.
  -- Unstamped historical public events keep their existing club fallback.
  v_union := NULL;
  IF NOT COALESCE(v_t.is_private, false) THEN
    v_union := v_t.union_id;
    IF v_union IS NULL THEN
      SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = v_t.club_id;
    END IF;
  END IF;

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
    UPDATE public.clubs
       SET total_rake = COALESCE(total_rake, 0) + v_net, updated_at = now()
     WHERE id = v_t.club_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'rake club is missing' USING ERRCODE = '23503';
    END IF;
    -- The settlement receipt's native escrow trigger removes fee liability.
    -- Only the destination changes: no club wallet or treasury is credited.
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, tournament_id, idempotency_key, description)
    VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      'prize_liability', p_tournament_id, 'chip_retirement', NULL,
      v_net, 'rake', v_t.club_id, p_tournament_id,
      'tournament:' || p_tournament_id::text || ':standalone_rake_burn',
      'Standalone club tournament rake burned (fn_settle_tournament_rake)');
    v_dest := 'chip_retirement:' || v_t.club_id;
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
CREATE OR REPLACE FUNCTION public.credit_club_rake_to_treasury(p_club_id uuid, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- This two-argument legacy door has no hand/event receipt. It cannot
  -- implement a retry-safe burn and must never credit rake to a club again.
  RAISE EXCEPTION 'legacy rake treasury credit is retired; use atomic_distribute_rake or fn_settle_tournament_rake'
    USING ERRCODE = '55000';
END;
$function$;

REVOKE ALL ON FUNCTION public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_rake(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.credit_club_rake_to_treasury(uuid,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_club_rake_to_treasury(uuid,numeric) TO service_role;
-- Terminal consumers recognize a burned fee as a settled fee. Patch only
-- these exact predicates; preserve every installed lock, wrapper and money guard.
DO $terminal_rake_destinations$
DECLARE
  r record;
  v_def text;
  v_body text;
  v_old text;
  v_new text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_ca_tournament_terminal_receipt(uuid,uuid)', 'bb4b0e1d1c758943fca29f9a83d064e4', 'v_r'),
    ('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)', '90f7506df2f1a94fe22952714fcd9f85', 'v_prior_rake')
  ) AS targets(signature, body_md5, first_record)
  LOOP
    SELECT pg_get_functiondef(p.oid),p.prosrc INTO v_def,v_body
      FROM pg_proc p WHERE p.oid=to_regprocedure(r.signature);
    IF md5(v_body) IS DISTINCT FROM r.body_md5 THEN
      RAISE EXCEPTION 'terminal rake consumer preimage changed: %',r.signature;
    END IF;
    v_old := 'AND ' || r.first_record || '.destination NOT LIKE ''club_treasury:%''';
    v_new := v_old || E'\n                 AND ' || r.first_record || '.destination NOT LIKE ''chip_retirement:%''';
    IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old) <> 1 THEN
      RAISE EXCEPTION 'expected one terminal rake predicate: %',r.signature;
    END IF;
    v_def := replace(v_def,v_old,v_new);
    IF r.first_record = 'v_prior_rake' THEN
      v_old := 'AND v_rake.destination NOT LIKE ''club_treasury:%''';
      v_new := v_old || E'\n               AND v_rake.destination NOT LIKE ''chip_retirement:%''';
      IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old) <> 1 THEN
        RAISE EXCEPTION 'expected one completed rake predicate: %',r.signature;
      END IF;
      v_def := replace(v_def,v_old,v_new);
    END IF;
    EXECUTE v_def;
  END LOOP;
END;
$terminal_rake_destinations$;

COMMIT;
