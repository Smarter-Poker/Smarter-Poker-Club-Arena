-- The previous cash commission key merged contributors under one agent.
-- A real per-player source receipt now anchors each liability while preserving
-- the existing 6.28-million-row commission ledger and its unique index.
-- All tiers use recorded earning-time agreements and exact cents. One hand
-- commits all contributors or none. Old source rows are retained as explicitly
-- unverified; they cannot certify a weekly close or silently be paid again.
-- No historical payment correction, no wallet transfer, no rate change.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text)'::regprocedure))<>'2fb58bacd784fb6da12a9ac01443454c'
 OR md5(pg_get_functiondef('public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid)'::regprocedure))<>'55b5d60335a28bb1ceb3131485681c18'
 OR md5(pg_get_functiondef('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure))<>'1b9bc9a006f45908bf65eb70a12e5f00'
 OR md5(pg_get_functiondef('public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure))<>'bc285677f84bf79ac1ac38884411d4df'
 OR md5(pg_get_functiondef('public.fn_process_weekly_accounting(uuid)'::regprocedure))<>'13d00646ebf85d989ef1465c3933973c'
 THEN RAISE EXCEPTION 'cash commission source changed since review'; END IF;
END $guard$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_accrue_cash_hand_commissions','approved','Private whole-hand cash liability writer. Every contributor has a real immutable source receipt; all tiers share the transaction and existing commission journal. Historical unverified sources do not pay or certify.'),
 ('fn_accounting_cash_commission_source_guard','approved','Trigger validates cash commission amount, club, payee, timestamp and rate against its source receipt; rejects a parallel legacy cash writer. No balance writes.');
DO $reader_guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_accounting_terms_at(text,text,timestamptz)'::regprocedure))<>'7ce22d801a2020499695febf374adabb'
 OR md5(pg_get_functiondef('public.fn_accounting_agent_terms_at(uuid,uuid,timestamptz)'::regprocedure))<>'90aec8c54e892a4d6977a232c5d50342'
 THEN RAISE EXCEPTION 'historical agreement reader changed since review'; END IF;
END $reader_guard$;
CREATE OR REPLACE FUNCTION public.fn_accounting_terms_at(p_entity_type text, p_entity_key text, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE h public.accounting_agreement_history%ROWTYPE;
BEGIN
 -- Service-only EXECUTE ACL also permits private source-owner triggers.
 IF p_entity_type NOT IN('agents','club_members','union_clubs') OR p_entity_type IS NULL
    OR p_entity_key IS NULL OR p_entity_key='' OR p_at IS NULL OR NOT isfinite(p_at) OR p_at>transaction_timestamp()
 THEN RAISE EXCEPTION 'invalid_accounting_terms_request' USING ERRCODE='22023'; END IF;
 SELECT * INTO h FROM public.accounting_agreement_history
  WHERE entity_type=p_entity_type AND entity_key=p_entity_key AND observed_at<=p_at
  ORDER BY observed_at DESC,id DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_terms_not_observed' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('history_id',h.id,'observed_at',h.observed_at,'terms',h.after_terms);
END $function$

;
CREATE OR REPLACE FUNCTION public.fn_accounting_agent_terms_at(p_club_id uuid, p_user_id uuid, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE identities text[]; identity_key text; v jsonb; result jsonb; active_count int:=0;
BEGIN
 -- Service-only EXECUTE ACL also permits private source-owner triggers.
 IF p_club_id IS NULL OR p_user_id IS NULL OR p_at IS NULL OR NOT isfinite(p_at) OR p_at>transaction_timestamp()
 THEN RAISE EXCEPTION 'invalid_accounting_terms_request' USING ERRCODE='22023'; END IF;
 -- Find candidate identities from history, then resolve each identity at the
 -- earning time. A later move/deletion closes the old identity; filtering the
 -- history by club before selecting its latest event would resurrect that row.
 SELECT array_agg(DISTINCT entity_key) INTO identities FROM public.accounting_agreement_history
  WHERE entity_type='agents' AND club_id=p_club_id AND subject_user_id=p_user_id AND observed_at<=p_at;
 IF identities IS NULL THEN RAISE EXCEPTION 'accounting_terms_not_observed' USING ERRCODE='55000'; END IF;
 FOREACH identity_key IN ARRAY identities LOOP
  v:=public.fn_accounting_terms_at('agents',identity_key,p_at);
  IF v->'terms'->>'club_id'=p_club_id::text AND v->'terms'->>'user_id'=p_user_id::text
     AND v->'terms'->>'status'='active' THEN
   active_count:=active_count+1; result:=v;
  END IF;
 END LOOP;
 IF active_count=0 THEN RAISE EXCEPTION 'accounting_terms_not_active' USING ERRCODE='55000'; END IF;
 IF active_count>1 THEN RAISE EXCEPTION 'accounting_terms_ambiguous' USING ERRCODE='55000'; END IF;
 RETURN result;
END $function$

;
REVOKE ALL ON FUNCTION public.fn_accounting_terms_at(text,text,timestamptz),public.fn_accounting_agent_terms_at(uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_terms_at(text,text,timestamptz),public.fn_accounting_agent_terms_at(uuid,uuid,timestamptz) TO service_role;

CREATE FUNCTION public.fn_cash_earning_club(p_hand_id uuid,p_table_id uuid,p_player_id uuid,p_source_club uuid,p_union_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE started timestamptz;clubs uuid[];
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_hand_id IS NULL OR p_table_id IS NULL OR p_player_id IS NULL OR p_source_club IS NULL THEN
  RAISE EXCEPTION 'cash_earning_identity_missing' USING ERRCODE='23514'; END IF;
 -- A private/standalone game's rake is owned by its game club regardless of
 -- union membership. Shared union tables require the player's actual seat.
 IF p_union_id IS NULL THEN RETURN p_source_club; END IF;
 SELECT h.started_at INTO started FROM public.hand_history h WHERE h.id=p_hand_id AND h.table_id=p_table_id;
 IF started IS NULL OR started>transaction_timestamp() THEN RAISE EXCEPTION 'cash_hand_start_not_recorded' USING ERRCODE='23514'; END IF;
 SELECT array_agg(DISTINCT s.club_id) INTO clubs FROM public.table_seats s
  WHERE s.table_id=p_table_id AND s.user_id=p_player_id AND s.club_id IS NOT NULL
   AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started);
 IF cardinality(clubs) IS DISTINCT FROM 1
  OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
   AND (c.is_union IS NOT TRUE OR c.id=p_union_id OR c.union_id=p_union_id))
 THEN RAISE EXCEPTION 'cash_earning_seat_provenance_missing_or_ambiguous' USING ERRCODE='23514'; END IF;
 RETURN clubs[1];
END $function$;
REVOKE ALL ON FUNCTION public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.fn_lock_cash_bank_accounting_week(p_club_id uuid,p_game_union_id uuid,p_banked_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE coordinator uuid;memberships int;week_from timestamptz;week_to timestamptz;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_banked_at IS DISTINCT FROM transaction_timestamp() THEN
  RAISE EXCEPTION 'cash_bank_week_identity_invalid' USING ERRCODE='22023'; END IF;
 coordinator:=p_game_union_id;
 IF coordinator IS NULL THEN
  -- A private game's bank remains local. Its weekly coordinator is determined
  -- independently from the observed membership, matching the source contract.
  SELECT count(*),(array_agg((h.after_terms->>'union_id')::uuid))[1] INTO memberships,coordinator FROM (
   SELECT DISTINCT ON(entity_key) entity_key,after_terms FROM public.accounting_agreement_history
    WHERE entity_type='union_clubs' AND club_id=p_club_id AND observed_at<=p_banked_at
    ORDER BY entity_key,observed_at DESC,id DESC
  )h WHERE h.after_terms IS NOT NULL AND h.after_terms->>'club_id'=p_club_id::text;
  IF memberships>1 THEN RAISE EXCEPTION 'cash_bank_coordinator_ambiguous' USING ERRCODE='55000'; END IF;
 END IF;
 week_from:=public.fn_union_week_start(p_banked_at);week_to:=public.fn_union_week_start(week_from+interval '8 days');
 PERFORM pg_advisory_xact_lock(hashtextextended(
  CASE WHEN coordinator IS NOT NULL THEN 'union-accounting:' ELSE 'club-accounting:' END
  ||COALESCE(coordinator,p_club_id)::text||':'||extract(epoch FROM week_from)::text||':'||extract(epoch FROM week_to)::text,0));
 IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.period_start=week_from AND r.period_end=week_to
   AND ((coordinator IS NOT NULL AND r.union_id=coordinator) OR (coordinator IS NULL AND r.standalone_club_id=p_club_id)))
  OR EXISTS(SELECT 1 FROM public.union_rakeback_log l WHERE l.union_id=coordinator AND l.period_start<=p_banked_at AND l.period_end>p_banked_at)
 THEN RAISE EXCEPTION 'cash_bank_closed_week_requires_adjustment' USING ERRCODE='55000'; END IF;
END $function$;
REVOKE ALL ON FUNCTION public.fn_lock_cash_bank_accounting_week(uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(p_table_id uuid, p_club_id uuid, p_hand_id uuid, p_hand_number integer, p_rake numeric, p_bbj numeric DEFAULT 0, p_pot numeric DEFAULT NULL::numeric, p_num_players integer DEFAULT (NULL::numeric)::integer, p_contributions jsonb DEFAULT NULL::jsonb, p_tournament_id uuid DEFAULT NULL::uuid, p_returned_uncalled jsonb DEFAULT NULL::jsonb, p_rake_method text DEFAULT 'DEALT_EQUAL'::text)
 RETURNS TABLE(applied boolean, already_processed boolean, recovered boolean, rake_record_id uuid, club_net_credit numeric, spendable_route text, spendable_amount numeric, union_id_out uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_bank_receipt_id uuid; v_banked_at timestamptz;
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

  IF p_hand_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('accounting_cash_hand:'||p_hand_id::text,0));
  END IF;
  PERFORM public.fn_lock_cash_bank_accounting_week(p_club_id,v_union_id,transaction_timestamp());

  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source,
    metadata, rake_method, returned_uncalled
  ) VALUES (
    p_hand_id, p_table_id, p_club_id, p_rake, v_bbj, p_pot,
    p_num_players, p_contributions, (p_tournament_id IS NOT NULL), p_tournament_id,
    'atomic_distribute_rake',
    jsonb_build_object('hand_number', p_hand_number, 'is_private', v_is_private, 'union_id', v_union_id, 'accounting_source_version', 2),
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
           public.fn_cash_earning_club(p_hand_id,p_table_id,a.user_id,p_club_id,v_union_id),
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
      ) RETURNING id,created_at INTO v_bank_receipt_id,v_banked_at;
      INSERT INTO public.accounting_cash_bank_receipts(rake_record_id,union_id,club_id,union_transaction_id,banked_at,amount)
       VALUES(v_rr_id,v_union_id,p_club_id,v_bank_receipt_id,v_banked_at,p_rake);

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  ELSE
    v_route := 'chip_retirement';
    -- Retain the original leg key so an earlier treasury credit cannot be
    -- replayed as a second disposition. A historical treasury leg needs an
    -- explicit adjustment; it is not evidence that this source was burned.
    IF EXISTS(SELECT 1 FROM public.rake_distribution_legs
       WHERE leg_key=v_leg_key AND leg='chip_treasury')
     AND NOT EXISTS(SELECT 1 FROM public.accounting_cash_bank_receipts b
       JOIN public.chip_ledger l ON l.id=b.club_ledger_id
       WHERE b.rake_record_id=v_rr_id AND b.union_id IS NULL AND b.union_transaction_id IS NULL
        AND b.club_id=p_club_id AND b.amount=p_rake AND l.amount=b.amount AND l.created_at=b.banked_at
        AND l.from_type='table_stack' AND l.to_type='chip_retirement' AND l.to_entity_id IS NULL
        AND l.club_id=p_club_id AND l.category='burn') THEN
      RAISE EXCEPTION 'cash_rake_legacy_treasury_leg_requires_adjustment' USING ERRCODE='55000';
    END IF;
    INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
    VALUES (v_leg_key, 'chip_treasury', p_club_id, NULL, p_rake)
    ON CONFLICT (leg_key, leg) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      -- Standalone/private rake leaves circulation. Statistics remain, but
      -- neither the club treasury nor its wallet receives spendable chips.
      UPDATE public.clubs
         SET total_rake = COALESCE(total_rake, 0) + p_rake,
             updated_at = NOW()
       WHERE id = p_club_id;
      -- The existing deferred chip_ledger issuance trigger registers this
      -- retirement. Calling fn_ca_burn would debit a wallet a second time;
      -- the hand settlement already removed these chips from table stacks.
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, to_type, to_entity_id,
         amount, category, club_id, table_id, hand_id, tournament_id, description)
      VALUES (
        COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
        'table_stack', p_table_id, 'chip_retirement', NULL,
        p_rake, 'burn', p_club_id, p_table_id, p_hand_id, p_tournament_id,
        'Standalone cash rake retired, hand ' || COALESCE('#' || p_hand_number::text, 'unknown')
          || ' (atomic_distribute_rake)') RETURNING id,created_at INTO v_bank_receipt_id,v_banked_at;
      -- The existing immutable source/ledger join records disposition; this
      -- private leg is a burn receipt and must never be counted as funding.
      INSERT INTO public.accounting_cash_bank_receipts(rake_record_id,union_id,club_id,club_ledger_id,banked_at,amount)
       VALUES(v_rr_id,NULL,p_club_id,v_bank_receipt_id,v_banked_at,p_rake);
      -- Any journal or receipt failure aborts the same producer transaction.
      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,
                      CASE WHEN v_union_id IS NULL THEN 0::numeric ELSE v_net END, v_route,
                      CASE WHEN v_union_id IS NULL THEN 0::numeric ELSE p_rake END, v_union_id;
END;
$function$

;

REVOKE ALL ON public.accounting_agreement_history FROM service_role;
GRANT SELECT ON public.accounting_agreement_history TO service_role;
CREATE TABLE public.accounting_cash_accrual_cutover (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 starts_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.accounting_cash_accrual_cutover(singleton) VALUES(true);
CREATE TABLE public.accounting_cash_bank_receipts (
 rake_record_id uuid PRIMARY KEY REFERENCES public.rake_records(id),
 union_id uuid,
 club_id uuid NOT NULL REFERENCES public.clubs(id),
 union_transaction_id uuid UNIQUE REFERENCES public.union_wallet_transactions(id),
 club_ledger_id uuid UNIQUE REFERENCES public.chip_ledger(id),
 banked_at timestamptz NOT NULL,
 amount numeric NOT NULL CHECK(amount>0 AND amount=round(amount,2) AND amount::text NOT IN('NaN','Infinity','-Infinity')),
 CHECK((union_id IS NOT NULL AND union_transaction_id IS NOT NULL AND club_ledger_id IS NULL)
  OR(union_id IS NULL AND union_transaction_id IS NULL AND club_ledger_id IS NOT NULL))
);
CREATE INDEX accounting_cash_bank_receipts_union_period ON public.accounting_cash_bank_receipts(union_id,banked_at);
ALTER TABLE public.accounting_cash_bank_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_cash_bank_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_cash_bank_receipts TO service_role;
CREATE TRIGGER accounting_cash_bank_immutable BEFORE UPDATE OR DELETE ON public.accounting_cash_bank_receipts FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_bank_no_truncate BEFORE TRUNCATE ON public.accounting_cash_bank_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TABLE public.accounting_cash_accrual_batches (
 rake_record_id uuid PRIMARY KEY REFERENCES public.rake_records(id),
 hand_id uuid NOT NULL UNIQUE,
 earned_at timestamptz NOT NULL,
 source_fingerprint text NOT NULL,
 status text NOT NULL CHECK(status IN('accrued','legacy_unverified')),
 plan jsonb,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((status='accrued')=(plan IS NOT NULL))
);
CREATE INDEX accounting_cash_accrual_batches_earned ON public.accounting_cash_accrual_batches(earned_at,status);
CREATE TABLE public.accounting_cash_rake_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 rake_record_id uuid NOT NULL REFERENCES public.accounting_cash_accrual_batches(rake_record_id),
 player_id uuid NOT NULL REFERENCES auth.users(id),
 club_id uuid NOT NULL REFERENCES public.clubs(id),
 union_id uuid,
 coordinator_union_id uuid,
 earned_at timestamptz NOT NULL,
 rake_credit numeric NOT NULL CHECK(rake_credit>=0 AND rake_credit=round(rake_credit,2) AND rake_credit::text NOT IN('NaN','Infinity','-Infinity')),
 contract jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(rake_record_id,player_id)
);
CREATE INDEX accounting_cash_rake_sources_period ON public.accounting_cash_rake_sources(club_id,earned_at,player_id);
CREATE INDEX accounting_cash_rake_sources_bank_period ON public.accounting_cash_rake_sources(union_id,earned_at) WHERE union_id IS NOT NULL;
CREATE INDEX accounting_cash_rake_sources_coordinator_period ON public.accounting_cash_rake_sources(coordinator_union_id,earned_at,club_id);
ALTER TABLE public.accounting_cash_accrual_cutover ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_cash_accrual_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_cash_rake_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_cash_accrual_cutover,public.accounting_cash_accrual_batches,public.accounting_cash_rake_sources FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_cash_accrual_cutover,public.accounting_cash_accrual_batches,public.accounting_cash_rake_sources TO service_role;
CREATE TRIGGER accounting_cash_cutover_immutable BEFORE UPDATE OR DELETE ON public.accounting_cash_accrual_cutover FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_cutover_no_truncate BEFORE TRUNCATE ON public.accounting_cash_accrual_cutover FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_batch_immutable BEFORE UPDATE OR DELETE ON public.accounting_cash_accrual_batches FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_batch_no_truncate BEFORE TRUNCATE ON public.accounting_cash_accrual_batches FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_source_immutable BEFORE UPDATE OR DELETE ON public.accounting_cash_rake_sources FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_source_no_truncate BEFORE TRUNCATE ON public.accounting_cash_rake_sources FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

CREATE FUNCTION public.fn_post_accounting_commission_source(p_source_id uuid,p_source_type text,p_earned_at timestamptz,p_contract jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE tier jsonb;commission_id uuid;count_rows integer:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_source_id IS NULL OR p_source_type NOT IN('cash_rake_accrual','tournament_fee_accrual')
  OR p_source_type IS NULL OR p_earned_at IS NULL OR NOT isfinite(p_earned_at)
  OR jsonb_typeof(p_contract->'tiers') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'invalid_accounting_commission_source' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements s WHERE s.club_id=(p_contract->>'club_id')::uuid
  AND p_earned_at>=s.period_start AND p_earned_at<s.period_end)
 THEN RAISE EXCEPTION 'cash_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
  FOR tier IN SELECT value FROM jsonb_array_elements(p_contract->'tiers') LOOP
   IF (tier->>'amount')::numeric>0 THEN
    -- source_id identifies the real per-player source receipt above; it is
    -- never a fabricated hand identifier. Existing unique keys now distinguish
    -- two players with the same agent and one agent earning in two clubs.
    INSERT INTO public.agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,notes,created_at)
     VALUES((p_contract->>'club_id')::uuid,(tier->>'user_id')::uuid,(tier->>'amount')::numeric,(tier->>'rate')::numeric,
      p_source_type,p_source_id,'Commission from recorded earning agreement; tier '||(tier->>'depth'),p_earned_at)
     RETURNING id INTO commission_id;
    count_rows:=count_rows+1;
   END IF;
   UPDATE public.agents SET lifetime_rake_generated=COALESCE(lifetime_rake_generated,0)+(p_contract->>'rake_credit')::numeric,
    weekly_rake_generated=COALESCE(weekly_rake_generated,0)+CASE WHEN public.fn_union_week_start(p_earned_at)=public.fn_union_week_start(now())
      THEN (p_contract->>'rake_credit')::numeric ELSE 0 END,
    last_active_at=now(),updated_at=now()
    WHERE id=(tier->>'agent_id')::uuid AND club_id=(p_contract->>'club_id')::uuid AND user_id=(tier->>'user_id')::uuid;
   -- Display counters exist only while the agent profile exists. The earned
   -- liability belongs to its recorded user and club even after retirement.
  END LOOP;
 RETURN count_rows;
END $function$;
REVOKE ALL ON FUNCTION public.fn_post_accounting_commission_source(uuid,text,timestamptz,jsonb) FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_post_accounting_commission_source','approved','Private shared source commission writer for cash and recognized tournament fees; immutable source receipt validates the exact club, payee, rate and amount. No balance writes. The source owner controls replay.');

CREATE FUNCTION public.fn_accrue_cash_hand_commissions(p_hand_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE source public.rake_records%ROWTYPE; batch public.accounting_cash_accrual_batches%ROWTYPE;
 fingerprint text; plan jsonb; player jsonb; source_id uuid; count_rows int:=0; cutoff timestamptz;scope record;week_start timestamptz;week_end timestamptz;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_hand_id IS NULL THEN RAISE EXCEPTION 'cash_hand_id_required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_cash_hand:'||p_hand_id::text,0));
 SELECT * INTO source FROM public.rake_records WHERE hand_id=p_hand_id FOR SHARE;
 IF NOT FOUND OR COALESCE(source.is_tournament,false) OR source.tournament_id IS NOT NULL OR source.rake_amount<=0
 THEN RAISE EXCEPTION 'cash_rake_source_required' USING ERRCODE='23514'; END IF;
 SELECT md5(jsonb_build_object('record',source.id,'hand',source.hand_id,'rake',source.rake_amount,'earned_at',source.created_at,
   'shares',COALESCE(jsonb_agg(jsonb_build_array(a.id,a.player_id,a.club_id,a.weighted_rake_credit) ORDER BY a.player_id),'[]'::jsonb))::text)
 INTO fingerprint FROM public.rake_attributions a WHERE a.rake_record_id=source.id;
 SELECT * INTO batch FROM public.accounting_cash_accrual_batches WHERE rake_record_id=source.id;
 IF FOUND THEN
  IF batch.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'cash_accrual_source_changed_after_recording' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('recorded',true,'duplicate',true,'status',batch.status,'source_version',2);
 END IF;
 SELECT starts_at INTO cutoff FROM public.accounting_cash_accrual_cutover WHERE singleton;
 IF cutoff IS NULL THEN RAISE EXCEPTION 'cash_accrual_cutover_missing' USING ERRCODE='23514'; END IF;
 -- Legacy rows remain untouched. Recording this gap is not a commission
 -- credit or a successful weekly close. The coordinator must reject it.
 IF source.created_at<cutoff THEN
  INSERT INTO public.accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status)
   VALUES(source.id,source.hand_id,source.created_at,fingerprint,'legacy_unverified');
  RETURN jsonb_build_object('recorded',true,'status','legacy_unverified','requires_reconciliation',true,'source_version',2);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commissions ac WHERE ac.source_id=source.hand_id AND ac.source_type IN('rake','rake_settlement'))
 THEN RAISE EXCEPTION 'cash_accrual_legacy_writer_after_cutover' USING ERRCODE='23514'; END IF;
 plan:=public.fn_accounting_cash_commission_plan(source.id);
 week_start:=public.fn_union_week_start(source.created_at);week_end:=public.fn_union_week_start(week_start+interval '8 days');
 FOR scope IN SELECT DISTINCT CASE WHEN p->>'coordinator_union_id' IS NOT NULL THEN 'union-accounting:' ELSE 'club-accounting:' END
   ||COALESCE(p->>'coordinator_union_id',p->>'club_id')||':'||extract(epoch FROM week_start)::text||':'||extract(epoch FROM week_end)::text AS lock_key
   FROM jsonb_array_elements(plan->'players')p ORDER BY lock_key LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(scope.lock_key,0));
 END LOOP;
 -- An empty or zero-own-commission completed week still closes the source set.
 IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r CROSS JOIN LATERAL jsonb_array_elements(plan->'players')p
  WHERE r.period_start<=source.created_at AND r.period_end>source.created_at
   AND((r.union_id IS NOT NULL AND r.union_id::text=p->>'coordinator_union_id')
    OR(r.standalone_club_id IS NOT NULL AND p->>'coordinator_union_id' IS NULL AND r.standalone_club_id::text=p->>'club_id')))
 THEN RAISE EXCEPTION 'cash_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
 INSERT INTO public.accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan)
  VALUES(source.id,source.hand_id,source.created_at,fingerprint,'accrued',plan);
 FOR player IN SELECT value FROM jsonb_array_elements(plan->'players') LOOP
  IF EXISTS(SELECT 1 FROM public.agent_commission_settlements s WHERE s.club_id=(player->>'club_id')::uuid
   AND source.created_at>=s.period_start AND source.created_at<s.period_end)
  THEN RAISE EXCEPTION 'cash_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
  INSERT INTO public.accounting_cash_rake_sources(rake_record_id,player_id,club_id,union_id,coordinator_union_id,earned_at,rake_credit,contract)
   VALUES(source.id,(player->>'player_id')::uuid,(player->>'club_id')::uuid,(player->>'union_id')::uuid,(player->>'coordinator_union_id')::uuid,source.created_at,(player->>'rake_credit')::numeric,player)
   RETURNING id INTO source_id;
  count_rows:=count_rows+public.fn_post_accounting_commission_source(source_id,'cash_rake_accrual',source.created_at,player);
 END LOOP;
 RETURN jsonb_build_object('recorded',true,'status','accrued','source_version',2,'rows_written',count_rows);
END $function$;
REVOKE ALL ON FUNCTION public.fn_accrue_cash_hand_commissions(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accrue_cash_hand_commissions(uuid) TO service_role;

CREATE FUNCTION public.fn_accounting_earning_contract(p_club_id uuid,p_player_id uuid,p_rake numeric,p_game_union_id uuid,p_terms_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE member jsonb;agent jsonb;terms jsonb;chain jsonb;remaining numeric;rate numeric;amount numeric;
 seen uuid[];agent_id uuid;parent_id uuid;agent_user uuid;direct_user uuid;union_count int;coordinator_union uuid;union_agreement jsonb;union_house boolean;
BEGIN
 -- Private EXECUTE grants admit only trusted source owners, including the
 -- registration trigger running for a human. Public wrappers verify actors.
 IF p_club_id IS NULL OR p_player_id IS NULL OR p_terms_at IS NULL OR NOT isfinite(p_terms_at) OR p_terms_at>clock_timestamp()
  OR p_rake IS NULL OR p_rake<0 OR p_rake<>round(p_rake,2) OR p_rake::text IN('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'invalid_accounting_earning_contract' USING ERRCODE='22023'; END IF;
  SELECT count(*),(array_agg((uc.after_terms->>'union_id')::uuid))[1],
   (jsonb_agg(jsonb_build_object('history_id',uc.id,'observed_at',uc.observed_at,'terms',uc.after_terms)))->0
   INTO union_count,coordinator_union,union_agreement FROM (
    SELECT DISTINCT ON(h.entity_key) h.id,h.observed_at,h.after_terms FROM public.accounting_agreement_history h
     WHERE h.entity_type='union_clubs' AND h.club_id=p_club_id AND h.observed_at<=p_terms_at
     ORDER BY h.entity_key,h.observed_at DESC,h.id DESC) uc
    WHERE uc.after_terms IS NOT NULL AND uc.after_terms->>'club_id'=p_club_id::text;
  SELECT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.is_union IS TRUE
   AND p_game_union_id IS NOT NULL AND (c.id=p_game_union_id OR c.union_id=p_game_union_id)) INTO union_house;
  IF union_house THEN coordinator_union:=p_game_union_id;union_agreement:=NULL; END IF;
  IF union_count>1 OR (p_game_union_id IS NOT NULL AND NOT union_house AND (union_count<>1 OR coordinator_union IS DISTINCT FROM p_game_union_id))
  THEN RAISE EXCEPTION 'cash_commission_earning_club_not_observed' USING ERRCODE='23514'; END IF;
  member:=public.fn_accounting_terms_at('club_members',p_club_id::text||':'||p_player_id::text,p_terms_at);
  terms:=member->'terms';
  IF terms IS NULL OR terms='null'::jsonb OR terms->>'club_id' IS DISTINCT FROM p_club_id::text OR terms->>'user_id' IS DISTINCT FROM p_player_id::text
   OR (terms->>'status' IS NULL OR terms->>'status' NOT IN('active','approved')) OR COALESCE((terms->>'is_active')::boolean,true)=false
  THEN RAISE EXCEPTION 'cash_commission_membership_not_active_at_earning' USING ERRCODE='23514'; END IF;
  direct_user:=NULLIF(terms->>'agent_id','')::uuid; agent:=NULL;
  IF direct_user IS NOT NULL THEN
   agent:=public.fn_accounting_agent_terms_at(p_club_id,direct_user,p_terms_at);
  ELSE
   BEGIN agent:=public.fn_accounting_agent_terms_at(p_club_id,p_player_id,p_terms_at);
   EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM IN('accounting_terms_not_observed','accounting_terms_not_active') THEN agent:=NULL; ELSE RAISE; END IF; END;
  END IF;
  remaining:=p_rake;chain:='[]';seen:=ARRAY[]::uuid[];
  WHILE agent IS NOT NULL AND agent->'terms' IS NOT NULL AND agent->'terms'<>'null'::jsonb LOOP
   terms:=agent->'terms'; agent_id:=(terms->>'id')::uuid;agent_user:=(terms->>'user_id')::uuid;
   IF agent_id IS NULL OR agent_user IS NULL OR agent_id=ANY(seen) OR cardinality(seen)>=64
    OR terms->>'club_id' IS DISTINCT FROM p_club_id::text OR terms->>'status' IS DISTINCT FROM 'active'
    OR terms->>'role' IS NULL OR terms->>'role' NOT IN('super_agent','agent','sub_agent')
   THEN RAISE EXCEPTION 'cash_commission_hierarchy_invalid_at_earning' USING ERRCODE='23514'; END IF;
   seen:=array_append(seen,agent_id);
   rate:=(terms->>'commission_rate')::numeric;
   IF rate>1 THEN rate:=rate/100; END IF;
   IF rate IS NULL OR rate<0 OR rate>1 OR rate::text IN('NaN','Infinity','-Infinity')
   THEN RAISE EXCEPTION 'cash_commission_rate_invalid_at_earning' USING ERRCODE='23514'; END IF;
   -- Preserve the installed agreement model: each upline rate applies to the
   -- remaining rake after the preceding tier. Round each payable to cents.
   amount:=round(remaining*rate,2);
   chain:=chain||jsonb_build_array(jsonb_build_object('agent_id',agent_id,'user_id',agent_user,
    'role',terms->>'role','depth',cardinality(seen),'rake_basis',p_rake,'remaining_basis',remaining,
    'rate',rate,'amount',amount,'agreement',agent));
   remaining:=remaining-amount;
   parent_id:=NULLIF(terms->>'parent_agent_id','')::uuid;
   IF parent_id IS NULL THEN agent:=NULL; ELSE agent:=public.fn_accounting_terms_at('agents',parent_id::text,p_terms_at); END IF;
  END LOOP;
 RETURN jsonb_build_object('player_id',p_player_id,'club_id',p_club_id,'union_id',p_game_union_id,
  'coordinator_union_id',coordinator_union,'rake_credit',p_rake,'membership',member,'tiers',chain,
  'club_residual',remaining,'union_agreement',union_agreement,'is_union_house',union_house,'terms_at',p_terms_at);
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_accounting_cash_commission_plan(p_rake_record_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE source public.rake_records%ROWTYPE;a record;players jsonb:='[]';allocated numeric;n int;game_union uuid;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO source FROM public.rake_records WHERE id=p_rake_record_id;
 IF NOT FOUND OR source.hand_id IS NULL OR COALESCE(source.is_tournament,false) OR source.tournament_id IS NOT NULL
  OR source.rake_amount<=0 OR source.rake_amount::text IN('NaN','Infinity','-Infinity') OR source.rake_amount<>round(source.rake_amount,2)
 THEN RAISE EXCEPTION 'cash_commission_source_invalid' USING ERRCODE='23514'; END IF;
 IF source.metadata->>'accounting_source_version' IS DISTINCT FROM '2' OR NOT (source.metadata ? 'union_id') THEN
  RAISE EXCEPTION 'cash_game_union_stamp_missing' USING ERRCODE='23514'; END IF;
 game_union:=NULLIF(source.metadata->>'union_id','')::uuid;
 IF COALESCE((source.metadata->>'is_private')::boolean,false) AND game_union IS NOT NULL THEN
  RAISE EXCEPTION 'private_cash_rake_cannot_belong_to_union' USING ERRCODE='23514'; END IF;
 -- A receipt creates liabilities only after the matching rake disposition:
 -- a Union wallet credit, or a standalone/private retirement. Retirement is
 -- source evidence, never funding for the existing treasury-funded payout.
 IF NOT EXISTS(SELECT 1 FROM public.accounting_cash_bank_receipts b
   LEFT JOIN public.union_wallet_transactions t ON t.id=b.union_transaction_id
   LEFT JOIN public.chip_ledger l ON l.id=b.club_ledger_id
   WHERE b.rake_record_id=source.id AND b.club_id=source.club_id AND b.amount=source.rake_amount
    AND b.banked_at=source.created_at AND b.union_id IS NOT DISTINCT FROM game_union
    AND ((game_union IS NOT NULL AND t.union_id=game_union AND t.amount=b.amount AND t.created_at=b.banked_at
      AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake' AND b.club_ledger_id IS NULL)
     OR (game_union IS NULL AND b.union_transaction_id IS NULL AND l.amount=b.amount AND l.created_at=b.banked_at
      AND l.from_type='table_stack' AND l.to_type='chip_retirement' AND l.to_entity_id IS NULL
      AND l.club_id=source.club_id AND l.category='burn')))
 THEN RAISE EXCEPTION 'cash_commission_bank_receipt_not_proven' USING ERRCODE='23514'; END IF;
 SELECT count(*),sum(weighted_rake_credit) INTO n,allocated FROM public.rake_attributions WHERE rake_record_id=source.id AND hand_id=source.hand_id;
 IF n=0 OR allocated IS DISTINCT FROM source.rake_amount OR EXISTS(SELECT 1 FROM public.rake_attributions
  WHERE hand_id=source.hand_id AND (rake_record_id IS DISTINCT FROM source.id OR club_id IS NULL OR player_id IS NULL
   OR weighted_rake_credit IS NULL OR weighted_rake_credit<0 OR weighted_rake_credit<>round(weighted_rake_credit,2)
   OR weighted_rake_credit::text IN('NaN','Infinity','-Infinity')))
 THEN RAISE EXCEPTION 'cash_commission_attribution_incomplete' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_attributions WHERE rake_record_id=source.id GROUP BY player_id HAVING count(*)<>1)
 THEN RAISE EXCEPTION 'cash_commission_attribution_ambiguous' USING ERRCODE='23514'; END IF;
 FOR a IN SELECT * FROM public.rake_attributions WHERE rake_record_id=source.id ORDER BY club_id,player_id LOOP
  IF game_union IS NULL AND a.club_id<>source.club_id THEN
   RAISE EXCEPTION 'cash_commission_earning_club_not_observed' USING ERRCODE='23514'; END IF;
  players:=players||jsonb_build_array(public.fn_accounting_earning_contract(a.club_id,a.player_id,a.weighted_rake_credit,game_union,source.created_at)
   ||jsonb_build_object('attribution_id',a.id));
 END LOOP;
 RETURN jsonb_build_object('source_version',2,'rake_record_id',source.id,'hand_id',source.hand_id,
  'earned_at',source.created_at,'rake',source.rake_amount,'players',players);
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_cash_commission_plan(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_cash_commission_plan(uuid) TO service_role;

CREATE FUNCTION public.fn_accounting_cash_source_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE old_source_id uuid;new_source_id uuid;hand uuid;
BEGIN
 IF TG_TABLE_NAME='rake_records' THEN
  old_source_id:=OLD.id;new_source_id:=NEW.id;
 ELSE
  IF TG_OP<>'INSERT' THEN old_source_id:=OLD.rake_record_id; END IF;
  IF TG_OP<>'DELETE' THEN new_source_id:=NEW.rake_record_id; END IF;
 END IF;
 -- The commission writer and every source mutation share the same hand key.
 -- A source edit which began before accrual must finish before it is frozen.
 FOR hand IN SELECT DISTINCT r.hand_id FROM public.rake_records r WHERE r.id IN(old_source_id,new_source_id) AND r.hand_id IS NOT NULL ORDER BY r.hand_id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('accounting_cash_hand:'||hand::text,0));
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches WHERE rake_record_id IN(old_source_id,new_source_id)) THEN
  RAISE EXCEPTION 'recorded_cash_earning_source_is_immutable' USING ERRCODE='55000';
 END IF;
 RETURN COALESCE(NEW,OLD);
END $function$;
CREATE TRIGGER accounting_cash_source_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.rake_attributions FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_cash_source_immutable();
CREATE TRIGGER accounting_cash_source_immutable BEFORE UPDATE OR DELETE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_cash_source_immutable();
REVOKE ALL ON FUNCTION public.fn_accounting_cash_source_immutable() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.fn_accounting_cash_commission_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE source public.accounting_cash_rake_sources%ROWTYPE; matches int;
BEGIN
 IF NEW.source_type='cash_rake_accrual' THEN
  SELECT * INTO source FROM public.accounting_cash_rake_sources WHERE id=NEW.source_id;
  IF NOT FOUND OR NEW.club_id IS DISTINCT FROM source.club_id OR NEW.created_at IS DISTINCT FROM source.earned_at THEN
   RAISE EXCEPTION 'cash_commission_source_receipt_required' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO matches FROM jsonb_array_elements(source.contract->'tiers') t
   WHERE t->>'user_id'=NEW.user_id::text AND (t->>'amount')::numeric=NEW.amount
    AND (t->>'rate')::numeric=NEW.commission_rate AND NEW.amount>0;
  IF matches<>1 THEN RAISE EXCEPTION 'cash_commission_disagrees_with_recorded_entitlement' USING ERRCODE='23514'; END IF;
 ELSIF NEW.source_type IN('rake','rake_settlement') AND EXISTS(
  SELECT 1 FROM public.rake_records r CROSS JOIN public.accounting_cash_accrual_cutover c
   WHERE c.singleton AND r.hand_id=NEW.source_id AND r.created_at>=c.starts_at
     AND NOT COALESCE(r.is_tournament,false) AND r.tournament_id IS NULL) THEN
  RAISE EXCEPTION 'cash_commission_requires_canonical_source_writer' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER accounting_cash_commission_source_guard BEFORE INSERT ON public.agent_commissions
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_cash_commission_source_guard();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
 ('agent_commissions','accounting_cash_commission_source_guard','Validate cash liability against its immutable per-player source receipt and forbid a second legacy cash writer after cutover. No balance or ledger write.');
REVOKE ALL ON FUNCTION public.fn_accounting_cash_commission_source_guard() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.fn_assert_cash_commission_period(p_union_id uuid,p_club_id uuid,p_from timestamptz,p_to timestamptz) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR p_union_id IS NULL OR NOT public.fn_is_union_overseer(p_union_id,auth.uid())) THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from
 THEN RAISE EXCEPTION 'invalid_cash_commission_scope' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=r.id
  WHERE r.created_at>=p_from AND r.created_at<p_to AND r.rake_amount>0 AND NOT COALESCE(r.is_tournament,false) AND r.tournament_id IS NULL
   AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata)
   AND ((p_club_id IS NOT NULL AND (r.club_id=p_club_id OR EXISTS(SELECT 1 FROM public.rake_attributions a WHERE a.rake_record_id=r.id AND a.club_id=p_club_id)))
     OR (p_union_id IS NOT NULL AND (r.club_id=p_union_id OR EXISTS(SELECT 1 FROM public.union_clubs c WHERE c.union_id=p_union_id AND c.club_id=r.club_id)
      OR EXISTS(SELECT 1 FROM public.rake_attributions a JOIN public.union_clubs c ON c.club_id=a.club_id WHERE a.rake_record_id=r.id AND c.union_id=p_union_id))))
   AND (b.status IS DISTINCT FROM 'accrued'))
 THEN RAISE EXCEPTION 'cash_commission_earning_evidence_requires_reconciliation' USING ERRCODE='55000'; END IF;
END $function$;
REVOKE ALL ON FUNCTION public.fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake(p_agent_user_id uuid, p_club_id uuid, p_rake_credit numeric, p_source_type text DEFAULT 'rake_settlement'::text, p_source_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id          UUID;
  v_agent_user_id     UUID;
  v_commission_rate   NUMERIC;
  v_parent_agent_id   UUID;
  v_parent_user_id    UUID;
  v_parent_rate       NUMERIC;
  v_direct_commission NUMERIC;
  v_parent_commission NUMERIC;
  v_remaining         NUMERIC;
  v_book_club         UUID;
  v_inserted_direct   INTEGER := 0;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
  IF p_source_type='rake_settlement' THEN
    IF p_source_id IS NULL THEN RAISE EXCEPTION 'cash_hand_id_required' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.rake_records r JOIN public.rake_attributions a ON a.rake_record_id=r.id AND a.hand_id=r.hand_id
      WHERE r.hand_id=p_source_id AND a.player_id=p_agent_user_id AND a.weighted_rake_credit=p_rake_credit
       AND (a.club_id=p_club_id OR r.club_id=p_club_id)) THEN
      RAISE EXCEPTION 'cash_commission_call_disagrees_with_source' USING ERRCODE='23514'; END IF;
    PERFORM public.fn_accrue_cash_hand_commissions(p_source_id);
    RETURN;
  END IF;
  IF p_source_type IS DISTINCT FROM 'tournament_rake_settlement' OR p_source_id IS NULL THEN
    RAISE EXCEPTION 'unsupported_commission_source' USING ERRCODE='23514'; END IF;
  -- Tournament settlement remains its existing source caller. Historical
  -- tournament allocation is not certified by this cash-only change.
  -- UNION LAW: the agent follows the PLAYER's club, not the table's club.
  v_book_club := public.fn_resolve_player_club_for_agent(p_agent_user_id, p_club_id, NULL);

  SELECT a.id, a.user_id, a.commission_rate, a.parent_agent_id
    INTO v_agent_id, v_agent_user_id, v_commission_rate, v_parent_agent_id
    FROM club_members cm
    JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id AND a.status = 'active'
   WHERE cm.user_id = p_agent_user_id AND cm.club_id = v_book_club
   LIMIT 1;

  -- The caller may itself be an agent generating rake.
  IF v_agent_id IS NULL THEN
    SELECT id, user_id, commission_rate, parent_agent_id
      INTO v_agent_id, v_agent_user_id, v_commission_rate, v_parent_agent_id
      FROM agents WHERE user_id = p_agent_user_id AND status = 'active'
     ORDER BY (club_id = v_book_club) DESC
     LIMIT 1;
  END IF;

  IF v_agent_id IS NULL THEN RETURN; END IF;

  -- Idempotency is per AGENT and source, never per source alone: a hand has
  -- one row per agent in the chain of every contributing player, and only a
  -- retry for the same agent returns here (Chip Standard P4, lane 2.2).
  IF p_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM agent_commissions
     WHERE source_id = p_source_id AND source_type = p_source_type
       AND user_id = v_agent_user_id
     LIMIT 1
  ) THEN
    RETURN;
  END IF;

  v_direct_commission := ROUND(p_rake_credit * COALESCE(v_commission_rate, 0), 2);
  v_remaining         := p_rake_credit - v_direct_commission;

  IF v_direct_commission > 0 THEN
    INSERT INTO agent_commissions (
      club_id, user_id, amount, commission_rate, source_type, source_id, notes
    ) VALUES (
      COALESCE(v_book_club, p_club_id), v_agent_user_id, v_direct_commission, v_commission_rate,
      p_source_type, p_source_id, COALESCE(p_notes, 'agent slice (accrual)')
    )
    ON CONFLICT (user_id, source_id, source_type) WHERE source_id IS NOT NULL
    DO NOTHING;
    GET DIAGNOSTICS v_inserted_direct = ROW_COUNT;

    IF v_inserted_direct > 0 THEN
      UPDATE agents SET
        weekly_rake_generated   = COALESCE(weekly_rake_generated, 0)   + p_rake_credit,
        lifetime_rake_generated = COALESCE(lifetime_rake_generated, 0) + p_rake_credit,
        last_active_at          = NOW(),
        updated_at              = NOW()
      WHERE id = v_agent_id;
    END IF;
  END IF;

  -- Super-agent override on the downstream volume (PokerBros model).
  IF v_parent_agent_id IS NOT NULL AND v_remaining > 0 THEN
    SELECT id, user_id, commission_rate
      INTO v_parent_agent_id, v_parent_user_id, v_parent_rate
      FROM agents WHERE id = v_parent_agent_id AND status = 'active'
     LIMIT 1;

    IF v_parent_agent_id IS NOT NULL AND v_parent_rate IS NOT NULL THEN
      v_parent_commission := ROUND(v_remaining * v_parent_rate, 2);
      IF v_parent_commission > 0 THEN
        INSERT INTO agent_commissions (
          club_id, user_id, amount, commission_rate, source_type, source_id, notes
        ) VALUES (
          COALESCE(v_book_club, p_club_id), v_parent_user_id, v_parent_commission, v_parent_rate,
          p_source_type, p_source_id, 'super-agent slice (accrual)'
        )
        ON CONFLICT (user_id, source_id, source_type) WHERE source_id IS NOT NULL
        DO NOTHING;
      END IF;
    END IF;
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.calculate_cascading_commission(p_hand_id uuid DEFAULT NULL,p_club_id uuid DEFAULT NULL,p_player_user_id uuid DEFAULT NULL,p_rake_amount numeric DEFAULT 0,p_rake_record_id uuid DEFAULT NULL,p_table_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $function$
DECLARE source_hand uuid;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_rake_record_id IS NOT NULL THEN
  SELECT hand_id INTO source_hand FROM public.rake_records WHERE id=p_rake_record_id;
  IF source_hand IS NULL OR (p_hand_id IS NOT NULL AND p_hand_id<>source_hand) THEN RAISE EXCEPTION 'cash_commission_source_mismatch' USING ERRCODE='23514'; END IF;
 ELSE source_hand:=p_hand_id; END IF;
 -- This compatibility door never writes a second commission calculation.
 RETURN public.fn_accrue_cash_hand_commissions(source_hand);
END $function$;
REVOKE ALL ON FUNCTION public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid),public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid),public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text) TO service_role;

-- One scope resolver admits the club that owned the earning even after a move.
CREATE FUNCTION public.fn_accounting_week_clubs(p_union_id uuid,p_club_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(club_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to)
  OR p_to<=p_from THEN RAISE EXCEPTION 'invalid_accounting_scope' USING ERRCODE='22023'; END IF;
 IF p_club_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.is_union IS NOT TRUE) THEN
   RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT p_club_id;
 ELSE
  RETURN QUERY SELECT x.id FROM (
   SELECT uc.club_id id FROM public.union_clubs uc WHERE uc.union_id=p_union_id
   UNION SELECT s.club_id FROM public.accounting_cash_rake_sources s
    WHERE s.coordinator_union_id=p_union_id AND s.earned_at>=p_from AND s.earned_at<p_to
   UNION SELECT c.club_id FROM public.accounting_rakeback_period_calculations c
    WHERE c.coordinator_union_id=p_union_id AND c.period_start=(p_from AT TIME ZONE 'America/Los_Angeles')::date
     AND c.period_end=(p_to AT TIME ZONE 'America/Los_Angeles')::date-1
  )x WHERE x.id<>p_union_id ORDER BY x.id;
 END IF;
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- Draft calculations and their durable retry requests precede financial writes.
-- A partial or wrong-scope receipt is never accepted as a finished weekly book.
CREATE FUNCTION public.fn_prepare_accounting_week(p_union_id uuid,p_club_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE clubs uuid[];club uuid;result jsonb;problems jsonb:='[]';from_date date;to_date date;ready boolean;verified boolean;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to)
  OR p_from IS DISTINCT FROM public.fn_union_week_start(p_from)
  OR p_to IS DISTINCT FROM public.fn_union_week_start(p_from+interval '8 days') OR p_to>now()
 THEN RAISE EXCEPTION 'accounting_preparation_requires_closed_week' USING ERRCODE='22023'; END IF;
 from_date:=(p_from AT TIME ZONE 'America/Los_Angeles')::date;to_date:=(p_to AT TIME ZONE 'America/Los_Angeles')::date-1;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) THEN RAISE EXCEPTION 'invalid_accounting_scope' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
  CASE WHEN p_union_id IS NOT NULL THEN 'union-accounting:' ELSE 'club-accounting:' END
   ||COALESCE(p_union_id,p_club_id)::text||':'||extract(epoch FROM p_from)::text||':'||extract(epoch FROM p_to)::text,0));
 SELECT COALESCE(array_agg(c.club_id ORDER BY c.club_id),ARRAY[]::uuid[]) INTO clubs
  FROM public.fn_accounting_week_clubs(p_union_id,p_club_id,p_from,p_to)c;
 -- Same order as the routing stages, before Round 1 takes any treasury row.
 PERFORM public.fn_lock_rakeback_payer_clubs(clubs);
 FOREACH club IN ARRAY clubs LOOP
  result:=public.fn_rakeback_recompute_periods(club,from_date,to_date,NULL);
  ready:=result->>'accounting_version'='2' AND result->>'club_id'=club::text
   AND result->>'period_start'=from_date::text AND result->>'period_end'=to_date::text
   AND result->>'status'='ready' AND result->>'request_state'='complete' AND result->>'request_recorded'='true';
  SELECT EXISTS(SELECT 1 FROM public.accounting_period_recompute_requests q
   WHERE q.id::text=result->>'request_id' AND q.club_id=club AND q.period_start=from_date AND q.period_end=to_date
    AND to_jsonb(q.requested_at)=result->'requested_at' AND q.status='complete'
    AND q.last_result->>'accounting_version'='2' AND q.last_result->>'status'='ready'
    AND q.last_result->>'club_id'=club::text AND q.last_result->>'period_start'=from_date::text
    AND q.last_result->>'period_end'=to_date::text) INTO verified;
  IF ready IS DISTINCT FROM true OR NOT verified THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('club_id',club,'period_start',from_date,'period_end',to_date,
    'reason',COALESCE(result->>'reason','weekly_calculation_receipt_not_confirmed')));
  END IF;
 END LOOP;
 RETURN jsonb_build_object('success',jsonb_array_length(problems)=0,'accounting_version',3,
  'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',cardinality(clubs),'problems',problems);
END $function$;
REVOKE ALL ON FUNCTION public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_prepare_accounting_week','approved','Private single-coordinator preparation calls the one certified period writer for each current or recorded earning club. No wallet writes; requires durable complete request receipts before any settlement stage.');

CREATE OR REPLACE FUNCTION public.fn_process_weekly_accounting(p_union_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_preparation jsonb; v_club record; v_pass int; v_batch jsonb; v_credit jsonb; v_started timestamptz; 
  v_now timestamptz := clock_timestamp();
  v_to timestamptz := public.fn_union_week_start(v_now);
  v_from timestamptz;
  v_first timestamptz;
  v_end timestamptz;
  v_due timestamptz;
  v_union record;
  v_previous jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_orphans integer;
  v_orphan_amount numeric;
  v_complete boolean;
  v_failed integer := 0;
  v_checked integer := 0;
  v_msg text; v_detail text; v_state text;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  -- Transaction locks release on errors and also work in reused connections.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
    RETURN jsonb_build_object('success',true,'skipped',true,'reason','already_running');
  END IF;
  IF public.fn_platform_frozen() OR extract(minute FROM v_now) >= 45 THEN
    RETURN jsonb_build_object('success',true,'skipped',true,'reason','maintenance_window');
  END IF;

  FOR v_union IN SELECT u.id, f.earliest_period_start
    FROM public.unions u LEFT JOIN public.union_settlement_floor f ON f.union_id=u.id WHERE p_union_id IS NULL OR u.id=p_union_id ORDER BY u.id
  LOOP
    -- Catch up chronologically from the explicit clean-data floor. A union
    -- without one starts at the just-closed week, never an invented history.
    v_first := COALESCE(public.fn_union_week_start(v_union.earliest_period_start),
                        public.fn_union_prev_week_start(v_now));
    IF v_first < v_union.earliest_period_start THEN
      v_first := public.fn_union_week_start(v_first + interval '8 days');
    END IF;
    v_from := v_first;
    WHILE v_from < v_to LOOP
      v_end := public.fn_union_week_start(v_from + interval '8 days');
      v_due := public.fn_union_accounting_run_at(v_end);
      IF v_now < v_due THEN EXIT; END IF;

      SELECT result INTO v_previous FROM public.union_accounting_runs
       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
      SELECT count(*), COALESCE(sum(rakeback_amount),0) INTO v_orphans,v_orphan_amount
        FROM public.rakeback_periods rp
       WHERE rp.club_id=v_union.id AND rp.status='pending' AND rp.rakeback_amount>0
         AND (rp.period_start::timestamp AT TIME ZONE 'UTC') < v_end
         AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') > v_from;

      SELECT NOT EXISTS (
        SELECT 1 FROM generate_series(1,4) n
        WHERE NOT EXISTS (SELECT 1 FROM public.union_settlement_rounds r
          WHERE r.union_id=v_union.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=n
            AND CASE
              WHEN n=1 THEN r.detail->>'success'='true'
              WHEN n IN(2,3) THEN
                COALESCE(r.detail->'latest_attempt',r.detail)->>'amount' IS NOT NULL
                AND COALESCE(r.detail->'latest_attempt',r.detail)->>'payees' IS NOT NULL
                AND COALESCE(r.detail->'latest_attempt',r.detail)->'shortfalls'='0'::jsonb
                AND COALESCE(COALESCE(r.detail->'latest_attempt',r.detail)->>'success','true')='true'
              ELSE r.detail->>'success'='true' AND COALESCE(r.detail->>'skipped','false')='false'
            END)) INTO v_complete;

      v_complete := v_complete AND NOT EXISTS (
        SELECT 1 FROM public.rakeback_periods rp
        JOIN public.union_clubs uc ON uc.club_id=rp.club_id AND uc.union_id=v_union.id
        WHERE rp.status='pending' AND rp.rakeback_amount>0
          AND rp.period_start >= (v_from AT TIME ZONE 'UTC')::date
          AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') <= v_end)
        AND NOT EXISTS (SELECT 1 FROM public.union_clubs uc
          WHERE uc.union_id=v_union.id AND uc.club_id<>v_union.id
            AND NOT EXISTS (SELECT 1 FROM public.settlement_invoices si
              WHERE si.club_id=uc.club_id AND si.invoice_type='union_weekly_squareup'
                AND si.breakdown->>'union_id'=v_union.id::text
                AND (si.breakdown->>'period_start')::timestamptz=v_from
                AND (si.breakdown->>'period_end')::timestamptz=v_end
                AND si.message_sent=true AND si.status<>'cancelled'));

      v_complete:=v_complete AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc
        WHERE uc.union_id=v_union.id AND uc.club_id<>v_union.id AND NOT EXISTS(
          SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
          WHERE i.club_id=uc.club_id AND i.invoice_type='club_weekly_accounting' AND i.message_sent
            AND sp.start_at=v_from AND sp.end_at=v_end));
      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='3' THEN
        v_from:=v_end; CONTINUE;
      END IF;
      -- Bounded recovery: never let a large history monopolize live wallets.
      IF v_checked>=8 OR clock_timestamp()-v_now>interval '15 minutes'
        OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
          'more_remaining',true,'detail',v_results);
      END IF;
      INSERT INTO public.union_accounting_runs
        (union_id,period_start,period_end,scheduled_at,status,attempts,started_at)
      VALUES (v_union.id,v_from,v_end,v_due,'running',1,clock_timestamp())
      ON CONFLICT(union_id,period_start,period_end) DO UPDATE
        SET status='running',attempts=union_accounting_runs.attempts+1,started_at=clock_timestamp();

      -- Keep a refused preparation request durable outside the wallet rollback.
      BEGIN
        v_preparation:=public.fn_prepare_accounting_week(v_union.id,NULL,v_from,v_end);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
        v_preparation:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
      END;

      -- Only this block may move chips. Any refused downstream stage raises
      -- and rolls back the whole union attempt, while the failure record below
      -- survives. Other unions have independent ledgers and transaction scopes.
      BEGIN
        IF v_preparation->>'success' IS DISTINCT FROM 'true' THEN
          RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;
        END IF;
        IF EXISTS(SELECT 1 FROM public.rake_records rr LEFT JOIN public.daemon_state ds ON ds.daemon='rakeback_settler'
          WHERE NOT COALESCE(rr.is_tournament,false) AND rr.tournament_id IS NULL AND rr.rake_amount>0
            AND rr.created_at>=v_from AND rr.created_at<v_end
            AND (rr.club_id=v_union.id OR EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.union_id=v_union.id AND uc.club_id=rr.club_id))
            AND (ds.high_water_mark IS NULL OR rr.created_at>ds.high_water_mark OR
              (rr.created_at=ds.high_water_mark AND (ds.high_water_mark_id IS NULL OR rr.id>ds.high_water_mark_id)))) THEN
          RAISE EXCEPTION 'weekly_rake_source_not_fully_accrued';
        END IF;
        PERFORM public.fn_assert_cash_commission_period(v_union.id,NULL,v_from,v_end);
        IF v_orphans>0 THEN
          RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_rakeback_wrong_club',
            DETAIL=jsonb_build_object('pending_periods',v_orphans,'pending_amount',v_orphan_amount)::text;
        END IF;
        IF v_complete AND v_previous->>'accounting_version'='3' THEN
          v_result:=jsonb_build_object('success',true,'already_posted',true);
        ELSE
          v_result:=public.fn_union_settlement_cascade(v_union.id,v_from,v_end);
          IF v_result->>'success' IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_settlement_incomplete',DETAIL=v_result::text;
          END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
        v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
      END;

      IF v_result->>'success'='true' THEN v_result:=v_result||jsonb_build_object('accounting_version',3); END IF;
      v_checked:=v_checked+1;
      UPDATE public.union_accounting_runs
         SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' ELSE 'failed' END,
             finished_at=clock_timestamp(),result=v_result
       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
      IF v_result->>'success' IS DISTINCT FROM 'true' THEN
        v_failed:=v_failed+1;
        -- Report a new failure or a changed failure, not the same alert every tick.
        IF v_previous IS DISTINCT FROM v_result THEN
          INSERT INTO public.financial_alerts(source,severity,message,context)
          VALUES ('union_accounting_scheduler','critical','Weekly union accounting is incomplete',
            jsonb_build_object('union_id',v_union.id,'period_start',v_from,'period_end',v_end,
                               'scheduled_at',v_due,'result',v_result));
        END IF;
      END IF;
      v_results:=v_results||jsonb_build_array(jsonb_build_object('union_id',v_union.id,
        'period_start',v_from,'period_end',v_end,'result',v_result));
      -- Resolve an older period before posting a later one for the same union.
      IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT; END IF;
      v_from:=v_end;
    END LOOP;
  END LOOP;

  -- Standalone clubs use the same schedule and caller. Existing payout rules
  -- remain scoped to that club; no standalone batch can bypass union stages.
  IF p_union_id IS NULL AND v_now>=public.fn_union_accounting_run_at(v_to) THEN
    v_from:=public.fn_union_prev_week_start(v_now);
    FOR v_club IN SELECT c.id FROM public.clubs c
      WHERE NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=c.id)
        AND NOT EXISTS(SELECT 1 FROM public.unions u WHERE u.id=c.id)
        AND (EXISTS(SELECT 1 FROM public.rakeback_periods rp WHERE rp.club_id=c.id AND rp.status='pending' AND rp.period_end<(v_to AT TIME ZONE 'America/Los_Angeles')::date)
          OR EXISTS(SELECT 1 FROM public.agents a WHERE a.club_id=c.id AND NOT COALESCE(a.is_prepaid,false) AND a.credit_used>0))
      ORDER BY c.id
    LOOP
      IF extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,'more_remaining',true,'detail',v_results);
      END IF;
      BEGIN
        PERFORM public.fn_assert_cash_commission_period(NULL,v_club.id,v_from,v_to);
        v_started:=clock_timestamp();v_pass:=0;
        LOOP
          v_batch:=public.fn_settle_club_rakeback_batch(v_club.id,40,4.0,2);
          IF v_batch->>'success' IS DISTINCT FROM 'true' OR COALESCE((v_batch->>'errors')::int,0)>0 THEN
            RAISE EXCEPTION 'standalone_weekly_payout_failed' USING DETAIL=(v_batch-'elapsed_seconds'-'clock_ran_out')::text; END IF;
          EXIT WHEN COALESCE((v_batch->>'periods_remaining')::int,0)=0;
          v_pass:=v_pass+1;
          IF COALESCE((v_batch->>'periods_settled')::int,0)=0 OR v_pass>=250 OR clock_timestamp()-v_started>interval '30 seconds' THEN
            RAISE EXCEPTION 'standalone_weekly_payout_incomplete' USING DETAIL=(v_batch-'elapsed_seconds'-'clock_ran_out')::text; END IF;
        END LOOP;
        v_credit:=public.fn_generate_scope_credit_invoices(v_club.id,v_from,v_to);
        INSERT INTO public.daemon_state(daemon,high_water_mark,updated_at)
         VALUES('weekly_accounting:'||v_club.id::text,v_to,clock_timestamp())
         ON CONFLICT(daemon) DO UPDATE SET high_water_mark=excluded.high_water_mark,updated_at=excluded.updated_at;
        v_result:=jsonb_build_object('success',true,'credit_invoices',v_credit,'accounting_version',3);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
        v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
        v_failed:=v_failed+1;
        INSERT INTO public.financial_alerts(source,severity,message,context)
          SELECT 'weekly_club_accounting','critical','Weekly club accounting is incomplete',
            jsonb_build_object('club_id',v_club.id,'period_start',v_from,'period_end',v_to,'result',v_result)
          WHERE NOT EXISTS(SELECT 1 FROM public.financial_alerts a WHERE a.source='weekly_club_accounting'
            AND a.context->>'club_id'=v_club.id::text AND a.context->>'period_end'=to_jsonb(v_to)#>>'{}'
            AND a.context->'result'=v_result);
      END;
      v_checked:=v_checked+1;
      v_results:=v_results||jsonb_build_array(jsonb_build_object('club_id',v_club.id,'period_start',v_from,'period_end',v_to,'result',v_result));
    END LOOP;
  END IF;
  RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
    'observed_at',clock_timestamp(),'detail',v_results);
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid, p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_preparation jsonb; v_credit_club record;
  v_from timestamptz := COALESCE(p_period_start, public.fn_union_prev_week_start(now()));
  v_to   timestamptz := COALESCE(p_period_end,   public.fn_union_week_start(now()));
  v_r1 jsonb; v_r2 jsonb; v_r3 jsonb; v_eco jsonb; v_inv jsonb;
  v_floor timestamptz;
  v_club_statements jsonb; v_previous_validated text;
  v_sqlstate text; v_msg text; v_detail text; v_context text;

BEGIN
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_union_overseer(p_union_id, auth.uid()))) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  -- THE FLOOR, checked before anything moves. Round 1 has always honoured it;
  -- nothing above round 1 did, so three further rounds ran on a floored week.
  SELECT f.earliest_period_start INTO v_floor
    FROM union_settlement_floor f WHERE f.union_id = p_union_id;

  IF v_floor IS NOT NULL AND v_from < v_floor THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'before_settlement_floor',
      'period_start', v_from, 'period_end', v_to,
      'settlement_floor', v_floor,
      'note', 'This period is below the union settlement floor and must not be '
              || 'settled. No round was run.'))::text;
  END IF;

  /* WARM THE CACHE BEFORE THE FIRST LOCK (2026-09-09). union_rake_rollup_days
     is a speed cache: a day that is missing is recomputed live and correct,
     but it is recomputed INSIDE the settlement, while it holds treasury rows -
     which is where this union has been deadlocking. Doing it here costs the
     same work at a moment when nothing is locked. A failure is not fatal:
     the live path still answers, just more slowly. */
  BEGIN
    PERFORM public.fn_union_rake_rollup_refresh_day(p_union_id, g.d::date)
       FROM generate_series(v_from::date, (v_to - interval '1 day')::date, interval '1 day') g(d)
      WHERE NOT EXISTS (SELECT 1 FROM public.union_rake_rollup_days rd
                         WHERE rd.union_id = p_union_id AND rd.day = g.d::date)
        AND g.d::date < (now() AT TIME ZONE 'UTC')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'settlement could not warm the rake rollup (%); the live path will answer instead', SQLERRM;
  END;

  -- Serialize every entry point for this union/period. A replay must read
  -- the receipts after the competing transaction commits, before moving chips.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'union-accounting:' || p_union_id::text || ':' || extract(epoch FROM v_from)::text || ':' || extract(epoch FROM v_to)::text, 0));

  -- A union-owned table is not a player's earning club. These outstanding
  -- records are invisible to the member-club join in Round 3. Never certify
  -- completion while they exist, and never guess a replacement beneficiary.
  IF EXISTS (SELECT 1 FROM public.rakeback_periods rp
       WHERE rp.club_id = p_union_id AND rp.status = 'pending'
         AND rp.rakeback_amount > 0
         AND (rp.period_start::timestamp AT TIME ZONE 'UTC') < v_to
         AND ((rp.period_end + 1)::timestamp AT TIME ZONE 'UTC') > v_from) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'union_rakeback_wrong_club',
      DETAIL = 'Pending player rakeback is booked under the union ID. Reconcile the earning-club evidence before settlement.';
  END IF;

  -- ROUND 1 - union rake treasury pays the clubs their 90%.
  PERFORM public.fn_assert_cash_commission_period(p_union_id,NULL,v_from,v_to);
  v_preparation:=public.fn_prepare_accounting_week(p_union_id,NULL,v_from,v_to);
  IF v_preparation->>'success' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;
  END IF;
  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payers, payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 1, 'union_to_clubs', 1,
          COALESCE((v_r1->>'clubs_paid')::int,0),
          COALESCE((v_r1->>'total_rakeback')::numeric,0), v_r1)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  IF COALESCE((v_r1->>'success')::boolean, false) IS NOT TRUE
     AND COALESCE(v_r1->>'error','') <> 'already_executed' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round1_failed: ' || COALESCE(v_r1->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1,
      'note', 'Rounds 2, 3 and 4 were not run. A club is not asked to pay its '
              || 'agents out of a treasury the union has not funded.'))::text;
  END IF;

  -- ROUND 2 - clubs pay their super agents and agents.
  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
  IF v_r2->>'routing_version' IS DISTINCT FROM '3'
    OR v_r2->>'source_version' IS DISTINCT FROM '2'
    OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
      WHERE r.union_id=p_union_id AND r.period_start=v_from AND r.period_end=v_to AND r.round_no=2
       AND r.result=(v_r2-'duplicate')) THEN
    RAISE EXCEPTION 'weekly_routing_receipt_not_confirmed' USING ERRCODE='23514';
  END IF;
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 2, 'club_to_agents',
          COALESCE((v_r2->>'payees')::int,0), COALESCE((v_r2->>'amount')::numeric,0),
          COALESCE((v_r2->>'shortfalls')::int,0), v_r2)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=union_settlement_rounds.detail || jsonb_build_object('latest_attempt',EXCLUDED.detail);

  -- Round 2 carries no 'success' key: it raises on error and returns
  -- {round,name,payees,amount,shortfalls,detail} otherwise, so a test for
  -- 'success' would be unreachable. Assert the CONTRACT instead - a round that
  -- stops reporting an amount must stop the cascade, not record 0 and carry on.
  IF (v_r2->>'amount') IS NULL OR (v_r2->>'payees') IS NULL
     OR (v_r2->>'shortfalls') IS NULL
     OR jsonb_typeof(v_r2->'shortfalls') IS DISTINCT FROM 'number'
     OR (v_r2 ? 'success' AND COALESCE((v_r2->>'success')::boolean, true) IS FALSE
         AND COALESCE(v_r2->>'error','') <> 'already_executed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round2_contract_violated_or_failed: ' || COALESCE(v_r2->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'note', 'Rounds 3 and 4 were not run.'))::text;
  END IF;

  -- ROUND 3 - agents pay their players.
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
  IF v_r3->>'routing_version' IS DISTINCT FROM '3'
    OR v_r3->>'source_version' IS DISTINCT FROM '2'
    OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
      WHERE r.union_id=p_union_id AND r.period_start=v_from AND r.period_end=v_to AND r.round_no=3
       AND r.result=(v_r3-'duplicate')) THEN
    RAISE EXCEPTION 'weekly_routing_receipt_not_confirmed' USING ERRCODE='23514';
  END IF;
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 3, 'agents_to_players',
          COALESCE((v_r3->>'payees')::int,0), COALESCE((v_r3->>'amount')::numeric,0),
          COALESCE((v_r3->>'shortfalls')::int,0), v_r3)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=union_settlement_rounds.detail || jsonb_build_object('latest_attempt',EXCLUDED.detail);

  -- Same contract assertion for round 3.
  IF (v_r3->>'amount') IS NULL OR (v_r3->>'payees') IS NULL
     OR (v_r3->>'shortfalls') IS NULL
     OR jsonb_typeof(v_r3->'shortfalls') IS DISTINCT FROM 'number'
     OR (v_r3 ? 'success' AND COALESCE((v_r3->>'success')::boolean, true) IS FALSE
         AND COALESCE(v_r3->>'error','') <> 'already_executed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round3_contract_violated_or_failed: ' || COALESCE(v_r3->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3,
      'note', 'Round 4 was not run; no statement is issued for a settlement '
              || 'that did not complete.'))::text;
  END IF;

  -- A round can post funded recipients while reporting others still unpaid.
  -- Keep that durable progress, but do not mark the period settled or issue
  -- completion statements until every reported shortfall is zero.
  IF (v_r2->>'shortfalls')::numeric <> 0
     OR (v_r3->>'shortfalls')::numeric <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success',false,'union_id',p_union_id,
      'error','recipient_shortfalls_remaining','period_start',v_from,'period_end',v_to,
      'round1_union_to_clubs',v_r1,'round2_club_to_agents',v_r2,
      'round3_agents_to_players',v_r3))::text;
  END IF;

  IF EXISTS (SELECT 1 FROM public.rakeback_periods rp
      JOIN public.union_clubs uc ON uc.club_id=rp.club_id AND uc.union_id=p_union_id
      WHERE rp.status='pending' AND rp.rakeback_amount>0
        AND rp.period_start >= (v_from AT TIME ZONE 'UTC')::date
        AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') <= v_to) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_player_obligations_remaining';
  END IF;

  -- CONSERVATION, asserted before anything else is written. Raises on a
  -- breach, which rolls this union's whole settlement back.
  PERFORM public.fn_union_settlement_conservation_assert(
            p_union_id, v_from, v_to, v_r1, v_r2, v_r3);

  -- The period is an accounting object, not a by-product of invoicing.
  PERFORM public.fn_union_mark_period_settled(p_union_id, v_from, v_to);

  IF public.fn_union_eco_enabled(p_union_id) THEN
    BEGIN
      v_eco := public.fn_union_eco_record(p_union_id, v_from, v_to, NULL);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_detail = PG_EXCEPTION_DETAIL, v_context = PG_EXCEPTION_CONTEXT;
      v_eco := jsonb_build_object('success', false, 'error', v_msg, 'sqlstate', v_sqlstate,
                                  'exception_detail', v_detail, 'exception_context', v_context);
    END;
  ELSE
    v_eco := jsonb_build_object('skipped', true, 'reason', 'eco_disabled');
  END IF;

  IF v_eco->>'success' = 'false' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'union_eco_record_failed', DETAIL = v_eco::text;
  END IF;

  IF public.fn_union_setting(p_union_id, 'weekly_invoices_enabled', 1) <> 1 THEN
    v_inv := jsonb_build_object(
      'success', true, 'skipped', true, 'invoices', 0,
      'reason', 'weekly_invoices_disabled: the union setting weekly_invoices_enabled is 0. '
                || 'Since Phase 6 (20260907) the statement reads the same fn_union_club_rake_basis '
                || 'rows round 1 pays on; switching statements back on is a setting, not a fix.');
  ELSE
    BEGIN
      v_inv := public.fn_union_issue_weekly_invoices(p_union_id, v_from, v_to, true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_detail = PG_EXCEPTION_DETAIL, v_context = PG_EXCEPTION_CONTEXT;
      v_inv := jsonb_build_object('success', false, 'error', v_msg, 'sqlstate', v_sqlstate,
                                  'exception_detail', v_detail, 'exception_context', v_context);
    END;
  END IF;

  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 4, 'union_invoices_issued',
          COALESCE((v_inv->>'invoices')::int, 0), 0, v_inv)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=EXCLUDED.detail,payees=EXCLUDED.payees;

  IF COALESCE((v_inv->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round4_invoices_failed: ' || COALESCE(v_inv->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
      'round4_invoices', v_inv))::text;
  END IF;

  IF COALESCE((v_inv->>'skipped')::boolean, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'union_invoices_not_issued', DETAIL = v_inv::text;
  END IF;

  IF EXISTS (SELECT 1 FROM public.union_clubs uc
    WHERE uc.union_id=p_union_id AND uc.club_id<>p_union_id
      AND NOT EXISTS (SELECT 1 FROM public.settlement_invoices si
        WHERE si.club_id=uc.club_id AND si.invoice_type='union_weekly_squareup'
          AND si.breakdown->>'union_id'=p_union_id::text
          AND (si.breakdown->>'period_start')::timestamptz=v_from
          AND (si.breakdown->>'period_end')::timestamptz=v_to
          AND si.message_sent=true AND si.status<>'cancelled')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_invoice_delivery_incomplete';
  END IF;

  FOR v_credit_club IN SELECT club_id FROM public.fn_accounting_week_clubs(p_union_id,NULL,v_from,v_to) ORDER BY club_id LOOP
    PERFORM public.fn_generate_scope_credit_invoices(v_credit_club.club_id,v_from,v_to);
  END LOOP;
  v_previous_validated:=current_setting('app.union_accounting_validated_period',true);
  PERFORM set_config('app.union_accounting_validated_period',p_union_id::text||':'||v_from::text||':'||v_to::text,true);
  v_club_statements:=public.fn_issue_club_weekly_accounting(p_union_id,v_from,v_to);
  PERFORM set_config('app.union_accounting_validated_period',COALESCE(v_previous_validated,''),true);
  RETURN jsonb_build_object('success', true, 'union_id', p_union_id, 'club_weekly_statements',v_club_statements,
    'period_start', v_from, 'period_end', v_to,
    'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
    'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
    'round4_invoices', v_inv);
END $function$
;
COMMIT;
