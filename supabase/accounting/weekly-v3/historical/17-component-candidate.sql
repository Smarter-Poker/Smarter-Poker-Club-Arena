-- UNAPPLIED CANDIDATE. Generated from independently tested components.
-- Complete schema replay, commercial terms, compatible engine reader deployment,
-- and exact live preimage verification are still required before activation.
-- All components share ONE transaction; no partial coordinator cutover.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='300s';
SELECT pg_advisory_xact_lock(hashtextextended('accounting-authority-install',0));
-- Component 20260914131539_cash_commissions_account_for_every_contributor_once.sql
-- The previous cash commission key merged contributors under one agent.
-- A real per-player source receipt now anchors each liability while preserving
-- the existing 6.28-million-row commission ledger and its unique index.
-- All tiers use recorded earning-time agreements and exact cents. One hand
-- commits all contributors or none. Old source rows are retained as explicitly
-- unverified; they cannot certify a weekly close or silently be paid again.
-- No historical payment correction, no wallet transfer, no rate change.

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
            || ' (atomic_distribute_rake)') RETURNING id,created_at INTO v_bank_receipt_id,v_banked_at;
        INSERT INTO public.accounting_cash_bank_receipts(rake_record_id,union_id,club_id,club_ledger_id,banked_at,amount)
         VALUES(v_rr_id,NULL,p_club_id,v_bank_receipt_id,v_banked_at,p_rake);
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
 -- A receipt creates liabilities only after the matching rake was actually
 -- banked. This is also required for private games and standalone clubs.
 IF NOT EXISTS(SELECT 1 FROM public.accounting_cash_bank_receipts b
   LEFT JOIN public.union_wallet_transactions t ON t.id=b.union_transaction_id
   LEFT JOIN public.chip_ledger l ON l.id=b.club_ledger_id
   WHERE b.rake_record_id=source.id AND b.club_id=source.club_id AND b.amount=source.rake_amount
    AND b.banked_at=source.created_at AND b.union_id IS NOT DISTINCT FROM game_union
    AND ((game_union IS NOT NULL AND t.union_id=game_union AND t.amount=b.amount AND t.created_at=b.banked_at
      AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake' AND b.club_ledger_id IS NULL)
     OR (game_union IS NULL AND b.union_transaction_id IS NULL AND l.amount=b.amount AND l.created_at=b.banked_at
      AND l.to_type='club_treasury' AND l.to_entity_id=source.club_id AND l.club_id=source.club_id AND l.category='rake')))
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

-- Component 20260914132216_cash_rakeback_periods_require_one_certified_week.sql
-- One period writer reads immutable earned-club source receipts and the exact
-- Pacific book. Unknown history and existing liabilities are never rewritten.

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure))<>'2078fb6e89f22704096974ecf933e385'
 THEN RAISE EXCEPTION 'rakeback period source changed since review'; END IF;
END $guard$;
CREATE TABLE public.accounting_rakeback_period_calculations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 period_id uuid NOT NULL REFERENCES public.rakeback_periods(id),
 accounting_version integer NOT NULL DEFAULT 2 CHECK(accounting_version=2),
 source_fingerprint text NOT NULL,
 club_id uuid NOT NULL REFERENCES public.clubs(id),
 player_id uuid NOT NULL,
 coordinator_union_id uuid,
 period_start date NOT NULL,
 period_end date NOT NULL,
 rake_generated numeric NOT NULL CHECK(rake_generated::text NOT IN('NaN','Infinity','-Infinity') AND rake_generated>=0 AND rake_generated=round(rake_generated,2)),
 rakeback_amount numeric NOT NULL CHECK(rakeback_amount::text NOT IN('NaN','Infinity','-Infinity') AND rakeback_amount>=0 AND rakeback_amount=round(rakeback_amount,2)),
 display_rate numeric NOT NULL CHECK(display_rate>=0 AND display_rate<=1 AND display_rate=round(display_rate,4)),
 payer_kind text NOT NULL CHECK(payer_kind IN('club','agent')),
 payer_user_id uuid,
 source_allocations jsonb NOT NULL CHECK(jsonb_typeof(source_allocations)='array'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((payer_kind='agent')=(payer_user_id IS NOT NULL)),
 CHECK(rakeback_amount<=rake_generated),
 UNIQUE(period_id,source_fingerprint)
);
CREATE INDEX accounting_rakeback_period_calculations_latest ON public.accounting_rakeback_period_calculations(period_id,id DESC);
ALTER TABLE public.accounting_rakeback_period_calculations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_rakeback_period_calculations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_rakeback_period_calculations TO service_role;
CREATE TRIGGER accounting_rakeback_calculation_immutable BEFORE UPDATE OR DELETE ON public.accounting_rakeback_period_calculations
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_rakeback_calculation_no_truncate BEFORE TRUNCATE ON public.accounting_rakeback_period_calculations
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_calculate_cash_rakeback_periods','approved','Private period calculation called only through the durable request wrapper; source receipts and observed history produce append-only period certificates. No wallet movement and no direct role execution grant.');
CREATE TABLE public.accounting_period_recompute_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 club_id uuid NOT NULL REFERENCES public.clubs(id),
 period_start date NOT NULL,
 period_end date NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','blocked','complete')),
 reason text,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempted_at timestamptz,
 attempts bigint NOT NULL DEFAULT 0,
 last_result jsonb NOT NULL DEFAULT '{}',
 UNIQUE(club_id,period_start,period_end),
 CHECK(extract(isodow FROM period_start)=1 AND period_end=period_start+6)
);
ALTER TABLE public.accounting_period_recompute_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_period_recompute_requests FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_period_recompute_requests TO service_role;
CREATE INDEX accounting_period_recompute_requests_pending ON public.accounting_period_recompute_requests(period_start,club_id) WHERE status<>'complete';

CREATE FUNCTION public.fn_calculate_cash_rakeback_periods(p_club_id uuid,p_period_start date,p_period_end date,p_user_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='300s' AS $function$
DECLARE
 v_from timestamptz; v_to timestamptz; cutover timestamptz; receipt jsonb;
 scope_union uuid; issue_count bigint; existing public.rakeback_periods%ROWTYPE;
 certificate public.accounting_rakeback_period_calculations%ROWTYPE;
 player record; total_unrounded numeric; amount numeric; display_rate numeric;
 payer_kind text; payer_user uuid; coordinator_union uuid; allocations jsonb; plan jsonb;
 fingerprint text; period_id uuid; written integer:=0; confirmed integer:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6
    OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids)>2000 OR array_position(p_user_ids,NULL) IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid_accounting_period_request' USING ERRCODE='22023'; END IF;
 receipt:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'written',0,'status','blocked');
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 SELECT starts_at INTO cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
 IF cutover IS NULL OR v_from<cutover THEN RETURN receipt||jsonb_build_object('reason','historical_week_before_observed_source_cutover'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||p_club_id::text||':'||p_period_start::text,0));
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
 -- Tournament entitlement has no immutable per-player earning-club receipt
 -- yet. It cannot be silently discarded from a weekly book containing cash.
 SELECT count(*) INTO issue_count FROM public.rake_records r
  WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
    AND (r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL)
    AND (r.club_id=p_club_id OR r.club_id=scope_union OR EXISTS(SELECT 1 FROM public.clubs h
      WHERE h.id=r.club_id AND h.is_union IS TRUE AND h.union_id=scope_union));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','tournament_earning_evidence_unavailable','source_count',issue_count); END IF;
 WITH scoped_records AS (
  SELECT r.* FROM public.rake_records r
   WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
     AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
     AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata)
     AND (r.club_id=p_club_id
       OR EXISTS(SELECT 1 FROM public.rake_attributions a WHERE a.rake_record_id=r.id AND a.club_id=p_club_id)
       OR EXISTS(SELECT 1 FROM public.clubs house WHERE house.id=r.club_id AND house.is_union IS TRUE
          AND scope_union IS NOT NULL AND (house.union_id=scope_union OR house.id=scope_union)))
 ), checks AS (
  SELECT r.id,r.hand_id,r.rake_amount,count(a.id) AS attribution_count,
    COALESCE(sum(a.weighted_rake_credit),0) AS attributed,
    count(a.id) FILTER(WHERE a.hand_id IS DISTINCT FROM r.hand_id OR a.club_id IS NULL
      OR a.player_id IS NULL OR a.weighted_rake_credit IS NULL OR a.weighted_rake_credit<0
      OR a.weighted_rake_credit<>round(a.weighted_rake_credit,2)
      OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND c.is_union IS NOT TRUE)) AS invalid_count
   FROM scoped_records r LEFT JOIN public.rake_attributions a ON a.rake_record_id=r.id
   GROUP BY r.id,r.hand_id,r.rake_amount
 )
 SELECT count(*) INTO issue_count FROM checks WHERE hand_id IS NULL OR attribution_count=0
  OR invalid_count>0 OR attributed<>rake_amount OR rake_amount<>round(rake_amount,2);
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','cash_earning_evidence_incomplete','source_count',issue_count); END IF;
 -- An old UTC or current-membership period remains an explicit conflict even
 -- when its numbers happen to match. Certificates establish the new writer.
 SELECT count(*) INTO issue_count FROM public.rakeback_periods rp
  WHERE rp.club_id=p_club_id AND rp.period_start<=p_period_end AND rp.period_end>=p_period_start
    AND (rp.status<>'pending' OR rp.period_start<>p_period_start OR rp.period_end<>p_period_end
      OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=rp.id));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','legacy_or_paid_period_requires_reconciliation','period_count',issue_count); END IF;
 SELECT count(*) INTO issue_count FROM public.rake_attributions a JOIN public.rake_records r ON r.id=a.rake_record_id
  LEFT JOIN public.accounting_cash_rake_sources s ON s.rake_record_id=r.id AND s.player_id=a.player_id
  LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=r.id
  WHERE a.club_id=p_club_id AND r.created_at>=v_from AND r.created_at<v_to
    AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL AND r.rake_amount>0
    AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata)
    AND (s.id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR s.club_id IS DISTINCT FROM a.club_id
      OR s.earned_at IS DISTINCT FROM r.created_at OR s.rake_credit IS DISTINCT FROM a.weighted_rake_credit
      OR s.contract->>'attribution_id' IS DISTINCT FROM a.id::text
      OR s.contract->>'player_id' IS DISTINCT FROM a.player_id::text OR s.contract->>'club_id' IS DISTINCT FROM a.club_id::text);
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_incomplete','source_count',issue_count); END IF;
 -- Bidirectional comparison also rejects an extra recorded source that no
 -- longer has an attribution. A matching subset is not a complete source set.
 SELECT count(*) INTO issue_count FROM public.accounting_cash_rake_sources s
  LEFT JOIN public.rake_records r ON r.id=s.rake_record_id
  LEFT JOIN public.rake_attributions a ON a.id=(s.contract->>'attribution_id')::uuid
  LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=s.rake_record_id
  WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
   AND (r.id IS NULL OR a.id IS NULL OR b.status IS DISTINCT FROM 'accrued'
    OR a.rake_record_id IS DISTINCT FROM s.rake_record_id OR a.hand_id IS DISTINCT FROM r.hand_id
    OR a.player_id IS DISTINCT FROM s.player_id OR a.club_id IS DISTINCT FROM s.club_id
    OR a.weighted_rake_credit IS DISTINCT FROM s.rake_credit OR s.earned_at IS DISTINCT FROM r.created_at
    OR r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL
    OR NULLIF(s.contract->'union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.union_id)
    OR NULLIF(s.contract->'coordinator_union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.coordinator_union_id));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',issue_count); END IF;


 FOR player IN
  WITH receipts AS (
   SELECT s.*,s.contract->'membership'->'terms' AS member,s.contract->'tiers'->0 AS direct,
    sum(s.rake_credit) OVER(PARTITION BY s.player_id) AS total_rake
   FROM public.accounting_cash_rake_sources s
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
     AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))
  ), parsed AS (
   SELECT r.*,NULLIF(r.member->>'agent_id','')::uuid AS member_agent,
    COALESCE((r.member->>'player_rakeback_pct')::numeric,0) AS deal,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL
      THEN COALESCE((r.direct->'agreement'->'terms'->>'player_rakeback_rate')::numeric,0) ELSE 0 END AS offer,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL THEN (r.direct->>'rate')::numeric END AS cap_rate,
    mh.id AS member_history_id,ah.id AS agent_history_id,
    mh.after_terms AS recorded_member,ah.after_terms AS recorded_agent
   FROM receipts r
   LEFT JOIN public.accounting_agreement_history mh ON mh.id=(r.contract->'membership'->>'history_id')::bigint
    AND mh.entity_type='club_members' AND mh.entity_key=p_club_id::text||':'||r.player_id::text AND mh.observed_at<=r.earned_at
   LEFT JOIN public.accounting_agreement_history ah ON ah.id=(r.direct->'agreement'->>'history_id')::bigint
    AND ah.entity_type='agents' AND ah.observed_at<=r.earned_at
  ), rates AS (
   SELECT p.*,CASE WHEN p.deal>0 THEN p.deal WHEN p.offer>0 THEN p.offer
    WHEN p.total_rake>=10000 THEN 0.30 WHEN p.total_rake>=2000 THEN 0.20
    WHEN p.total_rake>=500 THEN 0.15 WHEN p.total_rake>=100 THEN 0.10 ELSE 0.05 END AS base_rate
   FROM parsed p
  ), effective AS (
   SELECT r.*,CASE WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate
   FROM rates r
  )
  SELECT e.player_id,max(e.total_rake) AS total_rake,sum(e.rake_credit*e.applied_rate) AS total_unrounded,
   count(*) FILTER(WHERE e.member_history_id IS NULL OR e.member IS DISTINCT FROM e.recorded_member
    OR e.member->>'club_id' IS DISTINCT FROM p_club_id::text OR e.member->>'user_id' IS DISTINCT FROM e.player_id::text
    OR COALESCE(e.member->>'status','') NOT IN('active','approved') OR e.member->>'is_active' IS DISTINCT FROM 'true') AS invalid_members,
   count(*) FILTER(WHERE e.member_agent IS NOT NULL AND (e.direct IS NULL OR e.agent_history_id IS NULL
    OR e.direct->'agreement'->'terms' IS DISTINCT FROM e.recorded_agent
    OR e.direct->>'user_id' IS DISTINCT FROM e.member_agent::text OR e.direct->>'depth' IS DISTINCT FROM '1'
    OR e.recorded_agent->>'club_id' IS DISTINCT FROM p_club_id::text OR e.recorded_agent->>'user_id' IS DISTINCT FROM e.member_agent::text
    OR e.recorded_agent->>'status' IS DISTINCT FROM 'active')) AS invalid_agents,
   count(*) FILTER(WHERE e.deal::text IN('NaN','Infinity','-Infinity') OR e.offer::text IN('NaN','Infinity','-Infinity')
    OR e.deal<0 OR e.deal>1 OR e.offer<0 OR e.offer>1
    OR (e.member_agent IS NOT NULL AND (e.cap_rate IS NULL OR e.cap_rate<0 OR e.cap_rate>1 OR e.cap_rate::text IN('NaN','Infinity','-Infinity')))) AS invalid_rates,
   count(DISTINCT COALESCE(e.member_agent::text,'club')) AS payer_count,
   count(DISTINCT COALESCE(e.coordinator_union_id::text,'standalone')) AS coordinator_count,
   min(e.member_agent::text)::uuid AS payer_user,
   min(e.coordinator_union_id::text)::uuid AS coordinator_union,
   jsonb_agg(jsonb_build_object('source_id',e.id,'rake_record_id',e.rake_record_id,'union_id',e.union_id,
    'coordinator_union_id',e.coordinator_union_id,'rake_credit',e.rake_credit,'rate',e.applied_rate,
    'unrounded_rakeback',e.rake_credit*e.applied_rate,'membership_history_id',e.member_history_id,
    'agent_history_id',e.agent_history_id,'payer_kind',CASE WHEN e.member_agent IS NULL THEN 'club' ELSE 'agent' END,
    'payer_user_id',e.member_agent) ORDER BY e.earned_at,e.rake_record_id,e.id) AS allocations
  FROM effective e GROUP BY e.player_id ORDER BY e.player_id
 LOOP
  IF player.invalid_members>0 THEN RAISE EXCEPTION 'period_membership_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_agents>0 THEN RAISE EXCEPTION 'period_direct_agent_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_rates>0 THEN RAISE EXCEPTION 'period_observed_rate_invalid' USING ERRCODE='55000'; END IF;
  IF player.payer_count<>1 THEN RAISE EXCEPTION 'multiple_historical_payers_require_split_period' USING ERRCODE='55000'; END IF;
  IF player.coordinator_count<>1 THEN RAISE EXCEPTION 'multiple_recorded_coordinators_require_split_period' USING ERRCODE='55000'; END IF;
  total_unrounded:=player.total_unrounded;allocations:=player.allocations;payer_user:=player.payer_user;coordinator_union:=player.coordinator_union;
  payer_kind:=CASE WHEN payer_user IS NULL THEN 'club' ELSE 'agent' END;
  amount:=round(total_unrounded,2);
  display_rate:=CASE WHEN player.total_rake>0 THEN round(total_unrounded/player.total_rake,4) ELSE 0 END;
  IF amount>player.total_rake OR amount<0 THEN RAISE EXCEPTION 'period_rakeback_not_conserved' USING ERRCODE='55000'; END IF;
  fingerprint:=md5(jsonb_build_object('allocations',allocations,'rake',player.total_rake,'amount',amount,'rate',display_rate)::text);
  plan:=jsonb_build_object('player_id',player.player_id,'rake_generated',player.total_rake,
   'rakeback_amount',amount,'display_rate',display_rate,'coordinator_union_id',coordinator_union,'payer_kind',payer_kind,'payer_user_id',payer_user,
   'source_fingerprint',fingerprint,'allocations',allocations);
  SELECT * INTO existing FROM public.rakeback_periods WHERE club_id=p_club_id AND user_id=(plan->>'player_id')::uuid
    AND period_start=p_period_start AND period_end=p_period_end FOR UPDATE;
  IF FOUND THEN
   SELECT * INTO certificate FROM public.accounting_rakeback_period_calculations cert WHERE cert.period_id=existing.id ORDER BY cert.id DESC LIMIT 1;
   IF NOT FOUND OR certificate.accounting_version<>2 OR certificate.club_id IS DISTINCT FROM p_club_id
    OR certificate.player_id IS DISTINCT FROM existing.user_id OR certificate.period_start IS DISTINCT FROM p_period_start
    OR certificate.period_end IS DISTINCT FROM p_period_end
    OR existing.status<>'pending' OR existing.rake_generated IS DISTINCT FROM certificate.rake_generated
    OR existing.total_rake_paid IS DISTINCT FROM certificate.rake_generated OR existing.rakeback_rate IS DISTINCT FROM certificate.display_rate
    OR existing.rakeback_earned IS DISTINCT FROM certificate.rakeback_amount OR existing.rakeback_amount IS DISTINCT FROM certificate.rakeback_amount
   THEN RAISE EXCEPTION 'certified_period_drift_requires_reconciliation' USING ERRCODE='55000'; END IF;
   period_id:=existing.id;
   IF certificate.source_fingerprint=plan->>'source_fingerprint' THEN confirmed:=confirmed+1; CONTINUE; END IF;
   UPDATE public.rakeback_periods SET rake_generated=(plan->>'rake_generated')::numeric,total_rake_paid=(plan->>'rake_generated')::numeric,
    rakeback_rate=(plan->>'display_rate')::numeric,rakeback_earned=(plan->>'rakeback_amount')::numeric,rakeback_amount=(plan->>'rakeback_amount')::numeric
    WHERE id=period_id;
  ELSE
   INSERT INTO public.rakeback_periods(user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_earned,rakeback_amount,total_rake_paid,status)
    VALUES((plan->>'player_id')::uuid,p_club_id,p_period_start,p_period_end,(plan->>'rake_generated')::numeric,
     (plan->>'display_rate')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rake_generated')::numeric,'pending')
    RETURNING id INTO period_id;
  END IF;
  INSERT INTO public.accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,
    rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
   VALUES(period_id,plan->>'source_fingerprint',p_club_id,(plan->>'player_id')::uuid,(plan->>'coordinator_union_id')::uuid,p_period_start,p_period_end,
    (plan->>'rake_generated')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'display_rate')::numeric,
    plan->>'payer_kind',(plan->>'payer_user_id')::uuid,plan->'allocations');
  written:=written+1;confirmed:=confirmed+1;
 END LOOP;
 RETURN receipt||jsonb_build_object('status','ready','written',written,'confirmed_players',confirmed);
EXCEPTION WHEN SQLSTATE '55000' THEN
 RETURN receipt||jsonb_build_object('reason',SQLERRM);
END $function$;
REVOKE ALL ON FUNCTION public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(p_club_id uuid,p_period_start date,p_period_end date,p_user_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='300s' AS $function$
DECLARE request public.accounting_period_recompute_requests%ROWTYPE; result jsonb; request_state text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6
    OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids)>2000 OR array_position(p_user_ids,NULL) IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid_accounting_period_request' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||p_club_id::text||':'||p_period_start::text,0));
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
  VALUES(p_club_id,p_period_start,p_period_end)
  ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL
  RETURNING * INTO request;
 BEGIN
  result:=public.fn_calculate_cash_rakeback_periods(p_club_id,p_period_start,p_period_end,p_user_ids);
 EXCEPTION WHEN OTHERS THEN
  -- This subtransaction rolls back every period/certificate write before the
  -- durable request is marked blocked. The source cursor can keep accruing
  -- later hands; the weekly coordinator still refuses this unfinished book.
  result:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,
    'period_end',p_period_end,'status','blocked','written',0,'reason',SQLERRM);
 END;
 request_state:=CASE WHEN result->>'status'='ready' AND p_user_ids IS NULL THEN 'complete'
                     WHEN result->>'status'='ready' THEN 'pending' ELSE 'blocked' END;
 UPDATE public.accounting_period_recompute_requests SET status=request_state,reason=result->>'reason',
  attempted_at=clock_timestamp(),attempts=attempts+1,last_result=result WHERE id=request.id;
 RETURN result||jsonb_build_object('request_id',request.id,'requested_at',request.requested_at,
  'request_state',request_state,'request_recorded',true);
END $function$;
REVOKE ALL ON FUNCTION public.fn_rakeback_recompute_periods(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_recompute_periods(uuid,date,date,uuid[]) TO service_role;

-- Component 20260914132449_rakeback_follows_recorded_hierarchy_in_one_funded_transaction.sql
-- The previous agent round paid every tier directly from club treasury and
-- silently skipped insufficient funding. The player round chose its payer
-- from current membership. These private stages now consume recorded earning
-- contracts/certificates, route parent-to-child budgets, lock all accounts,
-- and abort the entire transaction on any missing funding or delivery.
-- Existing paid/partial legacy periods cannot be replayed. No history repair.

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_settle_round2_club_to_agents(uuid,timestamptz,timestamptz)'::regprocedure))<>'1f79888c067c5e4892442d88a66affbf'
 OR md5(pg_get_functiondef('public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)'::regprocedure))<>'422380ee15a8e452cf8044c0e91bbddd'
 THEN RAISE EXCEPTION 'routed accounting stage changed since review'; END IF;
 IF (SELECT count(*) FROM public.ca_money_rpc_registry WHERE proname IN('fn_settle_round2_club_to_agents','fn_settle_round3_agents_to_players') AND status='approved')<>2
 THEN RAISE EXCEPTION 'routed accounting writer registration missing'; END IF;
END $guard$;
CREATE TABLE public.accounting_routed_settlement_runs(
 union_id uuid NOT NULL,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,
 round_no integer NOT NULL CHECK(round_no IN(2,3)),routing_version integer NOT NULL DEFAULT 3 CHECK(routing_version=3),
 source_fingerprint text NOT NULL,result jsonb NOT NULL,completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(union_id,period_start,period_end,round_no),CHECK(period_start<period_end)
);
ALTER TABLE public.accounting_routed_settlement_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_routed_settlement_runs FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_routed_settlement_runs TO service_role;
CREATE TRIGGER accounting_routed_run_immutable BEFORE UPDATE OR DELETE ON public.accounting_routed_settlement_runs
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_routed_run_no_truncate BEFORE TRUNCATE ON public.accounting_routed_settlement_runs
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

CREATE OR REPLACE FUNCTION public.fn_settle_round2_club_to_agents(p_union_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE v_source record;v_edge record;previous public.accounting_routed_settlement_runs%ROWTYPE;
 fingerprint text;result jsonb;run_key text;own_total numeric;direct_total numeric;downstream_total numeric;
 source_count int;node_count int;finished int:=0;step int:=0;progress int;ledger_id uuid;receipt_count int;
 payer_before numeric;payee_before numeric;payer_after numeric;payee_after numeric;club_skip text;member_skip text;routing_context text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_commission_invalid_period' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_commission_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_commission_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||p_union_id::text||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text,0));
 run_key:='round2:v3:'||p_union_id::text||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 CREATE TEMP TABLE IF NOT EXISTS _routed_sources(source_id uuid PRIMARY KEY,club_id uuid,contract jsonb,earned_at timestamptz) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_sources;
 INSERT INTO pg_temp._routed_sources SELECT id,club_id,contract,earned_at FROM public.accounting_cash_rake_sources
  WHERE coordinator_union_id=p_union_id AND earned_at>=p_period_start AND earned_at<p_period_end;
 PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY(SELECT club_id FROM pg_temp._routed_sources UNION
  SELECT club_id FROM public.union_clubs WHERE union_id=p_union_id ORDER BY club_id));
 SELECT count(*),md5(COALESCE(string_agg(md5(jsonb_build_array(source_id,club_id,earned_at,contract)::text),'' ORDER BY source_id),''))
 INTO source_count,fingerprint FROM pg_temp._routed_sources;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE union_id=p_union_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
   AND (cs.union_id=p_union_id OR cs.club_id IN(SELECT club_id FROM pg_temp._routed_sources)))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
    AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commissions ac WHERE ac.created_at>=p_period_start AND ac.created_at<p_period_end
  AND (ac.club_id IN(SELECT club_id FROM pg_temp._routed_sources) OR ac.club_id IN(SELECT club_id FROM public.union_clubs WHERE union_id=p_union_id))
  AND (ac.source_type IS DISTINCT FROM 'cash_rake_accrual' OR ac.settled_at IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM public.accounting_cash_rake_sources rs WHERE rs.id=ac.source_id AND rs.club_id=ac.club_id AND rs.earned_at=ac.created_at)))
 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_tiers(source_id uuid,club_id uuid,depth int,agent_id uuid,user_id uuid,role text,
  parent_agent_id uuid,own_amount numeric,rate numeric,PRIMARY KEY(source_id,depth)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_tiers;
 FOR v_source IN SELECT * FROM pg_temp._routed_sources ORDER BY source_id LOOP
  IF jsonb_typeof(v_source.contract->'tiers') IS DISTINCT FROM 'array' OR v_source.contract->>'club_id' IS DISTINCT FROM v_source.club_id::text
  THEN RAISE EXCEPTION 'routed_commission_contract_invalid' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_tiers SELECT v_source.source_id,v_source.club_id,ord::int,(j->>'agent_id')::uuid,(j->>'user_id')::uuid,j->>'role',
   NULLIF(j->'agreement'->'terms'->>'parent_agent_id','')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric
   FROM jsonb_array_elements(v_source.contract->'tiers') WITH ORDINALITY x(j,ord);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.agent_id IS NULL OR t.user_id IS NULL OR t.role IS NULL OR t.role NOT IN('super_agent','agent','sub_agent')
   OR t.own_amount IS NULL OR t.own_amount<0 OR t.own_amount<>round(t.own_amount,2) OR t.own_amount::text IN('NaN','Infinity','-Infinity')
   OR t.rate IS NULL OR t.rate<0 OR t.rate>1 OR t.rate::text IN('NaN','Infinity','-Infinity')
   OR t.parent_agent_id IS DISTINCT FROM(SELECT u.agent_id FROM pg_temp._routed_tiers u WHERE u.source_id=t.source_id AND u.depth=t.depth+1))
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY source_id,user_id HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY club_id,user_id HAVING count(DISTINCT agent_id)<>1 OR count(DISTINCT role)<>1)
 THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE (t.own_amount>0 AND (SELECT count(*) FROM public.agent_commissions ac
   WHERE ac.source_type='cash_rake_accrual' AND ac.source_id=t.source_id AND ac.club_id=t.club_id AND ac.user_id=t.user_id
    AND ac.amount=t.own_amount AND ac.commission_rate=t.rate AND ac.settled_at IS NULL)=0)
   OR (SELECT count(*) FROM public.agent_commissions ac WHERE ac.source_type='cash_rake_accrual' AND ac.source_id=t.source_id AND ac.user_id=t.user_id)<>CASE WHEN t.own_amount>0 THEN 1 ELSE 0 END)
  OR EXISTS(SELECT 1 FROM public.agent_commissions ac JOIN pg_temp._routed_sources s ON s.source_id=ac.source_id
   WHERE ac.source_type='cash_rake_accrual' AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.source_id=s.source_id AND t.user_id=ac.user_id AND t.own_amount=ac.amount))
 THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_nodes(club_id uuid,user_id uuid,agent_id uuid,role text,own_amount numeric,rows_count int,
  opening_balance numeric,sort_order int,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_nodes;
 INSERT INTO pg_temp._routed_nodes(club_id,user_id,agent_id,role,own_amount,rows_count)
  SELECT club_id,user_id,min(agent_id::text)::uuid,min(role),sum(own_amount),count(*) FILTER(WHERE own_amount>0)
  FROM pg_temp._routed_tiers GROUP BY club_id,user_id;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges;
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role)
 SELECT t.club_id,parent.user_id,t.user_id,sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_id=t.source_id AND child.depth<=t.depth)),min(t.role)
 FROM pg_temp._routed_tiers t LEFT JOIN pg_temp._routed_tiers parent ON parent.source_id=t.source_id AND parent.depth=t.depth+1
 GROUP BY t.club_id,parent.user_id,t.user_id
 HAVING sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_id=t.source_id AND child.depth<=t.depth))>0;
 SELECT count(*) INTO node_count FROM pg_temp._routed_nodes;
 WHILE finished<node_count LOOP
  step:=step+1;
  UPDATE pg_temp._routed_nodes n SET sort_order=step WHERE sort_order IS NULL AND NOT EXISTS(
   SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_nodes p ON p.club_id=e.club_id AND p.user_id=e.payer_user
   WHERE e.club_id=n.club_id AND e.payee_user=n.user_id AND p.sort_order IS NULL);
  GET DIAGNOSTICS progress=ROW_COUNT;
  IF progress=0 THEN RAISE EXCEPTION 'routed_commission_weekly_hierarchy_cycle' USING ERRCODE='23514'; END IF;
  finished:=finished+progress;
 END LOOP;
 UPDATE pg_temp._routed_edges e SET sort_order=n.sort_order FROM pg_temp._routed_nodes n WHERE n.club_id=e.club_id AND n.user_id=e.payee_user;
 SELECT COALESCE(sum(own_amount),0) INTO own_total FROM pg_temp._routed_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.own_amount IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- All accounts are pinned before the first transfer. Current rates and parents
 -- never choose the route; only the persisted account identity is checked.
 PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_sources) ORDER BY c.id FOR UPDATE;
 PERFORM cm.id FROM public.club_members cm JOIN pg_temp._routed_nodes n ON n.club_id=cm.club_id AND n.user_id=cm.user_id ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;
 UPDATE pg_temp._routed_nodes n SET opening_balance=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=n.club_id AND cm.user_id=n.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.opening_balance IS NULL OR n.opening_balance<0
  OR n.opening_balance::text IN('NaN','Infinity','-Infinity') OR n.opening_balance<>round(n.opening_balance,2)
  OR NOT EXISTS(SELECT 1 FROM public.agents a WHERE a.id=n.agent_id AND a.club_id=n.club_id AND a.user_id=n.user_id))
 THEN RAISE EXCEPTION 'routed_commission_wallet_identity_or_balance_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(amount) owed FROM pg_temp._routed_edges WHERE payer_user IS NULL GROUP BY club_id) e
  LEFT JOIN public.clubs c ON c.id=e.club_id WHERE c.chip_treasury IS NULL OR c.chip_treasury<e.owed
   OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
 THEN RAISE EXCEPTION 'routed_commission_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',p_union_id::text||':'||p_period_start::text||':'||p_period_end::text,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 FOR v_edge IN SELECT * FROM pg_temp._routed_edges ORDER BY sort_order,club_id,payer_user NULLS FIRST,payee_user LOOP
  SELECT chip_balance INTO payee_before FROM public.club_members WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user;
  IF v_edge.payer_user IS NULL THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=v_edge.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-v_edge.amount WHERE id=v_edge.club_id AND chip_treasury>=v_edge.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user;
   UPDATE public.club_members SET chip_balance=chip_balance-v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user AND chip_balance>=v_edge.amount RETURNING chip_balance INTO payer_after;
  END IF;
  UPDATE public.club_members SET chip_balance=chip_balance+v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user RETURNING chip_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>v_edge.amount OR payee_after-payee_before<>v_edge.amount
  THEN RAISE EXCEPTION 'routed_commission_transfer_not_conserved' USING ERRCODE='23514'; END IF;
  IF v_edge.payer_user IS NOT NULL THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(v_edge.payer_user,'PLAYER','debit',v_edge.amount,'commission','Recorded weekly commission budget passed to child agent',payer_after); END IF;
  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(v_edge.payee_user,'PLAYER','credit',v_edge.amount,'commission','Recorded weekly commission budget received',payee_after);
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN v_edge.payer_user IS NULL THEN 'club_treasury' ELSE 'player_wallet' END,
    COALESCE(v_edge.payer_user,v_edge.club_id),'player_wallet',v_edge.payee_user,v_edge.amount,'commission',v_edge.club_id,p_union_id,
    'Weekly commission through recorded earning hierarchy',run_key||':'||v_edge.club_id::text||':'||COALESCE(v_edge.payer_user::text,'club')||':'||v_edge.payee_user::text,
    jsonb_build_object('routing_version',3,'period_start',p_period_start,'period_end',p_period_end,'payee_role_at_transfer',v_edge.role,
      'own_commission',(SELECT own_amount FROM pg_temp._routed_nodes WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user),
      'pass_through',v_edge.payer_user IS NOT NULL),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
   AND i.chips_transferred AND i.message_sent AND i.net_amount=v_edge.amount AND i.gross_amount=v_edge.amount AND i.deductions=0;
  IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_commission_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n JOIN public.club_members cm ON cm.club_id=n.club_id AND cm.user_id=n.user_id
   WHERE cm.chip_balance IS DISTINCT FROM n.opening_balance+n.own_amount)
 THEN RAISE EXCEPTION 'routed_commission_retained_balance_incorrect' USING ERRCODE='23514'; END IF;
 INSERT INTO public.agent_commission_settlements(club_id,user_id,union_id,period_start,period_end,amount,rows_count,paid_at,settlement_ref)
  SELECT club_id,user_id,p_union_id,p_period_start,p_period_end,own_amount,rows_count,now(),run_key FROM pg_temp._routed_nodes;
 IF node_count>0 THEN PERFORM public.fn_agent_commission_rollup_recompute(
  (SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id)) FROM pg_temp._routed_nodes)); END IF;
 result:=jsonb_build_object('success',true,'round',2,'name','recorded_commission_hierarchy','routing_version',3,'source_version',2,
  'payees',node_count,'amount',direct_total,'own_commission_amount',own_total,'downstream_amount',downstream_total,
  'shortfalls',0,'sources',source_count,'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,period_start,period_end,round_no,source_fingerprint,result)
 VALUES(p_union_id,p_period_start,p_period_end,2,fingerprint,result);
 RETURN result;
END $function$;
-- Internal stages are called only by the single SECURITY DEFINER coordinator.
REVOKE ALL ON FUNCTION public.fn_settle_round2_club_to_agents(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_round3_agents_to_players(p_union_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE r record;c public.accounting_rakeback_period_calculations%ROWTYPE;g record;
 previous public.accounting_routed_settlement_runs%ROWTYPE;fingerprint text;result jsonb;
 from_date date;to_date date;allocation_count int;matched_count int;actual_count int;
 generated numeric;unrounded numeric;display_rate numeric;amount numeric;paid numeric:=0;
 payer_before numeric;payer_after numeric;player_before numeric;player_after numeric;
 payout_id uuid;wallet_id uuid;ledger_id uuid;receipt_count int;payees int:=0;
 club_skip text;member_skip text;maintenance text;routing_context text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_rakeback_invalid_period' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_rakeback_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 from_date:=(p_period_start AT TIME ZONE 'America/Los_Angeles')::date;
 to_date:=(p_period_end AT TIME ZONE 'America/Los_Angeles')::date-1;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_rakeback_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||p_union_id::text||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text,0));
 PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY(SELECT club_id FROM public.union_clubs WHERE union_id=p_union_id UNION
  SELECT club_id FROM public.accounting_cash_rake_sources WHERE coordinator_union_id=p_union_id AND earned_at>=p_period_start AND earned_at<p_period_end ORDER BY club_id));
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_items(period_id uuid PRIMARY KEY,certificate_id bigint,club_id uuid,user_id uuid,
  payer_kind text,payer_user uuid,owed numeric,rake numeric,rate numeric,fingerprint text,status text) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_items;
 FOR r IN SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id IN(SELECT club_id FROM public.union_clubs WHERE union_id=p_union_id)
    OR EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND rs.coordinator_union_id=p_union_id AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end))
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE
 LOOP
  SELECT * INTO c FROM public.accounting_rakeback_period_calculations WHERE period_id=r.id ORDER BY id DESC LIMIT 1;
  IF NOT FOUND OR c.accounting_version<>2 OR c.coordinator_union_id IS DISTINCT FROM p_union_id OR r.period_start<>from_date OR r.period_end<>to_date
   OR c.club_id IS DISTINCT FROM r.club_id OR c.player_id IS DISTINCT FROM r.user_id
   OR c.period_start IS DISTINCT FROM r.period_start OR c.period_end IS DISTINCT FROM r.period_end
   OR c.rake_generated IS DISTINCT FROM r.rake_generated OR c.rake_generated IS DISTINCT FROM r.total_rake_paid
   OR c.rakeback_amount IS DISTINCT FROM r.rakeback_amount OR c.rakeback_amount IS DISTINCT FROM r.rakeback_earned
   OR c.display_rate IS DISTINCT FROM r.rakeback_rate OR c.rakeback_amount<0 OR c.rakeback_amount<>round(c.rakeback_amount,2)
   OR c.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR c.payer_kind NOT IN('agent','club')
   OR (c.payer_kind='agent') IS DISTINCT FROM(c.payer_user_id IS NOT NULL) OR c.payer_user_id=r.user_id
  THEN RAISE EXCEPTION 'routed_rakeback_certificate_required' USING ERRCODE='55000'; END IF;
  SELECT count(*),count(DISTINCT a->>'source_id'),sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric)
   INTO allocation_count,matched_count,generated,unrounded FROM jsonb_array_elements(c.source_allocations) a;
  SELECT count(*) INTO actual_count FROM public.accounting_cash_rake_sources rs WHERE rs.club_id=r.club_id AND rs.player_id=r.user_id
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end AND rs.coordinator_union_id=p_union_id;
  IF allocation_count=0 OR allocation_count<>matched_count OR allocation_count<>actual_count OR generated IS DISTINCT FROM c.rake_generated
    OR round(unrounded,2) IS DISTINCT FROM c.rakeback_amount
    OR c.display_rate IS DISTINCT FROM (CASE WHEN generated>0 THEN round(unrounded/generated,4) ELSE 0 END)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_allocations) a LEFT JOIN public.accounting_cash_rake_sources rs ON rs.id=(a->>'source_id')::uuid
     WHERE rs.id IS NULL OR rs.club_id<>r.club_id OR rs.player_id<>r.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR a->>'payer_kind' IS DISTINCT FROM c.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM c.payer_user_id
      OR NULLIF(rs.contract->'membership'->'terms'->>'agent_id','')::uuid IS DISTINCT FROM c.payer_user_id)
  THEN RAISE EXCEPTION 'routed_rakeback_sources_disagree_with_certificate' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_player_items VALUES(r.id,c.id,r.club_id,r.user_id,c.payer_kind,c.payer_user_id,c.rakeback_amount,c.rake_generated,c.display_rate,c.source_fingerprint,r.status);
 END LOOP;
 -- Missing periods are obligations too: every source player in this scope must
 -- have an admitted certificate, including zero-entitlement players.
 IF EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources rs WHERE rs.coordinator_union_id=p_union_id
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
   AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
 THEN RAISE EXCEPTION 'routed_rakeback_player_period_missing' USING ERRCODE='55000'; END IF;
 SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(i.period_id,i.certificate_id,i.club_id,i.user_id,i.payer_kind,i.payer_user,i.owed,i.rake,i.rate,i.fingerprint) ORDER BY i.period_id),'[]'::jsonb)::text)
  INTO fingerprint FROM pg_temp._routed_player_items i;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE union_id=p_union_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint OR EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status<>'paid' OR NOT EXISTS(
   SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.user_id=i.user_id AND pp.club_id=i.club_id AND pp.status='paid' AND pp.payout_amount=i.owed))
  THEN RAISE EXCEPTION 'routed_rakeback_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status IS DISTINCT FROM 'pending'
   OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds sr WHERE sr.union_id=p_union_id AND sr.round_no=3
   AND sr.period_start<p_period_end AND sr.period_end>p_period_start AND (sr.amount>0 OR sr.payees>0 OR sr.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_rakeback_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_wallets(club_id uuid,user_id uuid,opening numeric,delta numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_wallets;
 INSERT INTO pg_temp._routed_player_wallets(club_id,user_id,delta)
 SELECT club_id,user_id,sum(delta) FROM(
  SELECT club_id,user_id,owed AS delta FROM pg_temp._routed_player_items
  UNION ALL SELECT club_id,payer_user,-owed FROM pg_temp._routed_player_items WHERE payer_kind='agent') x GROUP BY club_id,user_id;
 PERFORM id FROM public.clubs WHERE id IN(SELECT club_id FROM pg_temp._routed_player_items) ORDER BY id FOR UPDATE;
 PERFORM cm.id FROM public.club_members cm JOIN pg_temp._routed_player_wallets w ON w.club_id=cm.club_id AND w.user_id=cm.user_id
  ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;
 UPDATE pg_temp._routed_player_wallets w SET opening=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=w.club_id AND cm.user_id=w.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets WHERE opening IS NULL OR opening<0 OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_account_missing_or_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,payer_user,sum(owed) owed FROM pg_temp._routed_player_items WHERE payer_kind='agent' GROUP BY club_id,payer_user) x
  JOIN pg_temp._routed_player_wallets w ON w.club_id=x.club_id AND w.user_id=x.payer_user WHERE w.opening<x.owed)
 THEN RAISE EXCEPTION 'routed_rakeback_agent_funding_shortfall' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(owed) owed FROM pg_temp._routed_player_items WHERE payer_kind='club' GROUP BY club_id) x
  LEFT JOIN public.clubs bank ON bank.id=x.club_id WHERE bank.chip_treasury IS NULL OR bank.chip_treasury<x.owed
   OR bank.chip_treasury<>round(bank.chip_treasury,2) OR bank.chip_treasury::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 maintenance:=current_setting('app.ledger_maintenance',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',p_union_id::text||':'||p_period_start::text||':'||p_period_end::text,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 FOR r IN SELECT * FROM pg_temp._routed_player_items ORDER BY club_id,payer_user NULLS FIRST,user_id,period_id LOOP
  amount:=r.owed;
  INSERT INTO public.rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
   VALUES(r.period_id,r.club_id,r.user_id,r.rake,round(r.rate*100,2),amount,'paid',now()) RETURNING id INTO payout_id;
  IF amount>0 THEN
   SELECT chip_balance INTO player_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.user_id;
   IF r.payer_kind='club' THEN
    SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=r.club_id;
    UPDATE public.clubs SET chip_treasury=chip_treasury-amount WHERE id=r.club_id AND chip_treasury>=amount RETURNING chip_treasury INTO payer_after;
   ELSE
    SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.payer_user;
    UPDATE public.club_members SET chip_balance=chip_balance-amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.payer_user AND chip_balance>=amount RETURNING chip_balance INTO payer_after;
   END IF;
   UPDATE public.club_members SET chip_balance=chip_balance+amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING chip_balance INTO player_after;
   IF payer_after IS NULL OR player_after IS NULL OR payer_before-payer_after<>amount OR player_after-player_before<>amount
   THEN RAISE EXCEPTION 'routed_rakeback_transfer_not_conserved' USING ERRCODE='23514'; END IF;
   IF r.payer_kind='agent' THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.payer_user,'PLAYER','debit',amount,'rakeback','Weekly rakeback paid under recorded agreement',payer_after,payout_id); END IF;
   INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.user_id,'PLAYER','credit',amount,'rakeback','Weekly rakeback received under recorded agreement',player_after,payout_id) RETURNING id INTO wallet_id;
   PERFORM set_config('app.ledger_maintenance','rakeback payout evidence pointer',true);
   UPDATE public.rakeback_period_payouts SET wallet_transaction_id=wallet_id WHERE id=payout_id;
   PERFORM set_config('app.ledger_maintenance',COALESCE(maintenance,''),true);
   INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
    VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN r.payer_kind='club' THEN 'club_treasury' ELSE 'player_wallet' END,
     COALESCE(r.payer_user,r.club_id),'player_wallet',r.user_id,amount,'rakeback',r.club_id,p_union_id,'Weekly rakeback from certified historical payer',
     'round3-period:v3:'||r.period_id::text,jsonb_build_object('routing_version',3,'period_id',r.period_id,'period_start',p_period_start,'period_end',p_period_end,
       'certificate_id',r.certificate_id,'source_fingerprint',r.fingerprint,'payout_id',payout_id,'wallet_transaction_id',wallet_id,'payee_role_at_transfer','player'),
      payer_before,payer_after,player_before,player_after) RETURNING id INTO ledger_id;
   SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
    AND i.chips_transferred AND i.message_sent AND i.net_amount=amount AND i.gross_amount=amount AND i.deductions=0;
   IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_rakeback_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
   paid:=paid+amount;payees:=payees+1;
  END IF;
  UPDATE public.rakeback_periods SET status='paid',paid_at=now() WHERE id=r.period_id;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets w JOIN public.club_members cm ON cm.club_id=w.club_id AND cm.user_id=w.user_id
   WHERE cm.chip_balance IS DISTINCT FROM w.opening+w.delta)
 THEN RAISE EXCEPTION 'routed_rakeback_final_balance_incorrect' USING ERRCODE='23514'; END IF;
 result:=jsonb_build_object('success',true,'round',3,'name','certified_payer_to_players','routing_version',3,'source_version',2,
  'amount',paid,'payees',payees,'shortfalls',0,'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,period_start,period_end,round_no,source_fingerprint,result)
  VALUES(p_union_id,p_period_start,p_period_end,3,fingerprint,result);
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- Component 20260914133404_routed_invoice_roles_follow_the_recorded_payment.sql
-- Routed payouts retain the role recorded by the atomic stage, including a
-- player's rakeback when that same account also has an agent profile. Only the
-- matching private stage's transaction context can assert a recorded role;
-- arbitrary message or transfer metadata cannot override the invoice party.

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_invoice_accounting_ledger_transfer(uuid)'::regprocedure))<>'dd1871aa89f1709b9b45cb16542b5fa9'
 THEN RAISE EXCEPTION 'accounting invoice source changed since review'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_invoice_accounting_ledger_transfer(p_ledger_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE leg public.chip_ledger%ROWTYPE; inv_id uuid; issuer_kind text; issuer_id uuid; payee_kind text; payee_id uuid; kind text; recorded_role text; routed boolean;
BEGIN
 SELECT * INTO leg FROM public.chip_ledger WHERE id=p_ledger_id;
 IF NOT FOUND OR leg.status IS DISTINCT FROM 'posted' OR leg.amount IS NULL OR leg.amount<=0
    OR leg.amount::text IN('NaN','Infinity','-Infinity') OR leg.amount<>round(leg.amount,2)
 THEN RAISE EXCEPTION 'invalid_accounting_transfer' USING ERRCODE='23514'; END IF;
 routed:=COALESCE(leg.metadata->>'routing_version'='3'
  AND current_setting('app.accounting_routing_context',true)=
   CASE WHEN leg.union_id IS NOT NULL THEN leg.union_id::text
    WHEN leg.metadata->>'accounting_scope_kind'='club' AND leg.metadata->>'accounting_scope_id'=leg.club_id::text
     THEN 'club:'||leg.club_id::text END
   ||':'||((leg.metadata->>'period_start')::timestamptz)::text||':'||((leg.metadata->>'period_end')::timestamptz)::text,false);
 recorded_role:=CASE WHEN routed THEN leg.metadata->>'payee_role_at_transfer' END;
 IF routed AND leg.to_type IN('player_wallet','agent_wallet') AND (recorded_role IS NULL OR recorded_role NOT IN('player','sub_agent','agent','super_agent')) THEN
  RAISE EXCEPTION 'routed_payment_recipient_role_missing' USING ERRCODE='23514'; END IF;

 IF leg.from_type IN('union_wallet','union_bank') THEN issuer_kind:='union';issuer_id:=leg.from_entity_id;
 ELSIF leg.from_type='club_treasury' THEN issuer_kind:='club';issuer_id:=leg.from_entity_id;
 ELSIF leg.from_type IN('player_wallet','agent_wallet') THEN issuer_id:=leg.from_entity_id;
   issuer_kind:=CASE WHEN routed OR leg.from_type='agent_wallet' OR EXISTS(SELECT 1 FROM public.agents a WHERE a.user_id=issuer_id AND a.club_id=leg.club_id) THEN 'agent' ELSE 'player' END;
 ELSIF leg.from_type='settlement_suspense' AND leg.category='rakeback' AND leg.club_id IS NOT NULL THEN
   -- Club-issued receipt for the existing clearing-account leg; preserve its actual source in breakdown.
   issuer_kind:='club';issuer_id:=leg.club_id;
 ELSE RAISE EXCEPTION 'unsupported_accounting_transfer_source' USING ERRCODE='23514'; END IF;
 -- Game payout journals retain the physical union_wallets.id store identity.
 -- Accounting parties use unions.id. Resolve only a matching, declared host;
 -- never rewrite the original journal or infer a different union.
 IF leg.category IN('wheel_prize','plinko_prize','crash_prize','crossing_prize','mines_prize')
    AND issuer_kind='union' AND leg.union_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.union_wallets w WHERE w.id=issuer_id AND w.union_id=leg.union_id)
 THEN issuer_id:=leg.union_id; END IF;
 IF leg.to_type IN('union_wallet','union_bank') THEN payee_kind:='union';payee_id:=leg.to_entity_id;
 ELSIF leg.to_type='club_treasury' THEN payee_kind:='club';payee_id:=leg.to_entity_id;
 ELSIF leg.to_type IN('player_wallet','agent_wallet') THEN
   payee_id:=leg.to_entity_id;
   payee_kind:=CASE WHEN routed THEN CASE WHEN recorded_role='player' THEN 'player' ELSE 'agent' END WHEN leg.category='commission' OR EXISTS(SELECT 1 FROM public.agents a WHERE a.user_id=payee_id AND a.club_id=leg.club_id) THEN 'agent' ELSE 'player' END;
 ELSE RAISE EXCEPTION 'unsupported_accounting_transfer_recipient' USING ERRCODE='23514'; END IF;
 kind:=CASE WHEN issuer_kind='union' AND payee_kind='club' THEN 'union_to_club'
            WHEN issuer_kind='club' AND payee_kind='agent' THEN 'club_to_agent'
            WHEN issuer_kind='agent' AND payee_kind='agent' THEN 'agent_to_subagent'
            WHEN issuer_kind='agent' AND payee_kind='player' THEN 'agent_to_player' ELSE 'transaction_receipt' END;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_ledger_invoice:'||leg.id::text,0));
 SELECT id INTO inv_id FROM public.settlement_invoices WHERE source_ledger_id=leg.id;
 IF inv_id IS NULL THEN
   INSERT INTO public.settlement_invoices(club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
    gross_amount,net_amount,deductions,breakdown,status,chips_transferred,transferred_at,notes,source_ledger_id)
   VALUES(COALESCE(leg.club_id,leg.union_id),kind,issuer_kind,issuer_id::text,payee_kind,payee_id::text,leg.amount,leg.amount,0,
    COALESCE(leg.metadata,'{}'::jsonb)||jsonb_build_object('ledger_id',leg.id,'category',leg.category,'ledger_from_type',leg.from_type,
      'ledger_from_entity_id',leg.from_entity_id,'ledger_to_type',leg.to_type,'ledger_to_entity_id',leg.to_entity_id,
      'payee_role_at_transfer',CASE WHEN routed AND recorded_role IS NOT NULL THEN recorded_role WHEN payee_kind='player' THEN 'player' ELSE (SELECT a.role FROM public.agents a WHERE a.user_id=payee_id AND a.club_id=leg.club_id ORDER BY a.id LIMIT 1) END),
    'paid',true,leg.created_at,'Receipt For A Posted Accounting Transfer. This Does Not Certify The Entire Weekly Close.',leg.id)
   RETURNING id INTO inv_id;
 END IF;
 PERFORM public.fn_deliver_accounting_invoice(inv_id);
 RETURN inv_id;
END $function$

;

-- Component 20260914135008_standalone_clubs_use_the_same_atomic_routed_stages.sql
-- Truly standalone clubs had no commission waterfall; their player path still
-- chose a current payer. Union wrappers and standalone calls now share the
-- exact same private commission and player stage implementations. One explicit
-- resolver admits recorded coordinator/club scope, including later membership
-- changes. No NULL-as-all-clubs scope, rate change, or historical payment replay.

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_settle_round2_club_to_agents(uuid,timestamptz,timestamptz)'::regprocedure))<>'c03c212bf251276d906b9bbf3568de47'
 OR md5(pg_get_functiondef('public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)'::regprocedure))<>'8132e8213c5432466aac403750358438'
 THEN RAISE EXCEPTION 'routed stage preimage changed before shared scope upgrade';END IF;
END $guard$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_settle_accounting_commission_stage','approved','One private commission payment implementation for explicit union or standalone club scope. Recorded earning contracts, full account locks and funds, immutable own-entitlement receipt, synchronous source invoice. No rates or history changed.'),
 ('fn_settle_accounting_rakeback_stage','approved','One private player payment implementation for explicit union or standalone club scope. Requires exact immutable week certificate and earning-time payer, full funding, one ledger/invoice/delivery, atomic rollback. No rates or history changed.');
ALTER TABLE public.accounting_routed_settlement_runs DROP CONSTRAINT accounting_routed_settlement_runs_pkey;
ALTER TABLE public.accounting_routed_settlement_runs ALTER COLUMN union_id DROP NOT NULL,
 ADD COLUMN standalone_club_id uuid,
 ADD COLUMN scope_kind text GENERATED ALWAYS AS(CASE WHEN union_id IS NULL THEN 'club'::text ELSE 'union'::text END) STORED,
 ADD COLUMN scope_id uuid GENERATED ALWAYS AS(COALESCE(union_id,standalone_club_id)) STORED,
 ADD CONSTRAINT accounting_routed_run_one_scope CHECK(num_nonnulls(union_id,standalone_club_id)=1),
 ADD PRIMARY KEY(scope_kind,scope_id,period_start,period_end,round_no);
-- Existing union receipts gain their generated scope without rewriting history.
CREATE FUNCTION public.fn_resolve_accounting_routing_scope(p_scope_kind text,p_scope_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS TABLE(union_id uuid,standalone_club_id uuid,club_ids uuid[],scope_key text,lock_key text,routing_context text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 IF p_scope_kind IS NULL OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL
  OR (p_scope_kind='union' AND NOT EXISTS(SELECT 1 FROM public.unions u WHERE u.id=p_scope_id))
  OR (p_scope_kind='club' AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_scope_id))
 THEN RAISE EXCEPTION 'invalid_accounting_routing_scope' USING ERRCODE='22023';END IF;
 union_id:=CASE WHEN p_scope_kind='union' THEN p_scope_id END;
 standalone_club_id:=CASE WHEN p_scope_kind='club' THEN p_scope_id END;
 -- Preserve union keys and the established coordinator lock exactly. Club keys
 -- have an explicit prefix so even identical UUID values can never collide.
 scope_key:=CASE WHEN p_scope_kind='union' THEN p_scope_id::text ELSE 'club:'||p_scope_id::text END;
 lock_key:=CASE WHEN p_scope_kind='union' THEN 'union-accounting:' ELSE 'club-accounting:' END||p_scope_id::text||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 routing_context:=scope_key||':'||p_period_start::text||':'||p_period_end::text;
 -- Acquire before reading source-club membership: a waiting close must see all
 -- earning sources committed by the previous lock holder. Accrual shares this key.
 PERFORM pg_advisory_xact_lock(hashtextextended(lock_key,0));
 IF p_scope_kind='union' THEN
  club_ids:=ARRAY(SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=p_scope_id UNION
   SELECT rs.club_id FROM public.accounting_cash_rake_sources rs WHERE rs.coordinator_union_id=p_scope_id
    AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end ORDER BY club_id);
 ELSE club_ids:=ARRAY[p_scope_id];END IF;
 RETURN NEXT;
END $function$;
REVOKE ALL ON FUNCTION public.fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_settle_accounting_commission_stage(p_scope_kind text,p_scope_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE scope record;p_union_id uuid;standalone_club uuid;
 v_source record;v_edge record;previous public.accounting_routed_settlement_runs%ROWTYPE;
 fingerprint text;result jsonb;run_key text;own_total numeric;direct_total numeric;downstream_total numeric;
 source_count int;node_count int;finished int:=0;step int:=0;progress int;ledger_id uuid;receipt_count int;
 payer_before numeric;payee_before numeric;payer_after numeric;payee_after numeric;club_skip text;member_skip text;routing_context text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_commission_invalid_period' USING ERRCODE='22023'; END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_commission_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_commission_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 run_key:='round2:v3:'||scope.scope_key||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 CREATE TEMP TABLE IF NOT EXISTS _routed_sources(source_id uuid PRIMARY KEY,club_id uuid,contract jsonb,earned_at timestamptz) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_sources;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 INSERT INTO pg_temp._routed_sources SELECT id,club_id,contract,earned_at FROM public.accounting_cash_rake_sources
  WHERE (coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND coordinator_union_id IS NULL AND club_id=standalone_club)) AND earned_at>=p_period_start AND earned_at<p_period_end;
 SELECT count(*),md5(COALESCE(string_agg(md5(jsonb_build_array(source_id,club_id,earned_at,contract)::text),'' ORDER BY source_id),''))
 INTO source_count,fingerprint FROM pg_temp._routed_sources;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
   AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
    AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commissions ac WHERE ac.created_at>=p_period_start AND ac.created_at<p_period_end
  AND (ac.club_id=ANY(scope.club_ids))
  AND (ac.source_type IS DISTINCT FROM 'cash_rake_accrual' OR ac.settled_at IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM public.accounting_cash_rake_sources rs WHERE rs.id=ac.source_id AND rs.club_id=ac.club_id AND rs.earned_at=ac.created_at)))
 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_tiers(source_id uuid,club_id uuid,depth int,agent_id uuid,user_id uuid,role text,
  parent_agent_id uuid,own_amount numeric,rate numeric,PRIMARY KEY(source_id,depth)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_tiers;
 FOR v_source IN SELECT * FROM pg_temp._routed_sources ORDER BY source_id LOOP
  IF jsonb_typeof(v_source.contract->'tiers') IS DISTINCT FROM 'array' OR v_source.contract->>'club_id' IS DISTINCT FROM v_source.club_id::text
  THEN RAISE EXCEPTION 'routed_commission_contract_invalid' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_tiers SELECT v_source.source_id,v_source.club_id,ord::int,(j->>'agent_id')::uuid,(j->>'user_id')::uuid,j->>'role',
   NULLIF(j->'agreement'->'terms'->>'parent_agent_id','')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric
   FROM jsonb_array_elements(v_source.contract->'tiers') WITH ORDINALITY x(j,ord);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.agent_id IS NULL OR t.user_id IS NULL OR t.role IS NULL OR t.role NOT IN('super_agent','agent','sub_agent')
   OR t.own_amount IS NULL OR t.own_amount<0 OR t.own_amount<>round(t.own_amount,2) OR t.own_amount::text IN('NaN','Infinity','-Infinity')
   OR t.rate IS NULL OR t.rate<0 OR t.rate>1 OR t.rate::text IN('NaN','Infinity','-Infinity')
   OR t.parent_agent_id IS DISTINCT FROM(SELECT u.agent_id FROM pg_temp._routed_tiers u WHERE u.source_id=t.source_id AND u.depth=t.depth+1))
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY source_id,user_id HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY club_id,user_id HAVING count(DISTINCT agent_id)<>1 OR count(DISTINCT role)<>1)
 THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE (t.own_amount>0 AND (SELECT count(*) FROM public.agent_commissions ac
   WHERE ac.source_type='cash_rake_accrual' AND ac.source_id=t.source_id AND ac.club_id=t.club_id AND ac.user_id=t.user_id
    AND ac.amount=t.own_amount AND ac.commission_rate=t.rate AND ac.settled_at IS NULL)=0)
   OR (SELECT count(*) FROM public.agent_commissions ac WHERE ac.source_type='cash_rake_accrual' AND ac.source_id=t.source_id AND ac.user_id=t.user_id)<>CASE WHEN t.own_amount>0 THEN 1 ELSE 0 END)
  OR EXISTS(SELECT 1 FROM public.agent_commissions ac JOIN pg_temp._routed_sources s ON s.source_id=ac.source_id
   WHERE ac.source_type='cash_rake_accrual' AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.source_id=s.source_id AND t.user_id=ac.user_id AND t.own_amount=ac.amount))
 THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_nodes(club_id uuid,user_id uuid,agent_id uuid,role text,own_amount numeric,rows_count int,
  opening_balance numeric,sort_order int,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_nodes;
 INSERT INTO pg_temp._routed_nodes(club_id,user_id,agent_id,role,own_amount,rows_count)
  SELECT club_id,user_id,min(agent_id::text)::uuid,min(role),sum(own_amount),count(*) FILTER(WHERE own_amount>0)
  FROM pg_temp._routed_tiers GROUP BY club_id,user_id;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges;
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role)
 SELECT t.club_id,parent.user_id,t.user_id,sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_id=t.source_id AND child.depth<=t.depth)),min(t.role)
 FROM pg_temp._routed_tiers t LEFT JOIN pg_temp._routed_tiers parent ON parent.source_id=t.source_id AND parent.depth=t.depth+1
 GROUP BY t.club_id,parent.user_id,t.user_id
 HAVING sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_id=t.source_id AND child.depth<=t.depth))>0;
 SELECT count(*) INTO node_count FROM pg_temp._routed_nodes;
 WHILE finished<node_count LOOP
  step:=step+1;
  UPDATE pg_temp._routed_nodes n SET sort_order=step WHERE sort_order IS NULL AND NOT EXISTS(
   SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_nodes p ON p.club_id=e.club_id AND p.user_id=e.payer_user
   WHERE e.club_id=n.club_id AND e.payee_user=n.user_id AND p.sort_order IS NULL);
  GET DIAGNOSTICS progress=ROW_COUNT;
  IF progress=0 THEN RAISE EXCEPTION 'routed_commission_weekly_hierarchy_cycle' USING ERRCODE='23514'; END IF;
  finished:=finished+progress;
 END LOOP;
 UPDATE pg_temp._routed_edges e SET sort_order=n.sort_order FROM pg_temp._routed_nodes n WHERE n.club_id=e.club_id AND n.user_id=e.payee_user;
 SELECT COALESCE(sum(own_amount),0) INTO own_total FROM pg_temp._routed_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.own_amount IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- All accounts are pinned before the first transfer. Current rates and parents
 -- never choose the route; only the persisted account identity is checked.
 PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_sources) ORDER BY c.id FOR UPDATE;
 PERFORM cm.id FROM public.club_members cm JOIN pg_temp._routed_nodes n ON n.club_id=cm.club_id AND n.user_id=cm.user_id ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;
 UPDATE pg_temp._routed_nodes n SET opening_balance=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=n.club_id AND cm.user_id=n.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.opening_balance IS NULL OR n.opening_balance<0
  OR n.opening_balance::text IN('NaN','Infinity','-Infinity') OR n.opening_balance<>round(n.opening_balance,2)
  OR NOT EXISTS(SELECT 1 FROM public.agents a WHERE a.id=n.agent_id AND a.club_id=n.club_id AND a.user_id=n.user_id))
 THEN RAISE EXCEPTION 'routed_commission_wallet_identity_or_balance_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(amount) owed FROM pg_temp._routed_edges WHERE payer_user IS NULL GROUP BY club_id) e
  LEFT JOIN public.clubs c ON c.id=e.club_id WHERE c.chip_treasury IS NULL OR c.chip_treasury<e.owed
   OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
 THEN RAISE EXCEPTION 'routed_commission_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 FOR v_edge IN SELECT * FROM pg_temp._routed_edges ORDER BY sort_order,club_id,payer_user NULLS FIRST,payee_user LOOP
  SELECT chip_balance INTO payee_before FROM public.club_members WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user;
  IF v_edge.payer_user IS NULL THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=v_edge.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-v_edge.amount WHERE id=v_edge.club_id AND chip_treasury>=v_edge.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user;
   UPDATE public.club_members SET chip_balance=chip_balance-v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user AND chip_balance>=v_edge.amount RETURNING chip_balance INTO payer_after;
  END IF;
  UPDATE public.club_members SET chip_balance=chip_balance+v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user RETURNING chip_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>v_edge.amount OR payee_after-payee_before<>v_edge.amount
  THEN RAISE EXCEPTION 'routed_commission_transfer_not_conserved' USING ERRCODE='23514'; END IF;
  IF v_edge.payer_user IS NOT NULL THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(v_edge.payer_user,'PLAYER','debit',v_edge.amount,'commission','Recorded weekly commission budget passed to child agent',payer_after); END IF;
  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(v_edge.payee_user,'PLAYER','credit',v_edge.amount,'commission','Recorded weekly commission budget received',payee_after);
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN v_edge.payer_user IS NULL THEN 'club_treasury' ELSE 'player_wallet' END,
    COALESCE(v_edge.payer_user,v_edge.club_id),'player_wallet',v_edge.payee_user,v_edge.amount,'commission',v_edge.club_id,p_union_id,
    'Weekly commission through recorded earning hierarchy',run_key||':'||v_edge.club_id::text||':'||COALESCE(v_edge.payer_user::text,'club')||':'||v_edge.payee_user::text,
    jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_start',p_period_start,'period_end',p_period_end,'payee_role_at_transfer',v_edge.role,
      'own_commission',(SELECT own_amount FROM pg_temp._routed_nodes WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user),
      'pass_through',v_edge.payer_user IS NOT NULL),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
   AND i.chips_transferred AND i.message_sent AND i.net_amount=v_edge.amount AND i.gross_amount=v_edge.amount AND i.deductions=0;
  IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_commission_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n JOIN public.club_members cm ON cm.club_id=n.club_id AND cm.user_id=n.user_id
   WHERE cm.chip_balance IS DISTINCT FROM n.opening_balance+n.own_amount)
 THEN RAISE EXCEPTION 'routed_commission_retained_balance_incorrect' USING ERRCODE='23514'; END IF;
 INSERT INTO public.agent_commission_settlements(club_id,user_id,union_id,period_start,period_end,amount,rows_count,paid_at,settlement_ref)
  SELECT club_id,user_id,p_union_id,p_period_start,p_period_end,own_amount,rows_count,now(),run_key FROM pg_temp._routed_nodes;
 IF node_count>0 THEN PERFORM public.fn_agent_commission_rollup_recompute(
  (SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id)) FROM pg_temp._routed_nodes)); END IF;
 result:=jsonb_build_object('success',true,'round',2,'name','recorded_commission_hierarchy','routing_version',3,'source_version',2,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'payees',node_count,'amount',direct_total,'own_commission_amount',own_total,'downstream_amount',downstream_total,
  'shortfalls',0,'sources',source_count,'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
 VALUES(p_union_id,standalone_club,p_period_start,p_period_end,2,fingerprint,result);
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_round2_club_to_agents(p_union_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $function$
 SELECT public.fn_settle_accounting_commission_stage('union',p_union_id,p_period_start,p_period_end);
$function$;
REVOKE ALL ON FUNCTION public.fn_settle_round2_club_to_agents(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_settle_accounting_rakeback_stage(p_scope_kind text,p_scope_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE scope record;p_union_id uuid;standalone_club uuid;
 r record;c public.accounting_rakeback_period_calculations%ROWTYPE;g record;
 previous public.accounting_routed_settlement_runs%ROWTYPE;fingerprint text;result jsonb;
 from_date date;to_date date;allocation_count int;matched_count int;actual_count int;
 generated numeric;unrounded numeric;display_rate numeric;amount numeric;paid numeric:=0;
 payer_before numeric;payer_after numeric;player_before numeric;player_after numeric;
 payout_id uuid;wallet_id uuid;ledger_id uuid;receipt_count int;payees int:=0;
 club_skip text;member_skip text;maintenance text;routing_context text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_rakeback_invalid_period' USING ERRCODE='22023'; END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_rakeback_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 from_date:=(p_period_start AT TIME ZONE 'America/Los_Angeles')::date;
 to_date:=(p_period_end AT TIME ZONE 'America/Los_Angeles')::date-1;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_rakeback_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_items(period_id uuid PRIMARY KEY,certificate_id bigint,club_id uuid,user_id uuid,
  payer_kind text,payer_user uuid,owed numeric,rake numeric,rate numeric,fingerprint text,status text) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_items;
 FOR r IN SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id=ANY(scope.club_ids)
    OR EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end))
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE
 LOOP
  SELECT * INTO c FROM public.accounting_rakeback_period_calculations WHERE period_id=r.id ORDER BY id DESC LIMIT 1;
  IF NOT FOUND OR c.accounting_version<>2 OR c.coordinator_union_id IS DISTINCT FROM p_union_id OR r.period_start<>from_date OR r.period_end<>to_date
   OR c.club_id IS DISTINCT FROM r.club_id OR c.player_id IS DISTINCT FROM r.user_id
   OR c.period_start IS DISTINCT FROM r.period_start OR c.period_end IS DISTINCT FROM r.period_end
   OR c.rake_generated IS DISTINCT FROM r.rake_generated OR c.rake_generated IS DISTINCT FROM r.total_rake_paid
   OR c.rakeback_amount IS DISTINCT FROM r.rakeback_amount OR c.rakeback_amount IS DISTINCT FROM r.rakeback_earned
   OR c.display_rate IS DISTINCT FROM r.rakeback_rate OR c.rakeback_amount<0 OR c.rakeback_amount<>round(c.rakeback_amount,2)
   OR c.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR c.payer_kind NOT IN('agent','club')
   OR (c.payer_kind='agent') IS DISTINCT FROM(c.payer_user_id IS NOT NULL) OR c.payer_user_id=r.user_id
  THEN RAISE EXCEPTION 'routed_rakeback_certificate_required' USING ERRCODE='55000'; END IF;
  SELECT count(*),count(DISTINCT a->>'source_id'),sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric)
   INTO allocation_count,matched_count,generated,unrounded FROM jsonb_array_elements(c.source_allocations) a;
  SELECT count(*) INTO actual_count FROM public.accounting_cash_rake_sources rs WHERE rs.club_id=r.club_id AND rs.player_id=r.user_id
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
  IF allocation_count=0 OR allocation_count<>matched_count OR allocation_count<>actual_count OR generated IS DISTINCT FROM c.rake_generated
    OR round(unrounded,2) IS DISTINCT FROM c.rakeback_amount
    OR c.display_rate IS DISTINCT FROM (CASE WHEN generated>0 THEN round(unrounded/generated,4) ELSE 0 END)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_allocations) a LEFT JOIN public.accounting_cash_rake_sources rs ON rs.id=(a->>'source_id')::uuid
     WHERE rs.id IS NULL OR rs.club_id<>r.club_id OR rs.player_id<>r.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR a->>'payer_kind' IS DISTINCT FROM c.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM c.payer_user_id
      OR NULLIF(rs.contract->'membership'->'terms'->>'agent_id','')::uuid IS DISTINCT FROM c.payer_user_id)
  THEN RAISE EXCEPTION 'routed_rakeback_sources_disagree_with_certificate' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_player_items VALUES(r.id,c.id,r.club_id,r.user_id,c.payer_kind,c.payer_user_id,c.rakeback_amount,c.rake_generated,c.display_rate,c.source_fingerprint,r.status);
 END LOOP;
 -- Missing periods are obligations too: every source player in this scope must
 -- have an admitted certificate, including zero-entitlement players.
 IF EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources rs WHERE (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club))
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
   AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
 THEN RAISE EXCEPTION 'routed_rakeback_player_period_missing' USING ERRCODE='55000'; END IF;
 SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(i.period_id,i.certificate_id,i.club_id,i.user_id,i.payer_kind,i.payer_user,i.owed,i.rake,i.rate,i.fingerprint) ORDER BY i.period_id),'[]'::jsonb)::text)
  INTO fingerprint FROM pg_temp._routed_player_items i;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint OR EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status<>'paid' OR NOT EXISTS(
   SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.user_id=i.user_id AND pp.club_id=i.club_id AND pp.status='paid' AND pp.payout_amount=i.owed))
  THEN RAISE EXCEPTION 'routed_rakeback_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status IS DISTINCT FROM 'pending'
   OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds sr WHERE sr.union_id=p_union_id AND sr.round_no=3
   AND sr.period_start<p_period_end AND sr.period_end>p_period_start AND (sr.amount>0 OR sr.payees>0 OR sr.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_rakeback_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_wallets(club_id uuid,user_id uuid,opening numeric,delta numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_wallets;
 INSERT INTO pg_temp._routed_player_wallets(club_id,user_id,delta)
 SELECT club_id,user_id,sum(delta) FROM(
  SELECT club_id,user_id,owed AS delta FROM pg_temp._routed_player_items
  UNION ALL SELECT club_id,payer_user,-owed FROM pg_temp._routed_player_items WHERE payer_kind='agent') x GROUP BY club_id,user_id;
 PERFORM id FROM public.clubs WHERE id IN(SELECT club_id FROM pg_temp._routed_player_items) ORDER BY id FOR UPDATE;
 PERFORM cm.id FROM public.club_members cm JOIN pg_temp._routed_player_wallets w ON w.club_id=cm.club_id AND w.user_id=cm.user_id
  ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;
 UPDATE pg_temp._routed_player_wallets w SET opening=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=w.club_id AND cm.user_id=w.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets WHERE opening IS NULL OR opening<0 OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_account_missing_or_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,payer_user,sum(owed) owed FROM pg_temp._routed_player_items WHERE payer_kind='agent' GROUP BY club_id,payer_user) x
  JOIN pg_temp._routed_player_wallets w ON w.club_id=x.club_id AND w.user_id=x.payer_user WHERE w.opening<x.owed)
 THEN RAISE EXCEPTION 'routed_rakeback_agent_funding_shortfall' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(owed) owed FROM pg_temp._routed_player_items WHERE payer_kind='club' GROUP BY club_id) x
  LEFT JOIN public.clubs bank ON bank.id=x.club_id WHERE bank.chip_treasury IS NULL OR bank.chip_treasury<x.owed
   OR bank.chip_treasury<>round(bank.chip_treasury,2) OR bank.chip_treasury::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 maintenance:=current_setting('app.ledger_maintenance',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 FOR r IN SELECT * FROM pg_temp._routed_player_items ORDER BY club_id,payer_user NULLS FIRST,user_id,period_id LOOP
  amount:=r.owed;
  INSERT INTO public.rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
   VALUES(r.period_id,r.club_id,r.user_id,r.rake,round(r.rate*100,2),amount,'paid',now()) RETURNING id INTO payout_id;
  IF amount>0 THEN
   SELECT chip_balance INTO player_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.user_id;
   IF r.payer_kind='club' THEN
    SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=r.club_id;
    UPDATE public.clubs SET chip_treasury=chip_treasury-amount WHERE id=r.club_id AND chip_treasury>=amount RETURNING chip_treasury INTO payer_after;
   ELSE
    SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.payer_user;
    UPDATE public.club_members SET chip_balance=chip_balance-amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.payer_user AND chip_balance>=amount RETURNING chip_balance INTO payer_after;
   END IF;
   UPDATE public.club_members SET chip_balance=chip_balance+amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING chip_balance INTO player_after;
   IF payer_after IS NULL OR player_after IS NULL OR payer_before-payer_after<>amount OR player_after-player_before<>amount
   THEN RAISE EXCEPTION 'routed_rakeback_transfer_not_conserved' USING ERRCODE='23514'; END IF;
   IF r.payer_kind='agent' THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.payer_user,'PLAYER','debit',amount,'rakeback','Weekly rakeback paid under recorded agreement',payer_after,payout_id); END IF;
   INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.user_id,'PLAYER','credit',amount,'rakeback','Weekly rakeback received under recorded agreement',player_after,payout_id) RETURNING id INTO wallet_id;
   PERFORM set_config('app.ledger_maintenance','rakeback payout evidence pointer',true);
   UPDATE public.rakeback_period_payouts SET wallet_transaction_id=wallet_id WHERE id=payout_id;
   PERFORM set_config('app.ledger_maintenance',COALESCE(maintenance,''),true);
   INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
    VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN r.payer_kind='club' THEN 'club_treasury' ELSE 'player_wallet' END,
     COALESCE(r.payer_user,r.club_id),'player_wallet',r.user_id,amount,'rakeback',r.club_id,p_union_id,'Weekly rakeback from certified historical payer',
     'round3-period:v3:'||r.period_id::text,jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_id',r.period_id,'period_start',p_period_start,'period_end',p_period_end,
       'certificate_id',r.certificate_id,'source_fingerprint',r.fingerprint,'payout_id',payout_id,'wallet_transaction_id',wallet_id,'payee_role_at_transfer','player'),
      payer_before,payer_after,player_before,player_after) RETURNING id INTO ledger_id;
   SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
    AND i.chips_transferred AND i.message_sent AND i.net_amount=amount AND i.gross_amount=amount AND i.deductions=0;
   IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_rakeback_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
   paid:=paid+amount;payees:=payees+1;
  END IF;
  UPDATE public.rakeback_periods SET status='paid',paid_at=now() WHERE id=r.period_id;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets w JOIN public.club_members cm ON cm.club_id=w.club_id AND cm.user_id=w.user_id
   WHERE cm.chip_balance IS DISTINCT FROM w.opening+w.delta)
 THEN RAISE EXCEPTION 'routed_rakeback_final_balance_incorrect' USING ERRCODE='23514'; END IF;
 result:=jsonb_build_object('success',true,'round',3,'name','certified_payer_to_players','routing_version',3,'source_version',2,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'amount',paid,'payees',payees,'shortfalls',0,'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
  VALUES(p_union_id,standalone_club,p_period_start,p_period_end,3,fingerprint,result);
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_round3_agents_to_players(p_union_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $function$
 SELECT public.fn_settle_accounting_rakeback_stage('union',p_union_id,p_period_start,p_period_end);
$function$;
REVOKE ALL ON FUNCTION public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- Component 20260914135530_tournament_fees_share_one_recorded_earning_authority.sql
-- CANDIDATE ONLY: one charge/recognition authority for all chip tournament fees.
-- Requires shared cash contract/posting components and durable period queue.
-- Roll out the server v2 completion receipt parser BEFORE activating this SQL.
-- Commission formula is inherited unchanged; no historical rates are invented.
-- Full production-schema lifecycle replay and payout-model signoff remain gates.
DO $tournament_preimages$ BEGIN
 IF to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)'))) IS DISTINCT FROM '6dac23baee41ff69ee0e1243f0a26c8e' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.atomic_cancel_tournament(uuid,uuid)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_attribute_tournament_rake(uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_attribute_tournament_rake(uuid)'))) IS DISTINCT FROM 'c4bfeb1900bd57a4d0c1d4543f651431' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_attribute_tournament_rake(uuid)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_backpay_tournament_rake_attribution(integer)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_backpay_tournament_rake_attribution(integer)'))) IS DISTINCT FROM '93211a9b37aeb8e4af8d308c6248163c' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_backpay_tournament_rake_attribution(integer)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_ca_satellite_settlement_receipt(uuid,uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_ca_satellite_settlement_receipt(uuid,uuid)'))) IS DISTINCT FROM '706ce8ee53b87a2a5547443b460ceb93' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_ca_satellite_settlement_receipt(uuid,uuid)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_ca_tournament_terminal_receipt(uuid,uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_ca_tournament_terminal_receipt(uuid,uuid)'))) IS DISTINCT FROM '317b582f72d120c745a5b7073d9b559a' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_ca_tournament_terminal_receipt(uuid,uuid)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'))) IS DISTINCT FROM '062c9a1314f33a5c8af4fdf5e00a046d' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_repair_tournament_rake_attribution(integer)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_repair_tournament_rake_attribution(integer)'))) IS DISTINCT FROM '1d2d9c8212bca8d0e9ab0984c425e815' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_repair_tournament_rake_attribution(integer)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'))) IS DISTINCT FROM 'b36386009f2b3f568fc648efbccaf7b4' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_settle_tournament_rake(uuid,text)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_settle_tournament_rake(uuid,text)'))) IS DISTINCT FROM '7cf1d81246d015b65d416ee6b3f96838' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_settle_tournament_rake(uuid,text)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_tournament_finish_readiness(uuid,uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_tournament_finish_readiness(uuid,uuid)'))) IS DISTINCT FROM '6361f556eac2ff2940e3f49f485176d0' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_tournament_finish_readiness(uuid,uuid)' USING ERRCODE='55000'; END IF;
 IF to_regprocedure('public.fn_tournament_rake_settlement_check(integer,integer)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fn_tournament_rake_settlement_check(integer,integer)'))) IS DISTINCT FROM '65dc8a03543053bec16f78b78c513b9b' THEN
  RAISE EXCEPTION 'tournament_source_preimage_changed: %', 'public.fn_tournament_rake_settlement_check(integer,integer)' USING ERRCODE='55000'; END IF;
END $tournament_preimages$;

DO $tournament_dependencies$ BEGIN
 IF to_regprocedure('public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)') IS NULL
  OR to_regprocedure('public.fn_post_accounting_commission_source(uuid,text,timestamp with time zone,jsonb)') IS NULL
  OR to_regclass('public.accounting_period_recompute_requests') IS NULL
  OR to_regclass('public.accounting_routed_settlement_runs') IS NULL THEN
  RAISE EXCEPTION 'canonical_accounting_dependencies_missing' USING ERRCODE='55000'; END IF;
END $tournament_dependencies$;

-- BEGIN tournament-fee-receipts-draft.sql
-- DRAFT ONLY. Not a deployable migration: producer stamps, terminal adapter,
-- shared commission INSERT guard, R1/R3 and source quality gates must land together.
-- This is a source receipt capture authority, not a second settlement scheduler.
CREATE TABLE public.accounting_tournament_fee_cutover (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), starts_at timestamptz NOT NULL
);
INSERT INTO public.accounting_tournament_fee_cutover VALUES(true,transaction_timestamp());
CREATE TABLE public.accounting_tournament_fee_batches (
 rake_record_id uuid PRIMARY KEY REFERENCES public.rake_records(id),
 tournament_id uuid NOT NULL, source_fingerprint text NOT NULL,
 status text NOT NULL DEFAULT 'captured' CHECK(status IN('captured','legacy_unverified')),
 source_version integer NOT NULL DEFAULT 2 CHECK(source_version=2), source_manifest jsonb,
 CHECK(status='legacy_unverified' OR jsonb_typeof(source_manifest)='object'),
 rake_amount numeric NOT NULL CHECK(rake_amount>0 AND rake_amount=round(rake_amount,2)
   AND rake_amount::text NOT IN('NaN','Infinity','-Infinity')),
 captured_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE TABLE public.accounting_tournament_fee_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 rake_record_id uuid NOT NULL REFERENCES public.accounting_tournament_fee_batches(rake_record_id),
 tournament_id uuid NOT NULL, player_id uuid NOT NULL, club_id uuid NOT NULL,
 union_id uuid, coordinator_union_id uuid, game_type text NOT NULL,
 registration_id uuid NOT NULL, source_charge_ledger_id uuid NOT NULL,
 source_entitlement_id uuid NOT NULL, charged_at timestamptz NOT NULL,
 rake_credit numeric NOT NULL CHECK(rake_credit>=0 AND rake_credit=round(rake_credit,2)
   AND rake_credit::text NOT IN('NaN','Infinity','-Infinity')),
 contract jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(rake_record_id,player_id), UNIQUE(source_entitlement_id)
);
CREATE INDEX accounting_tournament_fee_sources_event ON public.accounting_tournament_fee_sources(tournament_id,rake_record_id);
ALTER TABLE public.accounting_tournament_fee_cutover ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_fee_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_fee_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_tournament_fee_cutover,public.accounting_tournament_fee_batches,
 public.accounting_tournament_fee_sources FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_tournament_fee_cutover,public.accounting_tournament_fee_batches,
 public.accounting_tournament_fee_sources TO service_role;

CREATE FUNCTION public.fn_accounting_tournament_fee_fingerprint(p_row public.rake_records)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 -- Versioned economic fields are stable across unrelated schema additions.
 -- Tuple terminal markers are not economic source edits.
 SELECT md5(jsonb_object_agg(field,to_jsonb(p_row)->field ORDER BY field)::text)
 FROM unnest(ARRAY['id','hand_id','table_id','club_id','rake_amount','bbj_contribution','pot_size','num_players',
  'created_at','player_contributions','global_hand_id','is_tournament','tournament_id','source','metadata',
  'rake_method','returned_uncalled']::text[])field
$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_fingerprint(public.rake_records)
 FROM PUBLIC,anon,authenticated,service_role;

-- Called by the original producer AFTER its charge/roster/entitlement receipts
-- exist, in the SAME transaction. A deferred constraint trigger must additionally
-- require a captured batch for every new supported positive chip fee at COMMIT.
-- Required producer metadata.accounting_fee_source is versioned, exact-ID linkage;
-- it is never inferred from today's membership or the remaining tournament field.
CREATE FUNCTION public.fn_capture_accounting_tournament_fee(p_rake_record_id uuid,p_manifest jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE
 r public.rake_records%ROWTYPE; t record; previous record; cutoff timestamptz;
 manifest jsonb; item jsonb; contributors jsonb:='[]'; contract jsonb;
 e record; l record; tp record; source_type text; expected_kind text;
 player uuid; club uuid; registration uuid; ledger_id uuid; entitlement_id uuid;
 actual_union uuid; charged_at timestamptz; weight numeric; total_weight numeric:=0;
 total_cents bigint; floor_total bigint; remainder_cents bigint; credit numeric;
 allocated numeric:=0; seen_players uuid[]:='{}'; seen_entitlements uuid[]:='{}';
 fingerprint text; result_ids uuid[]:='{}'; new_id uuid; n integer; row_plan record;
BEGIN
 -- Private EXECUTE grants are the boundary: this owner-only helper also runs
 -- inside a legitimate authenticated human's original charge transaction.
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR SHARE;
 IF NOT FOUND OR r.is_tournament IS DISTINCT FROM true OR r.tournament_id IS NULL
  OR r.hand_id IS NOT NULL OR r.rake_amount IS NULL OR r.rake_amount<=0
  OR r.rake_amount<>round(r.rake_amount,2) OR r.rake_amount::text IN('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'positive_chip_tournament_fee_required' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_tournament_fee:'||r.id::text,0));
 fingerprint:=public.fn_accounting_tournament_fee_fingerprint(r);
 SELECT * INTO previous FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id;
 IF FOUND THEN
  IF previous.source_fingerprint IS DISTINCT FROM fingerprint THEN
   RAISE EXCEPTION 'captured_tournament_fee_source_changed' USING ERRCODE='23514';
  END IF;
  SELECT array_agg(id ORDER BY player_id),count(*),sum(rake_credit)
   INTO result_ids,n,allocated FROM public.accounting_tournament_fee_sources WHERE rake_record_id=r.id;
  IF n=0 OR allocated IS DISTINCT FROM previous.rake_amount THEN
   RAISE EXCEPTION 'captured_tournament_fee_incomplete' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('accounting_version',2,'status','captured','rake_record_id',r.id,
   'tournament_id',r.tournament_id,'source_ids',result_ids,'rake_credit',allocated,'replayed',true,'payable',false);
 END IF;
 SELECT starts_at INTO cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;
 IF cutoff IS NULL OR r.created_at<cutoff OR r.created_at IS DISTINCT FROM transaction_timestamp() THEN
  RAISE EXCEPTION 'tournament_fee_not_captured_by_original_producer' USING ERRCODE='55000';
 END IF;
 SELECT id,club_id,union_id,is_private,tournament_type INTO t FROM public.tournaments WHERE id=r.tournament_id FOR SHARE;
 IF NOT FOUND OR public.fn_poker_diamond_tournament(r.tournament_id) THEN
  RAISE EXCEPTION 'chip_tournament_fee_required' USING ERRCODE='23514';
 END IF;
 actual_union:=CASE WHEN t.is_private THEN NULL ELSE t.union_id END;
 manifest:=COALESCE(p_manifest,r.metadata->'accounting_fee_source');
 IF (p_manifest IS NULL AND r.metadata->>'accounting_source_version' IS DISTINCT FROM '2')
  OR jsonb_typeof(manifest) IS DISTINCT FROM 'object'
  OR NOT(manifest ? 'union_id')
  OR NULLIF(manifest->>'union_id','')::uuid IS DISTINCT FROM actual_union
  OR manifest->>'game_type' IS DISTINCT FROM lower(t.tournament_type)
  OR jsonb_typeof(manifest->'contributors') IS DISTINCT FROM 'array'
  OR jsonb_array_length(manifest->'contributors')=0
 THEN RAISE EXCEPTION 'tournament_fee_producer_manifest_required' USING ERRCODE='23514'; END IF;
 expected_kind:=CASE r.source
  WHEN 'fn_register_for_tournament' THEN 'tournament_entry_fee'
  WHEN 'fn_register_horse_for_tournament' THEN 'tournament_entry_fee'
  WHEN 'fn_award_satellite_seat' THEN 'satellite_seat_entry_fee'
  WHEN 'fn_register_for_tournament_with_ticket' THEN 'tournament_ticket_entry_fee'
  WHEN 'fn_spin_book_entry' THEN 'spin_rake'
  WHEN 'process_tournament_rebuy' THEN r.metadata->>'kind' END;
 IF expected_kind IS NULL OR r.metadata->>'kind' IS DISTINCT FROM expected_kind
  OR (r.source='process_tournament_rebuy' AND expected_kind NOT IN('tournament_rebuy_fee','tournament_reentry_fee'))
 THEN RAISE EXCEPTION 'tournament_fee_source_unsupported' USING ERRCODE='55000'; END IF;
 n:=jsonb_array_length(manifest->'contributors');
 IF (r.source='fn_spin_book_entry' AND n<>3) OR (r.source<>'fn_spin_book_entry' AND n<>1) THEN
  RAISE EXCEPTION 'tournament_fee_contributor_count_invalid' USING ERRCODE='23514';
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(manifest->'contributors') LOOP
  player:=(item->>'player_id')::uuid;club:=(item->>'club_id')::uuid;
  registration:=(item->>'registration_id')::uuid;ledger_id:=(item->>'charge_ledger_id')::uuid;
  entitlement_id:=(item->>'entitlement_id')::uuid;charged_at:=(item->>'charged_at')::timestamptz;
  weight:=(item->>'weight')::numeric;
  IF player IS NULL OR club IS NULL OR registration IS NULL OR ledger_id IS NULL OR entitlement_id IS NULL
   OR charged_at IS NULL OR NOT isfinite(charged_at) OR charged_at<cutoff OR charged_at>r.created_at
   OR weight IS NULL OR weight<=0 OR weight<>round(weight,2) OR weight::text IN('NaN','Infinity','-Infinity')
   OR player=ANY(seen_players) OR entitlement_id=ANY(seen_entitlements)
  THEN RAISE EXCEPTION 'tournament_fee_contributor_invalid' USING ERRCODE='23514'; END IF;
  seen_players:=array_append(seen_players,player);seen_entitlements:=array_append(seen_entitlements,entitlement_id);
  SELECT * INTO e FROM public.tournament_refund_entitlements WHERE id=entitlement_id;
  SELECT * INTO l FROM public.chip_ledger WHERE id=ledger_id;
  SELECT * INTO tp FROM public.tournament_players WHERE id=registration;
  IF e.id IS NULL OR l.id IS NULL OR tp.id IS NULL OR e.tournament_id IS DISTINCT FROM r.tournament_id
   OR e.user_id IS DISTINCT FROM player OR e.refund_wallet_club_id IS DISTINCT FROM club
   OR e.source_ledger_id IS DISTINCT FROM ledger_id OR e.created_at IS DISTINCT FROM charged_at
   OR tp.tournament_id IS DISTINCT FROM r.tournament_id OR tp.user_id IS DISTINCT FROM player OR tp.club_id IS DISTINCT FROM club
   OR l.created_at IS DISTINCT FROM charged_at OR l.amount IS DISTINCT FROM e.gross
  THEN RAISE EXCEPTION 'tournament_fee_charge_evidence_mismatch' USING ERRCODE='23514'; END IF;
  IF r.source='fn_spin_book_entry' THEN
   -- A Spin has one aggregate fee, three exact paid entries, and one immutable
   -- reserve contribution. Weights are paid entry amounts, never mutable rebuys.
   IF e.entitlement_kind IS DISTINCT FROM 'wallet_charge' OR e.charge_category IS DISTINCT FROM 'tournament_buyin'
    OR e.gross IS DISTINCT FROM weight OR l.from_type IS DISTINCT FROM 'player_wallet'
    OR l.from_entity_id IS DISTINCT FROM player OR l.to_type IS DISTINCT FROM 'prize_liability'
    OR l.to_entity_id IS DISTINCT FROM r.tournament_id OR l.club_id IS DISTINCT FROM club
    OR l.category IS DISTINCT FROM 'tournament_buyin'
    OR (r.player_contributions->>player::text)::numeric IS DISTINCT FROM weight
   THEN RAISE EXCEPTION 'spin_fee_charge_evidence_mismatch' USING ERRCODE='23514'; END IF;
  ELSE
   IF e.refund_fee IS DISTINCT FROM r.rake_amount OR weight IS DISTINCT FROM r.rake_amount
    OR r.metadata->>'user_id' IS DISTINCT FROM player::text
   THEN RAISE EXCEPTION 'tournament_fee_amount_evidence_mismatch' USING ERRCODE='23514'; END IF;
   IF r.source IN('fn_register_for_tournament','fn_register_horse_for_tournament','process_tournament_rebuy') THEN
    source_type:=CASE WHEN r.source='process_tournament_rebuy' THEN 'rebuy' ELSE 'tournament_buyin' END;
    IF e.entitlement_kind IS DISTINCT FROM 'wallet_charge' OR e.charge_category IS DISTINCT FROM source_type
     OR l.from_type IS DISTINCT FROM 'player_wallet' OR l.from_entity_id IS DISTINCT FROM player
     OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
     OR l.club_id IS DISTINCT FROM club OR l.category IS DISTINCT FROM source_type
     OR (r.source<>'process_tournament_rebuy' AND r.metadata->>'registration_id' IS DISTINCT FROM registration::text)
    THEN RAISE EXCEPTION 'tournament_fee_wallet_evidence_mismatch' USING ERRCODE='23514'; END IF;
   ELSIF r.source='fn_register_for_tournament_with_ticket' THEN
    IF e.entitlement_kind IS DISTINCT FROM 'tournament_ticket' OR e.registration_id IS DISTINCT FROM registration
     OR e.source_ticket_id IS NULL OR r.metadata->>'ticket_id' IS DISTINCT FROM e.source_ticket_id::text
     OR r.metadata->>'registration_id' IS DISTINCT FROM registration::text
     OR l.from_type IS DISTINCT FROM 'escrow' OR l.from_entity_id IS DISTINCT FROM e.source_ticket_id
     OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
     OR l.category IS DISTINCT FROM 'ticket_redeem'
    THEN RAISE EXCEPTION 'tournament_fee_ticket_evidence_mismatch' USING ERRCODE='23514'; END IF;
   ELSE
    IF e.entitlement_kind IS DISTINCT FROM 'satellite_seat' OR e.registration_id IS DISTINCT FROM registration
     OR e.source_satellite_id IS NULL OR r.metadata->>'satellite_id' IS DISTINCT FROM e.source_satellite_id::text
     OR r.metadata->>'registration_id' IS DISTINCT FROM registration::text
     OR l.from_type IS DISTINCT FROM 'prize_liability' OR l.from_entity_id IS DISTINCT FROM e.source_satellite_id
     OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
     OR l.category IS DISTINCT FROM 'tournament_buyin'
    THEN RAISE EXCEPTION 'tournament_fee_satellite_evidence_mismatch' USING ERRCODE='23514'; END IF;
   END IF;
  END IF;
  contributors:=contributors||jsonb_build_array(item);total_weight:=total_weight+weight;
 END LOOP;
 IF r.source='fn_spin_book_entry' THEN
  IF jsonb_typeof(r.player_contributions) IS DISTINCT FROM 'object'
   OR (SELECT count(*) FROM jsonb_object_keys(r.player_contributions))<>3
   OR (SELECT count(DISTINCT (x->>'weight')::numeric) FROM jsonb_array_elements(contributors)x)<>1
   OR NOT EXISTS(SELECT 1 FROM public.spin_reserve_ledger s
      WHERE s.id=(manifest->>'spin_reserve_id')::uuid AND s.tournament_id=r.tournament_id
       AND s.kind='contribution' AND s.seats=3 AND s.house_rake=r.rake_amount
       AND s.amount=total_weight-r.rake_amount AND s.buy_in=total_weight/3)
  THEN RAISE EXCEPTION 'spin_fee_reserve_evidence_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 total_cents:=(r.rake_amount*100)::bigint;
 SELECT sum(floor(total_cents*(x->>'weight')::numeric/total_weight)) INTO floor_total FROM jsonb_array_elements(contributors)x;
 remainder_cents:=total_cents-floor_total;
 INSERT INTO public.accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,rake_amount,source_manifest)
  VALUES(r.id,r.tournament_id,fingerprint,r.rake_amount,manifest);
 -- Largest remainder; UUID order breaks exact fractional ties reproducibly.
 FOR row_plan IN
  SELECT x, floor(total_cents*(x->>'weight')::numeric/total_weight)
    +CASE WHEN row_number() OVER(ORDER BY total_cents*(x->>'weight')::numeric/total_weight
       -floor(total_cents*(x->>'weight')::numeric/total_weight) DESC,x->>'player_id')<=remainder_cents THEN 1 ELSE 0 END cents
   FROM jsonb_array_elements(contributors)x ORDER BY x->>'player_id'
 LOOP
  item:=row_plan.x;credit:=row_plan.cents/100.0;
  contract:=public.fn_accounting_earning_contract((item->>'club_id')::uuid,(item->>'player_id')::uuid,
    credit,actual_union,(item->>'charged_at')::timestamptz);
  IF contract->>'player_id' IS DISTINCT FROM item->>'player_id' OR contract->>'club_id' IS DISTINCT FROM item->>'club_id'
   OR (contract->>'rake_credit')::numeric IS DISTINCT FROM credit
   OR NULLIF(contract->>'union_id','')::uuid IS DISTINCT FROM actual_union
   OR (contract->>'terms_at')::timestamptz IS DISTINCT FROM (item->>'charged_at')::timestamptz
  THEN RAISE EXCEPTION 'tournament_fee_contract_scope_mismatch' USING ERRCODE='23514'; END IF;
  INSERT INTO public.accounting_tournament_fee_sources(rake_record_id,tournament_id,player_id,club_id,union_id,
   coordinator_union_id,game_type,registration_id,source_charge_ledger_id,source_entitlement_id,charged_at,rake_credit,contract)
  VALUES(r.id,r.tournament_id,(item->>'player_id')::uuid,(item->>'club_id')::uuid,actual_union,
   NULLIF(contract->>'coordinator_union_id','')::uuid,manifest->>'game_type',(item->>'registration_id')::uuid,
   (item->>'charge_ledger_id')::uuid,(item->>'entitlement_id')::uuid,(item->>'charged_at')::timestamptz,credit,contract)
  RETURNING id INTO new_id;
  result_ids:=array_append(result_ids,new_id);allocated:=allocated+credit;
 END LOOP;
 IF allocated IS DISTINCT FROM r.rake_amount THEN RAISE EXCEPTION 'tournament_fee_credit_not_conserved' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('accounting_version',2,'status','captured','rake_record_id',r.id,
  'tournament_id',r.tournament_id,'source_ids',result_ids,'rake_credit',allocated,'replayed',false,'payable',false);
END $function$;
REVOKE ALL ON FUNCTION public.fn_capture_accounting_tournament_fee(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Receipt immutability/COMMIT coverage are deliberately specified in the handoff
-- pending integration with existing cancelled/terminal evidence guards. No test
-- of this draft is a claim that an uncaptured live producer is now safe.

-- END tournament-fee-receipts-draft.sql

-- BEGIN tournament-fee-producer-adapter-draft.sql
-- DRAFT. Installs one common source capture hook for every chip fee producer.
-- The hook runs after original atomic receipts exist. No membership is guessed:
-- the immutable funding entitlement names the club, user, charge and timestamp.
CREATE FUNCTION public.fn_stamp_accounting_tournament_fee(p_rake_record_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE r public.rake_records%ROWTYPE;t record;e record;tp record;item record;reserve_id uuid;
 manifest jsonb;contributors jsonb:='[]';game_union uuid;expected_entitlement text;
 expected_category text;uid uuid;reg uuid;count_rows int;cutoff timestamptz;legacy boolean:=false;
BEGIN
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR UPDATE;
 IF NOT FOUND OR NOT r.is_tournament OR r.rake_amount<=0 THEN
  RAISE EXCEPTION 'positive_chip_tournament_fee_required' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id) THEN
  IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id AND status='legacy_unverified') THEN
   RETURN jsonb_build_object('accounting_version',2,'status','legacy_unverified','rake_record_id',r.id,'payable',false);
  END IF;
  RETURN public.fn_capture_accounting_tournament_fee(r.id);
 END IF;
 SELECT starts_at INTO cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;
 IF r.created_at IS DISTINCT FROM transaction_timestamp() OR cutoff IS NULL OR r.created_at<cutoff THEN
  RAISE EXCEPTION 'tournament_fee_not_captured_by_original_producer' USING ERRCODE='55000'; END IF;
 SELECT id,club_id,union_id,is_private,tournament_type INTO t FROM public.tournaments WHERE id=r.tournament_id FOR SHARE;
 IF NOT FOUND OR public.fn_poker_diamond_tournament(r.tournament_id) THEN
  RAISE EXCEPTION 'chip_tournament_fee_required' USING ERRCODE='23514'; END IF;
 game_union:=CASE WHEN t.is_private THEN NULL ELSE t.union_id END;
 IF r.source='fn_spin_book_entry' THEN
  IF jsonb_typeof(r.player_contributions) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(r.player_contributions))<>3 THEN
   RAISE EXCEPTION 'spin_fee_exact_paid_contributors_required' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT key::uuid player_id,value::numeric weight FROM jsonb_each_text(r.player_contributions) ORDER BY key LOOP
   SELECT * INTO tp FROM public.tournament_players WHERE tournament_id=r.tournament_id AND user_id=item.player_id;
   IF NOT FOUND OR tp.club_id IS NULL THEN RAISE EXCEPTION 'spin_fee_entry_club_missing' USING ERRCODE='23514'; END IF;
   SELECT count(*) INTO count_rows FROM public.tournament_refund_entitlements x
    WHERE x.tournament_id=r.tournament_id AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge'
     AND x.charge_category='tournament_buyin' AND x.created_at=tp.registered_at AND x.gross=item.weight;
   IF count_rows<>1 THEN RAISE EXCEPTION 'spin_fee_exact_charge_ambiguous' USING ERRCODE='23514'; END IF;
   SELECT * INTO e FROM public.tournament_refund_entitlements x
    WHERE x.tournament_id=r.tournament_id AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge'
     AND x.charge_category='tournament_buyin' AND x.created_at=tp.registered_at AND x.gross=item.weight;
   contributors:=contributors||jsonb_build_array(jsonb_build_object('player_id',e.user_id,'club_id',e.refund_wallet_club_id,
    'registration_id',tp.id,'charge_ledger_id',e.source_ledger_id,'entitlement_id',e.id,'charged_at',e.created_at,'weight',item.weight));
   legacy:=legacy OR e.created_at<cutoff;
  END LOOP;
  SELECT count(*) INTO count_rows FROM public.spin_reserve_ledger s WHERE s.tournament_id=r.tournament_id AND s.kind='contribution';
  IF count_rows<>1 THEN RAISE EXCEPTION 'spin_fee_exact_reserve_required' USING ERRCODE='23514'; END IF;
  SELECT id INTO reserve_id FROM public.spin_reserve_ledger s WHERE s.tournament_id=r.tournament_id AND s.kind='contribution';
 ELSE
  IF NOT COALESCE(r.metadata->>'user_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',false) THEN
   RAISE EXCEPTION 'tournament_fee_exact_player_required' USING ERRCODE='23514'; END IF;
  uid:=(r.metadata->>'user_id')::uuid;
  expected_entitlement:=CASE r.source WHEN 'fn_register_for_tournament' THEN 'wallet_charge'
   WHEN 'fn_register_horse_for_tournament' THEN 'wallet_charge' WHEN 'process_tournament_rebuy' THEN 'wallet_charge'
   WHEN 'fn_award_satellite_seat' THEN 'satellite_seat' WHEN 'fn_register_for_tournament_with_ticket' THEN 'tournament_ticket' END;
  expected_category:=CASE WHEN r.source='process_tournament_rebuy' THEN 'rebuy' ELSE 'tournament_buyin' END;
  IF expected_entitlement IS NULL THEN RAISE EXCEPTION 'tournament_fee_source_unsupported' USING ERRCODE='55000'; END IF;
  reg:=NULLIF(r.metadata->>'registration_id','')::uuid;
  IF reg IS NULL AND r.source='process_tournament_rebuy' THEN
   SELECT id INTO reg FROM public.tournament_players WHERE tournament_id=r.tournament_id AND user_id=uid;
  END IF;
  IF reg IS NULL THEN RAISE EXCEPTION 'tournament_fee_exact_registration_required' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO count_rows FROM public.tournament_refund_entitlements x
   WHERE x.tournament_id=r.tournament_id AND x.user_id=uid AND x.created_at=r.created_at AND x.refund_fee=r.rake_amount
    AND x.entitlement_kind=expected_entitlement
    AND (CASE WHEN expected_entitlement='wallet_charge' THEN x.charge_category=expected_category ELSE x.registration_id=reg END);
  IF count_rows<>1 THEN RAISE EXCEPTION 'tournament_fee_exact_charge_ambiguous' USING ERRCODE='23514'; END IF;
  SELECT * INTO e FROM public.tournament_refund_entitlements x
   WHERE x.tournament_id=r.tournament_id AND x.user_id=uid AND x.created_at=r.created_at AND x.refund_fee=r.rake_amount
    AND x.entitlement_kind=expected_entitlement
    AND (CASE WHEN expected_entitlement='wallet_charge' THEN x.charge_category=expected_category ELSE x.registration_id=reg END);
  contributors:=jsonb_build_array(jsonb_build_object('player_id',e.user_id,'club_id',e.refund_wallet_club_id,
   'registration_id',reg,'charge_ledger_id',e.source_ledger_id,'entitlement_id',e.id,'charged_at',e.created_at,'weight',r.rake_amount));
 END IF;
 IF legacy THEN
  INSERT INTO public.accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,rake_amount,status)
   VALUES(r.id,r.tournament_id,public.fn_accounting_tournament_fee_fingerprint(r),r.rake_amount,'legacy_unverified');
  RETURN jsonb_build_object('accounting_version',2,'status','legacy_unverified','rake_record_id',r.id,'payable',false);
 END IF;
 manifest:=jsonb_build_object('union_id',game_union,'game_type',lower(t.tournament_type),'contributors',contributors,'spin_reserve_id',reserve_id);
 -- Original tournament evidence may already be sealed by a satellite receipt.
 -- Capture its manifest on the accounting batch; never rewrite that raw row.
 BEGIN
  RETURN public.fn_capture_accounting_tournament_fee(r.id,manifest);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  -- Missing observed agreement may not destroy a proved original fee charge.
  -- This subtransaction rolls back every contributor receipt before recording
  -- the entire batch as unavailable. No partial commission can become payable.
  IF SQLERRM NOT IN('accounting_terms_not_observed','accounting_terms_not_active') THEN RAISE; END IF;
  INSERT INTO public.accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,rake_amount,status,source_manifest)
   VALUES(r.id,r.tournament_id,public.fn_accounting_tournament_fee_fingerprint(r),r.rake_amount,'legacy_unverified',
    manifest||jsonb_build_object('capture_reason',SQLERRM));
  RETURN jsonb_build_object('accounting_version',2,'status','legacy_unverified','rake_record_id',r.id,'payable',false,'reason',SQLERRM);
 END;
END $function$;
REVOKE ALL ON FUNCTION public.fn_stamp_accounting_tournament_fee(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_accounting_tournament_fee_commit_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$BEGIN
 PERFORM public.fn_stamp_accounting_tournament_fee(NEW.id);RETURN NULL;
END$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_commit_capture() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER accounting_tournament_fee_commit_capture AFTER INSERT ON public.rake_records
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.is_tournament IS TRUE AND NEW.rake_amount>0)
 EXECUTE FUNCTION public.fn_accounting_tournament_fee_commit_capture();

CREATE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$BEGIN
 RAISE EXCEPTION 'accounting_tournament_fee_receipt_is_immutable' USING ERRCODE='55000';
END$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_receipt_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER accounting_tournament_fee_sources_immutable BEFORE UPDATE OR DELETE ON public.accounting_tournament_fee_sources FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_batches_immutable BEFORE UPDATE OR DELETE ON public.accounting_tournament_fee_batches FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_cutover_immutable BEFORE UPDATE OR DELETE ON public.accounting_tournament_fee_cutover FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_sources_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_sources FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_batches_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_batches FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_cutover_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_cutover FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();

CREATE FUNCTION public.fn_accounting_tournament_fee_source_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$BEGIN
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=OLD.id)
  AND (TG_OP='DELETE' OR public.fn_accounting_tournament_fee_fingerprint(OLD) IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(NEW)) THEN
  RAISE EXCEPTION 'captured_tournament_fee_source_is_immutable' USING ERRCODE='55000';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_source_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER accounting_tournament_fee_source_immutable BEFORE UPDATE OR DELETE ON public.rake_records
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_source_immutable();

-- END tournament-fee-producer-adapter-draft.sql

-- BEGIN tournament-fee-recognition-draft.sql
-- DRAFT source-net proof. Whole source-fee reversals only: no invented partial
-- allocation or current membership/rate lookup. The known unregister/cancel
-- producers name complete original fee rows. Dependencies are resolved by ID,
-- including cancellation after an earlier unregister and re-entry.
CREATE FUNCTION public.fn_accounting_tournament_fee_net_plan(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE refund_row record;raw_total numeric;positive_total numeric;refunded_total numeric:=0;expected numeric;raw_reference_sum numeric;
 positive_ids uuid[];negative_ids uuid[];processed uuid[]:='{}';refunded uuid[]:='{}';refs uuid[];direct_positive uuid[];
 pending uuid[];new_refunds uuid[];nested uuid[];covered uuid[];ref uuid;covered_ref uuid;
 refund_map jsonb:='{}';progress boolean;actual_union uuid;scope_count int;active_ids uuid[];refunded_ids uuid[];fingerprint text;
BEGIN
 IF p_tournament_id IS NULL THEN RAISE EXCEPTION 'tournament_required' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament
   AND (r.rake_amount IS NULL OR r.rake_amount<>round(r.rake_amount,2) OR r.rake_amount::text IN('NaN','Infinity','-Infinity') OR r.hand_id IS NOT NULL)) THEN
  RAISE EXCEPTION 'tournament_fee_source_invalid' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(array_agg(id ORDER BY id) FILTER(WHERE rake_amount>0),'{}'),
  COALESCE(array_agg(id ORDER BY id) FILTER(WHERE rake_amount<0),'{}'),COALESCE(sum(rake_amount),0),COALESCE(sum(rake_amount) FILTER(WHERE rake_amount>0),0)
 INTO positive_ids,negative_ids,raw_total,positive_total FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 IF raw_total<0 THEN RAISE EXCEPTION 'tournament_fee_net_negative' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
   WHERE r.id=ANY(positive_ids) AND (b.status IS DISTINCT FROM 'captured' OR b.tournament_id IS DISTINCT FROM p_tournament_id
    OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
    OR b.rake_amount IS DISTINCT FROM r.rake_amount
    OR b.rake_amount IS DISTINCT FROM (SELECT sum(s.rake_credit) FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id))) THEN
  RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=p_tournament_id AND NOT(s.rake_record_id=ANY(positive_ids))) THEN
  RAISE EXCEPTION 'tournament_fee_source_scope_changed' USING ERRCODE='23514'; END IF;
 SELECT count(DISTINCT COALESCE(union_id::text,'private')),(array_agg(union_id))[1] INTO scope_count,actual_union
  FROM public.accounting_tournament_fee_sources WHERE tournament_id=p_tournament_id;
 IF scope_count>1 THEN RAISE EXCEPTION 'tournament_fee_game_scope_changed' USING ERRCODE='23514'; END IF;
 pending:=negative_ids;
 WHILE cardinality(pending)>0 LOOP
  progress:=false;
  FOR refund_row IN SELECT * FROM public.rake_records WHERE id=ANY(pending) ORDER BY created_at,id LOOP
   IF refund_row.source NOT IN('fn_unregister_from_tournament','atomic_cancel_tournament') THEN
    RAISE EXCEPTION 'tournament_fee_refund_source_unsupported' USING ERRCODE='55000'; END IF;
   IF refund_row.metadata ? 'original_rake_record_ids' AND jsonb_typeof(refund_row.metadata->'original_rake_record_ids')='array' THEN
    SELECT array_agg(value::uuid ORDER BY value) INTO refs FROM jsonb_array_elements_text(refund_row.metadata->'original_rake_record_ids');
   ELSIF refund_row.metadata ? 'original_rake_record_id' THEN refs:=ARRAY[(refund_row.metadata->>'original_rake_record_id')::uuid];
   ELSE RAISE EXCEPTION 'tournament_fee_refund_source_ids_missing' USING ERRCODE='23514'; END IF;
   IF refs IS NULL OR cardinality(refs)=0 OR cardinality(refs)<>(SELECT count(DISTINCT x) FROM unnest(refs)x)
    OR refund_row.id=ANY(refs) OR EXISTS(SELECT 1 FROM unnest(refs)x WHERE NOT(x=ANY(positive_ids||negative_ids))) THEN
    RAISE EXCEPTION 'tournament_fee_refund_source_ids_invalid' USING ERRCODE='23514'; END IF;
   SELECT COALESCE(array_agg(id) FILTER(WHERE rake_amount>0),'{}'),COALESCE(array_agg(id) FILTER(WHERE rake_amount<0),'{}'),sum(rake_amount)
    INTO direct_positive,nested,raw_reference_sum FROM public.rake_records WHERE id=ANY(refs);
   IF NOT(nested<@processed) THEN CONTINUE; END IF;
   covered:='{}';
   FOREACH ref IN ARRAY nested LOOP
    FOR covered_ref IN SELECT value::uuid FROM jsonb_array_elements_text(refund_map->ref::text) LOOP
     covered:=array_append(covered,covered_ref);
    END LOOP;
   END LOOP;
   IF NOT(covered<@direct_positive) THEN RAISE EXCEPTION 'tournament_fee_refund_dependency_incomplete' USING ERRCODE='23514'; END IF;
   IF EXISTS(SELECT 1 FROM unnest(direct_positive)x WHERE x=ANY(refunded) AND NOT(x=ANY(covered))) THEN
    RAISE EXCEPTION 'tournament_fee_refund_duplicates_prior_refund' USING ERRCODE='23514'; END IF;
   SELECT COALESCE(array_agg(x ORDER BY x),'{}') INTO new_refunds FROM unnest(direct_positive)x WHERE NOT(x=ANY(refunded));
   SELECT COALESCE(sum(rake_amount),0) INTO expected FROM public.rake_records WHERE id=ANY(new_refunds);
   IF expected<=0 OR expected IS DISTINCT FROM -refund_row.rake_amount OR raw_reference_sum IS DISTINCT FROM expected
    OR EXISTS(SELECT 1 FROM public.rake_records q WHERE q.id=ANY(refs) AND (q.club_id IS DISTINCT FROM refund_row.club_id
      OR (q.metadata->>'user_id' IS DISTINCT FROM refund_row.metadata->>'user_id')
      OR q.created_at>refund_row.created_at)) THEN
    RAISE EXCEPTION 'tournament_fee_refund_not_exact_full_sources' USING ERRCODE='23514'; END IF;
   -- A player refund needs its immutable unregistration or cancellation witness.
   -- Spin unwind uses the cancellation's exact reversal-id list and zero net.
   IF refund_row.source='fn_unregister_from_tournament' THEN
    IF NOT EXISTS(SELECT 1 FROM public.tournament_unregistration_receipts u WHERE u.tournament_id=p_tournament_id
      AND refund_row.id=ANY(u.fee_reversal_ids) AND refs<@u.fee_source_rake_record_ids
      AND u.user_id::text=refund_row.metadata->>'user_id') THEN
     RAISE EXCEPTION 'tournament_fee_refund_receipt_missing' USING ERRCODE='23514'; END IF;
   ELSE
    IF NOT EXISTS(SELECT 1 FROM public.tournament_cancellation_receipts c WHERE c.tournament_id=p_tournament_id
      AND refund_row.id=ANY(c.fee_reversal_ids) AND c.total_rake_after=0 AND c.fees_reversed=c.total_rake_before) THEN
     RAISE EXCEPTION 'tournament_fee_cancellation_receipt_missing' USING ERRCODE='23514'; END IF;
   END IF;
   refunded:=refunded||new_refunds;refunded_total:=refunded_total+expected;
   refund_map:=refund_map||jsonb_build_object(refund_row.id::text,to_jsonb(direct_positive));
   processed:=array_append(processed,refund_row.id);pending:=array_remove(pending,refund_row.id);progress:=true;
  END LOOP;
  IF NOT progress THEN RAISE EXCEPTION 'tournament_fee_refund_dependency_cycle' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF positive_total-refunded_total IS DISTINCT FROM raw_total THEN
  RAISE EXCEPTION 'tournament_fee_net_not_conserved' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(array_agg(id ORDER BY id) FILTER(WHERE NOT(rake_record_id=ANY(refunded))),'{}'),
  COALESCE(array_agg(id ORDER BY id) FILTER(WHERE rake_record_id=ANY(refunded)),'{}')
 INTO active_ids,refunded_ids FROM public.accounting_tournament_fee_sources WHERE tournament_id=p_tournament_id;
 SELECT md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY r.id),'')) INTO fingerprint
  FROM public.rake_records r WHERE tournament_id=p_tournament_id AND is_tournament;
 RETURN jsonb_build_object('accounting_version',2,'status','proven','tournament_id',p_tournament_id,
  'source_fingerprint',fingerprint,'union_id',actual_union,'gross_fee',positive_total,'refunded_fee',refunded_total,
  'net_fee',raw_total,'active_source_ids',active_ids,'refunded_source_ids',refunded_ids,'payable',false);
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_net_plan(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE public.accounting_tournament_fee_recognitions (
 tournament_id uuid PRIMARY KEY, recognized_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN('recognized','cancelled','banked_accrual_deferred')),
 net_rake numeric NOT NULL CHECK(net_rake>=0 AND net_rake=round(net_rake,2) AND net_rake::text NOT IN('NaN','Infinity','-Infinity')),
 union_id uuid,bank_club_id uuid,union_wallet_transaction_id uuid UNIQUE REFERENCES public.union_wallet_transactions(id),
 bank_journal_id uuid UNIQUE REFERENCES public.chip_ledger(id),source_fingerprint text NOT NULL,plan jsonb NOT NULL,
 CHECK(net_rake=0 OR bank_club_id IS NOT NULL),
 CHECK((net_rake=0 AND union_wallet_transaction_id IS NULL AND bank_journal_id IS NULL)
  OR (net_rake>0 AND ((union_wallet_transaction_id IS NOT NULL)::int+(bank_journal_id IS NOT NULL)::int)=1))
);
CREATE TABLE public.accounting_tournament_recognized_sources (
 source_id uuid PRIMARY KEY REFERENCES public.accounting_tournament_fee_sources(id),
 tournament_id uuid NOT NULL REFERENCES public.accounting_tournament_fee_recognitions(tournament_id),
 recognized_at timestamptz NOT NULL, disposition text NOT NULL CHECK(disposition IN('earned','refunded')),
 rake_credit numeric NOT NULL CHECK(rake_credit>=0 AND rake_credit=round(rake_credit,2) AND rake_credit::text NOT IN('NaN','Infinity','-Infinity'))
);
CREATE INDEX accounting_tournament_recognized_sources_week ON public.accounting_tournament_recognized_sources(recognized_at,tournament_id);
ALTER TABLE public.accounting_tournament_fee_recognitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_recognized_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_tournament_fee_recognitions,public.accounting_tournament_recognized_sources FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_tournament_fee_recognitions,public.accounting_tournament_recognized_sources TO service_role;
CREATE TRIGGER accounting_tournament_fee_recognitions_immutable BEFORE UPDATE OR DELETE ON public.accounting_tournament_fee_recognitions FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_recognized_sources_immutable BEFORE UPDATE OR DELETE ON public.accounting_tournament_recognized_sources FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_recognitions_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_recognitions FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_recognized_sources_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_recognized_sources FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable();

-- Bank IDs are actual receipts read immediately after the existing fee transfer.
-- The whole caller transaction (fee bank, recognition, all commission rows,
-- stats, queue requests, terminal evidence) must roll back on any refusal.
CREATE FUNCTION public.fn_recognize_accounting_tournament_fees(p_tournament_id uuid,p_recognized_at timestamptz,
 p_bank_club_id uuid,p_union_wallet_transaction_id uuid,p_bank_journal_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE plan jsonb;prior record;source record;bank record;active_ids uuid[];refunded_ids uuid[];
 net_fee numeric;game_union uuid;rows_written int:=0;users_count int;source_count int;vip record;week_date date;
BEGIN
 IF p_recognized_at IS NULL OR p_recognized_at IS DISTINCT FROM transaction_timestamp() THEN
  RAISE EXCEPTION 'tournament_fee_original_recognition_transaction_required' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_tournament_recognition:'||p_tournament_id::text,0));
 PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,p_recognized_at);
 plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);
 SELECT * INTO prior FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=p_tournament_id;
 IF FOUND THEN
  IF prior.source_fingerprint IS DISTINCT FROM plan->>'source_fingerprint' THEN
   RAISE EXCEPTION 'recognized_tournament_fee_sources_changed' USING ERRCODE='23514'; END IF;
  RETURN prior.plan||jsonb_build_object('status',prior.status,'payable',prior.status='recognized','replayed',true,'recognized_at',prior.recognized_at);
 END IF;
 net_fee:=(plan->>'net_fee')::numeric;game_union:=NULLIF(plan->>'union_id','')::uuid;
 IF p_bank_club_id IS NULL AND net_fee>0 THEN RAISE EXCEPTION 'tournament_fee_bank_club_required' USING ERRCODE='23514'; END IF;
 PERFORM public.fn_accounting_tournament_bank_proof(p_tournament_id,p_recognized_at,p_bank_club_id,game_union,net_fee,p_union_wallet_transaction_id,p_bank_journal_id);
 SELECT COALESCE(array_agg(value::uuid),'{}') INTO active_ids FROM jsonb_array_elements_text(plan->'active_source_ids');
 SELECT COALESCE(array_agg(value::uuid),'{}') INTO refunded_ids FROM jsonb_array_elements_text(plan->'refunded_source_ids');
 INSERT INTO public.accounting_tournament_fee_recognitions(tournament_id,recognized_at,status,net_rake,union_id,bank_club_id,
  union_wallet_transaction_id,bank_journal_id,source_fingerprint,plan)
 VALUES(p_tournament_id,p_recognized_at,CASE WHEN net_fee>0 THEN 'recognized' ELSE 'cancelled' END,net_fee,game_union,p_bank_club_id,
  p_union_wallet_transaction_id,p_bank_journal_id,plan->>'source_fingerprint',plan);
 INSERT INTO public.accounting_tournament_recognized_sources(source_id,tournament_id,recognized_at,disposition,rake_credit)
 SELECT s.id,p_tournament_id,p_recognized_at,CASE WHEN s.id=ANY(active_ids) THEN 'earned' ELSE 'refunded' END,
  CASE WHEN s.id=ANY(active_ids) THEN s.rake_credit ELSE 0 END
 FROM public.accounting_tournament_fee_sources s WHERE s.id=ANY(active_ids||refunded_ids);
 FOR source IN SELECT * FROM public.accounting_tournament_fee_sources WHERE id=ANY(active_ids) ORDER BY club_id,player_id,id LOOP
  rows_written:=rows_written+public.fn_post_accounting_commission_source(source.id,'tournament_fee_accrual',p_recognized_at,source.contract);
  -- Statistics use the real source record/player pair. The source credit is
  -- recognized once; a retry is guarded by the terminal recognition row above.
  PERFORM public.apply_rakeback_player_stats(source.rake_record_id,source.player_id,source.club_id,0,source.rake_credit);
 END LOOP;
 -- VIP already has a unique event/player source key. Preserve its original
 -- settlement-time grouping while giving it exact conserved contributor cents.
 FOR vip IN SELECT player_id,sum(rake_credit) credit FROM public.accounting_tournament_fee_sources
  WHERE id=ANY(active_ids) GROUP BY player_id ORDER BY player_id LOOP
  IF vip.credit>0 THEN PERFORM public.fn_award_vip_credit(vip.player_id,vip.credit,'tournament_rake',p_tournament_id,'Tournament rake generated'); END IF;
 END LOOP;
 week_date:=(public.fn_union_week_start(p_recognized_at) AT TIME ZONE 'America/Los_Angeles')::date;
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end,status)
 SELECT DISTINCT club_id,week_date,week_date+6,'pending' FROM public.accounting_tournament_fee_sources WHERE id=ANY(active_ids)
 ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET status='pending',reason=NULL,last_result='{}'::jsonb,last_requested_at=transaction_timestamp();
 SELECT count(DISTINCT player_id),count(*) INTO users_count,source_count FROM public.accounting_tournament_fee_sources WHERE id=ANY(active_ids);
 RETURN plan||jsonb_build_object('status',CASE WHEN net_fee>0 THEN 'recognized' ELSE 'cancelled' END,
  'recognized_at',p_recognized_at,'payable',net_fee>0,'replayed',false,'commission_rows',rows_written,
  'attributed_users',users_count,'source_count',source_count,'attributed_chips',net_fee);
END $function$;
REVOKE ALL ON FUNCTION public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- END tournament-fee-recognition-draft.sql

-- BEGIN tournament-fee-terminal-common-draft.sql
CREATE FUNCTION public.fn_accounting_tournament_bank_proof(p_tournament_id uuid,p_recognized_at timestamptz,
 p_bank_club_id uuid,p_union_id uuid,p_net_fee numeric,p_union_wallet_transaction_id uuid,p_bank_journal_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$DECLARE bank record;BEGIN
 IF (p_bank_club_id IS NULL AND p_net_fee>0) OR p_recognized_at IS NULL OR NOT isfinite(p_recognized_at)
  OR p_net_fee IS NULL OR p_net_fee<0 OR p_net_fee<>round(p_net_fee,2) OR p_net_fee::text IN('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'tournament_fee_bank_proof_invalid' USING ERRCODE='23514'; END IF;
 IF p_net_fee=0 THEN
  IF p_union_wallet_transaction_id IS NOT NULL OR p_bank_journal_id IS NOT NULL THEN
   RAISE EXCEPTION 'zero_tournament_fee_has_no_bank_credit' USING ERRCODE='23514'; END IF;
 ELSIF p_union_id IS NOT NULL THEN
  SELECT * INTO bank FROM public.union_wallet_transactions WHERE id=p_union_wallet_transaction_id;
  IF p_bank_journal_id IS NOT NULL OR bank.id IS NULL OR bank.union_id IS DISTINCT FROM p_union_id
   OR bank.club_id IS DISTINCT FROM p_bank_club_id OR bank.wallet IS DISTINCT FROM 'rake_wallet'
   OR bank.direction IS DISTINCT FROM 'credit' OR bank.tx_type IS DISTINCT FROM 'rake' OR bank.amount IS DISTINCT FROM p_net_fee
   OR bank.created_at IS DISTINCT FROM p_recognized_at
   OR position('[tournament '||p_tournament_id::text||']' IN COALESCE(bank.notes,''))=0 THEN
   RAISE EXCEPTION 'tournament_fee_union_bank_receipt_mismatch' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO bank FROM public.chip_ledger WHERE id=p_bank_journal_id;
  IF p_union_wallet_transaction_id IS NOT NULL OR bank.id IS NULL OR bank.from_type IS DISTINCT FROM 'prize_liability'
   OR bank.from_entity_id IS DISTINCT FROM p_tournament_id OR bank.to_type IS DISTINCT FROM 'club_treasury'
   OR bank.to_entity_id IS DISTINCT FROM p_bank_club_id OR bank.category IS DISTINCT FROM 'rake'
   OR bank.amount IS DISTINCT FROM p_net_fee OR bank.created_at IS DISTINCT FROM p_recognized_at THEN
   RAISE EXCEPTION 'tournament_fee_club_bank_receipt_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN jsonb_build_object('bank_amount',p_net_fee,'banked_at',p_recognized_at,'bank_club_id',p_bank_club_id,'bank_union_id',p_union_id,
  'bank_receipt_kind',CASE WHEN p_net_fee=0 THEN 'none' WHEN p_union_id IS NULL THEN 'chip_ledger' ELSE 'union_wallet_transaction' END,
  'bank_receipt_id',COALESCE(p_union_wallet_transaction_id,p_bank_journal_id));
END$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_bank_proof(uuid,timestamptz,uuid,uuid,numeric,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_lock_accounting_tournament_recognition_week(p_tournament_id uuid,p_recognized_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$DECLARE scope record;week_start timestamptz;week_end timestamptz;BEGIN
 week_start:=public.fn_union_week_start(p_recognized_at);
 week_end:=((week_start AT TIME ZONE 'America/Los_Angeles')+interval '7 days') AT TIME ZONE 'America/Los_Angeles';
 FOR scope IN
  WITH scopes AS (
   SELECT coordinator_union_id,club_id FROM public.accounting_tournament_fee_sources WHERE tournament_id=p_tournament_id
   UNION
   -- The actual bank also participates in the same close order. A legacy event
   -- may have no captured contributor; this names its game bank, never guesses
   -- a contributor's historical membership or commission agreement.
   SELECT f.union_id,t.club_id FROM public.tournaments t
    JOIN public.accounting_tournament_fee_sources f ON f.tournament_id=t.id WHERE t.id=p_tournament_id AND t.club_id IS NOT NULL
   UNION
   SELECT CASE WHEN t.is_private THEN NULL ELSE t.union_id END,t.club_id FROM public.tournaments t
    WHERE t.id=p_tournament_id AND t.club_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f WHERE f.tournament_id=t.id)
  ) SELECT DISTINCT coordinator_union_id,club_id,
   CASE WHEN coordinator_union_id IS NULL THEN 'club-accounting:'||club_id::text ELSE 'union-accounting:'||coordinator_union_id::text END
    ||':'||extract(epoch FROM week_start)::text||':'||extract(epoch FROM week_end)::text lock_key
  FROM scopes ORDER BY lock_key
 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(scope.lock_key,0));
  IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.period_start<=p_recognized_at AND r.period_end>p_recognized_at
   AND ((r.union_id IS NOT NULL AND r.union_id=scope.coordinator_union_id)
     OR (r.standalone_club_id IS NOT NULL AND scope.coordinator_union_id IS NULL AND r.standalone_club_id=scope.club_id))) THEN
   RAISE EXCEPTION 'tournament_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
 END LOOP;
END$$;
REVOKE ALL ON FUNCTION public.fn_lock_accounting_tournament_recognition_week(uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_defer_accounting_tournament_fees(p_tournament_id uuid,p_recognized_at timestamptz,
 p_bank_club_id uuid,p_union_id uuid,p_union_wallet_transaction_id uuid,p_bank_journal_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$DECLARE net_fee numeric;fp text;proof jsonb;plan jsonb;prior record;BEGIN
 IF p_recognized_at IS DISTINCT FROM transaction_timestamp() OR p_reason IS NULL
  OR p_reason NOT IN('tournament_fee_sources_require_reconciliation','accounting_terms_not_observed','accounting_terms_not_active','tournament_fee_not_captured_by_original_producer') THEN
  RAISE EXCEPTION 'tournament_fee_deferral_reason_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament
   AND (r.rake_amount IS NULL OR r.rake_amount<>round(r.rake_amount,2) OR r.rake_amount::text IN('NaN','Infinity','-Infinity'))) THEN
  RAISE EXCEPTION 'tournament_fee_source_invalid' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(sum(rake_amount),0),md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY id),'')) INTO net_fee,fp
  FROM public.rake_records r WHERE tournament_id=p_tournament_id AND is_tournament;
 proof:=public.fn_accounting_tournament_bank_proof(p_tournament_id,p_recognized_at,p_bank_club_id,p_union_id,net_fee,p_union_wallet_transaction_id,p_bank_journal_id);
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_tournament_recognition:'||p_tournament_id::text,0));
 SELECT * INTO prior FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=p_tournament_id;
 IF FOUND THEN
  IF prior.status IS DISTINCT FROM 'banked_accrual_deferred' OR prior.source_fingerprint IS DISTINCT FROM fp OR prior.net_rake IS DISTINCT FROM net_fee THEN
   RAISE EXCEPTION 'tournament_fee_recognition_conflict' USING ERRCODE='23514'; END IF;
  RETURN prior.plan||jsonb_build_object('replayed',true);
 END IF;
 plan:=proof||jsonb_build_object('accounting_version',2,'tournament_id',p_tournament_id,'status','banked_accrual_deferred',
  'reason',p_reason,'source_fingerprint',fp,'net_fee',net_fee,'payable',false,'commission_rows',0,'attributed_users',0,'recognized_source_count',0);
 INSERT INTO public.accounting_tournament_fee_recognitions(tournament_id,recognized_at,status,net_rake,union_id,bank_club_id,
  union_wallet_transaction_id,bank_journal_id,source_fingerprint,plan)
 VALUES(p_tournament_id,p_recognized_at,'banked_accrual_deferred',net_fee,p_union_id,p_bank_club_id,p_union_wallet_transaction_id,p_bank_journal_id,fp,plan);
 RETURN plan||jsonb_build_object('replayed',false);
END$$;
REVOKE ALL ON FUNCTION public.fn_defer_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$DECLARE r record;proof jsonb;fp text;credits numeric;n int;BEGIN
 SELECT * INTO r FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=p_tournament_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(q),':' ORDER BY q.id),'')) INTO fp
  FROM public.rake_records q WHERE q.tournament_id=p_tournament_id AND q.is_tournament;
 IF r.source_fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'recognized_tournament_fee_sources_changed' USING ERRCODE='23514'; END IF;
 proof:=public.fn_accounting_tournament_bank_proof(r.tournament_id,r.recognized_at,r.bank_club_id,r.union_id,r.net_rake,r.union_wallet_transaction_id,r.bank_journal_id);
 SELECT COALESCE(sum(x.rake_credit),0),count(*) INTO credits,n FROM public.accounting_tournament_recognized_sources x WHERE x.tournament_id=p_tournament_id;
 IF (r.status='banked_accrual_deferred' AND (n<>0 OR r.plan->>'payable' IS DISTINCT FROM 'false' OR NULLIF(r.plan->>'reason','') IS NULL))
  OR (r.status<>'banked_accrual_deferred' AND (credits IS DISTINCT FROM r.net_rake
    OR n<>(SELECT count(*) FROM public.accounting_tournament_fee_sources f WHERE f.tournament_id=p_tournament_id)
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f LEFT JOIN public.accounting_tournament_recognized_sources x ON x.source_id=f.id
      WHERE f.tournament_id=p_tournament_id AND (x.source_id IS NULL OR x.tournament_id IS DISTINCT FROM p_tournament_id
        OR x.recognized_at IS DISTINCT FROM r.recognized_at OR x.rake_credit IS DISTINCT FROM CASE WHEN x.disposition='earned' THEN f.rake_credit ELSE 0 END))
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f
      JOIN public.accounting_tournament_recognized_sources x ON x.source_id=f.id AND x.disposition='earned'
      CROSS JOIN LATERAL jsonb_array_elements(f.contract->'tiers')tier
      WHERE f.tournament_id=p_tournament_id AND (tier->>'amount')::numeric>0 AND NOT EXISTS(
       SELECT 1 FROM public.agent_commissions c WHERE c.source_type='tournament_fee_accrual' AND c.source_id=f.id
        AND c.user_id::text=tier->>'user_id' AND c.club_id=f.club_id AND c.created_at=r.recognized_at
        AND c.amount=(tier->>'amount')::numeric AND c.commission_rate=(tier->>'rate')::numeric)))) THEN
  RAISE EXCEPTION 'tournament_fee_recognition_source_receipt_incomplete' USING ERRCODE='23514'; END IF;
 RETURN proof||jsonb_build_object('accounting_version',2,'tournament_id',p_tournament_id,'status',r.status,
  'source_fingerprint',fp,'reason',r.plan->>'reason','payable',r.status='recognized','recognized_source_count',n);
END$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_terminal_fee_receipt(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_record_accounting_tournament_cancellation(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$DECLARE t record;raw record;reason text;result jsonb;BEGIN
 SELECT id,club_id,union_id,is_private INTO t FROM public.tournaments WHERE id=p_tournament_id;
 IF NOT FOUND OR public.fn_poker_diamond_tournament(p_tournament_id) THEN
  RAISE EXCEPTION 'chip_tournament_cancellation_required' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournament_cancellation_receipts c WHERE c.tournament_id=p_tournament_id
   AND c.total_rake_after=0 AND c.fees_reversed=c.total_rake_before)
  OR (SELECT COALESCE(sum(rake_amount),0) FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament)<>0 THEN
  RAISE EXCEPTION 'tournament_cancellation_exact_zero_receipt_required' USING ERRCODE='23514'; END IF;
 -- A registration and cancellation can share one transaction. Its deferred
 -- capture hook has not fired yet; capture the original immutable charge now.
 -- This does not rewrite the raw fee sealed by the cancellation receipt.
 FOR raw IN SELECT r.id FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament
  AND r.rake_amount>0 AND r.created_at=transaction_timestamp()
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id) ORDER BY r.id LOOP
  PERFORM public.fn_stamp_accounting_tournament_fee(raw.id);
 END LOOP;
 BEGIN
  result:=public.fn_recognize_accounting_tournament_fees(p_tournament_id,transaction_timestamp(),t.club_id,NULL,NULL);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  reason:=SQLERRM;
  IF reason NOT IN('tournament_fee_sources_require_reconciliation','accounting_terms_not_observed','accounting_terms_not_active','tournament_fee_not_captured_by_original_producer') THEN RAISE; END IF;
  result:=public.fn_defer_accounting_tournament_fees(p_tournament_id,transaction_timestamp(),t.club_id,
   CASE WHEN t.is_private THEN NULL ELSE t.union_id END,NULL,NULL,reason);
 END;
 RETURN result;
END$$;
REVOKE ALL ON FUNCTION public.fn_record_accounting_tournament_cancellation(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_accounting_tournament_commission_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$DECLARE s record;matches int;BEGIN
 IF NEW.source_type='tournament_fee_accrual' THEN
  SELECT f.*,r.recognized_at,r.disposition,b.status accounting_status INTO s FROM public.accounting_tournament_fee_sources f
   JOIN public.accounting_tournament_recognized_sources r ON r.source_id=f.id
   JOIN public.accounting_tournament_fee_recognitions b ON b.tournament_id=r.tournament_id WHERE f.id=NEW.source_id;
  IF NOT FOUND OR s.disposition IS DISTINCT FROM 'earned' OR s.accounting_status IS DISTINCT FROM 'recognized'
   OR NEW.club_id IS DISTINCT FROM s.club_id OR NEW.created_at IS DISTINCT FROM s.recognized_at THEN
   RAISE EXCEPTION 'tournament_commission_recognized_source_required' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO matches FROM jsonb_array_elements(s.contract->'tiers')t
   WHERE t->>'user_id'=NEW.user_id::text AND (t->>'amount')::numeric=NEW.amount AND (t->>'rate')::numeric=NEW.commission_rate AND NEW.amount>0;
  IF matches<>1 THEN RAISE EXCEPTION 'tournament_commission_disagrees_with_recorded_entitlement' USING ERRCODE='23514'; END IF;
 ELSIF NEW.source_type IN('tournament_fee','tournament_rake_settlement') THEN
  RAISE EXCEPTION 'tournament_commission_requires_canonical_source_writer' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_commission_source_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER accounting_tournament_commission_source_guard BEFORE INSERT ON public.agent_commissions FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_commission_source_guard();

CREATE FUNCTION public.fn_accounting_tournament_recognized_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$DECLARE event uuid;BEGIN
 IF TG_TABLE_NAME='rake_records' THEN
  event:=CASE WHEN TG_OP='INSERT' THEN NEW.tournament_id ELSE OLD.tournament_id END;
  IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=event)
   AND (TG_OP<>'UPDATE' OR public.fn_accounting_tournament_fee_fingerprint(OLD) IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(NEW)) THEN
   RAISE EXCEPTION 'recognized_tournament_fee_evidence_is_immutable' USING ERRCODE='55000'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE
   (TG_TABLE_NAME='chip_ledger' AND bank_journal_id=OLD.id) OR (TG_TABLE_NAME='union_wallet_transactions' AND union_wallet_transaction_id=OLD.id)) THEN
   RAISE EXCEPTION 'recognized_tournament_fee_bank_receipt_is_immutable' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_recognized_evidence_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER accounting_tournament_recognized_evidence_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_recognized_evidence_immutable();
CREATE TRIGGER accounting_tournament_recognized_bank_immutable BEFORE UPDATE OR DELETE ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_recognized_evidence_immutable();
CREATE TRIGGER accounting_tournament_recognized_bank_immutable BEFORE UPDATE OR DELETE ON public.union_wallet_transactions FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_recognized_evidence_immutable();

-- END tournament-fee-terminal-common-draft.sql

-- BEGIN tournament-fee-settle-adapter-draft.sql
-- DRAFT. Captured preimage md5 7cf1d81246d015b65d416ee6b3f96838; Diamond branch preserved verbatim.
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_rake(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
 v_t record;v_prior record;v_claimed int;v_plan jsonb;v_att jsonb;v_res jsonb;
 v_net numeric;v_union uuid;v_dest text;v_reason text;v_raw record;v_bank_id uuid;v_journal_id uuid;v_matches int;
 v_week_start timestamptz;v_week_end timestamptz;v_lock_key text;
BEGIN
 PERFORM public.fn_ca_lock_settlement_lane_global();
 SELECT t.id,t.status,t.club_id,t.union_id,t.is_private,t.name,t.current_players INTO v_t
  FROM public.tournaments t WHERE t.id=p_tournament_id FOR NO KEY UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
 IF upper(COALESCE(v_t.status,'')) NOT IN('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
  RETURN jsonb_build_object('ok',false,'reason','not_terminal','status',v_t.status); END IF;
 INSERT INTO public.tournament_rake_settlements(tournament_id,club_id,amount,destination,source)
 VALUES(p_tournament_id,v_t.club_id,0,'pending',COALESCE(p_source,'engine')) ON CONFLICT(tournament_id) DO NOTHING;
 GET DIAGNOSTICS v_claimed=ROW_COUNT;
 IF v_claimed=0 THEN
  SELECT * INTO v_prior FROM public.tournament_rake_settlements WHERE tournament_id=p_tournament_id;
  IF v_prior.settled_at IS NULL OR v_prior.destination='pending' THEN
   RAISE EXCEPTION 'partial_tournament_fee_settlement_requires_reconciliation' USING ERRCODE='55000'; END IF;
  v_att:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  RETURN jsonb_build_object('ok',true,'already_settled',true,'amount',v_prior.amount,'destination',v_prior.destination,
    'settled_at',v_prior.settled_at,'attributed',v_prior.attributed_at IS NOT NULL,'attributed_users',v_prior.attributed_users,
    'accounting',v_att);
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

 -- Deferred capture is normally already committed. A same-transaction Spin
 -- close still captures the original exact charge before it can be recognized.
 FOR v_raw IN SELECT r.id FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament
  AND r.rake_amount>0 AND r.created_at=transaction_timestamp()
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id) ORDER BY r.id LOOP
  PERFORM public.fn_stamp_accounting_tournament_fee(v_raw.id);
 END LOOP;
 BEGIN
  v_plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT IN('tournament_fee_sources_require_reconciliation','accounting_terms_not_observed','accounting_terms_not_active','tournament_fee_not_captured_by_original_producer') THEN RAISE; END IF;
  v_reason:=SQLERRM;
 END;
 SELECT COALESCE(sum(r.rake_amount),0) INTO v_net FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
 IF v_net<0 OR v_net<>round(v_net,2) OR v_net::text IN('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'tournament_fee_net_invalid' USING ERRCODE='23514'; END IF;
 v_union:=CASE WHEN v_reason IS NULL THEN NULLIF(v_plan->>'union_id','')::uuid
  WHEN v_t.is_private THEN NULL ELSE v_t.union_id END;
 PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp());
 -- A legacy event may have no captured contributor scope. Its actual bank
 -- still takes the exact same close lock, before either wallet is touched.
 v_week_start:=public.fn_union_week_start(transaction_timestamp());
 v_week_end:=((v_week_start AT TIME ZONE 'America/Los_Angeles')+interval '7 days') AT TIME ZONE 'America/Los_Angeles';
 v_lock_key:=CASE WHEN v_union IS NULL THEN 'club-accounting:'||v_t.club_id::text ELSE 'union-accounting:'||v_union::text END
  ||':'||extract(epoch FROM v_week_start)::text||':'||extract(epoch FROM v_week_end)::text;
 IF v_lock_key IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_key,0)); END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs x WHERE x.period_start<=transaction_timestamp() AND x.period_end>transaction_timestamp()
   AND ((v_union IS NOT NULL AND x.union_id=v_union) OR(v_union IS NULL AND x.standalone_club_id=v_t.club_id))) THEN
  RAISE EXCEPTION 'tournament_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
 IF v_net>0 THEN
  IF v_t.club_id IS NULL THEN RAISE EXCEPTION 'tournament_fee_bank_club_required' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.club_wallets WHERE club_id=v_t.club_id FOR NO KEY UPDATE;
  PERFORM set_config('app.ledger_category','rake',true);
  PERFORM set_config('app.ledger_counterparty','prize_liability',true);
  PERFORM set_config('app.ledger_counterparty_entity',p_tournament_id::text,true);
  IF v_union IS NOT NULL THEN
   v_res:=public.increment_union_wallet(v_union,v_net,v_t.club_id,
    'Tournament rake: '||COALESCE(v_t.name,'tournament')||' [tournament '||p_tournament_id::text||']');
   IF COALESCE((v_res->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'tournament_fee_union_credit_failed' USING ERRCODE='23514'; END IF;
   SELECT count(*),(array_agg(id))[1] INTO v_matches,v_bank_id FROM public.union_wallet_transactions
    WHERE union_id=v_union AND club_id=v_t.club_id AND wallet='rake_wallet' AND direction='credit' AND tx_type='rake'
     AND amount=v_net AND created_at=transaction_timestamp() AND position('[tournament '||p_tournament_id::text||']' IN COALESCE(notes,''))>0;
   v_dest:='union:'||v_union::text;
  ELSE
   PERFORM public.credit_club_rake_to_treasury(v_t.club_id,v_net);
   SELECT count(*),(array_agg(id))[1] INTO v_matches,v_journal_id FROM public.chip_ledger
    WHERE from_type='prize_liability' AND from_entity_id=p_tournament_id AND to_type='club_treasury'
     AND to_entity_id=v_t.club_id AND category='rake' AND amount=v_net AND created_at=transaction_timestamp();
   v_dest:='club_treasury:'||v_t.club_id::text;
  END IF;
  IF v_matches<>1 THEN RAISE EXCEPTION 'tournament_fee_exact_bank_receipt_required' USING ERRCODE='23514'; END IF;
  UPDATE public.club_wallets SET period_rake_collected=COALESCE(period_rake_collected,0)+v_net,
   lifetime_rake_collected=COALESCE(lifetime_rake_collected,0)+v_net,updated_at=now() WHERE club_id=v_t.club_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'tournament_fee_club_wallet_missing' USING ERRCODE='23514'; END IF;
 ELSE v_dest:='none'; END IF;
 IF v_reason IS NULL THEN
  v_att:=public.fn_recognize_accounting_tournament_fees(p_tournament_id,transaction_timestamp(),v_t.club_id,v_bank_id,v_journal_id);
 ELSE
  v_att:=public.fn_defer_accounting_tournament_fees(p_tournament_id,transaction_timestamp(),v_t.club_id,v_union,v_bank_id,v_journal_id,v_reason);
 END IF;
 UPDATE public.tournament_rake_settlements SET amount=v_net,union_id=v_union,destination=v_dest,settled_at=transaction_timestamp(),
  attributed_at=CASE WHEN v_reason IS NULL THEN transaction_timestamp() ELSE NULL END,
  attributed_users=COALESCE((v_att->>'attributed_users')::int,0),attribution_error=v_reason WHERE tournament_id=p_tournament_id;
 RETURN jsonb_build_object('ok',true,'amount',v_net,'destination',v_dest,'attributed',v_reason IS NULL,
  'attributed_users',COALESCE((v_att->>'attributed_users')::int,0),
  'accounting',public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id));
END;
$function$;

-- END tournament-fee-settle-adapter-draft.sql

-- BEGIN tournament-fee-terminal-gates-draft.sql
-- DRAFT. New v2 terminal receipts retain truthful NULL attribution while
-- their durable accounting deferral is explicit. Existing v1 receipts stay valid.
DO $terminal_version_preimage$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_terminal_settlements'::regclass
  AND conname='tournament_terminal_settlements_receipt_version_check'
  AND pg_get_constraintdef(oid)='CHECK ((receipt_version = 1))') THEN
  RAISE EXCEPTION 'terminal_receipt_version_constraint_changed' USING ERRCODE='55000';
 END IF;
END $terminal_version_preimage$;
ALTER TABLE public.tournament_terminal_settlements
 ADD COLUMN accounting_state text NOT NULL DEFAULT 'legacy'
  CHECK(accounting_state IN('legacy','recognized','cancelled','banked_accrual_deferred')),
 DROP CONSTRAINT tournament_terminal_settlements_receipt_version_check,
 ADD CONSTRAINT terminal_receipt_version_matches_accounting_state CHECK(
  receipt_version=CASE WHEN accounting_state='legacy' THEN 1 ELSE 2 END),
 ALTER COLUMN rake_attributed_at DROP NOT NULL,
 ADD CONSTRAINT terminal_rake_attribution_matches_accounting_state CHECK(
  (accounting_state='banked_accrual_deferred' AND rake_attributed_at IS NULL AND rake_attributed_users=0)
  OR(accounting_state<>'banked_accrual_deferred' AND rake_attributed_at IS NOT NULL));

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal_pre_seat_guard(p_tournament_id uuid, p_observed_winner_id uuid, p_settlement_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_mode text := lower(btrim(COALESCE(p_settlement_mode,'')));
  v_diamond boolean := false;  -- DIAMOND PHASE 8
  v_t record;
  v_e public.tournament_escrow%ROWTYPE;
  v_cash jsonb;
  v_mystery jsonb;
  v_mystery_evidence jsonb;
  v_bounty jsonb;
  v_rake_result jsonb;
  v_rake record;
  v_prior_rake record;
  v_winner_id uuid;
  v_winner_count integer;
  v_is_bounty boolean;
  v_mystery_active boolean := false;
  v_mystery_stage text := 'pending';
  v_mystery_pool_cents bigint := 0;
  v_inventory_cents bigint := 0;
  v_cash_count integer;
  v_bubble_line_count integer;
  v_cash_total numeric(15,2);
  v_cash_before numeric(15,2);
  v_bounty_before numeric(15,2);
  v_bounty_total numeric(15,2);
  v_rake_total numeric(15,2);
  v_expected_fee numeric(15,2);
  v_started_status text;
  v_completed_at timestamptz;
  v_rows integer;
  v_closed_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_closed_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_event_union_id uuid;
  v_current_union_id uuid;
  v_locked_current_union_id uuid;
  v_deal_shares jsonb := '[]'::jsonb;
  v_full_payouts jsonb := '[]'::jsonb;
  v_cash_bubble jsonb := 'null'::jsonb;
  v_full_winner_amount numeric(15,2);
BEGIN
  -- All satellite and non-satellite terminal money commits use this exact
  -- first lock. It eliminates cross-event cycles on shared club, union and
  -- recipient wallets without weakening any event-local row proof.
  PERFORM public.fn_ca_lock_settlement_lane_global();

  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal completion requires a tournament id'
      USING ERRCODE = '22004';
  END IF;
  IF v_mode NOT IN ('places','final_table_deal') THEN
    RAISE EXCEPTION 'unknown terminal settlement mode %', p_settlement_mode
      USING ERRCODE = '22023';
  END IF;
  IF v_mode = 'places' AND p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'places completion requires an observed winner id'
      USING ERRCODE = '22004';
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  v_diamond := public.fn_poker_diamond_tournament(p_tournament_id);  -- DIAMOND PHASE 8

  -- Receipt first is the replay boundary. No money authority appears above it.
  IF EXISTS (
    SELECT 1 FROM public.tournament_terminal_settlements h
     WHERE h.tournament_id = p_tournament_id
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tournament_terminal_settlements h
       WHERE h.tournament_id = p_tournament_id
         AND h.settlement_mode = v_mode
         AND (p_observed_winner_id IS NULL
              OR h.winner_id = p_observed_winner_id)
    ) THEN
      RAISE EXCEPTION 'terminal replay parameters disagree with stored receipt for %',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    RETURN public.fn_ca_tournament_terminal_receipt(
      p_tournament_id,p_observed_winner_id);
  END IF;

  IF lower(COALESCE(v_t.variant::text,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite; use its whole-pool authority',
      p_tournament_id USING ERRCODE = '22023';
  END IF;
  v_started_status := upper(COALESCE(v_t.status::text,''));
  IF v_started_status NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'tournament % cannot complete from status % without a receipt',
      p_tournament_id,v_t.status USING ERRCODE = '55000';
  END IF;
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool,2)
     OR v_t.bounty_pool IS NULL
     OR v_t.bounty_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.bounty_pool < 0
     OR v_t.bounty_pool IS DISTINCT FROM round(v_t.bounty_pool,2) THEN
    RAISE EXCEPTION 'tournament % has malformed cash or bounty pools',
      p_tournament_id USING ERRCODE = '22003';
  END IF;

  IF NOT v_diamond THEN PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp()); END IF;

  -- Cross-event bank order is tournament -> club_wallets -> union_wallets
  -- (sorted) -> clubs, before a cash authority can apply an overlay. Rake uses
  -- club_wallets before its union/club destination; guarantee funding uses the
  -- union/club destination. Pre-owning both paths prevents two same-scope
  -- finishes from taking those shared banks in opposite order.
  v_event_union_id := CASE WHEN COALESCE(v_t.is_private,false)
                           THEN NULL ELSE v_t.union_id END;
  IF v_t.club_id IS NOT NULL THEN
    SELECT c.union_id INTO v_current_union_id
      FROM public.clubs c WHERE c.id = v_t.club_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tournament % refers to missing club %',
        p_tournament_id,v_t.club_id USING ERRCODE = 'P0404';
    END IF;
    PERFORM 1 FROM public.club_wallets cw
     WHERE cw.club_id = v_t.club_id
     ORDER BY cw.club_id FOR NO KEY UPDATE;
    PERFORM 1 FROM public.union_wallets uw
     WHERE uw.union_id IN (
       SELECT DISTINCT x.union_id
         FROM unnest(ARRAY[v_event_union_id,v_current_union_id]::uuid[]) x(union_id)
        WHERE x.union_id IS NOT NULL)
     ORDER BY uw.union_id FOR NO KEY UPDATE;
    SELECT c.union_id INTO v_locked_current_union_id
      FROM public.clubs c
     WHERE c.id = v_t.club_id
     FOR NO KEY UPDATE;
    IF v_locked_current_union_id IS DISTINCT FROM v_current_union_id THEN
      RAISE EXCEPTION 'club % changed union while tournament % claimed terminal banks',
        v_t.club_id,p_tournament_id USING ERRCODE = '40001';
    END IF;
  END IF;

  -- Freeze every tournament-owned evidence set before the first payer. The
  -- canonical payers reacquire only rows already owned by this transaction.
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.user_id,tp.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind,o.place NULLS LAST,o.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id ORDER BY p.id FOR SHARE;
  PERFORM 1 FROM public.tournament_guarantee_overlays g
   WHERE g.tournament_id = p_tournament_id
   ORDER BY g.tournament_id FOR UPDATE;
  -- The final-table deal authority uses this same order after its money sets.
  -- Holding these locks before any bounty or rake row prevents a reversed
  -- terminal lock chain while retaining the tournament row as the root lock.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY s.id FOR UPDATE OF s;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[])
    INTO v_closed_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  v_closed_table_count := cardinality(v_closed_table_ids);
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[])
    INTO v_source_seat_ids
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id;
  v_source_seat_count := cardinality(v_source_seat_ids);
  PERFORM 1 FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
   ORDER BY w.id FOR SHARE;
  PERFORM 1 FROM public.tournament_bounty_chests c
   WHERE c.tournament_id = p_tournament_id ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_awards a
   WHERE a.tournament_id = p_tournament_id ORDER BY a.id FOR UPDATE;
  PERFORM 1
    FROM public.tournament_bounty_award_recipients r
    JOIN public.tournament_bounty_awards a ON a.id = r.award_id
   WHERE a.tournament_id = p_tournament_id ORDER BY r.id FOR UPDATE OF r;
  PERFORM 1 FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament
   ORDER BY rr.id FOR SHARE;
  PERFORM 1 FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id FOR UPDATE;

  v_is_bounty := COALESCE(v_t.is_bounty,false)
              OR COALESCE(v_t.is_pko,false)
              OR COALESCE(v_t.is_mystery_bounty,false);

  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_bounty_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND lower(w.category) = 'bounty';
  -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.
  IF v_diamond THEN
    SELECT e.bounty_out INTO v_bounty_before
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.wallet_transactions w
     WHERE w.related_entity_id = p_tournament_id
       AND lower(w.category) = 'bounty'
       AND (lower(w.type) <> 'credit' OR w.amount <= 0
         OR w.amount::text IN ('NaN','Infinity','-Infinity')
         OR w.amount IS DISTINCT FROM round(w.amount,2))
  ) OR v_bounty_before < 0 OR v_bounty_before > v_t.bounty_pool
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_bounty_before THEN
    RAISE EXCEPTION 'tournament % has overpaid or contradictory bounty evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_is_bounty THEN
    IF v_t.bounty_pool <= 0 THEN
      RAISE EXCEPTION 'funded bounty tournament % has no positive bounty pool',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF v_t.bounty_pool <> 0 OR v_bounty_before <> 0
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind IN ('bounty','bounty_residual','mystery_bounty'))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'ordinary tournament % carries unfunded bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF COALESCE(v_t.is_mystery_bounty,false) THEN
    v_mystery_stage := COALESCE(v_t.mystery_bounty_stage,'');
    IF v_mystery_stage NOT IN ('pending','active','complete') THEN
      RAISE EXCEPTION 'tournament % has ambiguous mystery stage % without a receipt',
        p_tournament_id,v_t.mystery_bounty_stage USING ERRCODE = '55000';
    END IF;
    -- A rolling cutover may meet an event whose old finish path already
    -- completed the mystery inventory but never completed cash, rake or the
    -- lifecycle. Treat both active and complete as a funded mystery branch.
    -- Active is settled below; complete must already prove the entire mystery
    -- obligation and every inventory row before the wrapper can continue.
    v_mystery_active := v_mystery_stage IN ('active','complete');
    IF v_mystery_active THEN
      v_mystery_pool_cents := COALESCE(v_t.mystery_bounty_pool_cents,0);
      SELECT COALESCE(sum(c.amount_cents),0) INTO v_inventory_cents
        FROM public.tournament_bounty_chests c
       WHERE c.tournament_id = p_tournament_id;
      IF v_mystery_pool_cents <= 0
         OR v_inventory_cents IS DISTINCT FROM v_mystery_pool_cents
         OR v_mystery_pool_cents > round(v_t.bounty_pool * 100)::bigint
         OR EXISTS (
           SELECT 1 FROM public.tournament_bounty_chests c
            WHERE c.tournament_id = p_tournament_id
              AND (c.amount_cents <= 0 OR c.status NOT IN
                   ('available','reserved','revealed','paid','void')))
         OR EXISTS (
           SELECT 1 FROM public.tournament_bounty_awards a
            WHERE a.tournament_id = p_tournament_id
              AND (a.amount_cents <= 0 OR a.status NOT IN
                   ('reserved','revealed','paid','completed','void'))) THEN
        RAISE EXCEPTION 'tournament % mystery bounty inventory is not exactly funded',
          p_tournament_id USING ERRCODE = 'P0404';
      END IF;
    ELSIF COALESCE(v_t.mystery_bounty_pool_cents,0) <> 0
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id) THEN
      RAISE EXCEPTION 'pending mystery tournament % already carries inventory',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF COALESCE(v_t.mystery_bounty_stage,'pending') <> 'pending'
     OR COALESCE(v_t.mystery_bounty_pool_cents,0) <> 0
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id) THEN
    RAISE EXCEPTION 'non-mystery tournament % carries mystery bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(p.amount),0),2) INTO v_cash_before
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_before < 0 OR v_cash_before > v_t.prize_pool
     OR EXISTS (SELECT 1 FROM public.tournament_payouts p
                 WHERE p.tournament_id = p_tournament_id
                   AND p.source IN
                     ('satellite_seat','satellite_ticket','satellite_remainder')) THEN
    RAISE EXCEPTION 'tournament % has invalid pre-terminal cash evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  IF v_diamond THEN
    -- DIAMOND PHASE 8: the fee of a Diamond event is its fee bank (what came
    -- in as fee, less what was refunded), held in custody until it settles.
    SELECT e.fee_balance + e.fee_out INTO v_rake_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF v_rake_total < 0 OR v_rake_total::text IN ('NaN','Infinity','-Infinity')
     OR v_rake_total IS DISTINCT FROM round(v_rake_total,2) THEN
    RAISE EXCEPTION 'tournament % has malformed rake records',p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  SELECT rs.* INTO v_prior_rake FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_prior_rake.amount IS DISTINCT FROM v_rake_total
       OR v_prior_rake.settled_at IS NULL
       OR (v_prior_rake.attributed_at IS NULL AND NOT v_deferred)
       OR v_prior_rake.attributed_users IS NULL
       OR v_prior_rake.attributed_users < 0
       OR (v_prior_rake.attribution_error IS NOT NULL AND NOT v_deferred)
       OR lower(v_prior_rake.destination) IN ('pending','')
       OR (v_prior_rake.amount > 0 AND v_t.club_id IS NOT NULL AND NOT v_diamond AND NOT v_deferred
           AND (v_prior_rake.attributed_users < 1
             OR (v_prior_rake.destination NOT LIKE 'union:%'
                 AND v_prior_rake.destination NOT LIKE 'club_treasury:%'))) THEN
      RAISE EXCEPTION 'tournament % has a partial or unattributed prior rake row',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_expected_fee := 0;
  ELSE
    v_expected_fee := v_rake_total;
  END IF;

  IF v_diamond THEN
    -- DIAMOND PHASE 8: the escrow shadow of a Diamond event opens here, from
    -- its ledger with its exact parts, so every apply below moves it as a chip
    -- event's evidence moves it and the exact-zero close is the same close.
    PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);
  END IF;
  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM round(v_t.prize_pool-v_cash_before,2)
     OR v_e.bounty_balance IS DISTINCT FROM round(v_t.bounty_pool-v_bounty_before,2)
     OR v_e.fee_balance IS DISTINCT FROM v_expected_fee
     OR v_e.prize_balance < 0 OR v_e.bounty_balance < 0
     OR v_e.fee_balance < 0
     OR v_e.closed_at IS NOT NULL
     OR v_e.close_note IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % escrow does not exactly fund its remaining obligations',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Exactly one branch calls exactly one cash authority.
  IF v_mode = 'places' THEN
    v_cash := public.fn_settle_tournament_places(
      p_tournament_id,p_observed_winner_id);
  ELSE
    v_cash := public.fn_settle_tournament_final_table_deal(p_tournament_id);
  END IF;
  IF COALESCE((v_cash->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_cash->>'fully_settled')::boolean,false) IS NOT TRUE
     OR upper(COALESCE(v_cash->>'status','')) <> 'COMPLETING'
     OR jsonb_typeof(v_cash->'payouts') <> 'array'
     OR jsonb_array_length(v_cash->'payouts') < 1
     OR v_cash->>'winner_amount' IS NULL
     OR (v_cash->>'winner_amount')::numeric < 0
     OR (v_cash->>'winner_amount')::numeric IS DISTINCT FROM
          round((v_cash->>'winner_amount')::numeric,2)
     OR (v_mode = 'final_table_deal'
         AND v_cash->>'money_path'
               IS DISTINCT FROM 'fn_settle_tournament_final_table_deal') THEN
    RAISE EXCEPTION 'tournament % cash authority returned a partial result: %',
      p_tournament_id,v_cash USING ERRCODE = 'P0404';
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF upper(COALESCE(v_t.status::text,'')) <> 'COMPLETING'
     OR COALESCE(v_t.prize_pool_finalized,false) IS NOT TRUE
     OR v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool,2) THEN
    RAISE EXCEPTION 'tournament % cash authority did not claim one finalized pool',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_winner_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'winner' AND tp.position = 1;
  SELECT tp.user_id INTO v_winner_id
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'winner' AND tp.position = 1;
  IF v_winner_count <> 1 OR v_winner_id IS NULL
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_winner_id
          AND (tp.eliminated_at IS NOT NULL
            OR tp.elimination_sequence IS NOT NULL))
     OR (p_observed_winner_id IS NOT NULL
         AND v_winner_id IS DISTINCT FROM p_observed_winner_id)
     OR (SELECT count(*) FROM jsonb_array_elements(v_cash->'payouts') p
          WHERE (p->>'place')::integer = 1
            AND (p->>'user_id')::uuid = v_winner_id
            AND (p->>'amount')::numeric =
                (v_cash->>'winner_amount')::numeric) <> 1 THEN
    RAISE EXCEPTION 'tournament % cash authority left an ambiguous winner',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),round(COALESCE(sum(p.amount),0),2)
    INTO v_cash_count,v_cash_total
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_total IS DISTINCT FROM v_t.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source NOT IN (
            'bounty','bounty_residual','own_bounty','mystery_bounty',
            'mystery_bounty_residual','satellite_seat','satellite_ticket',
            'satellite_remainder')
          AND (p.amount <= 0 OR p.amount IS DISTINCT FROM round(p.amount,2)
            OR p.idempotency_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency k
               WHERE k.key = p.idempotency_key
                 AND k.user_id = p.user_id AND k.amount = p.amount))) THEN
    RAISE EXCEPTION 'tournament % cash pool did not settle exactly',p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  -- The deal authority returns only the still-live chop shares. That is the
  -- right presentation input for the table animation, but it is not the full
  -- prize-pool receipt when eliminated fixed places were already earned.
  -- Store both contracts explicitly: deal_shares is exactly the live chop;
  -- payouts is every non-bubble cash entitlement reconstructed from durable
  -- payout evidence and final standings. Bubble protection remains a distinct
  -- line, so sum(payouts.amount) + bubble_protection.amount is the full pool.
  IF v_mode = 'final_table_deal' THEN
    v_deal_shares := v_cash->'payouts';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_full_payouts
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source <> 'bubble_protection'
         AND p.source NOT IN (
           'bounty','bounty_residual','own_bounty','mystery_bounty',
           'mystery_bounty_residual','satellite_seat','satellite_ticket',
           'satellite_remainder')
       GROUP BY tp.position,p.user_id
    ) q;
  IF v_t.prize_pool = 0 AND v_full_payouts = '[]'::jsonb THEN
    -- The cash authority returns the derived zero-dollar winner line, but a
    -- zero payment correctly creates no tournament_payouts row.
    v_full_payouts := jsonb_build_array(jsonb_build_object(
      'place',1,'user_id',v_winner_id,'amount',0));
  END IF;
  -- A partly paid obligation has several immutable credit intervals, but
  -- exactly one Bubble recipient. Reconstruct that recipient's total from
  -- the durable payouts already verified against their exact credit keys.
  SELECT count(DISTINCT p.user_id) INTO v_bubble_line_count
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  IF v_bubble_line_count > 1 THEN
    RAISE EXCEPTION 'tournament % has more than one durable bubble payout recipient',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT jsonb_build_object(
           'user_id',p.user_id,'position',tp.position,'amount',round(sum(p.amount),2))
    INTO v_cash_bubble
    FROM public.tournament_payouts p
    JOIN public.tournament_players tp
      ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection'
   GROUP BY p.user_id,tp.position;
  v_cash_bubble := COALESCE(v_cash_bubble,'null'::jsonb);
  SELECT (p->>'amount')::numeric INTO v_full_winner_amount
    FROM jsonb_array_elements(v_full_payouts) p
   WHERE (p->>'place')::integer = 1;
  IF v_full_winner_amount IS NULL THEN
    RAISE EXCEPTION 'tournament % has no durable winner cash line',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_cash := v_cash || jsonb_build_object(
    'payouts',v_full_payouts,
    'deal_shares',v_deal_shares,
    'bubble_protection',v_cash_bubble,
    'winner_amount',v_full_winner_amount);

  IF v_mystery_stage = 'active' THEN
    v_mystery := public.fn_mystery_bounty_settle(
      p_tournament_id,v_winner_id);
    IF COALESCE((v_mystery->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_mystery->>'balanced')::boolean,false) IS NOT TRUE
       OR COALESCE((v_mystery->>'pool_cents')::bigint,-1)
            IS DISTINCT FROM v_mystery_pool_cents
       OR COALESCE((v_mystery->>'settled_cents')::bigint,-1)
            IS DISTINCT FROM v_mystery_pool_cents
       OR COALESCE((v_mystery->>'variance_cents')::bigint,1) <> 0 THEN
      RAISE EXCEPTION 'tournament % mystery bounty close was partial: %',
        p_tournament_id,v_mystery USING ERRCODE = 'P0404';
    END IF;
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_winner_id);
    v_mystery := v_mystery || jsonb_build_object(
      'payment_evidence',v_mystery_evidence,
      'residual_paid_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint);
  ELSIF v_mystery_stage = 'complete' THEN
    -- No payer is rerun for an already-complete inventory. The preflight
    -- proved exact terminal chests, awards and mystery obligations plus their
    -- immutable credit-key intervals while all rows were locked. Store that
    -- canonical replay result before the bounty-pool finalizer checks the
    -- mystery completion receipt; this is evidence capture, not a second pay.
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_winner_id);
    v_mystery := jsonb_build_object(
      'ok',true,'reason','already_complete',
      'pool_cents',v_mystery_pool_cents,
      'settled_cents',v_mystery_pool_cents,
      'unclaimed_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint,
      'residual_paid_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint,
      'balanced',true,'variance_cents',0,
      'payment_evidence',v_mystery_evidence);
    INSERT INTO public.tournament_bounty_completion_receipts
      (tournament_id,winner_user_id,mystery_settled_at,mystery_result,updated_at)
    VALUES (p_tournament_id,v_winner_id,now(),v_mystery,now())
    ON CONFLICT (tournament_id) DO UPDATE
      SET mystery_settled_at=COALESCE(
            public.tournament_bounty_completion_receipts.mystery_settled_at,
            EXCLUDED.mystery_settled_at),
          mystery_result=COALESCE(
            public.tournament_bounty_completion_receipts.mystery_result,
            EXCLUDED.mystery_result),
          winner_user_id=COALESCE(
            public.tournament_bounty_completion_receipts.winner_user_id,
            EXCLUDED.winner_user_id),
          updated_at=now();
    IF NOT EXISTS (
      SELECT 1 FROM public.tournament_bounty_completion_receipts r
       WHERE r.tournament_id=p_tournament_id
         AND r.winner_user_id=v_winner_id
         AND r.mystery_settled_at IS NOT NULL
         AND r.mystery_result IS NOT DISTINCT FROM v_mystery
    ) THEN
      RAISE EXCEPTION
        'tournament % completed mystery evidence receipt conflicts with canonical proof',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
  ELSIF COALESCE(v_t.is_mystery_bounty,false) THEN
    v_mystery := jsonb_build_object(
      'ok',true,'reason','never_activated','pool_cents',0,
      'settled_cents',0,'unclaimed_cents',0,'balanced',true,
      'variance_cents',0,'residual_paid_cents',0);
  ELSE
    v_mystery := jsonb_build_object(
      'ok',true,'reason','not_a_mystery_tournament','pool_cents',0,
      'settled_cents',0,'unclaimed_cents',0,'balanced',true,
      'variance_cents',0,'residual_paid_cents',0);
  END IF;

  IF v_is_bounty THEN
    v_bounty := public.fn_finalize_bounty_pool(p_tournament_id,v_winner_id);
    IF COALESCE((v_bounty->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_bounty->>'funded')::boolean,false) IS NOT TRUE
       OR v_bounty->>'residual' IS NULL
       OR (v_bounty->>'residual')::numeric < 0 THEN
      RAISE EXCEPTION 'tournament % bounty pool close was partial: %',
        p_tournament_id,v_bounty USING ERRCODE = 'P0404';
    END IF;
  ELSE
    v_bounty := jsonb_build_object(
      'ok',true,'funded',true,'residual',0,
      'reason','not_a_bounty_tournament');
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_bounty_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND lower(w.category) = 'bounty';
  -- DIAMOND PHASE 9: the same reading after the close.
  IF v_diamond THEN
    SELECT e.bounty_out INTO v_bounty_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF v_bounty_total IS DISTINCT FROM v_t.bounty_pool
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_t.bounty_pool
     OR EXISTS (SELECT 1 FROM public.wallet_transactions w
                 WHERE w.related_entity_id = p_tournament_id
                   AND lower(w.category) = 'bounty'
                   AND (lower(w.type) <> 'credit' OR w.amount <= 0
                     OR w.amount IS DISTINCT FROM round(w.amount,2)))
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND (o.amount_paid IS DISTINCT FROM o.amount_owed
                     OR o.settled_at IS NULL))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id
                   AND c.status NOT IN ('paid','void'))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id
                   AND a.status NOT IN ('completed','void'))
     OR (v_mystery_active AND (
          v_mystery_evidence IS NULL
          OR COALESCE((v_mystery_evidence->>'pool_cents')::bigint,-1)
               IS DISTINCT FROM v_mystery_pool_cents
          OR COALESCE((v_mystery_evidence->>'legacy_credit_cents')::bigint,-1)
             + COALESCE((v_mystery_evidence->>'obligation_cents')::bigint,-1)
               IS DISTINCT FROM v_mystery_pool_cents))
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_awards a
        WHERE a.tournament_id = p_tournament_id
          AND a.status = 'completed'
          AND (a.paid_at IS NULL
            OR (SELECT COALESCE(sum(r.amount_cents),0)
                  FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id = a.id) <> a.amount_cents
            OR EXISTS (SELECT 1
                         FROM public.tournament_bounty_award_recipients r
                        WHERE r.award_id = a.id
                          AND r.amount_cents > 0 AND r.paid_at IS NULL))) THEN
    RAISE EXCEPTION 'tournament % bounty obligations or chests remain open',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- current_bounty is the live head/cache, not payment evidence. The older
  -- finalizer clears only the champion when it itself pays a positive ordinary
  -- residual; an already-exhausted pool or mystery residual can therefore
  -- leave a stale live head after every chip is durably paid. Once exact pool,
  -- obligation and inventory conservation is proved above, zero every head in
  -- this same terminal commit so no completed player advertises open value.
  IF v_is_bounty THEN
    UPDATE public.tournament_players
       SET current_bounty = 0
     WHERE tournament_id = p_tournament_id
       AND COALESCE(current_bounty,0) <> 0;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'tournament % still has a live bounty head after close',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM v_expected_fee THEN
    RAISE EXCEPTION 'tournament % cash/bounty close did not preserve fee escrow',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id,'engine.fn_complete_tournament_terminal');
  IF COALESCE((v_rake_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament % rake authority refused: %',
      p_tournament_id,v_rake_result USING ERRCODE = 'P0404';
  END IF;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  SELECT rs.* INTO v_rake FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id FOR UPDATE;
  IF v_rake.tournament_id IS NULL
     OR v_rake.amount IS DISTINCT FROM v_rake_total
     OR v_rake.settled_at IS NULL OR (v_rake.attributed_at IS NULL AND NOT v_deferred)
     OR v_rake.attributed_users IS NULL OR v_rake.attributed_users < 0
     OR (v_rake.attribution_error IS NOT NULL AND NOT v_deferred)
     OR lower(v_rake.destination) IN ('pending','')
     OR (v_rake.amount > 0 AND v_t.club_id IS NOT NULL AND NOT v_diamond AND NOT v_deferred
         AND (v_rake.attributed_users < 1
           OR (v_rake.destination NOT LIKE 'union:%'
               AND v_rake.destination NOT LIKE 'club_treasury:%'))) THEN
    RAISE EXCEPTION 'tournament % rake attribution did not complete: %',
      p_tournament_id,v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'tournament % did not close all three escrow banks',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_completed_at := COALESCE(v_t.ended_at,transaction_timestamp());
  -- Persist the exact-zero proof before lifecycle. The historical after-status
  -- observer was detached above; this authority is now the only owner of the
  -- terminal escrow marker.
  UPDATE public.tournament_escrow
     SET closed_at = v_completed_at,
         close_note = 'terminal receipt: exact zero',
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND prize_balance = 0 AND bounty_balance = 0 AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its exact zero escrow close',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- Explicitly release every live seat and close every tournament table in
  -- this transaction. No timer, table manager or lifecycle watcher is part of
  -- the completion contract. IDs and counts are captured for immutable replay.
  WITH released AS (
    UPDATE public.table_seats s
       SET left_at = v_completed_at,
           status = 'left',
           leave_pending = false,
           is_sitting_out = false,
           is_away = false,
           sit_out_at = NULL,
           scheduled_leave_hands = NULL
      FROM public.tables tb
     WHERE tb.id = s.table_id
       AND tb.tournament_id = p_tournament_id
       AND s.left_at IS NULL
    RETURNING s.id
  )
  SELECT COALESCE(array_agg(r.id ORDER BY r.id),ARRAY[]::uuid[])
    INTO v_released_seat_ids
    FROM released r;
  v_released_seat_count := cardinality(v_released_seat_ids);

  -- Preserve an earlier departure time, but canonicalize every other mutable
  -- occupancy flag before the immutable source-seat snapshot is committed.
  UPDATE public.table_seats s
     SET status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE s.id = ANY(v_source_seat_ids)
     AND s.left_at IS NOT NULL
     AND (s.status IS DISTINCT FROM 'left'
       OR s.leave_pending IS DISTINCT FROM false
       OR s.is_sitting_out IS DISTINCT FROM false
       OR s.is_away IS DISTINCT FROM false
       OR s.sit_out_at IS NOT NULL
       OR s.scheduled_leave_hands IS NOT NULL);

  -- Publish terminal lifecycle after every seat is released but before table
  -- rows close. The managed table-status observer therefore sees a genuinely
  -- terminal parent and does not emit a false live-tournament incident. The
  -- deferred receipt constraint still requires the receipt later in this same
  -- transaction; any table or receipt failure rolls this update back too.
  UPDATE public.tournaments
     SET status = 'COMPLETED',
         ended_at = v_completed_at,
         on_break = false,
         break_started_at = NULL,
         break_ends_at = NULL,
         updated_at = now()
   WHERE id = p_tournament_id
     AND upper(COALESCE(status::text,'')) = 'COMPLETING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its terminal lifecycle claim',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  UPDATE public.tables
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_completed_at,
         updated_at = now()
   WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_closed_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text,'')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle,'')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_completed_at))
     OR EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables tb ON tb.id = s.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (s.left_at IS NULL
            OR s.status IS DISTINCT FROM 'left'
            OR s.leave_pending IS DISTINCT FROM false
            OR s.is_sitting_out IS DISTINCT FROM false
            OR s.is_away IS DISTINCT FROM false
            OR s.sit_out_at IS NOT NULL
            OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'tournament % did not durably release every seat and close every table',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.tournament_terminal_settlements
    (tournament_id,winner_id,settlement_mode,started_status,
     prize_pool,bounty_pool,cash_payout_count,cash_payout_total,
     bounty_payout_total,mystery_was_active,mystery_pool_cents,
     cash_receipt,mystery_receipt,bounty_receipt,
     closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,
     released_seat_count,released_seat_ids,
     rake_amount,rake_destination,rake_settled_at,rake_attributed_at,
     rake_attributed_users,escrow_closed_at,escrow_close_note,
     completed_at,settled_at,receipt_version,accounting_state)
  VALUES
    (p_tournament_id,v_winner_id,v_mode,v_started_status,
     v_t.prize_pool,v_t.bounty_pool,v_cash_count,v_cash_total,
     v_bounty_total,v_mystery_active,v_mystery_pool_cents,
     v_cash,v_mystery,v_bounty,
     v_closed_table_count,v_closed_table_ids,
     v_source_seat_count,v_source_seat_ids,
     v_released_seat_count,v_released_seat_ids,
     v_rake.amount,v_rake.destination,v_rake.settled_at,v_rake.attributed_at,
     v_rake.attributed_users,v_completed_at,'terminal receipt: exact zero',
     v_completed_at,transaction_timestamp(),CASE WHEN v_accounting IS NULL THEN 1 ELSE 2 END,COALESCE(v_accounting->>'status','legacy'));

  RETURN public.fn_ca_tournament_terminal_receipt(
    p_tournament_id,p_observed_winner_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_terminal_receipt(p_tournament_id uuid, p_observed_winner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_h public.tournament_terminal_settlements%ROWTYPE;
  v_t record;
  v_e public.tournament_escrow%ROWTYPE;
  v_r record;
  v_cash_count integer;
  v_cash_total numeric(15,2);
  v_cash_obligation_total numeric(15,2);
  v_bounty_total numeric(15,2);
  v_rake_total numeric(15,2);
  v_roster_count integer;
  v_winner_count integer;
  v_raw_winner_id uuid;
  v_raw_winner_amount numeric(15,2);
  v_bubble jsonb;
  v_durable_payouts jsonb;
  v_durable_deal_shares jsonb;
  v_durable_bubble jsonb;
  v_durable_table_ids uuid[];
  v_durable_table_count integer;
  v_durable_seat_ids uuid[];
  v_durable_seat_count integer;
  v_durable_released_count integer;
  v_mystery_evidence jsonb;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal receipt requires a tournament id'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_h
    FROM public.tournament_terminal_settlements h
   WHERE h.tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % has no immutable terminal receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF v_h.accounting_state IS DISTINCT FROM COALESCE(v_accounting->>'status','legacy')
     OR (v_accounting IS NOT NULL AND v_h.receipt_version<>2) THEN
    RAISE EXCEPTION 'terminal accounting state has no exact durable receipt' USING ERRCODE='P0404';
  END IF;
  IF p_observed_winner_id IS NOT NULL
     AND v_h.winner_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION 'tournament % receipt winner % differs from observed winner %',
      p_tournament_id, v_h.winner_id, p_observed_winner_id
      USING ERRCODE = '40001';
  END IF;

  SELECT t.id,t.status,t.variant,t.tournament_type,t.satellite_target_id,
         t.satellite_target,t.prize_pool,t.bounty_pool,t.bounty_pool_paid,
         t.is_bounty,t.is_pko,t.is_mystery_bounty,t.mystery_bounty_stage,
         t.mystery_bounty_pool_cents,t.club_id,t.ended_at,t.on_break,
         t.break_started_at,t.break_ends_at
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_t.id IS NULL THEN
    RAISE EXCEPTION 'terminal receipt lost tournament %', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;
  IF lower(COALESCE(v_t.variant::text, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'terminal receipt % belongs to a satellite', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_t.status::text, '')) <> 'COMPLETED'
     OR v_t.ended_at IS DISTINCT FROM v_h.completed_at
     OR COALESCE(v_t.on_break, false)
     OR v_t.break_started_at IS NOT NULL
     OR v_t.break_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is not durably closed by its receipt',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Every mutable child carries the same tuple-owned close fact. This makes a
  -- replay prove the synchronous marker transition itself, while queued
  -- writers can reject from OLD after a row-lock wait without relying on a
  -- pre-wait statement snapshot of the parent or receipt.
  IF EXISTS (SELECT 1 FROM public.tournament_players x
              WHERE x.tournament_id=p_tournament_id
                AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_payouts x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.rake_records x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=p_tournament_id
          AND s.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions x
                 WHERE x.related_entity_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_award_recipients r
       JOIN public.tournament_bounty_awards a ON a.id=r.award_id
        WHERE a.tournament_id=p_tournament_id
          AND r.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_escrow x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.kind NOT IN ('contribution','jackpot_draw')
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at) THEN
    RAISE EXCEPTION 'tournament % mutable evidence lacks its exact terminal marker',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Table closure is money-adjacent terminal state, not an asynchronous UI
  -- cleanup. The immutable identities prove that no tournament table vanished,
  -- appeared or reopened after this receipt and that every seat released by
  -- the terminal transaction still has its exact terminal state.
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[]),count(*)
    INTO v_durable_table_ids,v_durable_table_count
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[]),count(*)
    INTO v_durable_seat_ids,v_durable_seat_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_durable_released_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND s.id = ANY(v_h.released_seat_ids)
     AND s.left_at IS NOT DISTINCT FROM v_h.completed_at
     AND COALESCE(s.status,'') = 'left'
     AND COALESCE(s.leave_pending,false) IS FALSE
     AND COALESCE(s.is_sitting_out,false) IS FALSE;
  IF v_durable_table_ids IS DISTINCT FROM v_h.closed_table_ids
     OR v_durable_table_count IS DISTINCT FROM v_h.closed_table_count
     OR v_durable_seat_ids IS DISTINCT FROM v_h.source_seat_ids
     OR v_durable_seat_count IS DISTINCT FROM v_h.source_seat_count
     OR v_durable_released_count IS DISTINCT FROM v_h.released_seat_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text,'')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle,'')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_h.completed_at))
     OR EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables tb ON tb.id = s.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (s.left_at IS NULL
            OR s.status IS DISTINCT FROM 'left'
            OR s.terminal_closed_at IS DISTINCT FROM v_h.completed_at
            OR s.leave_pending IS DISTINCT FROM false
            OR s.is_sitting_out IS DISTINCT FROM false
            OR s.is_away IS DISTINCT FROM false
            OR s.sit_out_at IS NOT NULL
            OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'tournament % table or seat closure differs from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_t.prize_pool,2) IS DISTINCT FROM v_h.prize_pool
     OR v_t.bounty_pool IS NULL
     OR v_t.bounty_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_t.bounty_pool,2) IS DISTINCT FROM v_h.bounty_pool THEN
    RAISE EXCEPTION 'tournament % pools differ from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE tp.status::text = 'winner'
                            AND tp.position = 1)
    INTO v_roster_count,v_winner_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_roster_count < 1 OR v_winner_count <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_h.winner_id
          AND tp.status::text = 'winner' AND tp.position = 1
          AND tp.eliminated_at IS NULL
          AND tp.elimination_sequence IS NULL)
     OR (SELECT count(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR (SELECT count(DISTINCT tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR (SELECT min(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> 1
     OR (SELECT max(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.status::text NOT IN ('winner','eliminated')) THEN
    RAISE EXCEPTION 'tournament % has ambiguous or incomplete final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF jsonb_typeof(v_h.cash_receipt->'payouts') <> 'array'
     OR COALESCE((v_h.cash_receipt->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_h.cash_receipt->>'fully_settled')::boolean,false) IS NOT TRUE
     OR upper(COALESCE(v_h.cash_receipt->>'status','')) <> 'COMPLETING'
     OR v_h.cash_receipt->>'winner_amount' IS NULL
     OR (v_h.cash_receipt->>'winner_amount')::numeric < 0
     OR (v_h.cash_receipt->>'winner_amount')::numeric IS DISTINCT FROM
          round((v_h.cash_receipt->>'winner_amount')::numeric,2)
     OR (v_h.settlement_mode = 'final_table_deal'
         AND v_h.cash_receipt->>'money_path'
               IS DISTINCT FROM 'fn_settle_tournament_final_table_deal') THEN
    RAISE EXCEPTION 'tournament % stored a malformed cash authority receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT (p->>'user_id')::uuid,(p->>'amount')::numeric
    INTO v_raw_winner_id,v_raw_winner_amount
    FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p
   WHERE (p->>'place')::integer = 1;
  IF v_raw_winner_id IS DISTINCT FROM v_h.winner_id
     OR v_raw_winner_amount IS DISTINCT FROM
          (v_h.cash_receipt->>'winner_amount')::numeric
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p
        WHERE p->>'place' IS NULL OR p->>'user_id' IS NULL
           OR p->>'amount' IS NULL
           OR (p->>'place')::integer < 1
           OR (p->>'amount')::numeric < 0
           OR (p->>'amount')::numeric IS DISTINCT FROM
                round((p->>'amount')::numeric,2)
           OR NOT EXISTS (
             SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.position = (p->>'place')::integer
                AND tp.user_id = (p->>'user_id')::uuid))
     OR (SELECT count(*) FROM jsonb_array_elements(v_h.cash_receipt->'payouts')) < 1
     OR (SELECT count(DISTINCT (p->>'place')::integer)
           FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p)
          <> (SELECT count(*) FROM jsonb_array_elements(v_h.cash_receipt->'payouts')) THEN
    RAISE EXCEPTION 'tournament % cash receipt does not name exact finishers',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Satellite and bounty records never consume the ordinary prize pool.
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.source IN ('satellite_seat','satellite_ticket','satellite_remainder')
  ) THEN
    RAISE EXCEPTION 'non-satellite tournament % carries satellite payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT count(*),round(COALESCE(sum(p.amount),0),2)
    INTO v_cash_count,v_cash_total
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_count IS DISTINCT FROM v_h.cash_payout_count
     OR v_cash_total IS DISTINCT FROM v_h.cash_payout_total
     OR v_cash_total IS DISTINCT FROM v_h.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source NOT IN (
            'bounty','bounty_residual','own_bounty','mystery_bounty',
            'mystery_bounty_residual','satellite_seat','satellite_ticket',
            'satellite_remainder')
          AND (p.amount IS NULL
            OR p.amount::text IN ('NaN','Infinity','-Infinity')
            OR p.amount <= 0 OR p.amount IS DISTINCT FROM round(p.amount,2)
            OR p.idempotency_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency k
               WHERE k.key = p.idempotency_key
                 AND k.user_id = p.user_id AND k.amount = p.amount))) THEN
    RAISE EXCEPTION 'tournament % cash payout evidence is incomplete or malformed',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_durable_payouts
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source <> 'bubble_protection'
         AND p.source NOT IN (
           'bounty','bounty_residual','own_bounty','mystery_bounty',
           'mystery_bounty_residual','satellite_seat','satellite_ticket',
           'satellite_remainder')
       GROUP BY tp.position,p.user_id
    ) q;
  IF v_h.prize_pool = 0 AND v_durable_payouts = '[]'::jsonb THEN
    -- A zero-cash event has a real winner and no wallet/payout mutation. Keep
    -- that explicit standings line in the receipt without inventing durable
    -- payment evidence.
    v_durable_payouts := jsonb_build_array(jsonb_build_object(
      'place',1,'user_id',v_h.winner_id,'amount',0));
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_durable_deal_shares
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'final_table_deal'
       GROUP BY tp.position,p.user_id
    ) q;
  -- Match the terminal writer's one-recipient receipt across every verified
  -- partial credit interval. The exact credit-key and total checks still apply.
  IF (SELECT count(DISTINCT p.user_id) FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'bubble_protection') > 1 THEN
    RAISE EXCEPTION 'tournament % has multiple durable bubble payout recipients',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT jsonb_build_object(
           'user_id',p.user_id,'position',tp.position,'amount',round(sum(p.amount),2))
    INTO v_durable_bubble
    FROM public.tournament_payouts p
    JOIN public.tournament_players tp
      ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection'
   GROUP BY p.user_id,tp.position;
  v_durable_bubble := COALESCE(v_durable_bubble,'null'::jsonb);
  IF v_h.cash_receipt->'payouts' IS DISTINCT FROM v_durable_payouts
     OR jsonb_typeof(v_h.cash_receipt->'deal_shares') <> 'array'
     OR v_h.cash_receipt->'deal_shares' IS DISTINCT FROM
          (CASE WHEN v_h.settlement_mode = 'final_table_deal'
                THEN v_durable_deal_shares ELSE '[]'::jsonb END)
     OR COALESCE(v_h.cash_receipt->'bubble_protection','null'::jsonb)
          IS DISTINCT FROM v_durable_bubble
     OR ((SELECT round(COALESCE(sum((p->>'amount')::numeric),0),2)
            FROM jsonb_array_elements(v_durable_payouts) p)
         + (CASE WHEN v_durable_bubble = 'null'::jsonb THEN 0
                 ELSE (v_durable_bubble->>'amount')::numeric END))
          IS DISTINCT FROM v_h.cash_payout_total THEN
    RAISE EXCEPTION
      'tournament % stored cash lines differ from complete durable payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(o.amount_paid),0),2)
    INTO v_cash_obligation_total
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind IN ('place','bubble_protection','final_table_deal');
  IF v_cash_obligation_total IS DISTINCT FROM v_h.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = p_tournament_id
          AND (o.amount_owed IS NULL OR o.amount_paid IS NULL
            OR o.amount_owed::text IN ('NaN','Infinity','-Infinity')
            OR o.amount_paid::text IN ('NaN','Infinity','-Infinity')
            OR o.amount_owed < 0 OR o.amount_paid < 0
            OR o.amount_owed IS DISTINCT FROM round(o.amount_owed,2)
            OR o.amount_paid IS DISTINCT FROM round(o.amount_paid,2)
            OR o.amount_paid IS DISTINCT FROM o.amount_owed
            OR o.settled_at IS NULL)) THEN
    RAISE EXCEPTION 'tournament % has incomplete or malformed obligations',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(w.amount),0),2)
    INTO v_bounty_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id AND lower(w.category) = 'bounty';
  -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    SELECT e.bounty_out INTO v_bounty_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF v_bounty_total IS DISTINCT FROM v_h.bounty_payout_total
     OR v_bounty_total IS DISTINCT FROM v_h.bounty_pool
     OR EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.related_entity_id = p_tournament_id
          AND lower(w.category) = 'bounty'
          AND (lower(w.type) <> 'credit' OR w.amount <= 0
            OR w.amount::text IN ('NaN','Infinity','-Infinity')
            OR w.amount IS DISTINCT FROM round(w.amount,2)))
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_h.bounty_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'tournament % bounty pool is underfunded, overfunded or still open',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.bounty_pool > 0 THEN
    IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false))
       OR COALESCE((v_h.bounty_receipt->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.bounty_receipt->>'funded')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'tournament % bounty receipt is not a funded close',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
        OR COALESCE(v_t.is_mystery_bounty,false)
        OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                    WHERE o.tournament_id = p_tournament_id
                      AND o.kind IN ('bounty','bounty_residual','mystery_bounty'))
        OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                    WHERE c.tournament_id = p_tournament_id)
        OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                    WHERE a.tournament_id = p_tournament_id) THEN
    RAISE EXCEPTION 'ordinary tournament % carries unfunded bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.mystery_was_active THEN
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_h.winner_id);
    IF COALESCE(v_t.is_mystery_bounty,false) IS NOT TRUE
       OR v_t.mystery_bounty_stage IS DISTINCT FROM 'complete'
       OR COALESCE(v_t.mystery_bounty_pool_cents,0)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR COALESCE((v_h.mystery_receipt->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.mystery_receipt->>'balanced')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.mystery_receipt->>'pool_cents')::bigint,-1)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR COALESCE((v_h.mystery_receipt->>'settled_cents')::bigint,-1)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR (SELECT COALESCE(sum(c.amount_cents),0)
             FROM public.tournament_bounty_chests c
            WHERE c.tournament_id = p_tournament_id)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR v_h.mystery_receipt->'payment_evidence'
            IS DISTINCT FROM v_mystery_evidence
       OR COALESCE((v_h.mystery_receipt->>'residual_paid_cents')::bigint,-1)
            IS DISTINCT FROM
              COALESCE((v_mystery_evidence->>'void_chest_cents')::bigint,0)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id
                     AND c.status NOT IN ('paid','void'))
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id
                     AND a.status NOT IN ('completed','void'))
       OR EXISTS (
         SELECT 1 FROM public.tournament_bounty_awards a
          WHERE a.tournament_id = p_tournament_id
            AND ((a.status = 'completed' AND (
                  a.paid_at IS NULL OR
                  (SELECT COALESCE(sum(r.amount_cents),0)
                     FROM public.tournament_bounty_award_recipients r
                    WHERE r.award_id = a.id) <> a.amount_cents OR
                  EXISTS (SELECT 1
                            FROM public.tournament_bounty_award_recipients r
                           WHERE r.award_id = a.id
                             AND r.amount_cents > 0 AND r.paid_at IS NULL)))
              OR (a.status = 'void' AND EXISTS (
                  SELECT 1 FROM public.tournament_bounty_award_recipients r
                   WHERE r.award_id = a.id AND r.paid_at IS NOT NULL)))) THEN
      RAISE EXCEPTION 'tournament % has open or inconsistent mystery bounty evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSE
    IF v_h.mystery_pool_cents <> 0
       OR COALESCE(v_h.mystery_receipt->>'reason','')
            NOT IN ('never_activated','not_a_mystery_tournament')
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id) THEN
      RAISE EXCEPTION 'tournament % stored an invalid non-active mystery close',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric
     OR v_e.closed_at IS DISTINCT FROM v_h.escrow_closed_at
     OR v_e.close_note IS DISTINCT FROM v_h.escrow_close_note THEN
    RAISE EXCEPTION 'tournament % escrow is not an exact durable zero close',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    -- DIAMOND PHASE 8: a Diamond event's fee is its fee bank, settled to the house.
    SELECT e.fee_balance + e.fee_out INTO v_rake_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  SELECT rs.* INTO v_r FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  IF v_r.tournament_id IS NULL
     OR v_r.amount IS DISTINCT FROM v_rake_total
     OR v_r.amount IS DISTINCT FROM v_h.rake_amount
     OR v_r.destination IS DISTINCT FROM v_h.rake_destination
     OR v_r.settled_at IS DISTINCT FROM v_h.rake_settled_at
     OR v_r.attributed_at IS DISTINCT FROM v_h.rake_attributed_at
     OR v_r.attributed_users IS DISTINCT FROM v_h.rake_attributed_users
     OR v_r.attributed_users IS NULL OR v_r.attributed_users < 0
     OR (v_r.attribution_error IS NOT NULL AND NOT v_deferred)
     OR lower(v_r.destination) IN ('pending','')
     OR (v_r.amount > 0 AND v_t.club_id IS NOT NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id) AND NOT v_deferred
         AND (v_r.attributed_users < 1
           OR v_r.destination NOT LIKE 'union:%'
              AND v_r.destination NOT LIKE 'club_treasury:%')) THEN
    RAISE EXCEPTION 'tournament % rake is not durably and successfully attributed',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_bubble := CASE WHEN v_h.cash_receipt ? 'bubble_protection'
                    THEN v_h.cash_receipt->'bubble_protection'
                   ELSE 'null'::jsonb END;

  RETURN jsonb_build_object(
    'ok',true,
    'fully_settled',true,
    'status','COMPLETED',
    'tournament_id',v_h.tournament_id,
    'winner_id',v_h.winner_id,
    'mode',v_h.settlement_mode,
    'settlement_mode',v_h.settlement_mode,
    'payouts',v_h.cash_receipt->'payouts',
    'deal_shares',v_h.cash_receipt->'deal_shares',
    'winner_amount',(v_h.cash_receipt->>'winner_amount')::numeric,
    'bubble_protection',v_bubble,
    'cash',v_h.cash_receipt,
    'mystery_bounty',v_h.mystery_receipt,
    'bounty',v_h.bounty_receipt,
    'closed_table_count',v_h.closed_table_count,
    'source_seat_count',v_h.source_seat_count,
    'released_seat_count',v_h.released_seat_count,
    'table_closure',jsonb_build_object(
      'closed_table_count',v_h.closed_table_count,
      'closed_table_ids',to_jsonb(v_h.closed_table_ids),
      'source_seat_count',v_h.source_seat_count,
      'source_seat_ids',to_jsonb(v_h.source_seat_ids),
      'released_seat_count',v_h.released_seat_count,
      'released_seat_ids',to_jsonb(v_h.released_seat_ids)),
    'rake',jsonb_build_object(
      'amount',v_h.rake_amount,
      'destination',v_h.rake_destination,
      'attributed',NOT v_deferred,
      'accounting',v_accounting,
      'attributed_users',v_h.rake_attributed_users,
      'settled_at',v_h.rake_settled_at,
      'attributed_at',v_h.rake_attributed_at),
    'escrow',jsonb_build_object(
      'prize_balance',v_e.prize_balance,
      'bounty_balance',v_e.bounty_balance,
      'fee_balance',v_e.fee_balance,
      'closed_at',v_h.escrow_closed_at,
      'close_note',v_h.escrow_close_note),
    'cash_payout_total',v_h.cash_payout_total,
    'bounty_payout_total',v_h.bounty_payout_total,
    'receipt_version',v_h.receipt_version,
    'settled_at',v_h.settled_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_finish_readiness(p_tournament_id uuid, p_winner_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_t public.tournaments%ROWTYPE;
  v_finish public.tournament_finish_receipts%ROWTYPE;
  v_kind text;
  v_failures jsonb := '[]'::jsonb;
  v_winner_count integer := 0;
  v_position_one_count integer := 0;
  v_canonical_winner uuid;
  v_position_one_winner uuid;
  v_open_players integer := 0;
  v_unranked integer := 0;
  v_duplicate_positions integer := 0;
  v_unsettled_obligations integer := 0;
  v_bad_place_evidence integer := 0;
  v_bad_player_prizes integer := 0;
  v_place_owed numeric := 0;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_escrow_found boolean := false;
  v_rake_expected numeric := 0;
  v_rake_recorded numeric;
  v_rake_destination text;
  v_rake_settled_at timestamptz;
  v_rake_attributed_at timestamptz;
  v_rake_found boolean := false;
  v_bounty public.tournament_bounty_completion_receipts%ROWTYPE;
  v_place_batch public.tournament_place_settlement_batches%ROWTYPE;
  v_deal public.tournament_final_table_deal_batches%ROWTYPE;
  v_satellite public.tournament_satellite_settlement_batches%ROWTYPE;
  v_domain_check jsonb;
  v_modern_place boolean := false;
  v_modern_deal boolean := false;
  v_bad_satellite_seats integer := 0;
  v_bad_satellite_outcomes integer := 0;
  v_satellite_award_gaps integer := 0;
BEGIN
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found',
      'failures',jsonb_build_array(jsonb_build_object('code','tournament_not_found')));
  END IF;
  v_kind := public.fn_tournament_finish_kind(p_tournament_id);
  IF v_kind='normal' THEN
    SELECT COALESCE((to_jsonb(b)->>'contract_version')::integer,1)=2
      INTO v_modern_place FROM public.tournament_place_settlement_batches b
     WHERE b.tournament_id=p_tournament_id;
  ELSIF v_kind='final_table_deal' THEN
    SELECT COALESCE((to_jsonb(b)->>'contract_version')::integer,1)=2
      INTO v_modern_deal FROM public.tournament_final_table_deal_batches b
     WHERE b.tournament_id=p_tournament_id;
  END IF;
  v_modern_place:=COALESCE(v_modern_place,false);
  v_modern_deal:=COALESCE(v_modern_deal,false);


  SELECT * INTO v_finish FROM public.tournament_finish_receipts
   WHERE tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','finish_claim_missing'));
  ELSIF v_finish.winner_user_id IS DISTINCT FROM p_winner_user_id
     OR v_finish.finish_kind IS DISTINCT FROM v_kind THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','finish_claim_conflict','claimed_winner',v_finish.winner_user_id,
      'claimed_kind',v_finish.finish_kind,'observed_kind',v_kind));
  END IF;

  SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_winner_count, v_canonical_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status = 'winner' AND tp.position = 1;
  SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
    INTO v_position_one_count, v_position_one_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id AND tp.position = 1;
  IF v_winner_count <> 1 OR v_position_one_count <> 1
     OR v_canonical_winner IS DISTINCT FROM p_winner_user_id
     OR v_position_one_winner IS DISTINCT FROM p_winner_user_id THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','canonical_winner_not_proven','winner_rows',v_winner_count,
      'position_one_rows',v_position_one_count,'observed_winner',v_canonical_winner,
      'requested_winner',p_winner_user_id));
  END IF;

  SELECT count(*) FILTER (WHERE tp.status IN ('registered','playing')),
         count(*) FILTER (WHERE tp.position IS NULL)
    INTO v_open_players, v_unranked
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_duplicate_positions
    FROM (
      SELECT tp.position FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position IS NOT NULL
       GROUP BY tp.position HAVING count(*) <> 1
    ) duplicates;
  IF v_open_players <> 0 OR v_unranked <> 0 OR v_duplicate_positions <> 0 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','standings_not_terminal','open_players',v_open_players,
      'unranked_players',v_unranked,'duplicate_positions',v_duplicate_positions));
  END IF;
  IF COALESCE(v_t.on_break,false) THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','terminal_break_flag_set'));
  END IF;

  SELECT count(*) INTO v_unsettled_obligations
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND abs(round(COALESCE(o.amount_paid,0),2)
           - round(COALESCE(o.amount_owed,0),2)) > 0.005;
  IF v_unsettled_obligations <> 0 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','unsettled_obligations','count',v_unsettled_obligations));
  END IF;

  -- Satellite prize history is one combined entitlement row (ticket value plus
  -- an optional cash remainder). Its format checker proves both constituent
  -- receipts exactly; comparing that cache to either receipt alone would
  -- falsely reject a short-field last-seat winner. The generic relation stays
  -- an independent certificate for every other format.
  IF v_kind <> 'satellite' AND NOT v_modern_place AND NOT v_modern_deal THEN
    SELECT count(*) INTO v_bad_place_evidence
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND o.amount_owed > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = o.tournament_id
            AND tp.position = o.place AND tp.user_id = o.user_id
            AND abs(round(COALESCE(tp.prize,0),2) - round(o.amount_owed,2)) <= 0.005
       );
    SELECT count(*) INTO v_bad_player_prizes
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND round(COALESCE(tp.prize,0),2) > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = tp.tournament_id AND o.kind = 'place'
            AND o.place = tp.position AND o.user_id = tp.user_id
            AND abs(round(o.amount_paid,2) - round(COALESCE(tp.prize,0),2)) <= 0.005
            AND abs(round(o.amount_owed,2) - round(o.amount_paid,2)) <= 0.005
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = tp.tournament_id AND o.kind = 'final_table_deal'
            AND o.user_id = tp.user_id
            AND abs(round(o.amount_paid,2) - round(COALESCE(tp.prize,0),2)) <= 0.005
            AND abs(round(o.amount_owed,2) - round(o.amount_paid,2)) <= 0.005
       );
  END IF;
  IF v_bad_place_evidence <> 0 OR v_bad_player_prizes <> 0 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','prize_evidence_mismatch','place_obligations',v_bad_place_evidence,
      'player_prizes',v_bad_player_prizes));
  END IF;

  IF v_kind = 'normal' THEN
    SELECT * INTO v_place_batch
      FROM public.tournament_place_settlement_batches b
     WHERE b.tournament_id = p_tournament_id;
    IF NOT FOUND OR v_place_batch.settled_at IS NULL THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','atomic_place_batch_not_settled'));
    END IF;

    IF v_modern_place THEN
      BEGIN
        v_domain_check:=public.fn_ca_verify_terminal_place_batch(p_tournament_id,true);
        IF COALESCE((v_domain_check->>'ok')::boolean,false) IS NOT TRUE THEN
          RAISE EXCEPTION 'canonical place proof refused';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_failures:=v_failures||jsonb_build_array(jsonb_build_object(
          'code','canonical_place_batch_not_proven','detail',SQLERRM));
      END;
    END IF;

    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place';
    IF NOT v_modern_place AND abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','prize_pool_not_fully_obligated','prize_pool',v_t.prize_pool,
        'place_obligations',v_place_owed));
    END IF;
    IF round(COALESCE(v_t.guaranteed_prize,0),2)
         > round(COALESCE(v_t.prize_pool,0),2) + 0.005 THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','guarantee_not_funded','guarantee',v_t.guaranteed_prize,
        'prize_pool',v_t.prize_pool));
    END IF;
  END IF;

  SELECT * INTO v_escrow FROM public.tournament_escrow
   WHERE tournament_id = p_tournament_id;
  v_escrow_found := FOUND;
  IF NOT v_escrow_found THEN
    IF COALESCE(v_t.prize_pool,0) <> 0 OR COALESCE(v_t.bounty_pool,0) <> 0
       OR COALESCE(v_t.total_rake,0) <> 0
       OR EXISTS (SELECT 1 FROM public.tournament_payouts po
                   WHERE po.tournament_id = p_tournament_id) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','escrow_evidence_missing'));
    END IF;
  ELSIF abs(round(v_escrow.prize_balance,2)) > 0.005
     OR abs(round(v_escrow.bounty_balance,2)) > 0.005
     OR abs(round(v_escrow.fee_balance,2)) > 0.005 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','escrow_not_zero','prize_balance',v_escrow.prize_balance,
      'bounty_balance',v_escrow.bounty_balance,'fee_balance',v_escrow.fee_balance));
  END IF;

  SELECT GREATEST(round(COALESCE(sum(rr.rake_amount),0),2),0) INTO v_rake_expected
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  SELECT amount,destination,settled_at,attributed_at
    INTO v_rake_recorded,v_rake_destination,v_rake_settled_at,v_rake_attributed_at
    FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  v_rake_found := FOUND;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF NOT v_rake_found OR v_rake_settled_at IS NULL
     OR (v_rake_attributed_at IS NULL AND NOT v_deferred) OR v_rake_destination = 'pending'
     OR abs(round(COALESCE(v_rake_recorded,0),2) - v_rake_expected) > 0.005 THEN
    v_failures := v_failures || jsonb_build_array(jsonb_build_object(
      'code','rake_not_settled','expected',v_rake_expected,
      'recorded',CASE WHEN v_rake_found THEN v_rake_recorded ELSE NULL END,
      'destination',CASE WHEN v_rake_found THEN v_rake_destination ELSE NULL END,
      'attributed_at',CASE WHEN v_rake_found THEN v_rake_attributed_at ELSE NULL END));
  END IF;

  IF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
     OR COALESCE(v_t.is_mystery_bounty,false) THEN
    IF public.fn_tournament_has_unsettled_bounties(p_tournament_id) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','pending_bounty_obligations'));
    END IF;
    SELECT * INTO v_bounty FROM public.tournament_bounty_completion_receipts
     WHERE tournament_id = p_tournament_id;
    IF NOT FOUND OR v_bounty.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR v_bounty.pool_finalized_at IS NULL
       OR COALESCE((v_bounty.pool_result->>'ok')::boolean,false) IS NOT TRUE THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','bounty_pool_not_certified'));
    END IF;
    IF COALESCE(v_t.is_mystery_bounty,false)
       AND COALESCE(v_t.mystery_bounty_stage,'pending') <> 'pending'
       AND (v_bounty.mystery_settled_at IS NULL
            OR COALESCE((v_bounty.mystery_result->>'ok')::boolean,false) IS NOT TRUE
            OR COALESCE((v_bounty.mystery_result->>'balanced')::boolean,false) IS NOT TRUE) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','mystery_bounty_not_certified'));
    END IF;
  END IF;

  IF v_kind = 'final_table_deal' THEN
    SELECT * INTO v_deal FROM public.tournament_final_table_deal_batches
     WHERE tournament_id = p_tournament_id;
    IF NOT FOUND OR v_deal.chip_leader IS DISTINCT FROM p_winner_user_id
       OR v_deal.settled_at IS NULL OR v_deal.escrow_prize_after IS NULL THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','atomic_final_table_deal_batch_not_settled'));
    ELSE
      IF v_modern_deal THEN
        BEGIN
          v_domain_check:=public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id,true);
        EXCEPTION WHEN OTHERS THEN
          v_domain_check:=jsonb_build_object('ok',false,'reason',SQLERRM);
        END;
      ELSE
        v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);
      END IF;
      IF COALESCE((v_domain_check->>'ok')::boolean,false) IS NOT TRUE THEN
        v_failures := v_failures || jsonb_build_array(jsonb_build_object(
          'code','atomic_final_table_deal_not_proven','detail',v_domain_check));
      END IF;
    END IF;
  END IF;

  IF v_kind = 'satellite' THEN
    SELECT * INTO v_satellite
      FROM public.tournament_satellite_settlement_batches b
     WHERE b.tournament_id = p_tournament_id;
    IF NOT FOUND OR v_satellite.winner_user_id IS DISTINCT FROM p_winner_user_id
       OR v_satellite.settled_at IS NULL THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','atomic_satellite_batch_not_settled'));
    ELSE
      v_domain_check := public.fn_check_atomic_satellite_finish(p_tournament_id);
      IF COALESCE((v_domain_check->>'ok')::boolean,false) IS NOT TRUE THEN
        v_failures := v_failures || jsonb_build_array(jsonb_build_object(
          'code','atomic_satellite_finish_not_proven','detail',v_domain_check));
      END IF;
    END IF;

    SELECT count(*) INTO v_bad_satellite_seats
      FROM public.tournament_players target_seat
     WHERE target_seat.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_payouts po
          WHERE po.tournament_id = p_tournament_id
            AND po.source = 'satellite_seat'
            AND po.user_id = target_seat.user_id
            AND po.metadata->>'registration_id' = target_seat.id::text
       );
    IF v_bad_satellite_seats <> 0 THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','satellite_seat_evidence_missing','count',v_bad_satellite_seats));
    END IF;

    -- Every in-kind payout names the original finisher/place and the exact
    -- target registration it funded. A payout row by itself is not a seat,
    -- and a target seat by itself is not a durable payout record.
    SELECT count(*) INTO v_bad_satellite_outcomes
      FROM public.tournament_payouts po
     WHERE po.tournament_id = p_tournament_id AND po.source = 'satellite_seat'
       AND (po."position" IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_players finisher
               WHERE finisher.tournament_id = p_tournament_id
                 AND finisher.user_id = po.user_id
                 AND finisher.position = po."position"
            )
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_players target_seat
               WHERE target_seat.id::text = po.metadata->>'registration_id'
                 AND target_seat.user_id = po.user_id
                 AND target_seat.source_satellite_id = p_tournament_id
            ));

    -- Seat awards and cash ticket fallbacks form a top-finisher prefix. A gap
    -- means a lower place was paid while a higher promised place was skipped.
    WITH awarded_positions AS (
      SELECT po."position" AS place
        FROM public.tournament_payouts po
       WHERE po.tournament_id = p_tournament_id
         AND po.source = 'satellite_seat' AND po."position" IS NOT NULL
      UNION
      SELECT o.place
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
         AND o.place IS NOT NULL AND round(o.amount_paid,2) > 0
         AND abs(round(o.amount_paid,2)-round(o.amount_owed,2)) <= 0.005
    ), bounds AS (SELECT max(place) AS max_place FROM awarded_positions)
    SELECT count(*) INTO v_satellite_award_gaps
      FROM bounds b
      CROSS JOIN LATERAL generate_series(1,b.max_place) expected(place)
     WHERE b.max_place IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM awarded_positions a WHERE a.place=expected.place);

    IF v_bad_satellite_outcomes <> 0 OR v_satellite_award_gaps <> 0
       OR EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = p_tournament_id
            AND o.kind = 'satellite_remainder'
            AND NOT EXISTS (
              SELECT 1 FROM public.tournament_players tp
               WHERE tp.tournament_id=p_tournament_id AND tp.user_id=o.user_id
            )
       ) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'code','satellite_awards_not_certified',
        'invalid_outcomes',v_bad_satellite_outcomes,
        'award_gaps',v_satellite_award_gaps));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok',jsonb_array_length(v_failures) = 0,
    'reason',CASE WHEN jsonb_array_length(v_failures) = 0 THEN NULL
                  ELSE v_failures->0->>'code' END,
    'tournament_id',p_tournament_id,'winner_user_id',p_winner_user_id,
    'finish_kind',v_kind,'failures',v_failures,
    'financials',jsonb_build_object(
      'unsettled_obligations',v_unsettled_obligations,
      'place_obligations',v_place_owed,
      'rake_expected',v_rake_expected,
      'prize_balance',CASE WHEN v_escrow_found THEN v_escrow.prize_balance ELSE NULL END,
      'bounty_balance',CASE WHEN v_escrow_found THEN v_escrow.bounty_balance ELSE NULL END,
      'fee_balance',CASE WHEN v_escrow_found THEN v_escrow.fee_balance ELSE NULL END));
END;
$function$;

-- END tournament-fee-terminal-gates-draft.sql

-- BEGIN tournament-fee-satellite-gates-draft.sql
-- DRAFT. Exact ticket/prize/escrow checks are preserved.
CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament_pre_money_path_gate(p_tournament_id uuid, p_observed_winner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_source record;
  v_target record;
  v_target_after record;
  v_winner public.tournament_players%ROWTYPE;
  v_finisher public.tournament_players%ROWTYPE;
  v_existing_target public.tournament_players%ROWTYPE;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow_after public.tournament_escrow%ROWTYPE;
  v_existing_header public.tournament_satellite_settlements%ROWTYPE;
  v_obligation public.tournament_obligations%ROWTYPE;
  v_observed_target_id uuid;
  v_target_id uuid;
  v_target_open boolean := false;
  v_pool numeric;
  v_target_buy_in numeric;
  v_target_fee numeric;
  v_ticket_cost numeric;
  v_advertised_seats integer;
  v_ticket_award_count integer;
  v_seat_count integer := 0;
  v_cash_ticket_count integer := 0;
  v_entry_ticket_count integer := 0;
  v_remainder numeric;
  v_bubble_position integer;
  v_bubble_user_id uuid;
  v_field_size integer;
  v_target_count integer := 0;
  v_target_count_before integer := 0;
  v_target_live_count integer := 0;
  v_target_live_count_before integer := 0;
  v_target_counter_before integer := 0;
  v_target_counter_after integer := 0;
  v_target_slots integer := 0;
  v_live_count integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_distinct_sequence_count integer;
  v_place integer;
  v_cap_user_id uuid;
  v_cap_load integer;
  v_rows integer;
  v_registration_id uuid;
  v_ticket_id uuid;
  v_ticket_club_id uuid;
  v_ticket_ledger_id uuid;
  v_ticket_transaction_id uuid;
  v_payout_id uuid;
  v_pool_before numeric;
  v_rake_result jsonb;
  v_credited boolean;
  v_payout_count integer;
  v_paid numeric;
  v_delivery_kind text;
  v_payout_key text;
  v_plan jsonb := '[]'::jsonb;
  v_plan_item jsonb;
  v_source_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_source_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_closeout_at timestamptz := transaction_timestamp();
  v_source_escrow_close_note text :=
    'atomic satellite terminal receipt: exact zero';
BEGIN
  -- Every terminal money authority takes this transaction lock before any
  -- row lock. Cash and satellite finishes can pay the same wallets, so one
  -- shared first lock prevents opposite recipient orders from deadlocking.
  PERFORM public.fn_ca_lock_settlement_lane_global();

  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'satellite settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- A committed header wins before target admission is inspected. Replays can
  -- never turn a previously delivered seat into cash because a target closed.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_settlement_receipt(
      p_tournament_id, p_observed_winner_id);
  END IF;

  SELECT COALESCE(t.satellite_target_id, t.satellite_target)
    INTO v_observed_target_id
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_observed_target_id IS NULL OR v_observed_target_id = p_tournament_id THEN
    RAISE EXCEPTION 'satellite % has no distinct target', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  -- During the rolling cutover the legacy seat door still takes target before
  -- source. Match that order until stage two removes it; the global lock also
  -- serializes this authority with every new terminal payer.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_observed_target_id)
   ORDER BY CASE WHEN t.id = v_observed_target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'tournament % disappeared while being locked', p_tournament_id
      USING ERRCODE = '40001';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  v_target_id := COALESCE(v_source.satellite_target_id, v_source.satellite_target);
  IF v_target_id IS DISTINCT FROM v_observed_target_id THEN
    RAISE EXCEPTION 'satellite % target changed while settlement acquired locks',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- A concurrent caller may have committed while this caller waited above.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_settlement_receipt(
      p_tournament_id, p_observed_winner_id);
  END IF;

  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp());
  END IF;

  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % is not a satellite', p_tournament_id
      USING ERRCODE = '22023';
  END IF;
  IF upper(COALESCE(v_source.status, '')) NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'satellite % cannot first-settle from status %',
      p_tournament_id, v_source.status USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE THEN
    RAISE EXCEPTION
      'satellite % prize pool is not finalized; guarantee funding is not proven',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.is_bounty, false)
     OR COALESCE(v_source.is_pko, false)
     OR COALESCE(v_source.is_mystery_bounty, false)
     OR COALESCE(v_source.is_premium_spin, false)
     OR lower(COALESCE(v_source.variant, '')) = 'spin'
     OR upper(COALESCE(v_source.tournament_type, '')) = 'SPIN' THEN
    RAISE EXCEPTION 'satellite % mixes another payout authority', p_tournament_id
      USING ERRCODE = '22023';
  END IF;

  v_pool := v_source.prize_pool;
  v_advertised_seats := COALESCE(v_source.satellite_seats, 0);
  IF v_pool IS NULL OR v_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_pool < 0 OR v_pool IS DISTINCT FROM round(v_pool, 2) THEN
    RAISE EXCEPTION 'satellite % has invalid whole-cent pool %',
      p_tournament_id, v_pool USING ERRCODE = '22003';
  END IF;
  IF v_advertised_seats < 0 THEN
    RAISE EXCEPTION 'satellite % has invalid advertised seat count %',
      p_tournament_id, v_advertised_seats USING ERRCODE = '22003';
  END IF;

  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.buy_in_amount, t.buy_in_fee, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin,
         t.max_players, t.current_players, t.current_level,
         t.late_reg_levels, t.rebuy_levels, t.prize_pool_finalized,
         t.prize_pool, t.total_rake
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_target_id
   FOR UPDATE;
  IF v_target.id IS NULL THEN
    -- PostgreSQL cannot row-lock an absent target. Refuse the settlement so a
    -- concurrent same-id target insert can never race a cash substitution.
    RAISE EXCEPTION
      'satellite % target % is missing; absence cannot authorize cash substitution',
      p_tournament_id, v_target_id USING ERRCODE = 'P0404';
  END IF;
  v_target_buy_in := v_target.buy_in_amount;
  v_target_fee := COALESCE(v_target.buy_in_fee, 0);
  IF v_target_buy_in IS NULL
     OR v_target_buy_in::text IN ('NaN','Infinity','-Infinity')
     OR v_target_buy_in < 0
     OR v_target_buy_in IS DISTINCT FROM round(v_target_buy_in, 2)
     OR v_target_fee IS NULL
     OR v_target_fee::text IN ('NaN','Infinity','-Infinity')
     OR v_target_fee < 0
     OR v_target_fee IS DISTINCT FROM round(v_target_fee, 2) THEN
    RAISE EXCEPTION 'satellite % target has an invalid whole-cent entry contract',
      p_tournament_id USING ERRCODE = '22003';
  END IF;
  v_ticket_cost := round(v_target_buy_in + v_target_fee, 2);
  IF v_ticket_cost <= 0 THEN
    RAISE EXCEPTION 'satellite % target ticket has no positive value',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  -- A bounty or Spin target needs a different, fully receipted split across
  -- prize, fee and bounty rails. This authority deliberately refuses that
  -- contract instead of silently classifying the bounty slice as prize.
  IF (
       v_target.is_bounty IS DISTINCT FROM false
       OR v_target.is_pko IS DISTINCT FROM false
       OR v_target.is_mystery_bounty IS DISTINCT FROM false
       OR v_target.is_premium_spin IS DISTINCT FROM false
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN'
     ) THEN
    RAISE EXCEPTION
      'satellite % target % uses an unsupported bounty or Spin entry split',
      p_tournament_id, v_target_id USING ERRCODE = '22023';
  END IF;
  IF v_pool < v_advertised_seats * v_ticket_cost THEN
    RAISE EXCEPTION
      'satellite % finalized pool % does not fund its % advertised tickets at % each',
      p_tournament_id, v_pool, v_advertised_seats, v_ticket_cost
      USING ERRCODE = 'P0403';
  END IF;

  -- Open and own only the source escrow before the delivery plan is known. A
  -- cash-only plan must not touch a completed target's immutable escrow merely
  -- to prove that no seat will be delivered there.
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id, 'atomic satellite settlement source lock');
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.closed_at IS NOT NULL
     OR v_source_escrow.close_note IS NOT NULL
     OR v_source_escrow.prize_balance IS DISTINCT FROM v_pool
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS NULL
     OR v_source_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
     OR v_source_escrow.fee_balance < 0
     OR v_source_escrow.fee_balance IS DISTINCT FROM round(v_source_escrow.fee_balance, 2)
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION
      'satellite % escrow does not hold exactly its locked pool (pool %, prize %, bounty %, fee %)',
      p_tournament_id, v_pool, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0403';
  END IF;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_target_id)
   ORDER BY tp.tournament_id, tp.id FOR UPDATE;

  -- Keep the same root lock order used by every terminal authority: tournament,
  -- tournament roster, source tables, then source seats. The identities are
  -- frozen before any payer runs and become part of the immutable header.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[]),
         COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id)
                    FILTER (WHERE ts.left_at IS NULL), ARRAY[]::uuid[])
    INTO v_source_seat_ids, v_released_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  v_source_table_count := cardinality(v_source_table_ids);
  v_source_seat_count := cardinality(v_source_seat_ids);
  v_released_seat_count := cardinality(v_released_seat_ids);
  IF v_source_table_count < 1 THEN
    RAISE EXCEPTION 'satellite % has no source table to close', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_field_size FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*),
         count(*) FILTER (
           WHERE tp.status::text IN ('registered','playing'))
    INTO v_target_count, v_target_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = v_target_id;
  v_target_count_before := v_target_count;
  v_target_live_count_before := v_target_live_count;
  -- Before start, current_players is the live lobby count maintained by the
  -- canonical roster trigger. Once RUNNING, it is the immutable total entrant
  -- count and must not shrink when a player is eliminated.
  v_target_counter_before := CASE
    WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
      THEN v_target_live_count_before
    ELSE v_target_count_before
  END;
  IF v_field_size < 1 THEN
    RAISE EXCEPTION 'satellite % has no final field', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND (tp.status IS NULL
         OR tp.status::text NOT IN ('playing','winner','eliminated'))
  ) THEN
    RAISE EXCEPTION 'satellite % still has an unresolved roster',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Apart from the one explicitly adopted historical miss below, a new
  -- settlement must start with no money, target-seat or cache fragments.
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND COALESCE(tp.prize, 0) <> 0)
     OR EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id = p_tournament_id
          AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                       || ':seat:%:pool_transfer')
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = v_target_id
          AND tp.source_satellite_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_target_id
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text) THEN
    RAISE EXCEPTION 'satellite % has partial or legacy settlement evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text IN ('playing','winner');
  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'satellite % still has % live players',
      p_tournament_id, v_live_count USING ERRCODE = '55000';
  ELSIF v_live_count = 1 THEN
    SELECT * INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text IN ('playing','winner');
  ELSE
    SELECT * INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_observed_winner_id
       AND tp.status::text = 'eliminated'
       AND tp.elimination_sequence IS NOT NULL;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.id <> v_winner.id
         AND tp.elimination_sequence = v_winner.elimination_sequence
    ) THEN
      RAISE EXCEPTION
        'satellite % has an ambiguous final elimination witness',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND (tp.elimination_sequence IS NULL
           OR tp.elimination_sequence > v_winner.elimination_sequence)
    ) THEN
      v_winner := NULL;
    END IF;
  END IF;
  IF v_winner.id IS NULL
     OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION
      'observed winner % does not match the locked last survivor in satellite %',
      p_observed_winner_id, p_tournament_id USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = 1 AND tp.user_id IS DISTINCT FROM v_winner.user_id
  ) THEN
    RAISE EXCEPTION 'satellite % assigns first place to another player',
      p_tournament_id USING ERRCODE = '23505';
  END IF;

  UPDATE public.tournament_players
     SET status = 'winner', position = 1,
         eliminated_at = NULL, elimination_sequence = NULL
   WHERE id = v_winner.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not promote exactly one winner',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), count(tp.elimination_sequence),
         count(DISTINCT tp.elimination_sequence)
    INTO v_eliminated_count, v_sequenced_count, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  IF v_eliminated_count <> v_field_size - 1
     OR v_sequenced_count <> v_eliminated_count
     OR v_distinct_sequence_count <> v_eliminated_count THEN
    RAISE EXCEPTION
      'satellite % has no complete durable elimination sequence (%/% of %)',
      p_tournament_id, v_sequenced_count, v_distinct_sequence_count,
      v_eliminated_count USING ERRCODE = 'P0404';
  END IF;

  -- No evidence exists, so numeric positions can be rebuilt from the durable
  -- transition order without relabelling a payment.
  UPDATE public.tournament_players tp
     SET position = NULL
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  WITH ranked AS (
    SELECT tp.id,
           row_number() OVER (
             ORDER BY tp.elimination_sequence DESC, tp.id ASC
           )::integer + 1 AS final_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated'
  )
  UPDATE public.tournament_players tp
     SET position = ranked.final_position
    FROM ranked
   WHERE tp.id = ranked.id;

  SELECT count(*), count(DISTINCT tp.position)
    INTO v_rows, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.position BETWEEN 1 AND v_field_size;
  IF v_rows <> v_field_size OR v_distinct_sequence_count <> v_field_size THEN
    RAISE EXCEPTION 'satellite % could not prove contiguous final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_ticket_award_count := floor(v_pool / v_ticket_cost)::integer;
  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);
  IF v_remainder < 0 OR v_remainder >= v_ticket_cost THEN
    RAISE EXCEPTION 'satellite % derived invalid residual % below ticket %',
      p_tournament_id, v_remainder, v_ticket_cost USING ERRCODE = '23514';
  END IF;
  IF (v_ticket_award_count
      + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END) > v_field_size THEN
    RAISE EXCEPTION
      'satellite % pool needs % ticket/remainder finishers but field has %',
      p_tournament_id,
      v_ticket_award_count + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END,
      v_field_size USING ERRCODE = '23514';
  END IF;
  IF v_remainder > 0 THEN
    v_bubble_position := v_ticket_award_count + 1;
    SELECT tp.user_id INTO v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_position;
    IF NOT FOUND OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'satellite % has no single bubble at place %',
        p_tournament_id, v_bubble_position USING ERRCODE = 'P0404';
    END IF;
  END IF;

  -- Decide a complete immutable delivery plan while target and roster locks are
  -- held. Only explicit terminal or full states become cash. Any other
  -- unknown lifecycle state refuses the whole settlement.
  IF COALESCE(v_target.max_players, 0) < 0
     OR v_target.late_reg_levels < 0
     OR v_target.rebuy_levels < 0 THEN
    RAISE EXCEPTION
      'satellite % target % has invalid admission bounds',
      p_tournament_id, v_target_id USING ERRCODE = '22003';
  END IF;
  IF v_target.max_players IS NOT NULL AND v_target.max_players > 0
     AND v_target_count >= v_target.max_players THEN
    v_target_open := false;
  ELSIF COALESCE(v_target.prize_pool_finalized, false) THEN
    v_target_open := false;
  ELSIF upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING') THEN
    v_target_open := true;
  ELSIF upper(COALESCE(v_target.status, '')) = 'RUNNING' THEN
    IF v_target.current_level < 0 THEN
      RAISE EXCEPTION
        'satellite % target % has invalid RUNNING admission level',
        p_tournament_id, v_target_id USING ERRCODE = '55000';
    END IF;
    -- The target row and both rosters are already locked. Delegate the actual
    -- RUNNING admission decision to the same canonical authority used by every
    -- other late-registration path, including its minutes-based fallback.
    v_target_open :=
      public.fn_tournament_late_registration_open(v_target_id);
  ELSIF upper(COALESCE(v_target.status, '')) IN
        ('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
    v_target_open := false;
  ELSE
    RAISE EXCEPTION
      'satellite % target % admission state % is ambiguous',
      p_tournament_id, v_target_id, v_target.status
      USING ERRCODE = '55000';
  END IF;
  IF v_target_open THEN
    v_target_slots := CASE
      WHEN v_target.max_players IS NULL OR v_target.max_players = 0
        THEN v_ticket_award_count
      ELSE GREATEST(v_target.max_players - v_target_count, 0)
    END;
  END IF;

  -- The booking and live-seat triggers serialize every four-table decision on
  -- this same user key. Take all winner keys in UUID order before classifying
  -- anyone, so a concurrent seat cannot race a direct-ticket disposition and
  -- two multi-award satellites cannot deadlock by taking the keys oppositely.
  FOR v_cap_user_id IN
    SELECT tp.user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND tp.position BETWEEN 1 AND v_ticket_award_count
     ORDER BY tp.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('table_cap:'||v_cap_user_id::text,0));
  END LOOP;

  IF v_ticket_award_count > 0 THEN
    FOR v_place IN 1..v_ticket_award_count LOOP
      SELECT * INTO v_finisher FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position = v_place;
      IF v_finisher.id IS NULL THEN
        RAISE EXCEPTION 'satellite % has no finisher at ticket place %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_delivery_kind := 'cash';
      SELECT * INTO v_existing_target FROM public.tournament_players tp
       WHERE tp.tournament_id = v_target_id
         AND tp.user_id = v_finisher.user_id;
      IF FOUND THEN
        IF COALESCE(v_existing_target.is_satellite_qualifier, false) IS NOT TRUE THEN
          v_delivery_kind := 'cash';
        ELSIF v_existing_target.source_satellite_id IS NULL THEN
          RAISE EXCEPTION
            'satellite % cannot prove origin of target seat held by place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSIF v_existing_target.source_satellite_id = p_tournament_id THEN
          RAISE EXCEPTION
            'satellite % has an unreceipted target seat already delivered to place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSE
          v_delivery_kind := 'cash';
        END IF;
      ELSIF v_target_open AND v_seat_count < v_target_slots THEN
        v_cap_load:=public.fn_concurrent_game_load(
          v_finisher.user_id,NULL,NULL,v_target_id);
        IF v_cap_load>=4 THEN
          -- The cap remains absolute. The winner receives the funded entry as
          -- a noncash tournament ticket instead of a fifth game or wallet chips.
          v_delivery_kind := 'ticket';
        ELSE
          v_delivery_kind := 'seat';
        END IF;
      END IF;

      IF v_delivery_kind = 'seat' THEN
        v_seat_count := v_seat_count + 1;
      ELSIF v_delivery_kind = 'ticket' THEN
        v_entry_ticket_count := v_entry_ticket_count + 1;
      ELSE
        v_cash_ticket_count := v_cash_ticket_count + 1;
      END IF;
      v_plan := v_plan || jsonb_build_array(jsonb_build_object(
        'place', v_place,
        'user_id', v_finisher.user_id,
        'delivery_kind', v_delivery_kind));
    END LOOP;
  END IF;
  IF v_seat_count + v_cash_ticket_count + v_entry_ticket_count
       <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % did not classify every funded ticket',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- Closed/full/independently-held tickets are cash substitutions and do not
  -- touch target aggregates. Validate those mutable target banks only when
  -- this exact plan will add at least one real registration.
  IF v_seat_count > 0 THEN
    -- Zero-delta reconstruction is a write when the escrow already exists, so
    -- it belongs after seat classification and only on the actual seat path.
    PERFORM public.fn_ca_escrow_apply(
      v_target_id, 'atomic satellite settlement target seat lock');
    SELECT * INTO v_target_escrow FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
  END IF;
  IF v_seat_count > 0 AND (
       v_target.current_players IS NULL
       OR v_target.current_players < 0
       OR v_target.current_players IS DISTINCT FROM v_target_counter_before
       OR v_target.prize_pool IS NULL
       OR v_target.prize_pool::text IN ('NaN','Infinity','-Infinity')
       OR v_target.prize_pool < 0
       OR v_target.prize_pool IS DISTINCT FROM round(v_target.prize_pool, 2)
       OR v_target.total_rake IS NULL
       OR v_target.total_rake::text IN ('NaN','Infinity','-Infinity')
       OR v_target.total_rake < 0
       OR v_target.total_rake IS DISTINCT FROM round(v_target.total_rake, 2)
       OR (v_target_fee > 0 AND v_target.club_id IS NULL)
       OR v_target_escrow.tournament_id IS NULL
       OR v_target_escrow.enforced IS DISTINCT FROM true
       OR v_target_escrow.closed_at IS NOT NULL
       OR v_target_escrow.close_note IS NOT NULL
       OR v_target_escrow.prize_balance IS NULL
       OR v_target_escrow.prize_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.prize_balance < 0
       OR v_target_escrow.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance, 2)
       OR v_target.prize_pool IS DISTINCT FROM v_target_escrow.prize_balance
       OR v_target_escrow.bounty_balance IS DISTINCT FROM 0::numeric
       OR v_target_escrow.fee_balance IS NULL
       OR v_target_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.fee_balance < 0
       OR v_target_escrow.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance, 2)
       OR v_target.total_rake IS DISTINCT FROM v_target_escrow.fee_balance
       OR EXISTS (
         SELECT 1
           FROM unnest(ARRAY[
             'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
             'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
             'refund_prize','refund_bounty','refund_fee',
             'reserve_out','reserve_in'
           ]::text[]) AS component(name)
           CROSS JOIN LATERAL (
             SELECT (to_jsonb(v_target_escrow)->>component.name)::numeric AS amount
           ) AS persisted
          WHERE persisted.amount IS NULL
             OR CASE
                  WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                    THEN true
                  ELSE persisted.amount < 0
                    OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
                END
       )
     ) THEN
    RAISE EXCEPTION
      'satellite % cannot deliver a target seat against malformed aggregate or escrow state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, target_id, target_was_missing, target_contract_version,
     winner_id, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, entry_ticket_count,
     remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, source_closed_at,
     source_escrow_closed_at, source_escrow_close_note, settled_at)
  VALUES
    (p_tournament_id, v_target_id, false, NULL,
     p_observed_winner_id, v_field_size, v_advertised_seats, v_pool,
     v_target_buy_in, v_target_fee, v_ticket_cost, v_ticket_award_count,
     v_seat_count, v_cash_ticket_count, v_entry_ticket_count, v_remainder,
     v_bubble_user_id, v_bubble_position,
     v_source_table_count, v_source_table_ids, v_source_seat_count,
     v_source_seat_ids, v_released_seat_count, v_released_seat_ids,
     v_closeout_at, v_closeout_at, v_source_escrow_close_note, v_closeout_at);

  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = now()
   WHERE id = p_tournament_id
     AND upper(COALESCE(status, '')) IN ('RUNNING','COMPLETING')
     AND COALESCE(prize_pool_finalized, false);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not claim its atomic settlement',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  FOR v_plan_item IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    v_place := (v_plan_item->>'place')::integer;
    v_delivery_kind := v_plan_item->>'delivery_kind';
    SELECT * INTO v_finisher FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_place
       AND tp.user_id = (v_plan_item->>'user_id')::uuid;
    IF v_finisher.id IS NULL THEN
      RAISE EXCEPTION 'satellite % delivery plan lost finisher at place %',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;

    IF v_delivery_kind = 'seat' THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status,
         is_satellite_qualifier, source_satellite_id)
      VALUES
        (v_target_id, v_finisher.user_id, v_finisher.username, 0, 'registered',
         true, p_tournament_id)
      RETURNING id INTO v_registration_id;
      IF v_registration_id IS NULL THEN
        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'prize_liability', v_target_id, 'tournaments.prize_pool+total_rake',
         v_ticket_cost, 'tournament_buyin', v_target.club_id, p_tournament_id,
         'tourney:' || p_tournament_id::text || ':seat:'
            || v_finisher.user_id::text || ':pool_transfer',
         'satellite:' || p_tournament_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket place %s delivered as target seat (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'satellite_seat_pool_transfer',
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'position', v_place,
           'registration_id', v_registration_id,
           'seat_value', v_ticket_cost,
           'moved', v_ticket_cost,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2));

      -- The transfer leg puts the complete ticket into target satellite-in.
      -- A positive fee row reclassifies only that fee from target prize to
      -- target fee escrow. A zero-fee target needs no synthetic rake record.
      IF v_target_fee > 0 THEN
        INSERT INTO public.rake_records
          (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
           bbj_contribution, is_tournament, tournament_id, source, metadata)
        VALUES
          (NULL, NULL, v_target.club_id, v_target_fee, v_ticket_cost, 1,
           0, true, v_target_id, 'fn_award_satellite_seat',
           jsonb_build_object(
             'kind', 'satellite_seat_entry_fee',
             'recorded_by', 'fn_settle_satellite_tournament',
             'user_id', v_finisher.user_id,
             'position', v_place,
             'satellite_id', p_tournament_id,
             'registration_id', v_registration_id));
      END IF;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':seat:' || v_finisher.user_id::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_place, v_ticket_cost,
         'satellite_seat', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'registration_id', v_registration_id,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'pool_transfer', v_ticket_cost,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, registration_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'seat', v_ticket_cost,
         v_payout_id, 'satellite_seat', v_payout_key, v_registration_id);
    ELSIF v_delivery_kind = 'ticket' THEN
      -- A four-table cap is not an economic failure and cannot turn a funded
      -- satellite award into wallet chips. Resolve the exact target club and
      -- escrow the funded award in a target-scoped, noncash ticket instead.
      v_ticket_club_id := public.fn_tournament_club_for_user(
        v_finisher.user_id, v_target_id,
        COALESCE(v_target.club_id, v_source.club_id));
      -- A UNION TICKET IS ISSUED AT THE CLUB THE WINNER PLAYS FROM
      -- (2026-09-10): a union-hosted target accepts a ticket at any member
      -- club of its union, exactly as redemption already does. Demanding the
      -- house club refused every capped winner of a union satellite.
      IF v_ticket_club_id IS NULL
         OR (v_target.club_id IS NOT NULL
             AND v_ticket_club_id IS DISTINCT FROM v_target.club_id
             AND NOT EXISTS (
               SELECT 1 FROM public.tournaments tt
               JOIN public.union_clubs uc ON uc.union_id = tt.union_id
              WHERE tt.id = v_target_id AND uc.club_id = v_ticket_club_id)) THEN
        RAISE EXCEPTION
          'satellite % ticket place % has no exact target club',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_ticket_id := gen_random_uuid();
      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_place, v_ticket_cost,
         'satellite_ticket', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_tickets
        (id, club_id, issued_by, holder_id, value, status, note,
         redemption_mode, source_tournament_id, source_satellite_id,
         source_refund_entitlement_id, source_satellite_award_place,
         entry_prize, entry_bounty, entry_fee, created_at)
      VALUES
        (v_ticket_id, v_ticket_club_id,
         '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
         v_finisher.user_id, v_ticket_cost, 'issued',
         'Four-Table Cap Satellite Award: Tournament Entry Only',
         'tournament_entry_only', v_target_id, p_tournament_id,
         NULL, v_place, v_target_buy_in, 0, v_target_fee,
         transaction_timestamp());

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance,
         pre_to_balance, post_to_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'escrow', v_ticket_id, 'satellite tournament entry ticket',
         v_ticket_cost, 'ticket_issue', v_ticket_club_id, p_tournament_id,
         v_payout_key || ':ticket_escrow',
         'satellite-ticket:' || v_ticket_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket place %s held as noncash target entry (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'direct_satellite_entry_ticket',
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'payout_id', v_payout_id,
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'position', v_place,
           'entry_prize', v_target_buy_in,
           'entry_bounty', 0,
           'entry_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2),
         0, v_ticket_cost)
      RETURNING id INTO v_ticket_ledger_id;

      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type,
         notes, balance_after, metadata)
      VALUES
        (v_ticket_club_id, NULL, v_finisher.user_id, v_ticket_cost,
         'tournament_ticket_issue',
         'Satellite Award Held As Tournament-Entry Ticket', NULL,
         jsonb_build_object(
           'ticket_id', v_ticket_id,
           'escrow_entity_id', v_ticket_id,
           'holder_id', v_finisher.user_id,
           'value', v_ticket_cost,
           'redemption_mode', 'tournament_entry_only',
           'source_tournament_id', v_target_id,
           'source_satellite_id', p_tournament_id,
           'source_award_place', v_place,
           'payout_id', v_payout_id,
           'ledger_id', v_ticket_ledger_id,
           'idempotency_key', v_payout_key,
           'wallet_chips_credited', 0))
      RETURNING id INTO v_ticket_transaction_id;

      PERFORM public.fn_ca_escrow_apply(
        p_tournament_id, 'direct satellite entry ticket out',
        p_prize_out => v_ticket_cost);

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, ticket_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'ticket',
         v_ticket_cost, v_payout_id, 'satellite_ticket', v_payout_key,
         v_ticket_id);
    ELSIF v_delivery_kind = 'cash' THEN
      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'seat', v_place, v_finisher.user_id,
         v_ticket_cost, 0, 'engine.fn_settle_satellite_tournament', NULL)
      RETURNING * INTO v_obligation;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      v_credited := public.fn_credit_and_log(
        p_user_id => v_finisher.user_id,
        p_amount => v_ticket_cost,
        p_idempotency_key => v_payout_key,
        p_category => 'prize',
        p_description => 'Satellite ticket paid in cash because target admission was definitively unavailable',
        p_related_entity_id => p_tournament_id,
        p_wallet_type => 'PLAYER',
        p_table_id => NULL,
        p_hand_id => NULL,
        p_payout_position => v_place,
        p_payout_source => 'satellite_ticket');
      IF v_credited IS NOT TRUE THEN
        RAISE EXCEPTION 'satellite % cash ticket % was not a new exact credit',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      UPDATE public.tournament_obligations o
         SET amount_paid = v_ticket_cost, settled_at = now(), updated_at = now()
       WHERE o.id = v_obligation.id
         AND o.amount_owed = v_ticket_cost AND o.amount_paid = 0;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'satellite % could not close cash ticket debt %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      SELECT p.id INTO v_payout_id FROM public.tournament_payouts p
       WHERE p.idempotency_key = v_payout_key
         AND p.tournament_id = p_tournament_id
         AND p.user_id = v_finisher.user_id
         AND p."position" = v_place
         AND p.amount = v_ticket_cost
         AND p.source = 'satellite_ticket';
      IF v_payout_id IS NULL THEN
        RAISE EXCEPTION 'satellite % cash ticket % has no payout row',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key,
         obligation_id, obligation_kind)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'cash', v_ticket_cost,
         v_payout_id, 'satellite_ticket', v_payout_key,
         v_obligation.id, 'seat');
    ELSE
      RAISE EXCEPTION 'satellite % has unknown delivery kind % at place %',
        p_tournament_id, v_delivery_kind, v_place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  IF v_seat_count > 0 THEN
    SELECT count(*),
           count(*) FILTER (
             WHERE tp.status::text IN ('registered','playing'))
      INTO v_target_count, v_target_live_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_target_id;
    v_target_counter_after := CASE
      WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
        THEN v_target_live_count
      ELSE v_target_count
    END;
    IF v_target_count IS DISTINCT FROM v_target_count_before + v_seat_count
       OR v_target_live_count IS DISTINCT FROM
            v_target_live_count_before + v_seat_count
       OR v_target_counter_after IS DISTINCT FROM
            v_target_counter_before + v_seat_count THEN
      RAISE EXCEPTION
        'satellite % target roster changed outside its locked delivery plan',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    UPDATE public.tournaments
       SET current_players = v_target.current_players + v_seat_count,
           prize_pool = round(COALESCE(prize_pool, 0)
                              + v_seat_count * v_target_buy_in, 2),
           total_rake = round(COALESCE(total_rake, 0)
                             + v_seat_count * v_target_fee, 2),
           updated_at = now()
     WHERE id = v_target_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not update target aggregate receipt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT t.id, t.current_players, t.prize_pool, t.total_rake
      INTO v_target_after
      FROM public.tournaments t
     WHERE t.id = v_target_id;
    SELECT * INTO v_target_escrow_after
      FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
    IF v_target_after.id IS NULL
       OR v_target_after.current_players IS DISTINCT FROM
            v_target.current_players + v_seat_count
       OR v_target_after.current_players IS DISTINCT FROM v_target_counter_after
       OR v_target_after.prize_pool IS DISTINCT FROM
            round(v_target.prize_pool + v_seat_count * v_target_buy_in, 2)
       OR v_target_after.total_rake IS DISTINCT FROM
            round(v_target.total_rake + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.tournament_id IS DISTINCT FROM v_target_id
       OR v_target_escrow_after.enforced IS DISTINCT FROM v_target_escrow.enforced
       OR v_target_escrow_after.gross_in IS DISTINCT FROM v_target_escrow.gross_in
       OR v_target_escrow_after.fee_entries_in IS DISTINCT FROM v_target_escrow.fee_entries_in
       OR v_target_escrow_after.satellite_fee_in IS DISTINCT FROM
            round(v_target_escrow.satellite_fee_in
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.bounty_in IS DISTINCT FROM v_target_escrow.bounty_in
       OR v_target_escrow_after.overlay_in IS DISTINCT FROM v_target_escrow.overlay_in
       OR v_target_escrow_after.satellite_in IS DISTINCT FROM
            round(v_target_escrow.satellite_in
                  + v_seat_count * v_target_buy_in, 2)
       OR v_target_escrow_after.prize_out IS DISTINCT FROM v_target_escrow.prize_out
       OR v_target_escrow_after.bounty_out IS DISTINCT FROM v_target_escrow.bounty_out
       OR v_target_escrow_after.fee_out IS DISTINCT FROM v_target_escrow.fee_out
       OR v_target_escrow_after.refund_prize IS DISTINCT FROM v_target_escrow.refund_prize
       OR v_target_escrow_after.refund_bounty IS DISTINCT FROM v_target_escrow.refund_bounty
       OR v_target_escrow_after.refund_fee IS DISTINCT FROM v_target_escrow.refund_fee
       OR v_target_escrow_after.reserve_out IS DISTINCT FROM v_target_escrow.reserve_out
       OR v_target_escrow_after.reserve_in IS DISTINCT FROM v_target_escrow.reserve_in
       OR v_target_escrow_after.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance
                  + v_seat_count * v_target_buy_in, 2)
       OR v_target_escrow_after.bounty_balance IS DISTINCT FROM v_target_escrow.bounty_balance
       OR v_target_escrow_after.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.opened_at IS DISTINCT FROM v_target_escrow.opened_at
       OR v_target_escrow_after.opened_from IS DISTINCT FROM v_target_escrow.opened_from
       OR v_target_escrow_after.closed_at IS DISTINCT FROM v_target_escrow.closed_at
       OR v_target_escrow_after.close_note IS DISTINCT FROM v_target_escrow.close_note THEN
      RAISE EXCEPTION
        'satellite % target aggregate or escrow delta is not the exact delivered seat value',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF v_remainder > 0 THEN
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid,
       source, settled_at)
    VALUES
      (p_tournament_id, 'satellite_remainder', v_bubble_position,
       v_bubble_user_id, v_remainder, 0,
       'engine.fn_settle_satellite_tournament', NULL)
    RETURNING * INTO v_obligation;

    v_payout_key := 'tourney:' || p_tournament_id::text
                    || ':satellite_remainder:place:'
                    || v_bubble_position::text;
    v_credited := public.fn_credit_and_log(
      p_user_id => v_bubble_user_id,
      p_amount => v_remainder,
      p_idempotency_key => v_payout_key,
      p_category => 'prize',
      p_description => 'Satellite pool remainder paid to the single bubble',
      p_related_entity_id => p_tournament_id,
      p_wallet_type => 'PLAYER',
      p_table_id => NULL,
      p_hand_id => NULL,
      p_payout_position => v_bubble_position,
      p_payout_source => 'satellite_remainder');
    IF v_credited IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite % remainder credit was not a new exact credit',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    UPDATE public.tournament_obligations
       SET amount_paid = v_remainder, settled_at = now(), updated_at = now()
     WHERE id = v_obligation.id
       AND tournament_id = p_tournament_id
       AND kind = 'satellite_remainder' AND place = v_bubble_position
       AND user_id = v_bubble_user_id
       AND amount_owed = v_remainder
       AND amount_paid = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not close one exact remainder debt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT p.id INTO v_payout_id
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_bubble_user_id
       AND p."position" = v_bubble_position
       AND p.amount = v_remainder
       AND p.source = 'satellite_remainder'
       AND p.idempotency_key = v_payout_key;
    IF v_payout_id IS NULL THEN
      RAISE EXCEPTION 'satellite % remainder has no exact payout row',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    INSERT INTO public.tournament_satellite_remainders
      (tournament_id, user_id, place, amount,
       payout_id, payout_source, payout_position, idempotency_key,
       obligation_id, obligation_kind, obligation_place, evidence_kind)
    VALUES
      (p_tournament_id, v_bubble_user_id, v_bubble_position, v_remainder,
       v_payout_id, 'satellite_remainder', v_bubble_position, v_payout_key,
       v_obligation.id, 'satellite_remainder', v_bubble_position, 'atomic');
  END IF;

  UPDATE public.tournament_players SET prize = 0
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_players SET prize = v_ticket_cost
   WHERE tournament_id = p_tournament_id
     AND position BETWEEN 1 AND v_ticket_award_count;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % stamped % ticket caches, expected %',
      p_tournament_id, v_rows, v_ticket_award_count USING ERRCODE = 'P0404';
  END IF;
  IF v_remainder > 0 THEN
    UPDATE public.tournament_players SET prize = v_remainder
     WHERE tournament_id = p_tournament_id
       AND user_id = v_bubble_user_id AND position = v_bubble_position;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not stamp the single bubble cache',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_payout_count, v_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_payout_count <> (v_ticket_award_count
                        + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END)
     OR v_paid IS DISTINCT FROM v_pool THEN
    RAISE EXCEPTION 'satellite % paid % of locked pool % across % rows',
      p_tournament_id, v_paid, v_pool, v_payout_count
      USING ERRCODE = 'P0404';
  END IF;

  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id, 'engine.fn_settle_satellite_tournament');
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF COALESCE((v_rake_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_rake_result->>'amount')::numeric, 0) > 0
         AND COALESCE((v_rake_result->>'attributed')::boolean, false) IS NOT TRUE AND NOT v_deferred) THEN
    RAISE EXCEPTION 'satellite % rake did not settle and attribute exactly: %',
      p_tournament_id, v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION
      'satellite % settlement leaves escrow prize %, bounty %, fee %',
      p_tournament_id, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0404';
  END IF;

  -- The atomic authority, not the legacy lifecycle observer, owns the escrow
  -- close. Stamp the exact zero proof before publishing COMPLETED so the
  -- receipt remains valid after that observer is retired by the terminal
  -- cutover migration.
  UPDATE public.tournament_escrow
     SET closed_at = v_closeout_at,
         close_note = v_source_escrow_close_note,
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND closed_at IS NULL
     AND close_note IS NULL
     AND prize_balance = 0
     AND bounty_balance = 0
     AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit its exact escrow close',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- Source felt closure is part of the money commit. This runs after tickets,
  -- the single Bubble remainder, rake and escrow so any table/seat refusal
  -- rolls all of those effects back. The pre-payer identity arrays prevent a
  -- concurrent table or seat from appearing outside the receipt.
  UPDATE public.table_seats ts
     SET left_at = v_closeout_at,
         status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_released_seat_ids)
     AND ts.left_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_released_seat_count THEN
    RAISE EXCEPTION 'satellite % released % source seats, expected %',
      p_tournament_id, v_rows, v_released_seat_count USING ERRCODE = '40001';
  END IF;

  -- Elimination already gave predeparted seats a durable departure time. Close
  -- only their mutable occupancy flags here; never rewrite that historical time
  -- or fire left_at-specific effects a second time.
  UPDATE public.table_seats ts
     SET status = 'left', leave_pending = false, is_sitting_out = false,
         is_away = false, sit_out_at = NULL, scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_source_seat_ids)
     AND ts.left_at IS NOT NULL
     AND (ts.status IS DISTINCT FROM 'left'
       OR ts.leave_pending IS DISTINCT FROM false
       OR ts.is_sitting_out IS DISTINCT FROM false
       OR ts.is_away IS DISTINCT FROM false
       OR ts.sit_out_at IS NOT NULL
       OR ts.scheduled_leave_hands IS NOT NULL);

  -- Mark the game terminal only after its seats are released, but before its
  -- tables close. The existing table-status trigger treats a close under a
  -- COMPLETING tournament as an accidental live-game close and files an
  -- incident. COMPLETED is therefore the canonical parent-before-child order.
  -- A later table-close refusal still rolls this status and all money back.
  UPDATE public.tournaments
     SET status = 'COMPLETED', ended_at = now(), prize_pool_finalized = true,
         current_players = 0, on_break = false,
         break_started_at = NULL, break_ends_at = NULL, updated_at = now()
   WHERE id = p_tournament_id AND upper(COALESCE(status, '')) = 'COMPLETING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit COMPLETING to COMPLETED',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  UPDATE public.tables tb
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_closeout_at,
         updated_at = now()
   WHERE tb.id = ANY(v_source_table_ids)
     AND tb.tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_source_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % did not durably release every source seat and close every source table',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  RETURN public.fn_ca_satellite_settlement_receipt(
    p_tournament_id, p_observed_winner_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_satellite_settlement_receipt(p_tournament_id uuid, p_observed_winner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_h public.tournament_satellite_settlements%ROWTYPE;
  v_source record;
  v_target record;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_rake_settlement record;
  v_field_size integer;
  v_position_count integer;
  v_rows integer;
  v_expected_rows integer;
  v_amount numeric;
  v_rake numeric;
  v_awards jsonb := '[]'::jsonb;
  v_seats jsonb := '[]'::jsonb;
  v_remainder jsonb := NULL;
  v_winner_amount numeric := 0;
  v_source_table_ids uuid[];
  v_source_seat_ids uuid[];
  v_durable_released_ids uuid[];
  v_durable_released_count integer;
BEGIN
  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'satellite receipt requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_h
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'satellite % has no immutable settlement header',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_h.winner_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION
      'satellite % receipt winner % differs from observed winner %',
      p_tournament_id, v_h.winner_id, p_observed_winner_id
      USING ERRCODE = '40001';
  END IF;
  IF v_h.receipt_version IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'satellite % has unsupported receipt version %',
      p_tournament_id, v_h.receipt_version USING ERRCODE = 'P0404';
  END IF;

  -- Target lifecycle state is intentionally absent from replay. A target may
  -- close after commit without changing what was already delivered.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_h.target_id)
   ORDER BY CASE WHEN t.id = v_h.target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.ended_at,
         t.current_players, t.on_break, t.break_started_at, t.break_ends_at
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'satellite % source row is missing',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_source.status, '')) <> 'COMPLETED'
     OR COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE
     OR v_source.ended_at IS NULL
     OR v_source.ended_at IS DISTINCT FROM v_h.source_closed_at
     OR v_source.current_players IS DISTINCT FROM 0
     OR v_source.on_break IS DISTINCT FROM false
     OR v_source.break_started_at IS NOT NULL
     OR v_source.break_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'satellite % receipt is not attached to one completed close',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % no longer identifies as a satellite',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  IF COALESCE(v_source.satellite_target_id, v_source.satellite_target)
       IS DISTINCT FROM v_h.target_id
     OR v_source.prize_pool IS NULL
     OR v_source.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_source.prize_pool, 2) IS DISTINCT FROM v_h.pool
     OR COALESCE(v_source.satellite_seats, 0) IS DISTINCT FROM v_h.advertised_seats
     OR v_h.pool < v_h.advertised_seats * v_h.ticket_cost
     OR floor(v_h.pool / v_h.ticket_cost)::integer IS DISTINCT FROM v_h.ticket_award_count
     OR round(v_h.pool - v_h.ticket_award_count * v_h.ticket_cost, 2)
          IS DISTINCT FROM v_h.remainder THEN
    RAISE EXCEPTION 'satellite % immutable receipt disagrees with its locked contract',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id,t.buy_in_amount,t.buy_in_fee,t.bounty_amount,t.is_bounty,
         t.is_pko,t.is_mystery_bounty,t.is_premium_spin,t.variant,
         t.tournament_type,t.club_id
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_h.target_id
   FOR SHARE;
  IF v_target.id IS NULL
     OR v_h.target_was_missing IS DISTINCT FROM false
     OR v_h.target_contract_version IS NOT NULL
     OR ((v_h.seat_count > 0 OR v_h.entry_ticket_count > 0) AND (
          v_target.buy_in_amount IS DISTINCT FROM v_h.target_buy_in
       OR COALESCE(v_target.buy_in_fee,0) IS DISTINCT FROM v_h.target_fee
       OR COALESCE(v_target.bounty_amount,0) <> 0
       OR COALESCE(v_target.is_bounty,false)
       OR COALESCE(v_target.is_pko,false)
       OR COALESCE(v_target.is_mystery_bounty,false)
       OR COALESCE(v_target.is_premium_spin,false)
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN')) THEN
    RAISE EXCEPTION 'satellite % immutable receipt lost its locked target row',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- The header is the immutable settlement-time contract. Replay proves that
  -- exact value through its award, transfer and fee evidence. The terminal
  -- hardening migration also freezes the target's economic columns after its
  -- first actual seat, so cancellation and unregister use the same split.

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_h.target_id)
   ORDER BY tp.tournament_id, tp.id FOR SHARE;
  SELECT count(*), count(DISTINCT tp.position)
    INTO v_field_size, v_position_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_field_size <> v_h.field_size
     OR v_position_count <> v_h.field_size
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND (tp.position IS NULL OR tp.position < 1 OR tp.position > v_h.field_size)
    ) OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_h.winner_id
          AND tp.position = 1 AND tp.status::text = 'winner'
          AND tp.eliminated_at IS NULL
          AND tp.elimination_sequence IS NULL
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.position > 1
          AND tp.status::text IS DISTINCT FROM 'eliminated'
     ) THEN
    RAISE EXCEPTION 'satellite % receipt has no exact final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- A satellite is not terminal while its felt still owns live seats. The
  -- header freezes every source table and seat identity, plus the subset that
  -- this settlement itself released. Replay requires the exact same durable
  -- rows, every table closed at zero and no live seat left behind.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[])
    INTO v_source_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[])
    INTO v_durable_released_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND ts.left_at IS NOT DISTINCT FROM v_h.settled_at
     AND ts.status IS NOT DISTINCT FROM 'left'
     AND ts.leave_pending IS FALSE
     AND ts.is_sitting_out IS FALSE
     AND ts.is_away IS FALSE
     AND ts.sit_out_at IS NULL
     AND ts.scheduled_leave_hands IS NULL;
  v_durable_released_count := cardinality(v_durable_released_ids);
  IF v_source_table_ids IS DISTINCT FROM v_h.source_table_ids
     OR cardinality(v_source_table_ids) IS DISTINCT FROM v_h.source_table_count
     OR v_source_seat_ids IS DISTINCT FROM v_h.source_seat_ids
     OR cardinality(v_source_seat_ids) IS DISTINCT FROM v_h.source_seat_count
     OR v_durable_released_ids IS DISTINCT FROM v_h.released_seat_ids
     OR v_durable_released_count IS DISTINCT FROM v_h.released_seat_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_h.source_closed_at)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % source table or seat closeout differs from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id;
  IF v_rows <> v_h.ticket_award_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'seat')
          <> v_h.seat_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'cash')
          <> v_h.cash_ticket_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'ticket')
          <> v_h.entry_ticket_count
     OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_awards a
         JOIN public.tournament_players tp
           ON tp.tournament_id = p_tournament_id AND tp.position = a.place
        WHERE a.tournament_id = p_tournament_id
          AND (a.place > v_h.ticket_award_count
            OR a.user_id IS DISTINCT FROM tp.user_id
            OR a.amount IS DISTINCT FROM v_h.ticket_cost)
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.position BETWEEN 1 AND v_h.ticket_award_count
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_satellite_awards a
             WHERE a.tournament_id = p_tournament_id
               AND a.place = tp.position AND a.user_id = tp.user_id)
     ) THEN
    RAISE EXCEPTION 'satellite % has incomplete or non-contiguous award lines',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Every line has one exact payout row. Cash lines additionally prove the
  -- wallet credit and closed obligation; seats prove the registration and
  -- source-to-target funding leg below.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_payouts p ON p.id = a.payout_id
     WHERE a.tournament_id = p_tournament_id
       AND (p.id IS NULL
         OR p.tournament_id IS DISTINCT FROM p_tournament_id
         OR p.user_id IS DISTINCT FROM a.user_id
         OR p."position" IS DISTINCT FROM a.place
         OR p.amount IS DISTINCT FROM a.amount
         OR p.source IS DISTINCT FROM a.payout_source
         OR p.idempotency_key IS DISTINCT FROM a.idempotency_key)
  ) THEN
    RAISE EXCEPTION 'satellite % award line has no exact payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_obligations o ON o.id = a.obligation_id
      LEFT JOIN public.wallet_credit_idempotency k ON k.key = a.idempotency_key
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'cash'
       AND (o.id IS NULL
         OR o.tournament_id IS DISTINCT FROM p_tournament_id
         OR o.kind IS DISTINCT FROM a.obligation_kind
         OR o.place IS DISTINCT FROM a.place
         OR o.user_id IS DISTINCT FROM a.user_id
         OR o.amount_owed IS DISTINCT FROM a.amount
         OR o.amount_paid IS DISTINCT FROM a.amount
         OR o.settled_at IS NULL
         OR k.key IS NULL
         OR k.user_id IS DISTINCT FROM a.user_id
         OR k.amount IS DISTINCT FROM a.amount)
  ) THEN
    RAISE EXCEPTION 'satellite % cash ticket has no exact wallet/debt evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- A cap-blocked full award remains the source pool's money but is held in a
  -- noncash, target-scoped ticket escrow. Prove the immutable award identity,
  -- exact issue journal and absence of a wallet credit on every replay.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_payouts p ON p.id=a.payout_id
      LEFT JOIN public.tournament_tickets tk ON tk.id=a.ticket_id
      LEFT JOIN public.chip_ledger l
        ON l.idempotency_key=a.idempotency_key||':ticket_escrow'
       AND l.to_type='escrow' AND l.to_entity_id=a.ticket_id
     WHERE a.tournament_id=p_tournament_id
       AND a.delivery_kind='ticket'
       AND (tk.id IS NULL
         OR tk.issued_by IS DISTINCT FROM
              '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid
         OR tk.holder_id IS DISTINCT FROM a.user_id
         OR tk.value IS DISTINCT FROM a.amount
         OR tk.status NOT IN ('issued','redeemed')
         OR tk.redemption_mode IS DISTINCT FROM 'tournament_entry_only'
         OR tk.source_tournament_id IS DISTINCT FROM v_h.target_id
         OR tk.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR tk.source_refund_entitlement_id IS NOT NULL
         OR tk.source_satellite_award_place IS DISTINCT FROM a.place
         OR tk.entry_prize IS DISTINCT FROM v_h.target_buy_in
         OR tk.entry_bounty IS DISTINCT FROM 0::numeric
         OR tk.entry_fee IS DISTINCT FROM v_h.target_fee
         OR p.metadata->>'delivery_kind' IS DISTINCT FROM 'ticket'
         OR p.metadata->>'ticket_id' IS DISTINCT FROM tk.id::text
         OR p.metadata->>'satellite_target_id' IS DISTINCT FROM v_h.target_id::text
         OR p.metadata->>'wallet_chips_credited' IS DISTINCT FROM '0'
         OR l.id IS NULL
         OR l.status IS DISTINCT FROM 'posted'
         OR l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM p_tournament_id
         OR l.to_type IS DISTINCT FROM 'escrow'
         OR l.to_entity_id IS DISTINCT FROM tk.id
         OR l.amount IS DISTINCT FROM a.amount
         OR l.category IS DISTINCT FROM 'ticket_issue'
         OR l.club_id IS DISTINCT FROM tk.club_id
         OR l.tournament_id IS DISTINCT FROM p_tournament_id
         OR l.settlement_id IS DISTINCT FROM
              'satellite-ticket:'||tk.id::text
         OR l.actor_service IS DISTINCT FROM 'fn_settle_satellite_tournament'
         OR l.pre_from_balance IS DISTINCT FROM
              round(v_h.pool-(a.place-1)*v_h.ticket_cost,2)
         OR l.post_from_balance IS DISTINCT FROM
              round(v_h.pool-a.place*v_h.ticket_cost,2)
         OR l.pre_to_balance IS DISTINCT FROM 0::numeric
         OR l.post_to_balance IS DISTINCT FROM a.amount
         OR l.metadata->>'kind' IS DISTINCT FROM
              'direct_satellite_entry_ticket'
         OR l.metadata->>'delivery_kind' IS DISTINCT FROM 'ticket'
         OR l.metadata->>'ticket_id' IS DISTINCT FROM tk.id::text
         OR l.metadata->>'payout_id' IS DISTINCT FROM a.payout_id::text
         OR l.metadata->>'satellite_id' IS DISTINCT FROM p_tournament_id::text
         OR l.metadata->>'satellite_target_id' IS DISTINCT FROM v_h.target_id::text
         OR l.metadata->>'user_id' IS DISTINCT FROM a.user_id::text
         OR l.metadata->>'position' IS DISTINCT FROM a.place::text
         OR (l.metadata->>'entry_prize')::numeric IS DISTINCT FROM
              v_h.target_buy_in
         OR (l.metadata->>'entry_bounty')::numeric IS DISTINCT FROM 0::numeric
         OR (l.metadata->>'entry_fee')::numeric IS DISTINCT FROM v_h.target_fee
         OR l.metadata->>'wallet_chips_credited' IS DISTINCT FROM '0'
         OR EXISTS (
           SELECT 1 FROM public.wallet_credit_idempotency wallet_key
            WHERE wallet_key.key=a.idempotency_key)
         OR (SELECT count(*)
               FROM public.chip_transactions issue_tx
              WHERE issue_tx.transaction_type='tournament_ticket_issue'
                AND issue_tx.club_id=tk.club_id
                AND issue_tx.from_user_id IS NULL
                AND issue_tx.to_user_id=a.user_id
                AND issue_tx.amount=a.amount
                AND issue_tx.metadata->>'ticket_id'=tk.id::text
                AND issue_tx.metadata->>'escrow_entity_id'=tk.id::text
                AND issue_tx.metadata->>'holder_id'=a.user_id::text
                AND (issue_tx.metadata->>'value')::numeric=a.amount
                AND issue_tx.metadata->>'redemption_mode'=
                      'tournament_entry_only'
                AND issue_tx.metadata->>'source_tournament_id'=
                      v_h.target_id::text
                AND issue_tx.metadata->>'source_satellite_id'=
                      p_tournament_id::text
                AND issue_tx.metadata->>'source_award_place'=a.place::text
                AND issue_tx.metadata->>'payout_id'=a.payout_id::text
                AND issue_tx.metadata->>'ledger_id'=l.id::text
                AND issue_tx.metadata->>'idempotency_key'=a.idempotency_key
                AND issue_tx.metadata->>'wallet_chips_credited'='0') <> 1)
  ) OR (SELECT count(*) FROM public.tournament_tickets tk
         WHERE tk.source_satellite_id=p_tournament_id
           AND tk.source_satellite_award_place IS NOT NULL)
       <> v_h.entry_ticket_count
    OR (SELECT count(*) FROM public.chip_ledger l
         WHERE l.from_type='prize_liability'
           AND l.from_entity_id=p_tournament_id
           AND l.category='ticket_issue'
           AND l.metadata->>'kind'='direct_satellite_entry_ticket')
       <> v_h.entry_ticket_count THEN
    RAISE EXCEPTION
      'satellite % direct ticket has no exact noncash escrow evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.seat_count > 0 AND v_target.id IS NULL THEN
    RAISE EXCEPTION 'satellite % delivered seats into a missing target',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_players target_player
        ON target_player.id = a.registration_id
      LEFT JOIN public.chip_ledger l
        ON l.idempotency_key = 'tourney:' || p_tournament_id::text
                               || ':seat:' || a.user_id::text || ':pool_transfer'
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'seat'
       AND (target_player.id IS NULL
         OR target_player.tournament_id IS DISTINCT FROM v_h.target_id
           OR target_player.user_id IS DISTINCT FROM a.user_id
           OR COALESCE(target_player.is_satellite_qualifier, false) IS NOT TRUE
           OR target_player.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR l.id IS NULL
         OR l.amount IS DISTINCT FROM v_h.ticket_cost
         OR l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM p_tournament_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM v_h.target_id
         OR l.category IS DISTINCT FROM 'tournament_buyin'
         OR l.metadata->>'registration_id' IS DISTINCT FROM a.registration_id::text)
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = v_h.target_id
       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
  ) OR (SELECT count(*) FROM public.chip_ledger l
         WHERE l.from_type = 'prize_liability'
           AND l.from_entity_id = p_tournament_id
           AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                          || ':seat:%:pool_transfer')
       <> v_h.seat_count THEN
    RAISE EXCEPTION 'satellite % has malformed or extra actual-seat evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), round(COALESCE(sum(r.rake_amount), 0), 2)
    INTO v_rows, v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = v_h.target_id
     AND r.is_tournament
     AND r.source = 'fn_award_satellite_seat'
     AND r.metadata->>'satellite_id' = p_tournament_id::text;
  IF v_rows <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
     OR v_rake IS DISTINCT FROM round(v_h.seat_count * v_h.target_fee, 2)
     OR (SELECT count(DISTINCT r.metadata->>'registration_id')
           FROM public.rake_records r
          WHERE r.tournament_id = v_h.target_id
            AND r.is_tournament
            AND r.source = 'fn_award_satellite_seat'
            AND r.metadata->>'satellite_id' = p_tournament_id::text)
          <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_h.target_id
          AND r.is_tournament
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text
          AND (r.rake_amount IS DISTINCT FROM v_h.target_fee
            OR r.pot_size IS DISTINCT FROM v_h.ticket_cost
            OR r.metadata->>'kind' IS DISTINCT FROM 'satellite_seat_entry_fee'
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_satellite_awards a
               WHERE a.tournament_id = p_tournament_id
                 AND a.delivery_kind = 'seat'
                 AND a.user_id::text = r.metadata->>'user_id'
                 AND a.registration_id::text = r.metadata->>'registration_id'))
     ) OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_awards a
        WHERE a.tournament_id = p_tournament_id
          AND a.delivery_kind = 'seat'
          AND v_h.target_fee > 0
          AND (SELECT count(*)
                 FROM public.rake_records r
                WHERE r.tournament_id = v_h.target_id
                  AND r.is_tournament
                  AND r.source = 'fn_award_satellite_seat'
                  AND r.metadata->>'kind' = 'satellite_seat_entry_fee'
                  AND r.metadata->>'satellite_id' = p_tournament_id::text
                  AND r.metadata->>'user_id' = a.user_id::text
                  AND r.metadata->>'registration_id' = a.registration_id::text
                  AND r.rake_amount = v_h.target_fee
                  AND r.pot_size = v_h.ticket_cost) <> 1
     ) THEN
    RAISE EXCEPTION 'satellite % has malformed target-entry evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id;
  IF v_rows <> (v_h.cash_ticket_count
                + CASE WHEN v_h.remainder > 0 THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'satellite % has missing or extra obligation evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.remainder > 0 THEN
    IF (SELECT count(*) FROM public.tournament_satellite_remainders r
         WHERE r.tournament_id = p_tournament_id) <> 1
       OR NOT EXISTS (
      SELECT 1
        FROM public.tournament_players bubble
        JOIN public.tournament_satellite_remainders r
          ON r.tournament_id = p_tournament_id
         AND r.user_id = bubble.user_id
         AND r.place = v_h.bubble_position
         AND r.amount = v_h.remainder
        JOIN public.tournament_payouts p
          ON p.id = r.payout_id
         AND p.tournament_id = p_tournament_id
         AND p.user_id = bubble.user_id
         AND p."position" IS NOT DISTINCT FROM r.payout_position
         AND p.amount = v_h.remainder
         AND p.source = r.payout_source
         AND p.idempotency_key = r.idempotency_key
        JOIN public.tournament_obligations o
          ON o.id = r.obligation_id
         AND o.tournament_id = p_tournament_id
         AND o.kind = r.obligation_kind
         AND o.place IS NOT DISTINCT FROM r.obligation_place
         AND o.user_id = bubble.user_id
         AND o.amount_owed = v_h.remainder
         AND o.amount_paid = v_h.remainder
         AND o.settled_at IS NOT NULL
        JOIN public.wallet_credit_idempotency k
          ON k.key = r.idempotency_key
         AND k.user_id = bubble.user_id
         AND k.amount = v_h.remainder
       WHERE bubble.tournament_id = p_tournament_id
         AND bubble.user_id = v_h.bubble_user_id
         AND bubble.position = v_h.bubble_position
         AND (
           (r.evidence_kind = 'atomic'
             AND r.payout_position IS NOT DISTINCT FROM r.place
             AND r.obligation_place IS NOT DISTINCT FROM r.place
             AND r.idempotency_key = 'tourney:' || p_tournament_id::text
                 || ':satellite_remainder:place:' || r.place::text)
           OR r.evidence_kind = 'legacy_20260908_682')
    ) THEN
      RAISE EXCEPTION 'satellite % has no exact single-bubble remainder payment',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_remainder := jsonb_build_object(
      'user_id', v_h.bubble_user_id,
      'position', v_h.bubble_position,
      'amount', v_h.remainder);
  ELSIF EXISTS (SELECT 1 FROM public.tournament_satellite_remainders r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source = 'satellite_remainder'
     ) THEN
    RAISE EXCEPTION 'satellite % has remainder evidence when remainder is zero',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_expected_rows := v_h.ticket_award_count
                     + CASE WHEN v_h.remainder > 0 THEN 1 ELSE 0 END;
  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_rows, v_amount
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_rows <> v_expected_rows OR v_amount IS DISTINCT FROM v_h.pool THEN
    RAISE EXCEPTION
      'satellite % payout evidence has % rows / % chips, expected % / %',
      p_tournament_id, v_rows, v_amount, v_expected_rows, v_h.pool
      USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.prize IS DISTINCT FROM CASE
         WHEN tp.position BETWEEN 1 AND v_h.ticket_award_count THEN v_h.ticket_cost
         WHEN v_h.remainder > 0 AND tp.position = v_h.bubble_position
           THEN v_h.remainder
         ELSE 0::numeric
       END
  ) THEN
    RAISE EXCEPTION 'satellite % prize cache disagrees with its receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.prize_out IS DISTINCT FROM v_h.pool
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.closed_at IS DISTINCT FROM v_h.source_escrow_closed_at
     OR v_source_escrow.close_note IS DISTINCT FROM v_h.source_escrow_close_note
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION 'satellite % did not close every escrow bank at zero',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_rake_settlement
    FROM public.tournament_rake_settlements s
   WHERE s.tournament_id = p_tournament_id;
  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF v_rake_settlement.tournament_id IS NULL
     OR v_rake_settlement.settled_at IS NULL
     OR v_rake_settlement.amount IS DISTINCT FROM v_rake
     OR (v_rake > 0 AND v_rake_settlement.attributed_at IS NULL AND NOT v_deferred) THEN
    RAISE EXCEPTION 'satellite % rake has no exact terminal settlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.user_id,
           'position', a.place,
           'amount', a.amount,
           'delivery_kind', a.delivery_kind,
           'payout_id', a.payout_id,
           'registration_id', a.registration_id,
           'ticket_id', a.ticket_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_awards
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.user_id,
           'position', a.place,
           'amount', a.amount,
           'registration_id', a.registration_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_seats
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id
     AND a.delivery_kind = 'seat';

  v_winner_amount := CASE WHEN v_h.ticket_award_count > 0
                          THEN v_h.ticket_cost ELSE v_h.remainder END;
  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'status', 'COMPLETED',
    'tournament_id', p_tournament_id,
    'target_id', v_h.target_id,
    'winner_id', v_h.winner_id,
    'field_size', v_h.field_size,
    'pool', v_h.pool,
    'ticket_cost', v_h.ticket_cost,
    'ticket_award_count', v_h.ticket_award_count,
    'seat_count', v_h.seat_count,
    'cash_ticket_count', v_h.cash_ticket_count,
    'entry_ticket_count', v_h.entry_ticket_count,
    'awards', v_awards,
    'seats', v_seats,
    'remainder', v_remainder,
    'winner_amount', v_winner_amount,
    'source_table_count', v_h.source_table_count,
    'source_seat_count', v_h.source_seat_count,
    'released_seat_count', v_h.released_seat_count,
    'source_closeout', jsonb_build_object(
      'source_table_count', v_h.source_table_count,
      'source_table_ids', to_jsonb(v_h.source_table_ids),
      'source_seat_count', v_h.source_seat_count,
      'source_seat_ids', to_jsonb(v_h.source_seat_ids),
      'released_seat_count', v_h.released_seat_count,
      'released_seat_ids', to_jsonb(v_h.released_seat_ids),
      'closed_at', v_h.source_closed_at,
      'escrow_closed_at', v_h.source_escrow_closed_at,
      'escrow_close_note', v_h.source_escrow_close_note),
    'settled_at', v_h.settled_at,
    'receipt_version', v_h.receipt_version,
    'accounting',v_accounting);
END;
$function$;

-- END tournament-fee-satellite-gates-draft.sql

-- BEGIN tournament-fee-cancellation-adapter-draft.sql
-- DRAFT. Original cancellation receipts stay intact; accounting records zero net.
CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament(p_tournament_id uuid, p_admin_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_actor uuid := COALESCE(
    auth.uid(),p_admin_id,'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
  v_t public.tournaments%ROWTYPE;
  v_stored public.tournament_cancellation_receipts%ROWTYPE;
  v_e public.tournament_escrow%ROWTYPE;
  v_player record;
  v_entitlement public.tournament_refund_entitlements%ROWTYPE;
  v_fee record;
  v_contribution public.spin_reserve_ledger%ROWTYPE;
  v_draw public.spin_reserve_ledger%ROWTYPE;
  v_pool public.spin_bonus_pools%ROWTYPE;
  v_settle jsonb;
  v_receipt jsonb;
  v_refunds jsonb := '[]'::jsonb;
  v_ticket_returns jsonb := '[]'::jsonb;
  v_source_player_ids uuid[] := ARRAY[]::uuid[];
  v_refunded_registration_ids uuid[] := ARRAY[]::uuid[];
  v_ticket_return_ids uuid[] := ARRAY[]::uuid[];
  v_zero_refund_registration_ids uuid[] := ARRAY[]::uuid[];
  v_closed_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_fee_reversal_ids uuid[] := ARRAY[]::uuid[];
  v_registration_id uuid;
  v_fee_reversal_id uuid;
  v_original_entry_journal_id uuid;
  v_original_draw_journal_id uuid;
  v_draw_reversal_id uuid;
  v_draw_reversal_journal_id uuid;
  v_contribution_reversal_id uuid;
  v_contribution_reversal_journal_id uuid;
  v_spin_unwind_id uuid;
  v_source_player_count integer := 0;
  v_refunded_count integer := 0;
  v_refund_line_count integer := 0;
  v_ticket_return_count integer := 0;
  v_zero_refund_count integer := 0;
  v_closed_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_total_refunded numeric := 0;
  v_total_ticket_returned numeric := 0;
  v_fees_reversed numeric := 0;
  v_total_rake_before numeric := 0;
  v_total_rake_after numeric := 0;
  v_total_owed numeric;
  v_draw_amount numeric := 0;
  v_pool_balance_before numeric;
  v_pool_balance_after numeric;
  v_rows integer;
  v_journal_count integer;
  v_cancelled_at timestamptz := transaction_timestamp();
  v_close_note constant text := 'atomic cancellation receipt: exact zero';
BEGIN
  -- Every terminal authority takes this lock before any row lock. Cancellation,
  -- satellite finish and cash finish can touch the same wallets and event rows.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'Tournament id is required' USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE = 'P0002';
  END IF;
  -- DIAMOND PHASE 8: a Diamond event is cancelled by its own authority, which
  -- returns every entry from custody and writes the same immutable receipt;
  -- the chip rails below never saw a Diamond entry.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN public.fn_poker_diamond_tournament_cancel(p_tournament_id, p_admin_id);
  END IF;
  IF v_uid IS NOT NULL
     AND NOT public.fn_can_create_games(v_t.club_id,v_uid) THEN
    RAISE EXCEPTION 'Only the governed game operator may cancel a tournament'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_stored FROM public.tournament_cancellation_receipts h
   WHERE h.tournament_id=p_tournament_id FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id,NULL);
  END IF;
  IF upper(COALESCE(v_t.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED','COMPLETING') THEN
    RAISE EXCEPTION 'Tournament is already %',v_t.status USING ERRCODE='55000';
  END IF;

  -- A tournament that has started is resumed or settled, never voided.
  -- start_time is a schedule/fill deadline; it is not proof that play began.
  -- The stored receipt above remains replayable without another cancellation.
  IF v_t.started_at IS NOT NULL
     OR upper(COALESCE(v_t.status::text,'')) IN ('RUNNING','BREAK')
     OR COALESCE(v_t.spin_multiplier,0)>0
     OR EXISTS (SELECT 1 FROM public.tournament_launch_receipts r
                 WHERE r.tournament_id=p_tournament_id AND r.completed_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.spin_draw_receipts r
                 WHERE r.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger r
                 WHERE r.tournament_id=p_tournament_id AND r.kind='jackpot_draw')
     OR EXISTS (SELECT 1 FROM public.hand_history hh
                 WHERE hh.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tables tb
                 JOIN public.hand_history hh ON hh.table_id=tb.id
                 WHERE tb.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id=p_tournament_id
                   AND o.kind<>'refund' AND o.amount_paid>0) THEN
    RAISE EXCEPTION
      'Tournament has started or committed awards; resume or settle it instead of cancelling'
      USING ERRCODE='55000';
  END IF;

  PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp());

  -- Freeze every identity before any payer runs. Any concurrent registration,
  -- seat move or hand settlement either committed before these locks and is in
  -- the receipt, or waits behind this transaction and sees a terminal parent.
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
   ORDER BY tp.user_id,tp.id FOR UPDATE;
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id=p_tournament_id ORDER BY tb.id FOR UPDATE;
  PERFORM 1 FROM public.table_seats s
   JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
   ORDER BY s.table_id,s.id FOR UPDATE OF s;
  SELECT COALESCE(array_agg(tp.id ORDER BY tp.id),ARRAY[]::uuid[])
    INTO v_source_player_ids FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[])
    INTO v_closed_table_ids FROM public.tables tb
   WHERE tb.tournament_id=p_tournament_id;
  SELECT COALESCE(array_agg(s.id ORDER BY s.table_id,s.id),ARRAY[]::uuid[])
    INTO v_source_seat_ids FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id;
  v_source_player_count := cardinality(v_source_player_ids);
  v_closed_table_count := cardinality(v_closed_table_ids);
  v_source_seat_count := cardinality(v_source_seat_ids);

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'atomic cancellation escrow prelock');
  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL OR v_e.enforced IS DISTINCT FROM true
     OR v_t.prize_pool IS DISTINCT FROM v_e.prize_balance
     OR v_t.bounty_pool IS DISTINCT FROM v_e.bounty_balance
     OR v_t.total_rake IS DISTINCT FROM v_e.fee_balance THEN
    RAISE EXCEPTION 'tournament % caches do not equal exact escrow before cancellation',
      p_tournament_id USING ERRCODE='P0404';
  END IF;

  -- A booked Spin first gives back its draw, then withdraws this event's own
  -- contribution. Each pool movement creates its strict journal before the
  -- matching immutable reversal row and all four ids are stored together.
  PERFORM 1 FROM public.spin_reserve_ledger r
   WHERE r.tournament_id=p_tournament_id ORDER BY r.created_at,r.id FOR UPDATE;
  SELECT * INTO v_contribution FROM public.spin_reserve_ledger r
   WHERE r.tournament_id=p_tournament_id AND r.kind='contribution';
  IF FOUND THEN
    IF (SELECT count(*) FROM public.spin_reserve_ledger r
         WHERE r.tournament_id=p_tournament_id AND r.kind='contribution') <> 1
       OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger r
                   WHERE r.tournament_id=p_tournament_id
                     AND r.kind IN ('draw_reversal','contribution_reversal'))
       OR EXISTS (SELECT 1 FROM public.tournament_spin_cancellation_unwinds u
                   WHERE u.tournament_id=p_tournament_id) THEN
      RAISE EXCEPTION 'Spin % has an ambiguous or partially unwound reserve contract',
        p_tournament_id USING ERRCODE='P0404';
    END IF;
    SELECT * INTO v_draw FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id AND r.kind='jackpot_draw';
    IF FOUND AND (SELECT count(*) FROM public.spin_reserve_ledger r
                   WHERE r.tournament_id=p_tournament_id
                     AND r.kind='jackpot_draw') <> 1 THEN
      RAISE EXCEPTION 'Spin % has more than one immutable draw',p_tournament_id
        USING ERRCODE='P0404';
    END IF;
    SELECT * INTO v_pool FROM public.spin_bonus_pools p
     WHERE p.club_id=v_contribution.club_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Spin % original reserve owner is missing',p_tournament_id
        USING ERRCODE='P0404';
    END IF;
    v_pool_balance_before := v_pool.balance;
    IF v_pool_balance_before IS NULL
       OR v_pool_balance_before::text IN ('NaN','Infinity','-Infinity')
       OR v_pool_balance_before<0 THEN
      RAISE EXCEPTION 'Spin % reserve balance is invalid',p_tournament_id
        USING ERRCODE='22003';
    END IF;
    SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
      INTO v_journal_count,v_original_entry_journal_id
      FROM public.chip_ledger l
     WHERE l.tournament_id=p_tournament_id
       AND l.category='spin_entry'
       AND l.from_type='prize_liability'
       AND l.from_entity_id=p_tournament_id
       AND l.to_type='spin_reserve' AND l.to_entity_id=v_pool.id
       AND l.amount=v_contribution.amount;
    IF v_journal_count<>1 OR v_contribution.amount<=0 THEN
      RAISE EXCEPTION 'Spin % contribution has no single exact journal',p_tournament_id
        USING ERRCODE='P0404';
    END IF;

    IF v_draw.id IS NOT NULL THEN
      IF v_draw.club_id IS DISTINCT FROM v_contribution.club_id
         OR v_draw.amount>=0 THEN
        RAISE EXCEPTION 'Spin % draw disagrees with its contribution owner',p_tournament_id
          USING ERRCODE='P0404';
      END IF;
      v_draw_amount := round(-v_draw.amount,2);
      SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
        INTO v_journal_count,v_original_draw_journal_id
        FROM public.chip_ledger l
       WHERE l.tournament_id=p_tournament_id
         AND l.category='spin_prize'
         AND l.from_type='spin_reserve' AND l.from_entity_id=v_pool.id
         AND l.to_type='prize_liability' AND l.to_entity_id=p_tournament_id
         AND l.amount=v_draw_amount;
      IF v_journal_count<>1 THEN
        RAISE EXCEPTION 'Spin % draw has no single exact journal',p_tournament_id
          USING ERRCODE='P0404';
      END IF;
      PERFORM public.fn_ca_declare_ledger(
        'reversal','prize_liability',p_tournament_id,NULL,
        'spin:'||p_tournament_id::text||':cancel:draw',NULL);
      UPDATE public.spin_bonus_pools
         SET balance=balance+v_draw_amount,updated_at=now()
       WHERE id=v_pool.id RETURNING balance INTO v_pool_balance_after;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Spin % reserve vanished during draw reversal',p_tournament_id
          USING ERRCODE='40001';
      END IF;
      INSERT INTO public.spin_reserve_ledger
        (club_id,tournament_id,kind,amount,balance_after,multiplier,
         buy_in,seats,house_rake,note)
      VALUES
        (v_draw.club_id,p_tournament_id,'draw_reversal',v_draw_amount,
         v_pool_balance_after,v_draw.multiplier,v_draw.buy_in,v_draw.seats,
         v_draw.house_rake,'atomic cancellation reversed the exact reserve draw')
      RETURNING id INTO v_draw_reversal_id;
      SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
        INTO v_journal_count,v_draw_reversal_journal_id
        FROM public.chip_ledger l
       WHERE l.idempotency_key='spin:'||p_tournament_id::text||':cancel:draw'
         AND l.tournament_id=p_tournament_id AND l.category='reversal'
         AND l.from_type='prize_liability' AND l.from_entity_id=p_tournament_id
         AND l.to_type='spin_reserve' AND l.to_entity_id=v_pool.id
         AND l.amount=v_draw_amount;
      IF v_journal_count<>1 THEN
        RAISE EXCEPTION 'Spin % draw reversal has no single exact journal',p_tournament_id
          USING ERRCODE='P0404';
      END IF;
    ELSE
      v_pool_balance_after := v_pool_balance_before;
    END IF;

    IF v_pool_balance_after<v_contribution.amount THEN
      RAISE EXCEPTION 'Spin % reserve cannot return its own contribution',p_tournament_id
        USING ERRCODE='P0403';
    END IF;
    PERFORM public.fn_ca_declare_ledger(
      'reversal','prize_liability',p_tournament_id,NULL,
      'spin:'||p_tournament_id::text||':cancel:entry',NULL);
    UPDATE public.spin_bonus_pools
       SET balance=balance-v_contribution.amount,updated_at=now()
     WHERE id=v_pool.id RETURNING balance INTO v_pool_balance_after;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Spin % reserve vanished during contribution reversal',p_tournament_id
        USING ERRCODE='40001';
    END IF;
    INSERT INTO public.spin_reserve_ledger
      (club_id,tournament_id,kind,amount,balance_after,multiplier,
       buy_in,seats,house_rake,note)
    VALUES
      (v_contribution.club_id,p_tournament_id,'contribution_reversal',
       -v_contribution.amount,v_pool_balance_after,v_contribution.multiplier,
       v_contribution.buy_in,v_contribution.seats,v_contribution.house_rake,
       'atomic cancellation returned the exact entry contribution')
    RETURNING id INTO v_contribution_reversal_id;
    SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
      INTO v_journal_count,v_contribution_reversal_journal_id
      FROM public.chip_ledger l
     WHERE l.idempotency_key='spin:'||p_tournament_id::text||':cancel:entry'
       AND l.tournament_id=p_tournament_id AND l.category='reversal'
       AND l.from_type='spin_reserve' AND l.from_entity_id=v_pool.id
       AND l.to_type='prize_liability' AND l.to_entity_id=p_tournament_id
       AND l.amount=v_contribution.amount;
    IF v_journal_count<>1 THEN
      RAISE EXCEPTION 'Spin % contribution reversal has no single exact journal',
        p_tournament_id USING ERRCODE='P0404';
    END IF;
    INSERT INTO public.tournament_spin_cancellation_unwinds(
      tournament_id,pool_id,reserve_owner_id,
      original_contribution_id,original_draw_id,
      original_entry_journal_id,original_draw_journal_id,
      draw_reversal_id,draw_reversal_journal_id,
      contribution_reversal_id,contribution_reversal_journal_id,
      contribution_amount,draw_amount,pool_balance_before,pool_balance_after,
      settled_at)
    VALUES(
      p_tournament_id,v_pool.id,v_contribution.club_id,
      v_contribution.id,v_draw.id,
      v_original_entry_journal_id,v_original_draw_journal_id,
      v_draw_reversal_id,v_draw_reversal_journal_id,
      v_contribution_reversal_id,v_contribution_reversal_journal_id,
      v_contribution.amount,v_draw_amount,v_pool_balance_before,
      v_pool_balance_after,v_cancelled_at)
    RETURNING tournament_id INTO v_spin_unwind_id;
  ELSIF EXISTS (
    SELECT 1 FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id
       AND r.kind IN ('jackpot_draw','draw_reversal','contribution_reversal')) THEN
    RAISE EXCEPTION 'Spin % has reserve evidence without its contribution',p_tournament_id
      USING ERRCODE='P0404';
  END IF;

  -- Return each unconsumed funded entitlement as cash to its recorded club.
  -- The exact refund payer proves wallet, satellite transfer or redeemed-ticket
  -- funding and excludes value already returned as a ticket. Stored historical
  -- cancellation receipts continue to replay through their original evidence.
  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_entitlements e
    JOIN public.tournament_players tp ON tp.id=e.registration_id
    JOIN public.tournament_tickets tk
      ON tk.source_refund_entitlement_id=e.id
   WHERE e.tournament_id=p_tournament_id
     AND tp.tournament_id=p_tournament_id) THEN
    RAISE EXCEPTION 'active qualifier roster already has an unreceipted return ticket'
      USING ERRCODE='P0404';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_entitlements e
    LEFT JOIN public.tournament_players tp
      ON tp.tournament_id=e.tournament_id AND tp.user_id=e.user_id
   WHERE e.tournament_id=p_tournament_id
     AND (tp.id IS NULL OR (e.entitlement_kind IN (
            'satellite_seat','tournament_ticket')
          AND e.registration_id IS DISTINCT FROM tp.id))) THEN
    RAISE EXCEPTION 'refund entitlement is detached from the frozen roster'
      USING ERRCODE='P0404';
  END IF;
  FOR v_player IN
    SELECT DISTINCT ON (tp.user_id) tp.id,tp.user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id IS NOT NULL
     ORDER BY tp.user_id,tp.id
  LOOP
    -- The owner-only plan validates every source ledger, wallet debit and
    -- escrow rail. Identity comes from the locked entitlement table below.
    PERFORM 1 FROM public.fn_ca_tournament_refund_plan(
      p_tournament_id,v_player.user_id);
    LOOP
      SELECT e.* INTO v_entitlement
        FROM public.tournament_refund_entitlements e
       WHERE e.tournament_id=p_tournament_id
         AND e.user_id=v_player.user_id
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_refund_tranches tr
            WHERE tr.entitlement_id=e.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_tickets tk
            WHERE tk.source_refund_entitlement_id=e.id)
       ORDER BY e.entitlement_kind,e.id
       LIMIT 1 FOR UPDATE OF e;
      EXIT WHEN NOT FOUND;
      v_registration_id:=COALESCE(v_entitlement.registration_id,v_player.id);
      IF v_entitlement.entitlement_kind IN (
          'wallet_charge','satellite_seat','tournament_ticket') THEN
        SELECT COALESCE(o.amount_paid,0)+v_entitlement.gross
          INTO v_total_owed FROM public.tournament_obligations o
         WHERE o.tournament_id=p_tournament_id AND o.kind='refund'
           AND o.place IS NULL AND o.user_id=v_player.user_id FOR UPDATE;
        IF NOT FOUND THEN v_total_owed:=v_entitlement.gross; END IF;
        v_settle:=public.fn_settle_tournament_refund_exact(
          p_tournament_id,v_player.user_id,
          v_entitlement.refund_wallet_club_id,v_total_owed,
          v_entitlement.refund_prize,v_entitlement.refund_bounty,
          v_entitlement.refund_fee,'atomic_cancel_tournament',
          'Tournament cancellation refund: '||COALESCE(v_t.name,'Unknown'));
        IF COALESCE((v_settle->>'ok')::boolean,false) IS NOT TRUE
           OR COALESCE((v_settle->>'fully_settled')::boolean,false) IS NOT TRUE
           OR COALESCE((v_settle->>'remaining')::numeric,-1)<>0
           OR (v_settle->>'entitlement_id')::uuid
                IS DISTINCT FROM v_entitlement.id
           OR v_settle->>'entitlement_kind' IS DISTINCT FROM v_entitlement.entitlement_kind
           OR (v_settle->>'paid')::numeric IS DISTINCT FROM v_entitlement.gross
           OR (v_settle->>'refund_prize')::numeric
                IS DISTINCT FROM v_entitlement.refund_prize
           OR (v_settle->>'refund_bounty')::numeric
                IS DISTINCT FROM v_entitlement.refund_bounty
           OR (v_settle->>'refund_fee')::numeric
                IS DISTINCT FROM v_entitlement.refund_fee THEN
          RAISE EXCEPTION 'exact cancellation refund refused entitlement %: %',
            v_entitlement.id,v_settle USING ERRCODE='55000';
        END IF;
        v_refunds:=v_refunds||jsonb_build_array(jsonb_build_object(
          'registration_id',v_registration_id,
          'user_id',v_player.user_id,
          'entitlement_id',v_entitlement.id,
          'entitlement_kind',v_entitlement.entitlement_kind,
          'source_wallet_club_id',v_entitlement.refund_wallet_club_id,
          'gross_paid',v_entitlement.gross,
          'amount_paid_before',(v_settle->>'already_paid')::numeric,
          'amount_paid_now',(v_settle->>'paid')::numeric,
          'refund_prize',(v_settle->>'refund_prize')::numeric,
          'refund_bounty',(v_settle->>'refund_bounty')::numeric,
          'refund_fee',(v_settle->>'refund_fee')::numeric,
          'obligation_id',(v_settle->>'obligation_id')::uuid,
          'idempotency_key',v_settle->>'idempotency_key',
          'credit_ledger_id',(v_settle->>'credit_ledger_id')::uuid,
          'wallet_transaction_id',(v_settle->>'wallet_transaction_id')::uuid));
        v_refund_line_count:=v_refund_line_count+1;
        v_total_refunded:=round(
          v_total_refunded+(v_settle->>'paid')::numeric,2);
      ELSE
        RAISE EXCEPTION 'unknown cancellation entitlement kind %',
          v_entitlement.entitlement_kind USING ERRCODE='P0404';
      END IF;
      IF NOT v_registration_id=ANY(v_refunded_registration_ids) THEN
        v_refunded_registration_ids:=array_append(
          v_refunded_registration_ids,v_registration_id);
      END IF;
    END LOOP;
  END LOOP;
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_refunded_registration_ids
    FROM unnest(v_refunded_registration_ids) ids(id);
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_zero_refund_registration_ids
    FROM unnest(v_source_player_ids) ids(id)
   WHERE NOT id=ANY(v_refunded_registration_ids);
  v_refunded_count:=cardinality(v_refunded_registration_ids);
  v_zero_refund_count:=cardinality(v_zero_refund_registration_ids);

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.fn_ca_tournament_refund_plan(
                    p_tournament_id,tp.user_id))) THEN
    RAISE EXCEPTION 'cancellation left a refundable entitlement unpaid'
      USING ERRCODE='55000';
  END IF;

  -- Rake reversal is attribution only: the exact refund payer already returned
  -- the fee component from escrow. Reverse each current player's net fee and
  -- each aggregate Spin source exactly once, retaining immutable source ids.
  IF EXISTS (SELECT 1 FROM public.rake_records r
              WHERE r.tournament_id=p_tournament_id
                AND r.source='atomic_cancel_tournament') THEN
    RAISE EXCEPTION 'unreceipted cancellation rake evidence already exists'
      USING ERRCODE='P0404';
  END IF;
  SELECT round(COALESCE(sum(r.rake_amount),0),2)
    INTO v_total_rake_before FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  IF v_total_rake_before<0
     OR v_total_rake_before::text IN ('NaN','Infinity','-Infinity')
     OR round(COALESCE(v_t.total_rake,0),2) IS DISTINCT FROM v_total_rake_before THEN
    RAISE EXCEPTION 'tournament % rake cache and evidence disagree',p_tournament_id
      USING ERRCODE='P0404';
  END IF;

  FOR v_fee IN
    SELECT tp.user_id,r.club_id,
           round(sum(r.rake_amount),2) AS amount,
           jsonb_agg(r.id ORDER BY r.id) AS source_ids
      FROM (SELECT DISTINCT p.user_id FROM public.tournament_players p
             WHERE p.tournament_id=p_tournament_id AND p.user_id IS NOT NULL) tp
      JOIN public.rake_records r
        ON r.tournament_id=p_tournament_id AND r.is_tournament
       AND r.metadata->>'user_id'=tp.user_id::text
     GROUP BY tp.user_id,r.club_id HAVING round(sum(r.rake_amount),2)>0
     ORDER BY tp.user_id,r.club_id
  LOOP
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(NULL,NULL,v_fee.club_id,-v_fee.amount,v_fee.amount,1,0,true,
      p_tournament_id,'atomic_cancel_tournament',jsonb_build_object(
        'kind','tournament_fee_refund','user_id',v_fee.user_id,
        'original_rake_record_ids',v_fee.source_ids))
    RETURNING id INTO v_fee_reversal_id;
    v_fee_reversal_ids:=array_append(v_fee_reversal_ids,v_fee_reversal_id);
    v_fees_reversed:=round(v_fees_reversed+v_fee.amount,2);
  END LOOP;
  FOR v_fee IN
    SELECT r.*,round(r.rake_amount+COALESCE((SELECT sum(rr.rake_amount)
      FROM public.rake_records rr WHERE rr.tournament_id=p_tournament_id
       AND rr.source='atomic_cancel_tournament'
       AND rr.metadata->>'original_rake_record_id'=r.id::text),0),2) AS amount
      FROM public.rake_records r
     WHERE r.tournament_id=p_tournament_id AND r.is_tournament
       AND r.source IN ('fn_spin_book_entry','fn_spin_settle_game')
       AND r.rake_amount>0 AND NULLIF(r.metadata->>'user_id','') IS NULL
     ORDER BY r.id FOR UPDATE
  LOOP
    IF v_fee.amount>0 THEN
      INSERT INTO public.rake_records(
        hand_id,table_id,club_id,rake_amount,pot_size,num_players,
        bbj_contribution,is_tournament,tournament_id,source,
        player_contributions,metadata)
      VALUES(NULL,NULL,v_fee.club_id,-v_fee.amount,v_fee.pot_size,
        v_fee.num_players,0,true,p_tournament_id,'atomic_cancel_tournament',
        v_fee.player_contributions,jsonb_build_object(
          'kind','spin_rake_refund','original_source',v_fee.source,
          'original_rake_record_id',v_fee.id))
      RETURNING id INTO v_fee_reversal_id;
      v_fee_reversal_ids:=array_append(v_fee_reversal_ids,v_fee_reversal_id);
      v_fees_reversed:=round(v_fees_reversed+v_fee.amount,2);
    END IF;
  END LOOP;
  SELECT round(COALESCE(sum(r.rake_amount),0),2)
    INTO v_total_rake_after FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  IF v_total_rake_after IS DISTINCT FROM 0::numeric
     OR v_fees_reversed IS DISTINCT FROM v_total_rake_before THEN
    RAISE EXCEPTION 'tournament % fee reversal did not close exactly',p_tournament_id
      USING ERRCODE='P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL OR v_e.enforced IS DISTINCT FROM true
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'tournament % cancellation did not close all escrow banks',
      p_tournament_id USING ERRCODE='P0404';
  END IF;
  UPDATE public.tournament_escrow
     SET closed_at=v_cancelled_at,close_note=v_close_note,updated_at=now()
   WHERE tournament_id=p_tournament_id AND closed_at IS NULL
     AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament % lost its exact-zero escrow close',p_tournament_id
      USING ERRCODE='40001';
  END IF;

  UPDATE public.tournament_players
     SET status='eliminated',eliminated_at=v_cancelled_at,
         chips=0,current_bounty=0
   WHERE tournament_id=p_tournament_id;
  WITH released AS (
    UPDATE public.table_seats s
       SET left_at=v_cancelled_at,status='left',leave_pending=false,
           is_sitting_out=false,is_away=false,sit_out_at=NULL,
           scheduled_leave_hands=NULL
      FROM public.tables tb
     WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id
       AND s.left_at IS NULL RETURNING s.id)
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_released_seat_ids FROM released;
  v_released_seat_count:=cardinality(v_released_seat_ids);
  UPDATE public.table_seats s
     SET status='left',leave_pending=false,is_sitting_out=false,is_away=false,
         sit_out_at=NULL,scheduled_leave_hands=NULL
   WHERE s.id=ANY(v_source_seat_ids) AND s.left_at IS NOT NULL;

  UPDATE public.tournaments
     SET status='CANCELLED',ended_at=v_cancelled_at,updated_at=now(),
         prize_pool=0,bounty_pool=0,total_rake=0,current_players=0,
         on_break=false,break_started_at=NULL,break_ends_at=NULL
   WHERE id=p_tournament_id
     AND upper(COALESCE(status::text,'')) NOT IN
         ('COMPLETED','CANCELLED','CANCELED','COMPLETING');
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament % lost its cancellation lifecycle claim',
      p_tournament_id USING ERRCODE='40001';
  END IF;
  UPDATE public.tables
     SET status='closed',lifecycle='closed',current_players=0,
         terminal_closed_at=v_cancelled_at,updated_at=now()
   WHERE tournament_id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>v_closed_table_count THEN
    RAISE EXCEPTION 'tournament % did not close every table',p_tournament_id
      USING ERRCODE='40001';
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_fee_reversal_ids FROM unnest(v_fee_reversal_ids) ids(id);
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_ticket_return_ids FROM unnest(v_ticket_return_ids) ids(id);
  v_receipt:=jsonb_build_object(
    'ok',true,'success',true,'fully_settled',true,'receipt_version',2,
    'tournament_id',p_tournament_id,'actor_id',v_actor,'status','CANCELLED',
    'source_player_count',v_source_player_count,
    'refunded_count',v_refunded_count,'refund_line_count',v_refund_line_count,
    'ticket_return_count',v_ticket_return_count,
    'total_ticket_returned',v_total_ticket_returned,
    'total_refunded',v_total_refunded,'fees_reversed',v_fees_reversed,
    'closed_table_count',v_closed_table_count,
    'source_seat_count',v_source_seat_count,
    'released_seat_count',v_released_seat_count,
    'refunds',v_refunds,'ticket_returns',v_ticket_returns,
    'settled_at',v_cancelled_at);
  INSERT INTO public.tournament_cancellation_receipts(
    tournament_id,actor_id,receipt_version,
    source_player_count,source_player_ids,
    refunded_count,refunded_registration_ids,refund_line_count,
    ticket_return_count,ticket_return_ids,total_ticket_returned,
    zero_refund_count,zero_refund_registration_ids,
    total_refunded,fees_reversed,total_rake_before,total_rake_after,
    closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,
    released_seat_count,released_seat_ids,fee_reversal_ids,
    escrow_closed_at,escrow_close_note,spin_unwind_tournament_id,
    receipt,settled_at)
  VALUES(
    p_tournament_id,v_actor,2,
    v_source_player_count,v_source_player_ids,
    v_refunded_count,v_refunded_registration_ids,v_refund_line_count,
    v_ticket_return_count,v_ticket_return_ids,v_total_ticket_returned,
    v_zero_refund_count,v_zero_refund_registration_ids,
    v_total_refunded,v_fees_reversed,v_total_rake_before,v_total_rake_after,
    v_closed_table_count,v_closed_table_ids,v_source_seat_count,v_source_seat_ids,
    v_released_seat_count,v_released_seat_ids,v_fee_reversal_ids,
    v_cancelled_at,v_close_note,v_spin_unwind_id,v_receipt,v_cancelled_at);

  PERFORM public.fn_record_accounting_tournament_cancellation(p_tournament_id);
  RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id,v_actor);
END;
$function$;

-- END tournament-fee-cancellation-adapter-draft.sql

-- BEGIN tournament-fee-legacy-adapters-draft.sql
-- The original attribution RPC is now a read-only compatibility receipt. The
-- single fee settlement authority owns source posting; this door cannot post a
-- second synthetic tournament/user commission or repeat player/VIP statistics.
CREATE OR REPLACE FUNCTION public.fn_attribute_tournament_rake(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$DECLARE receipt jsonb;n int;amount numeric;BEGIN
 receipt:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
 IF receipt IS NULL OR receipt->>'status'='banked_accrual_deferred' THEN
  -- Raising also protects old callers that ignored a returned ok:false.
  RAISE EXCEPTION 'tournament_fee_sources_require_reconciliation' USING ERRCODE='55000'; END IF;
 SELECT count(DISTINCT f.player_id),COALESCE(sum(r.rake_credit),0) INTO n,amount
  FROM public.accounting_tournament_fee_sources f JOIN public.accounting_tournament_recognized_sources r ON r.source_id=f.id
  WHERE r.tournament_id=p_tournament_id AND r.disposition='earned';
 RETURN jsonb_build_object('ok',true,'accounting_version',2,'already_attributed',true,'attributed_users',n,'members',n,'attributed_chips',amount,'accounting',receipt);
END$$;
REVOKE ALL ON FUNCTION public.fn_attribute_tournament_rake(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_attribute_tournament_rake(uuid) TO service_role;

-- Existing repair RPC names remain compatible observations. They cannot bypass
-- the one source/recognition path or stamp a deferred event attributed-complete.
CREATE OR REPLACE FUNCTION public.fn_backpay_tournament_rake_attribution(p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('ok',true,'authority','fn_process_weekly_accounting','scanned',0,'paid',0,'chips',0,
  'remaining',count(*),'requires_reconciliation',count(*)) FROM public.tournament_rake_settlements r
  WHERE r.settled_at IS NOT NULL AND r.amount>0 AND (r.attributed_at IS NULL OR NOT EXISTS(
   SELECT 1 FROM public.accounting_tournament_fee_recognitions a WHERE a.tournament_id=r.tournament_id AND a.status='recognized'))
$$;
CREATE OR REPLACE FUNCTION public.fn_repair_tournament_rake_attribution(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('ok',true,'authority','fn_process_weekly_accounting','repaired',0,'still_failing',count(*))
 FROM public.tournament_rake_settlements r WHERE r.settled_at IS NOT NULL AND r.amount>0 AND r.attributed_at IS NULL
$$;
REVOKE ALL ON FUNCTION public.fn_backpay_tournament_rake_attribution(integer),public.fn_repair_tournament_rake_attribution(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_backpay_tournament_rake_attribution(integer),public.fn_repair_tournament_rake_attribution(integer) TO service_role;

-- END tournament-fee-legacy-adapters-draft.sql

-- BEGIN tournament-fee-monitor-draft.sql
-- DRAFT. Exact preimage md5 65dc8a03543053bec16f78b78c513b9b. One existing monitor; no second payment authority.
CREATE OR REPLACE FUNCTION public.fn_tournament_rake_settlement_check(p_grace_minutes integer DEFAULT 30, p_since_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_grace    integer := GREATEST(COALESCE(p_grace_minutes, 30), 1);
  v_days     integer := GREATEST(COALESCE(p_since_days, 7), 1);
  v_missing  integer := 0;
  v_owed     numeric := 0;
  v_oldest   timestamptz;
  v_ids      uuid[];
  v_verdict  text := 'pass';
  v_severity text;
  v_message  text;
  v_context  jsonb;
  v_alerts   integer := 0;
BEGIN
  WITH unsettled AS (
    SELECT t.id,
           t.ended_at,
           (SELECT COALESCE(sum(r.rake_amount), 0) FROM public.rake_records r
             WHERE r.tournament_id = t.id AND r.is_tournament) AS banked
      FROM public.tournaments t
     WHERE upper(COALESCE(t.status, '')) IN ('COMPLETED', 'CANCELLED', 'CANCELED')
       AND t.ended_at IS NOT NULL
       AND t.ended_at > now() - make_interval(days => v_days)
       AND t.ended_at < now() - make_interval(mins => v_grace)
       AND EXISTS (SELECT 1 FROM public.rake_records r
                    WHERE r.tournament_id = t.id AND r.is_tournament)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_rake_settlements s
                        WHERE s.tournament_id = t.id AND s.settled_at IS NOT NULL)
       -- A fully refunded cancellation has no fee-bank movement to make.
       -- Its independent exact-zero accounting receipt is still mandatory.
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_cancellation_receipts c
         JOIN public.accounting_tournament_fee_recognitions a ON a.tournament_id=c.tournament_id
         WHERE c.tournament_id=t.id AND c.total_rake_after=0
           AND c.fees_reversed=c.total_rake_before AND a.net_rake=0
           AND a.status IN('cancelled','banked_accrual_deferred')
           AND public.fn_accounting_tournament_terminal_fee_receipt(t.id)->>'bank_receipt_kind'='none')
  )
  SELECT count(*),
         COALESCE(sum(banked), 0),
         min(ended_at),
         COALESCE((array_agg(id ORDER BY ended_at))[1:20], ARRAY[]::uuid[])
    INTO v_missing, v_owed, v_oldest, v_ids
    FROM unsettled;

  IF v_missing > 0 THEN
    v_verdict  := 'rake_never_settled';
    v_severity := CASE WHEN v_missing >= 5 OR v_owed >= 50 THEN 'critical' ELSE 'warning' END;
    v_message  := format(
      '%s terminal tournament(s) have fee evidence and no completed bank or exact-zero cancellation receipt after '
      '%s minutes; their net fee evidence totals %s. Oldest finished %s. ',
      v_missing, v_grace, round(v_owed, 2), v_oldest);
  END IF;

  v_context := jsonb_build_object(
    'grace_minutes',  v_grace,
    'window_days',    v_days,
    'missing_count',  v_missing,
    'rake_unpaid',    round(v_owed, 2),
    'oldest_ended_at', v_oldest,
    'sample_games',   to_jsonb(v_ids),
    'verdict',        v_verdict,
    'detail',         'the canonical tournament terminal authority owns fee banking and recognition; this detector only reports missing custody receipts. Deferred accrual remains blocked by weekly source-quality checks');

  IF v_severity IS NOT NULL THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT v_severity, 'fn_tournament_rake_settlement_check', v_message, v_context
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_tournament_rake_settlement_check'
          AND fa.resolved IS NOT TRUE
          AND fa.context->>'verdict' = v_verdict);
    IF FOUND THEN v_alerts := 1; END IF;
  END IF;

  RETURN v_context || jsonb_build_object('ok', true, 'alerts_raised', v_alerts);
END;
$function$;

-- END tournament-fee-monitor-draft.sql

-- Component 20260914140015_recognized_cash_and_tournament_sources_share_one_payment_route.sql
-- Cash and terminally recognized tournament fees share one source reader and
-- the same private payment stages. Captured, refunded or deferred tournament
-- fees cannot become payable through this view. Recognition time chooses the
-- accounting week; original charge-time contracts choose rates and hierarchy.
-- Source identity includes its type. No new payer, formula, historical payment,
-- agreement change or current-agent requirement is introduced.
-- Depends on the complete tournament capture/recognition migration bundle.

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz)'::regprocedure))<>'336a4a482ef5482792fcbaafefa1a1df'
 OR md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))<>'7d17e883dc9a26febe835655f80ccdbc'
 OR md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))<>'404e23af8a37939355a4f5176791dfad'
 THEN RAISE EXCEPTION 'shared routed source preimage changed';END IF;
 IF (SELECT count(*) FROM public.ca_money_rpc_registry WHERE proname IN('fn_settle_accounting_commission_stage','fn_settle_accounting_rakeback_stage') AND status='approved')<>2
 THEN RAISE EXCEPTION 'shared routed writer registration missing';END IF;
END $guard$;
CREATE VIEW public.accounting_payable_earning_sources WITH(security_invoker=true) AS
 SELECT 'cash_rake_accrual'::text AS source_type,s.id AS source_id,s.rake_record_id,NULL::uuid AS tournament_id,
  s.player_id,s.club_id,s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,s.contract
 FROM public.accounting_cash_rake_sources s
 UNION ALL
 SELECT 'tournament_fee_accrual'::text,s.id,s.rake_record_id,s.tournament_id,
  s.player_id,s.club_id,s.union_id,s.coordinator_union_id,rs.recognized_at,s.rake_credit,s.contract
 FROM public.accounting_tournament_fee_sources s
 JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
 JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
 WHERE rs.disposition='earned' AND r.status='recognized' AND rs.rake_credit=s.rake_credit
  AND rs.recognized_at=r.recognized_at AND s.union_id IS NOT DISTINCT FROM r.union_id;
REVOKE ALL ON public.accounting_payable_earning_sources FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_payable_earning_sources TO service_role;


CREATE OR REPLACE FUNCTION public.fn_resolve_accounting_routing_scope(p_scope_kind text,p_scope_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS TABLE(union_id uuid,standalone_club_id uuid,club_ids uuid[],scope_key text,lock_key text,routing_context text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 IF p_scope_kind IS NULL OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL
  OR (p_scope_kind='union' AND NOT EXISTS(SELECT 1 FROM public.unions u WHERE u.id=p_scope_id))
  OR (p_scope_kind='club' AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_scope_id))
 THEN RAISE EXCEPTION 'invalid_accounting_routing_scope' USING ERRCODE='22023';END IF;
 union_id:=CASE WHEN p_scope_kind='union' THEN p_scope_id END;
 standalone_club_id:=CASE WHEN p_scope_kind='club' THEN p_scope_id END;
 -- Preserve union keys and the established coordinator lock exactly. Club keys
 -- have an explicit prefix so even identical UUID values can never collide.
 scope_key:=CASE WHEN p_scope_kind='union' THEN p_scope_id::text ELSE 'club:'||p_scope_id::text END;
 lock_key:=CASE WHEN p_scope_kind='union' THEN 'union-accounting:' ELSE 'club-accounting:' END||p_scope_id::text||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 routing_context:=scope_key||':'||p_period_start::text||':'||p_period_end::text;
 -- Acquire before reading source-club membership: a waiting close must see all
 -- earning sources committed by the previous lock holder. Accrual shares this key.
 PERFORM pg_advisory_xact_lock(hashtextextended(lock_key,0));
 IF p_scope_kind='union' THEN
  club_ids:=ARRAY(SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=p_scope_id UNION
   SELECT rs.club_id FROM public.accounting_payable_earning_sources rs WHERE rs.coordinator_union_id=p_scope_id
    AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end ORDER BY club_id);
 ELSE club_ids:=ARRAY[p_scope_id];END IF;
 RETURN NEXT;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_settle_accounting_commission_stage(p_scope_kind text,p_scope_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE scope record;p_union_id uuid;standalone_club uuid;
 v_source record;v_edge record;previous public.accounting_routed_settlement_runs%ROWTYPE;
 fingerprint text;result jsonb;run_key text;own_total numeric;direct_total numeric;downstream_total numeric;
 source_count int;node_count int;finished int:=0;step int:=0;progress int;ledger_id uuid;receipt_count int;
 payer_before numeric;payee_before numeric;payer_after numeric;payee_after numeric;club_skip text;member_skip text;routing_context text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_commission_invalid_period' USING ERRCODE='22023'; END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_commission_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_commission_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 run_key:='round2:v3:'||scope.scope_key||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 CREATE TEMP TABLE IF NOT EXISTS _routed_sources(source_type text,source_id uuid,club_id uuid,contract jsonb,earned_at timestamptz,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_sources;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 INSERT INTO pg_temp._routed_sources SELECT source_type,source_id,club_id,contract,earned_at FROM public.accounting_payable_earning_sources
  WHERE (coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND coordinator_union_id IS NULL AND club_id=standalone_club)) AND earned_at>=p_period_start AND earned_at<p_period_end;
 SELECT count(*),md5(COALESCE(string_agg(md5((CASE WHEN source_type='cash_rake_accrual' THEN jsonb_build_array(source_id,club_id,earned_at,contract) ELSE jsonb_build_array(source_type,source_id,club_id,earned_at,contract) END)::text),'' ORDER BY source_type,source_id),''))
 INTO source_count,fingerprint FROM pg_temp._routed_sources;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
   AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
    AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commissions ac WHERE ac.created_at>=p_period_start AND ac.created_at<p_period_end
  AND (ac.club_id=ANY(scope.club_ids))
  AND (ac.source_type IS NULL OR ac.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual') OR ac.settled_at IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.source_type=ac.source_type AND rs.source_id=ac.source_id AND rs.club_id=ac.club_id AND rs.earned_at=ac.created_at)))
 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_tiers(source_type text,source_id uuid,club_id uuid,depth int,agent_id uuid,user_id uuid,role text,
  parent_agent_id uuid,own_amount numeric,rate numeric,PRIMARY KEY(source_type,source_id,depth)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_tiers;
 FOR v_source IN SELECT * FROM pg_temp._routed_sources ORDER BY source_type,source_id LOOP
  IF jsonb_typeof(v_source.contract->'tiers') IS DISTINCT FROM 'array' OR v_source.contract->>'club_id' IS DISTINCT FROM v_source.club_id::text
  THEN RAISE EXCEPTION 'routed_commission_contract_invalid' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_tiers SELECT v_source.source_type,v_source.source_id,v_source.club_id,ord::int,(j->>'agent_id')::uuid,(j->>'user_id')::uuid,j->>'role',
   NULLIF(j->'agreement'->'terms'->>'parent_agent_id','')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric
   FROM jsonb_array_elements(v_source.contract->'tiers') WITH ORDINALITY x(j,ord);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.agent_id IS NULL OR t.user_id IS NULL OR t.role IS NULL OR t.role NOT IN('super_agent','agent','sub_agent')
   OR t.own_amount IS NULL OR t.own_amount<0 OR t.own_amount<>round(t.own_amount,2) OR t.own_amount::text IN('NaN','Infinity','-Infinity')
   OR t.rate IS NULL OR t.rate<0 OR t.rate>1 OR t.rate::text IN('NaN','Infinity','-Infinity')
   OR t.parent_agent_id IS DISTINCT FROM(SELECT u.agent_id FROM pg_temp._routed_tiers u WHERE u.source_type=t.source_type AND u.source_id=t.source_id AND u.depth=t.depth+1))
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY source_type,source_id,user_id HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY club_id,user_id HAVING count(DISTINCT agent_id)<>1 OR count(DISTINCT role)<>1)
 THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE (t.own_amount>0 AND (SELECT count(*) FROM public.agent_commissions ac
   WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.club_id=t.club_id AND ac.user_id=t.user_id
    AND ac.amount=t.own_amount AND ac.commission_rate=t.rate AND ac.settled_at IS NULL)=0)
   OR (SELECT count(*) FROM public.agent_commissions ac WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.user_id=t.user_id)<>CASE WHEN t.own_amount>0 THEN 1 ELSE 0 END)
  OR EXISTS(SELECT 1 FROM public.agent_commissions ac JOIN pg_temp._routed_sources s ON s.source_type=ac.source_type AND s.source_id=ac.source_id
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.source_type=s.source_type AND t.source_id=s.source_id AND t.user_id=ac.user_id AND t.own_amount=ac.amount))
 THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_nodes(club_id uuid,user_id uuid,agent_id uuid,role text,own_amount numeric,rows_count int,
  opening_balance numeric,sort_order int,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_nodes;
 INSERT INTO pg_temp._routed_nodes(club_id,user_id,agent_id,role,own_amount,rows_count)
  SELECT club_id,user_id,min(agent_id::text)::uuid,min(role),sum(own_amount),count(*) FILTER(WHERE own_amount>0)
  FROM pg_temp._routed_tiers GROUP BY club_id,user_id;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges;
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role)
 SELECT t.club_id,parent.user_id,t.user_id,sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_type=t.source_type AND child.source_id=t.source_id AND child.depth<=t.depth)),min(t.role)
 FROM pg_temp._routed_tiers t LEFT JOIN pg_temp._routed_tiers parent ON parent.source_type=t.source_type AND parent.source_id=t.source_id AND parent.depth=t.depth+1
 GROUP BY t.club_id,parent.user_id,t.user_id
 HAVING sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_type=t.source_type AND child.source_id=t.source_id AND child.depth<=t.depth))>0;
 SELECT count(*) INTO node_count FROM pg_temp._routed_nodes;
 WHILE finished<node_count LOOP
  step:=step+1;
  UPDATE pg_temp._routed_nodes n SET sort_order=step WHERE sort_order IS NULL AND NOT EXISTS(
   SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_nodes p ON p.club_id=e.club_id AND p.user_id=e.payer_user
   WHERE e.club_id=n.club_id AND e.payee_user=n.user_id AND p.sort_order IS NULL);
  GET DIAGNOSTICS progress=ROW_COUNT;
  IF progress=0 THEN RAISE EXCEPTION 'routed_commission_weekly_hierarchy_cycle' USING ERRCODE='23514'; END IF;
  finished:=finished+progress;
 END LOOP;
 UPDATE pg_temp._routed_edges e SET sort_order=n.sort_order FROM pg_temp._routed_nodes n WHERE n.club_id=e.club_id AND n.user_id=e.payee_user;
 SELECT COALESCE(sum(own_amount),0) INTO own_total FROM pg_temp._routed_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.own_amount IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- All accounts are pinned before the first transfer. Current rates and parents
 -- never choose the route. A retired agent keeps the earned entitlement; the
 -- existing club member wallet and immutable source contract remain mandatory.
 PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_sources) ORDER BY c.id FOR UPDATE;
 PERFORM cm.id FROM public.club_members cm JOIN pg_temp._routed_nodes n ON n.club_id=cm.club_id AND n.user_id=cm.user_id ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;
 UPDATE pg_temp._routed_nodes n SET opening_balance=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=n.club_id AND cm.user_id=n.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.opening_balance IS NULL OR n.opening_balance<0
  OR n.opening_balance::text IN('NaN','Infinity','-Infinity') OR n.opening_balance<>round(n.opening_balance,2))
 THEN RAISE EXCEPTION 'routed_commission_wallet_identity_or_balance_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(amount) owed FROM pg_temp._routed_edges WHERE payer_user IS NULL GROUP BY club_id) e
  LEFT JOIN public.clubs c ON c.id=e.club_id WHERE c.chip_treasury IS NULL OR c.chip_treasury<e.owed
   OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
 THEN RAISE EXCEPTION 'routed_commission_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 FOR v_edge IN SELECT * FROM pg_temp._routed_edges ORDER BY sort_order,club_id,payer_user NULLS FIRST,payee_user LOOP
  SELECT chip_balance INTO payee_before FROM public.club_members WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user;
  IF v_edge.payer_user IS NULL THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=v_edge.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-v_edge.amount WHERE id=v_edge.club_id AND chip_treasury>=v_edge.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user;
   UPDATE public.club_members SET chip_balance=chip_balance-v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user AND chip_balance>=v_edge.amount RETURNING chip_balance INTO payer_after;
  END IF;
  UPDATE public.club_members SET chip_balance=chip_balance+v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user RETURNING chip_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>v_edge.amount OR payee_after-payee_before<>v_edge.amount
  THEN RAISE EXCEPTION 'routed_commission_transfer_not_conserved' USING ERRCODE='23514'; END IF;
  IF v_edge.payer_user IS NOT NULL THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(v_edge.payer_user,'PLAYER','debit',v_edge.amount,'commission','Recorded weekly commission budget passed to child agent',payer_after); END IF;
  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(v_edge.payee_user,'PLAYER','credit',v_edge.amount,'commission','Recorded weekly commission budget received',payee_after);
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN v_edge.payer_user IS NULL THEN 'club_treasury' ELSE 'player_wallet' END,
    COALESCE(v_edge.payer_user,v_edge.club_id),'player_wallet',v_edge.payee_user,v_edge.amount,'commission',v_edge.club_id,p_union_id,
    'Weekly commission through recorded earning hierarchy',run_key||':'||v_edge.club_id::text||':'||COALESCE(v_edge.payer_user::text,'club')||':'||v_edge.payee_user::text,
    jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_start',p_period_start,'period_end',p_period_end,'payee_role_at_transfer',v_edge.role,
      'own_commission',(SELECT own_amount FROM pg_temp._routed_nodes WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user),
      'pass_through',v_edge.payer_user IS NOT NULL),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
   AND i.chips_transferred AND i.message_sent AND i.net_amount=v_edge.amount AND i.gross_amount=v_edge.amount AND i.deductions=0;
  IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_commission_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n JOIN public.club_members cm ON cm.club_id=n.club_id AND cm.user_id=n.user_id
   WHERE cm.chip_balance IS DISTINCT FROM n.opening_balance+n.own_amount)
 THEN RAISE EXCEPTION 'routed_commission_retained_balance_incorrect' USING ERRCODE='23514'; END IF;
 INSERT INTO public.agent_commission_settlements(club_id,user_id,union_id,period_start,period_end,amount,rows_count,paid_at,settlement_ref)
  SELECT club_id,user_id,p_union_id,p_period_start,p_period_end,own_amount,rows_count,now(),run_key FROM pg_temp._routed_nodes;
 IF node_count>0 THEN PERFORM public.fn_agent_commission_rollup_recompute(
  (SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id)) FROM pg_temp._routed_nodes)); END IF;
 result:=jsonb_build_object('success',true,'round',2,'name','recorded_commission_hierarchy','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'payees',node_count,'amount',direct_total,'own_commission_amount',own_total,'downstream_amount',downstream_total,
  'shortfalls',0,'sources',source_count,'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
 VALUES(p_union_id,standalone_club,p_period_start,p_period_end,2,fingerprint,result);
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_settle_accounting_rakeback_stage(p_scope_kind text,p_scope_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE legacy_paid_cash_replay boolean:=false;scope record;p_union_id uuid;standalone_club uuid;
 r record;c public.accounting_rakeback_period_calculations%ROWTYPE;g record;
 previous public.accounting_routed_settlement_runs%ROWTYPE;fingerprint text;result jsonb;
 from_date date;to_date date;allocation_count int;matched_count int;actual_count int;
 generated numeric;unrounded numeric;display_rate numeric;amount numeric;paid numeric:=0;
 payer_before numeric;payer_after numeric;player_before numeric;player_after numeric;
 payout_id uuid;wallet_id uuid;ledger_id uuid;receipt_count int;payees int:=0;
 club_skip text;member_skip text;maintenance text;routing_context text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_rakeback_invalid_period' USING ERRCODE='22023'; END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_rakeback_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 from_date:=(p_period_start AT TIME ZONE 'America/Los_Angeles')::date;
 to_date:=(p_period_end AT TIME ZONE 'America/Los_Angeles')::date-1;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_rakeback_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 -- Only a completed cash-only run can read its original untyped allocation
 -- again. Pending certificates need explicit source types before any payment.
 legacy_paid_cash_replay:=FOUND AND previous.routing_version=3 AND previous.result->>'source_version'='2'
  AND NOT(previous.result ? 'source_contract_version');
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_items(period_id uuid PRIMARY KEY,certificate_id bigint,club_id uuid,user_id uuid,
  payer_kind text,payer_user uuid,owed numeric,rake numeric,rate numeric,fingerprint text,status text) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_items;
 FOR r IN SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id=ANY(scope.club_ids)
    OR EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end))
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE
 LOOP
  SELECT * INTO c FROM public.accounting_rakeback_period_calculations WHERE period_id=r.id ORDER BY id DESC LIMIT 1;
  IF NOT FOUND OR c.accounting_version<>2 OR c.coordinator_union_id IS DISTINCT FROM p_union_id OR r.period_start<>from_date OR r.period_end<>to_date
   OR c.club_id IS DISTINCT FROM r.club_id OR c.player_id IS DISTINCT FROM r.user_id
   OR c.period_start IS DISTINCT FROM r.period_start OR c.period_end IS DISTINCT FROM r.period_end
   OR c.rake_generated IS DISTINCT FROM r.rake_generated OR c.rake_generated IS DISTINCT FROM r.total_rake_paid
   OR c.rakeback_amount IS DISTINCT FROM r.rakeback_amount OR c.rakeback_amount IS DISTINCT FROM r.rakeback_earned
   OR c.display_rate IS DISTINCT FROM r.rakeback_rate OR c.rakeback_amount<0 OR c.rakeback_amount<>round(c.rakeback_amount,2)
   OR c.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR c.payer_kind NOT IN('agent','club')
   OR (c.payer_kind='agent') IS DISTINCT FROM(c.payer_user_id IS NOT NULL) OR c.payer_user_id=r.user_id
  THEN RAISE EXCEPTION 'routed_rakeback_certificate_required' USING ERRCODE='55000'; END IF;
  SELECT count(*),count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')),sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric)
   INTO allocation_count,matched_count,generated,unrounded FROM jsonb_array_elements(c.source_allocations) a;
  SELECT count(*) INTO actual_count FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=r.club_id AND rs.player_id=r.user_id
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
  IF allocation_count=0 OR allocation_count<>matched_count OR allocation_count<>actual_count OR generated IS DISTINCT FROM c.rake_generated
    OR round(unrounded,2) IS DISTINCT FROM c.rakeback_amount
    OR c.display_rate IS DISTINCT FROM (CASE WHEN generated>0 THEN round(unrounded/generated,4) ELSE 0 END)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_allocations) a LEFT JOIN public.accounting_payable_earning_sources rs ON rs.source_type=COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) AND rs.source_id=(a->>'source_id')::uuid
     WHERE COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL OR COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) NOT IN('cash_rake_accrual','tournament_fee_accrual')
      OR rs.source_id IS NULL OR rs.club_id<>r.club_id OR rs.player_id<>r.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR a->>'payer_kind' IS DISTINCT FROM c.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM c.payer_user_id
      OR NULLIF(rs.contract->'membership'->'terms'->>'agent_id','')::uuid IS DISTINCT FROM c.payer_user_id)
  THEN RAISE EXCEPTION 'routed_rakeback_sources_disagree_with_certificate' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_player_items VALUES(r.id,c.id,r.club_id,r.user_id,c.payer_kind,c.payer_user_id,c.rakeback_amount,c.rake_generated,c.display_rate,c.source_fingerprint,r.status);
 END LOOP;
 -- Missing periods are obligations too: every source player in this scope must
 -- have an admitted certificate, including zero-entitlement players.
 IF EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club))
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
   AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
 THEN RAISE EXCEPTION 'routed_rakeback_player_period_missing' USING ERRCODE='55000'; END IF;
 SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(i.period_id,i.certificate_id,i.club_id,i.user_id,i.payer_kind,i.payer_user,i.owed,i.rake,i.rate,i.fingerprint) ORDER BY i.period_id),'[]'::jsonb)::text)
  INTO fingerprint FROM pg_temp._routed_player_items i;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint OR EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status<>'paid' OR NOT EXISTS(
   SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.user_id=i.user_id AND pp.club_id=i.club_id AND pp.status='paid' AND pp.payout_amount=i.owed))
  THEN RAISE EXCEPTION 'routed_rakeback_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status IS DISTINCT FROM 'pending'
   OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds sr WHERE sr.union_id=p_union_id AND sr.round_no=3
   AND sr.period_start<p_period_end AND sr.period_end>p_period_start AND (sr.amount>0 OR sr.payees>0 OR sr.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_rakeback_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_wallets(club_id uuid,user_id uuid,opening numeric,delta numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_wallets;
 INSERT INTO pg_temp._routed_player_wallets(club_id,user_id,delta)
 SELECT club_id,user_id,sum(delta) FROM(
  SELECT club_id,user_id,owed AS delta FROM pg_temp._routed_player_items
  UNION ALL SELECT club_id,payer_user,-owed FROM pg_temp._routed_player_items WHERE payer_kind='agent') x GROUP BY club_id,user_id;
 PERFORM id FROM public.clubs WHERE id IN(SELECT club_id FROM pg_temp._routed_player_items) ORDER BY id FOR UPDATE;
 PERFORM cm.id FROM public.club_members cm JOIN pg_temp._routed_player_wallets w ON w.club_id=cm.club_id AND w.user_id=cm.user_id
  ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;
 UPDATE pg_temp._routed_player_wallets w SET opening=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=w.club_id AND cm.user_id=w.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets WHERE opening IS NULL OR opening<0 OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_account_missing_or_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,payer_user,sum(owed) owed FROM pg_temp._routed_player_items WHERE payer_kind='agent' GROUP BY club_id,payer_user) x
  JOIN pg_temp._routed_player_wallets w ON w.club_id=x.club_id AND w.user_id=x.payer_user WHERE w.opening<x.owed)
 THEN RAISE EXCEPTION 'routed_rakeback_agent_funding_shortfall' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(owed) owed FROM pg_temp._routed_player_items WHERE payer_kind='club' GROUP BY club_id) x
  LEFT JOIN public.clubs bank ON bank.id=x.club_id WHERE bank.chip_treasury IS NULL OR bank.chip_treasury<x.owed
   OR bank.chip_treasury<>round(bank.chip_treasury,2) OR bank.chip_treasury::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 maintenance:=current_setting('app.ledger_maintenance',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 FOR r IN SELECT * FROM pg_temp._routed_player_items ORDER BY club_id,payer_user NULLS FIRST,user_id,period_id LOOP
  amount:=r.owed;
  INSERT INTO public.rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
   VALUES(r.period_id,r.club_id,r.user_id,r.rake,round(r.rate*100,2),amount,'paid',now()) RETURNING id INTO payout_id;
  IF amount>0 THEN
   SELECT chip_balance INTO player_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.user_id;
   IF r.payer_kind='club' THEN
    SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=r.club_id;
    UPDATE public.clubs SET chip_treasury=chip_treasury-amount WHERE id=r.club_id AND chip_treasury>=amount RETURNING chip_treasury INTO payer_after;
   ELSE
    SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.payer_user;
    UPDATE public.club_members SET chip_balance=chip_balance-amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.payer_user AND chip_balance>=amount RETURNING chip_balance INTO payer_after;
   END IF;
   UPDATE public.club_members SET chip_balance=chip_balance+amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING chip_balance INTO player_after;
   IF payer_after IS NULL OR player_after IS NULL OR payer_before-payer_after<>amount OR player_after-player_before<>amount
   THEN RAISE EXCEPTION 'routed_rakeback_transfer_not_conserved' USING ERRCODE='23514'; END IF;
   IF r.payer_kind='agent' THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.payer_user,'PLAYER','debit',amount,'rakeback','Weekly rakeback paid under recorded agreement',payer_after,payout_id); END IF;
   INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.user_id,'PLAYER','credit',amount,'rakeback','Weekly rakeback received under recorded agreement',player_after,payout_id) RETURNING id INTO wallet_id;
   PERFORM set_config('app.ledger_maintenance','rakeback payout evidence pointer',true);
   UPDATE public.rakeback_period_payouts SET wallet_transaction_id=wallet_id WHERE id=payout_id;
   PERFORM set_config('app.ledger_maintenance',COALESCE(maintenance,''),true);
   INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
    VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN r.payer_kind='club' THEN 'club_treasury' ELSE 'player_wallet' END,
     COALESCE(r.payer_user,r.club_id),'player_wallet',r.user_id,amount,'rakeback',r.club_id,p_union_id,'Weekly rakeback from certified historical payer',
     'round3-period:v3:'||r.period_id::text,jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_id',r.period_id,'period_start',p_period_start,'period_end',p_period_end,
       'certificate_id',r.certificate_id,'source_fingerprint',r.fingerprint,'payout_id',payout_id,'wallet_transaction_id',wallet_id,'payee_role_at_transfer','player'),
      payer_before,payer_after,player_before,player_after) RETURNING id INTO ledger_id;
   SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
    AND i.chips_transferred AND i.message_sent AND i.net_amount=amount AND i.gross_amount=amount AND i.deductions=0;
   IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_rakeback_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
   paid:=paid+amount;payees:=payees+1;
  END IF;
  UPDATE public.rakeback_periods SET status='paid',paid_at=now() WHERE id=r.period_id;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets w JOIN public.club_members cm ON cm.club_id=w.club_id AND cm.user_id=w.user_id
   WHERE cm.chip_balance IS DISTINCT FROM w.opening+w.delta)
 THEN RAISE EXCEPTION 'routed_rakeback_final_balance_incorrect' USING ERRCODE='23514'; END IF;
 result:=jsonb_build_object('success',true,'round',3,'name','certified_payer_to_players','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'amount',paid,'payees',payees,'shortfalls',0,'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
  VALUES(p_union_id,standalone_club,p_period_start,p_period_end,3,fingerprint,result);
 RETURN result;
END $function$;

REVOKE ALL ON FUNCTION public.fn_resolve_accounting_routing_scope(text,uuid,timestamptz,timestamptz),public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz),public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- Component 20260914141013_weekly_player_certificates_include_recognized_tournament_fees.sql
-- The durable weekly request wrapper stays intact. Its one private calculator
-- now certifies typed cash plus terminally recognized tournament fee sources.
-- Recognition chooses the week; charge-time immutable history chooses the rate
-- and payer. Open fee captures create no premature rebate; deferred/missing
-- terminal source proof blocks the real settlement week. No rate/formula change.

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure))<>'9d22946c66028dbb44cdd01ab5fb25a9'
 OR md5(pg_get_functiondef('public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure))<>'dbeadf42b4143e11c6e7b76343fecf0a'
 THEN RAISE EXCEPTION 'weekly certificate calculator changed before mixed-source upgrade';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ca_money_rpc_registry WHERE proname='fn_calculate_cash_rakeback_periods' AND status='approved')
 THEN RAISE EXCEPTION 'weekly certificate writer registration missing';END IF;
END $guard$;

CREATE FUNCTION public.fn_accounting_tournament_week_quality(p_club_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE event record;scope_union uuid;actual_union uuid;related boolean;unknown_scope boolean;
 proof jsonb;active_ids uuid[];refunded_ids uuid[];checked int:=0;issue_count bigint;reason text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501';END IF;
 IF p_club_id IS NULL OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from>=p_to
 THEN RAISE EXCEPTION 'invalid_accounting_tournament_week' USING ERRCODE='22023';END IF;
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023';END IF;
 FOR event IN
  WITH candidates AS (
   SELECT tournament_id FROM public.accounting_tournament_fee_recognitions WHERE recognized_at>=p_from AND recognized_at<p_to
   UNION SELECT tournament_id FROM public.tournament_rake_settlements WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_terminal_settlements WHERE COALESCE(settled_at,completed_at)>=p_from AND COALESCE(settled_at,completed_at)<p_to
   UNION SELECT tournament_id FROM public.tournament_cancellation_receipts WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_satellite_settlements WHERE settled_at>=p_from AND settled_at<p_to
  )
  SELECT c.tournament_id,r.recognized_at,r.status,r.net_rake,r.union_id,r.bank_club_id,r.source_fingerprint,
   b.settled_at AS bank_at,b.amount AS bank_amount,b.union_id AS bank_union,b.club_id AS fee_bank_club
   FROM candidates c LEFT JOIN public.accounting_tournament_fee_recognitions r USING(tournament_id)
    LEFT JOIN public.tournament_rake_settlements b USING(tournament_id) ORDER BY c.tournament_id
 LOOP
  IF COALESCE(event.bank_at,event.recognized_at) IS NOT NULL
   AND NOT(COALESCE(event.bank_at,event.recognized_at)>=p_from AND COALESCE(event.bank_at,event.recognized_at)<p_to)
   AND (event.recognized_at IS NULL OR NOT(event.recognized_at>=p_from AND event.recognized_at<p_to)) THEN CONTINUE;END IF;
  actual_union:=COALESCE(event.union_id,event.bank_union,(SELECT min(s.union_id::text)::uuid
   FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
   HAVING count(DISTINCT COALESCE(s.union_id::text,'private'))=1));
  -- Current union membership only widens conflict detection. It never sets
  -- a payable source's historical coordinator or a player's payer.
  related:=COALESCE(actual_union=scope_union,false) OR COALESCE(event.bank_club_id=p_club_id,false)
   OR COALESCE(event.fee_bank_club=p_club_id,false)
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
      AND (s.club_id=p_club_id OR (scope_union IS NOT NULL AND s.coordinator_union_id=scope_union)))
   OR EXISTS(SELECT 1 FROM public.tournament_refund_entitlements e WHERE e.tournament_id=event.tournament_id AND e.refund_wallet_club_id=p_club_id);
  -- A private legacy event with unproved coordinator history cannot be silently
  -- assigned to today's standalone/union scope. The affected week stays open.
  unknown_scope:=actual_union IS NULL AND (event.status IS NULL OR event.status='banked_accrual_deferred')
   AND (COALESCE(event.net_rake,event.bank_amount,0)>0
    OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount<>0))
   AND (NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount>0)
    OR EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
     WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount>0
      AND (b.status IS DISTINCT FROM 'captured' OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
       OR r.rake_amount IS DISTINCT FROM(SELECT sum(s.rake_credit) FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id)))
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
     AND (NOT(s.contract ? 'coordinator_union_id') OR s.contract->'membership'->>'history_id' IS NULL
      OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text)));
  IF NOT related AND NOT unknown_scope THEN CONTINUE;END IF;
  checked:=checked+1;
  IF event.status IS NULL THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_terminal_recognition_missing','tournament_id',event.tournament_id,'unknown_scope',unknown_scope);
  END IF;
  IF event.status='banked_accrual_deferred' THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_deferred','tournament_id',event.tournament_id,'unknown_scope',unknown_scope);
  END IF;
  -- An eventual normal/satellite terminal receipt may follow a banked fee in
  -- another week. Only original fee-bank/recognition time chooses its liability.
  IF event.bank_at IS NOT NULL AND (event.bank_at IS DISTINCT FROM event.recognized_at
    OR event.bank_amount IS DISTINCT FROM event.net_rake OR event.bank_union IS DISTINCT FROM event.union_id) THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_bank_disagrees','tournament_id',event.tournament_id);
  END IF;
  BEGIN proof:=public.fn_accounting_tournament_fee_net_plan(event.tournament_id);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '55000' THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_net_source_evidence_invalid','detail',SQLERRM,'tournament_id',event.tournament_id);
  END;
  IF proof->>'status' IS DISTINCT FROM 'proven' OR proof->>'source_fingerprint' IS DISTINCT FROM event.source_fingerprint
    OR (proof->>'net_fee')::numeric IS DISTINCT FROM event.net_rake OR NULLIF(proof->>'union_id','')::uuid IS DISTINCT FROM event.union_id
    OR (event.status='recognized') IS DISTINCT FROM(event.net_rake>0)
    OR (event.status='cancelled') IS DISTINCT FROM(event.net_rake=0) THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_disagrees_with_sources','tournament_id',event.tournament_id);
  END IF;
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO active_ids FROM jsonb_array_elements_text(proof->'active_source_ids');
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO refunded_ids FROM jsonb_array_elements_text(proof->'refunded_source_ids');
  SELECT count(*) INTO issue_count FROM public.accounting_tournament_fee_sources s
   LEFT JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id
   WHERE s.tournament_id=event.tournament_id AND (rs.source_id IS NULL OR rs.tournament_id IS DISTINCT FROM s.tournament_id
    OR rs.recognized_at IS DISTINCT FROM event.recognized_at
    OR NOT(s.id=ANY(active_ids||refunded_ids))
    OR rs.disposition IS DISTINCT FROM CASE WHEN s.id=ANY(active_ids) THEN 'earned' ELSE 'refunded' END
    OR rs.rake_credit IS DISTINCT FROM CASE WHEN s.id=ANY(active_ids) THEN s.rake_credit ELSE 0 END
    OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text
    OR (s.contract->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit
    OR (s.contract->>'terms_at')::timestamptz IS DISTINCT FROM s.charged_at OR s.charged_at>event.recognized_at
    OR NULLIF(s.contract->>'union_id','')::uuid IS DISTINCT FROM s.union_id
    OR NULLIF(s.contract->>'coordinator_union_id','')::uuid IS DISTINCT FROM s.coordinator_union_id);
  IF issue_count>0 OR EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources rs
   LEFT JOIN public.accounting_tournament_fee_sources s ON s.id=rs.source_id
   WHERE rs.tournament_id=event.tournament_id AND (s.id IS NULL OR s.tournament_id IS DISTINCT FROM event.tournament_id))
   OR (SELECT COALESCE(sum(rake_credit),0) FROM public.accounting_tournament_recognized_sources WHERE tournament_id=event.tournament_id AND disposition='earned') IS DISTINCT FROM event.net_rake THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognized_source_receipts_incomplete','tournament_id',event.tournament_id);
  END IF;
 END LOOP;
 RETURN jsonb_build_object('status','ready','checked',checked);
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_calculate_cash_rakeback_periods(p_club_id uuid,p_period_start date,p_period_end date,p_user_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='300s' AS $function$
DECLARE
 tournament_quality jsonb;v_from timestamptz; v_to timestamptz; cutover timestamptz; receipt jsonb;
 scope_union uuid; issue_count bigint; existing public.rakeback_periods%ROWTYPE;
 certificate public.accounting_rakeback_period_calculations%ROWTYPE;
 player record; total_unrounded numeric; amount numeric; display_rate numeric;
 payer_kind text; payer_user uuid; coordinator_union uuid; allocations jsonb; plan jsonb;
 fingerprint text; period_id uuid; written integer:=0; confirmed integer:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6
    OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids)>2000 OR array_position(p_user_ids,NULL) IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid_accounting_period_request' USING ERRCODE='22023'; END IF;
 receipt:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'written',0,'status','blocked');
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 SELECT starts_at INTO cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
 IF cutover IS NULL OR v_from<cutover THEN RETURN receipt||jsonb_build_object('reason','historical_week_before_observed_source_cutover'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||p_club_id::text||':'||p_period_start::text,0));
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
 -- Tournament fees are earned at terminal recognition. Open captured fees
 -- are excluded; deferred or missing terminal authority blocks its actual week.
 tournament_quality:=public.fn_accounting_tournament_week_quality(p_club_id,v_from,v_to);
 IF tournament_quality->>'status' IS DISTINCT FROM 'ready' THEN
  RETURN receipt||tournament_quality||jsonb_build_object('written',0);END IF;
 WITH scoped_records AS (
  SELECT r.* FROM public.rake_records r
   WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
     AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
     AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata)
     AND (r.club_id=p_club_id
       OR EXISTS(SELECT 1 FROM public.rake_attributions a WHERE a.rake_record_id=r.id AND a.club_id=p_club_id)
       OR EXISTS(SELECT 1 FROM public.clubs house WHERE house.id=r.club_id AND house.is_union IS TRUE
          AND scope_union IS NOT NULL AND (house.union_id=scope_union OR house.id=scope_union)))
 ), checks AS (
  SELECT r.id,r.hand_id,r.rake_amount,count(a.id) AS attribution_count,
    COALESCE(sum(a.weighted_rake_credit),0) AS attributed,
    count(a.id) FILTER(WHERE a.hand_id IS DISTINCT FROM r.hand_id OR a.club_id IS NULL
      OR a.player_id IS NULL OR a.weighted_rake_credit IS NULL OR a.weighted_rake_credit<0
      OR a.weighted_rake_credit<>round(a.weighted_rake_credit,2)
      OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND c.is_union IS NOT TRUE)) AS invalid_count
   FROM scoped_records r LEFT JOIN public.rake_attributions a ON a.rake_record_id=r.id
   GROUP BY r.id,r.hand_id,r.rake_amount
 )
 SELECT count(*) INTO issue_count FROM checks WHERE hand_id IS NULL OR attribution_count=0
  OR invalid_count>0 OR attributed<>rake_amount OR rake_amount<>round(rake_amount,2);
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','cash_earning_evidence_incomplete','source_count',issue_count); END IF;
 -- An old UTC or current-membership period remains an explicit conflict even
 -- when its numbers happen to match. Certificates establish the new writer.
 SELECT count(*) INTO issue_count FROM public.rakeback_periods rp
  WHERE rp.club_id=p_club_id AND rp.period_start<=p_period_end AND rp.period_end>=p_period_start
    AND (rp.status<>'pending' OR rp.period_start<>p_period_start OR rp.period_end<>p_period_end
      OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=rp.id));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','legacy_or_paid_period_requires_reconciliation','period_count',issue_count); END IF;
 SELECT count(*) INTO issue_count FROM public.rake_attributions a JOIN public.rake_records r ON r.id=a.rake_record_id
  LEFT JOIN public.accounting_cash_rake_sources s ON s.rake_record_id=r.id AND s.player_id=a.player_id
  LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=r.id
  WHERE a.club_id=p_club_id AND r.created_at>=v_from AND r.created_at<v_to
    AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL AND r.rake_amount>0
    AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata)
    AND (s.id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR s.club_id IS DISTINCT FROM a.club_id
      OR s.earned_at IS DISTINCT FROM r.created_at OR s.rake_credit IS DISTINCT FROM a.weighted_rake_credit
      OR s.contract->>'attribution_id' IS DISTINCT FROM a.id::text
      OR s.contract->>'player_id' IS DISTINCT FROM a.player_id::text OR s.contract->>'club_id' IS DISTINCT FROM a.club_id::text);
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_incomplete','source_count',issue_count); END IF;
 -- Bidirectional comparison also rejects an extra recorded source that no
 -- longer has an attribution. A matching subset is not a complete source set.
 SELECT count(*) INTO issue_count FROM public.accounting_cash_rake_sources s
  LEFT JOIN public.rake_records r ON r.id=s.rake_record_id
  LEFT JOIN public.rake_attributions a ON a.id=(s.contract->>'attribution_id')::uuid
  LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=s.rake_record_id
  WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
   AND (r.id IS NULL OR a.id IS NULL OR b.status IS DISTINCT FROM 'accrued'
    OR a.rake_record_id IS DISTINCT FROM s.rake_record_id OR a.hand_id IS DISTINCT FROM r.hand_id
    OR a.player_id IS DISTINCT FROM s.player_id OR a.club_id IS DISTINCT FROM s.club_id
    OR a.weighted_rake_credit IS DISTINCT FROM s.rake_credit OR s.earned_at IS DISTINCT FROM r.created_at
    OR r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL
    OR NULLIF(s.contract->'union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.union_id)
    OR NULLIF(s.contract->'coordinator_union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.coordinator_union_id));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',issue_count); END IF;


 FOR player IN
  WITH receipts AS (
   SELECT s.*,CASE WHEN s.source_type='tournament_fee_accrual' THEN fee.charged_at ELSE s.earned_at END AS agreement_at,s.contract->'membership'->'terms' AS member,s.contract->'tiers'->0 AS direct,
    sum(s.rake_credit) OVER(PARTITION BY s.player_id) AS total_rake
   FROM public.accounting_payable_earning_sources s
   LEFT JOIN public.accounting_tournament_fee_sources fee ON s.source_type='tournament_fee_accrual' AND fee.id=s.source_id
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
     AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))
  ), parsed AS (
   SELECT r.*,NULLIF(r.member->>'agent_id','')::uuid AS member_agent,
    COALESCE((r.member->>'player_rakeback_pct')::numeric,0) AS deal,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL
      THEN COALESCE((r.direct->'agreement'->'terms'->>'player_rakeback_rate')::numeric,0) ELSE 0 END AS offer,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL THEN (r.direct->>'rate')::numeric END AS cap_rate,
    mh.id AS member_history_id,ah.id AS agent_history_id,
    mh.after_terms AS recorded_member,ah.after_terms AS recorded_agent
   FROM receipts r
   LEFT JOIN public.accounting_agreement_history mh ON mh.id=(r.contract->'membership'->>'history_id')::bigint
    AND mh.entity_type='club_members' AND mh.entity_key=p_club_id::text||':'||r.player_id::text AND mh.observed_at<=r.agreement_at
   LEFT JOIN public.accounting_agreement_history ah ON ah.id=(r.direct->'agreement'->>'history_id')::bigint
    AND ah.entity_type='agents' AND ah.observed_at<=r.agreement_at
  ), rates AS (
   SELECT p.*,CASE WHEN p.deal>0 THEN p.deal WHEN p.offer>0 THEN p.offer
    WHEN p.total_rake>=10000 THEN 0.30 WHEN p.total_rake>=2000 THEN 0.20
    WHEN p.total_rake>=500 THEN 0.15 WHEN p.total_rake>=100 THEN 0.10 ELSE 0.05 END AS base_rate
   FROM parsed p
  ), effective AS (
   SELECT r.*,CASE WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate
   FROM rates r
  )
  SELECT e.player_id,max(e.total_rake) AS total_rake,sum(e.rake_credit*e.applied_rate) AS total_unrounded,
   count(*) FILTER(WHERE e.member_history_id IS NULL OR e.member IS DISTINCT FROM e.recorded_member
    OR e.member->>'club_id' IS DISTINCT FROM p_club_id::text OR e.member->>'user_id' IS DISTINCT FROM e.player_id::text
    OR COALESCE(e.member->>'status','') NOT IN('active','approved') OR e.member->>'is_active' IS DISTINCT FROM 'true') AS invalid_members,
   count(*) FILTER(WHERE e.member_agent IS NOT NULL AND (e.direct IS NULL OR e.agent_history_id IS NULL
    OR e.direct->'agreement'->'terms' IS DISTINCT FROM e.recorded_agent
    OR e.direct->>'user_id' IS DISTINCT FROM e.member_agent::text OR e.direct->>'depth' IS DISTINCT FROM '1'
    OR e.recorded_agent->>'club_id' IS DISTINCT FROM p_club_id::text OR e.recorded_agent->>'user_id' IS DISTINCT FROM e.member_agent::text
    OR e.recorded_agent->>'status' IS DISTINCT FROM 'active')) AS invalid_agents,
   count(*) FILTER(WHERE e.deal::text IN('NaN','Infinity','-Infinity') OR e.offer::text IN('NaN','Infinity','-Infinity')
    OR e.deal<0 OR e.deal>1 OR e.offer<0 OR e.offer>1
    OR (e.member_agent IS NOT NULL AND (e.cap_rate IS NULL OR e.cap_rate<0 OR e.cap_rate>1 OR e.cap_rate::text IN('NaN','Infinity','-Infinity')))) AS invalid_rates,
   count(DISTINCT COALESCE(e.member_agent::text,'club')) AS payer_count,
   count(DISTINCT COALESCE(e.coordinator_union_id::text,'standalone')) AS coordinator_count,
   min(e.member_agent::text)::uuid AS payer_user,
   min(e.coordinator_union_id::text)::uuid AS coordinator_union,
   jsonb_agg(jsonb_build_object('source_type',e.source_type,'source_id',e.source_id,'rake_record_id',e.rake_record_id,'union_id',e.union_id,
    'coordinator_union_id',e.coordinator_union_id,'rake_credit',e.rake_credit,'rate',e.applied_rate,
    'unrounded_rakeback',e.rake_credit*e.applied_rate,'earned_at',e.earned_at,'agreement_at',e.agreement_at,'membership_history_id',e.member_history_id,
    'agent_history_id',e.agent_history_id,'payer_kind',CASE WHEN e.member_agent IS NULL THEN 'club' ELSE 'agent' END,
    'payer_user_id',e.member_agent) ORDER BY e.earned_at,e.source_type,e.rake_record_id,e.source_id) AS allocations
  FROM effective e GROUP BY e.player_id ORDER BY e.player_id
 LOOP
  IF player.invalid_members>0 THEN RAISE EXCEPTION 'period_membership_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_agents>0 THEN RAISE EXCEPTION 'period_direct_agent_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_rates>0 THEN RAISE EXCEPTION 'period_observed_rate_invalid' USING ERRCODE='55000'; END IF;
  IF player.payer_count<>1 THEN RAISE EXCEPTION 'multiple_historical_payers_require_split_period' USING ERRCODE='55000'; END IF;
  IF player.coordinator_count<>1 THEN RAISE EXCEPTION 'multiple_recorded_coordinators_require_split_period' USING ERRCODE='55000'; END IF;
  total_unrounded:=player.total_unrounded;allocations:=player.allocations;payer_user:=player.payer_user;coordinator_union:=player.coordinator_union;
  payer_kind:=CASE WHEN payer_user IS NULL THEN 'club' ELSE 'agent' END;
  amount:=round(total_unrounded,2);
  display_rate:=CASE WHEN player.total_rake>0 THEN round(total_unrounded/player.total_rake,4) ELSE 0 END;
  IF amount>player.total_rake OR amount<0 THEN RAISE EXCEPTION 'period_rakeback_not_conserved' USING ERRCODE='55000'; END IF;
  fingerprint:=md5(jsonb_build_object('allocations',allocations,'rake',player.total_rake,'amount',amount,'rate',display_rate)::text);
  plan:=jsonb_build_object('player_id',player.player_id,'rake_generated',player.total_rake,
   'rakeback_amount',amount,'display_rate',display_rate,'coordinator_union_id',coordinator_union,'payer_kind',payer_kind,'payer_user_id',payer_user,
   'source_fingerprint',fingerprint,'allocations',allocations);
  SELECT * INTO existing FROM public.rakeback_periods WHERE club_id=p_club_id AND user_id=(plan->>'player_id')::uuid
    AND period_start=p_period_start AND period_end=p_period_end FOR UPDATE;
  IF FOUND THEN
   SELECT * INTO certificate FROM public.accounting_rakeback_period_calculations cert WHERE cert.period_id=existing.id ORDER BY cert.id DESC LIMIT 1;
   IF NOT FOUND OR certificate.accounting_version<>2 OR certificate.club_id IS DISTINCT FROM p_club_id
    OR certificate.player_id IS DISTINCT FROM existing.user_id OR certificate.period_start IS DISTINCT FROM p_period_start
    OR certificate.period_end IS DISTINCT FROM p_period_end
    OR existing.status<>'pending' OR existing.rake_generated IS DISTINCT FROM certificate.rake_generated
    OR existing.total_rake_paid IS DISTINCT FROM certificate.rake_generated OR existing.rakeback_rate IS DISTINCT FROM certificate.display_rate
    OR existing.rakeback_earned IS DISTINCT FROM certificate.rakeback_amount OR existing.rakeback_amount IS DISTINCT FROM certificate.rakeback_amount
   THEN RAISE EXCEPTION 'certified_period_drift_requires_reconciliation' USING ERRCODE='55000'; END IF;
   period_id:=existing.id;
   IF certificate.source_fingerprint=plan->>'source_fingerprint' THEN confirmed:=confirmed+1; CONTINUE; END IF;
   UPDATE public.rakeback_periods SET rake_generated=(plan->>'rake_generated')::numeric,total_rake_paid=(plan->>'rake_generated')::numeric,
    rakeback_rate=(plan->>'display_rate')::numeric,rakeback_earned=(plan->>'rakeback_amount')::numeric,rakeback_amount=(plan->>'rakeback_amount')::numeric
    WHERE id=period_id;
  ELSE
   INSERT INTO public.rakeback_periods(user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_earned,rakeback_amount,total_rake_paid,status)
    VALUES((plan->>'player_id')::uuid,p_club_id,p_period_start,p_period_end,(plan->>'rake_generated')::numeric,
     (plan->>'display_rate')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rake_generated')::numeric,'pending')
    RETURNING id INTO period_id;
  END IF;
  INSERT INTO public.accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,
    rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
   VALUES(period_id,plan->>'source_fingerprint',p_club_id,(plan->>'player_id')::uuid,(plan->>'coordinator_union_id')::uuid,p_period_start,p_period_end,
    (plan->>'rake_generated')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'display_rate')::numeric,
    plan->>'payer_kind',(plan->>'payer_user_id')::uuid,plan->'allocations');
  written:=written+1;confirmed:=confirmed+1;
 END LOOP;
 RETURN receipt||jsonb_build_object('status','ready','written',written,'confirmed_players',confirmed);
EXCEPTION WHEN SQLSTATE '55000' THEN
 RETURN receipt||jsonb_build_object('reason',SQLERRM);
END $function$;
REVOKE ALL ON FUNCTION public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated,service_role;

-- Component 20260914141800_union_close_matches_recorded_earnings_to_every_bank_credit.sql
-- Round 1, statements, cash, and recognized tournament fees share one
-- immutable earning basis. Every source must match an actual bank deposit.
-- Historical final statements retain their original frozen paid basis.

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_union_club_rake_basis(uuid,timestamptz,timestamptz,boolean)'::regprocedure))<>'73e6a90482ad9a5e0bcac494e371651e'
 OR md5(pg_get_functiondef('public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure))<>'315af918ff53073c0d1f08f4189e49d3'
 THEN RAISE EXCEPTION 'union source close preimage changed';END IF;
END $guard$;
CREATE FUNCTION public.fn_accounting_union_earned_plan(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE issue_count bigint;bank_total numeric;source_total numeric;house_total numeric;detail jsonb;fingerprint text;
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
 THEN RAISE EXCEPTION 'invalid_union_earning_source_period' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_start)
 THEN RAISE EXCEPTION 'union_earning_source_historical_week_uncertified' USING ERRCODE='55000'; END IF;
 -- Each real rake-bank credit must have exactly one typed source authority.
 -- A banked tournament with missing agreements is a debt exception, never
 -- silently reclassified as retained union revenue.
 SELECT count(*) INTO issue_count FROM public.union_wallet_transactions t
  LEFT JOIN public.accounting_cash_bank_receipts c ON c.union_transaction_id=t.id
  LEFT JOIN public.accounting_tournament_fee_recognitions f ON f.union_wallet_transaction_id=t.id
  WHERE t.union_id=p_union_id AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
   AND t.created_at>=p_start AND t.created_at<p_end
   AND (((c.rake_record_id IS NOT NULL)::int+(f.tournament_id IS NOT NULL)::int)<>1
    OR (c.rake_record_id IS NOT NULL AND (c.union_id IS DISTINCT FROM p_union_id OR c.amount IS DISTINCT FROM t.amount
     OR c.banked_at IS DISTINCT FROM t.created_at OR c.club_ledger_id IS NOT NULL))
    OR (f.tournament_id IS NOT NULL AND (f.union_id IS DISTINCT FROM p_union_id OR f.net_rake IS DISTINCT FROM t.amount
     OR f.recognized_at IS DISTINCT FROM t.created_at OR f.status IS DISTINCT FROM 'recognized' OR f.bank_journal_id IS NOT NULL))
    OR t.amount IS NULL OR t.amount<=0 OR t.amount<>round(t.amount,2) OR t.amount::text IN('NaN','Infinity','-Infinity'));
 IF issue_count>0 THEN RAISE EXCEPTION 'union_rake_bank_source_unverified:%',issue_count USING ERRCODE='55000'; END IF;
 -- Check the reverse direction too, including sources whose bank row was
 -- changed to another week, union, wallet, or category.
 SELECT count(*) INTO issue_count FROM (
  SELECT c.union_transaction_id AS bank_id,c.banked_at AS earned_at,c.amount AS amount,c.union_id
   FROM public.accounting_cash_bank_receipts c WHERE c.union_id=p_union_id AND c.banked_at>=p_start AND c.banked_at<p_end
  UNION ALL
  SELECT f.union_wallet_transaction_id,f.recognized_at,f.net_rake,f.union_id
   FROM public.accounting_tournament_fee_recognitions f WHERE f.union_id=p_union_id AND f.net_rake>0
    AND f.recognized_at>=p_start AND f.recognized_at<p_end
 ) s LEFT JOIN public.union_wallet_transactions t ON t.id=s.bank_id
 WHERE t.id IS NULL OR t.union_id IS DISTINCT FROM s.union_id OR t.created_at IS DISTINCT FROM s.earned_at
  OR t.amount IS DISTINCT FROM s.amount OR t.wallet IS DISTINCT FROM 'rake_wallet'
  OR t.direction IS DISTINCT FROM 'credit' OR t.tx_type IS DISTINCT FROM 'rake';
 IF issue_count>0 THEN RAISE EXCEPTION 'union_rake_bank_receipt_drifted:%',issue_count USING ERRCODE='55000'; END IF;
 SELECT count(*) INTO issue_count FROM public.accounting_cash_bank_receipts c
  LEFT JOIN public.rake_records r ON r.id=c.rake_record_id
  LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=c.rake_record_id
  LEFT JOIN LATERAL (SELECT count(*) AS n,sum(s.rake_credit) AS total,
    count(*) FILTER(WHERE s.union_id IS DISTINCT FROM c.union_id OR s.earned_at IS DISTINCT FROM c.banked_at) AS invalid
    FROM public.accounting_payable_earning_sources s WHERE s.source_type='cash_rake_accrual' AND s.rake_record_id=c.rake_record_id) x ON true
  WHERE c.union_id=p_union_id AND c.banked_at>=p_start AND c.banked_at<p_end
   AND (r.id IS NULL OR r.rake_amount IS DISTINCT FROM c.amount OR r.created_at IS DISTINCT FROM c.banked_at
    OR r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL OR b.status IS DISTINCT FROM 'accrued'
    OR b.earned_at IS DISTINCT FROM r.created_at OR x.n=0 OR x.total IS DISTINCT FROM c.amount OR x.invalid>0);
 IF issue_count>0 THEN RAISE EXCEPTION 'union_cash_sources_do_not_match_bank:%',issue_count USING ERRCODE='55000'; END IF;
 SELECT count(*) INTO issue_count FROM public.accounting_tournament_fee_recognitions f
  LEFT JOIN LATERAL (SELECT count(*) AS n,sum(s.rake_credit) AS total
   FROM public.accounting_payable_earning_sources s WHERE s.source_type='tournament_fee_accrual'
    AND s.tournament_id=f.tournament_id AND s.union_id=p_union_id AND s.earned_at=f.recognized_at) x ON true
  WHERE f.union_id=p_union_id AND f.recognized_at>=p_start AND f.recognized_at<p_end AND f.net_rake>0
   AND (f.status IS DISTINCT FROM 'recognized' OR x.n=0 OR x.total IS DISTINCT FROM f.net_rake);
 IF issue_count>0 THEN RAISE EXCEPTION 'union_tournament_sources_do_not_match_bank:%',issue_count USING ERRCODE='55000'; END IF;
 SELECT count(*) INTO issue_count FROM public.accounting_payable_earning_sources s
  LEFT JOIN public.accounting_cash_bank_receipts c ON s.source_type='cash_rake_accrual' AND c.rake_record_id=s.rake_record_id
  LEFT JOIN public.accounting_tournament_fee_recognitions f ON s.source_type='tournament_fee_accrual' AND f.tournament_id=s.tournament_id
  WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end
   AND ((s.source_type='cash_rake_accrual' AND (c.rake_record_id IS NULL OR c.union_id IS DISTINCT FROM s.union_id OR c.banked_at IS DISTINCT FROM s.earned_at))
    OR (s.source_type='tournament_fee_accrual' AND (f.tournament_id IS NULL OR f.union_id IS DISTINCT FROM s.union_id
      OR f.recognized_at IS DISTINCT FROM s.earned_at OR f.status IS DISTINCT FROM 'recognized'))
    OR s.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual'));
 IF issue_count>0 THEN RAISE EXCEPTION 'union_earning_source_without_bank:%',issue_count USING ERRCODE='55000'; END IF;
 -- The recorded union agreement must be the latest observation at earning
 -- (cash) or charge (tournament) time. Current membership/rates do not alter it.
 WITH sources AS (
  SELECT s.*,COALESCE(f.game_type,'cash') AS game_type,
   s.contract->'union_agreement' AS agreement,(s.contract->>'terms_at')::timestamptz AS terms_at,
   COALESCE((s.contract->>'is_union_house')::boolean,false) AS is_house
   FROM public.accounting_payable_earning_sources s LEFT JOIN public.accounting_tournament_fee_sources f
    ON s.source_type='tournament_fee_accrual' AND f.id=s.source_id
   WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end
 ), checked AS (
  SELECT s.*,h.id AS history_id,h.observed_at,h.after_terms,
   COALESCE(CASE s.game_type WHEN 'cash' THEN s.agreement->'terms'->>'rate_cash'
    WHEN 'mtt' THEN s.agreement->'terms'->>'rate_mtt' WHEN 'sng' THEN s.agreement->'terms'->>'rate_sng'
    WHEN 'spin' THEN s.agreement->'terms'->>'rate_spin' WHEN 'satellite' THEN s.agreement->'terms'->>'rate_satellite' END,
    s.agreement->'terms'->>'club_commission_rate')::numeric AS rate
   FROM sources s LEFT JOIN public.accounting_agreement_history h ON h.id=(s.agreement->>'history_id')::bigint
 )
 SELECT count(*) INTO issue_count FROM checked s
 WHERE s.contract->>'club_id' IS DISTINCT FROM s.club_id::text OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text
  OR s.contract->>'union_id' IS DISTINCT FROM p_union_id::text OR s.coordinator_union_id IS DISTINCT FROM p_union_id
  OR (s.contract->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit OR s.terms_at IS NULL OR s.terms_at>s.earned_at
  OR (s.source_type='cash_rake_accrual' AND s.terms_at IS DISTINCT FROM s.earned_at)
  OR (s.source_type='tournament_fee_accrual' AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f
    WHERE f.id=s.source_id AND f.charged_at=s.terms_at))
  OR (s.is_house AND (s.agreement IS DISTINCT FROM 'null'::jsonb OR NOT EXISTS(SELECT 1 FROM public.clubs c
    WHERE c.id=s.club_id AND c.is_union IS TRUE AND (c.id=p_union_id OR c.union_id=p_union_id))))
  OR (NOT s.is_house AND (s.history_id IS NULL OR s.after_terms IS DISTINCT FROM s.agreement->'terms'
    OR s.agreement->'terms'->>'club_id' IS DISTINCT FROM s.club_id::text OR s.agreement->'terms'->>'union_id' IS DISTINCT FROM p_union_id::text
    OR s.observed_at>s.terms_at OR s.observed_at IS DISTINCT FROM (s.agreement->>'observed_at')::timestamptz
    OR NOT EXISTS(SELECT 1 FROM public.accounting_agreement_history h WHERE h.id=s.history_id AND h.entity_type='union_clubs'
     AND h.club_id=s.club_id AND h.entity_key=s.agreement->'terms'->>'id')
    OR EXISTS(SELECT 1 FROM public.accounting_agreement_history h JOIN public.accounting_agreement_history old ON old.id=s.history_id
      WHERE h.entity_type='union_clubs' AND h.entity_key=old.entity_key AND h.observed_at<=s.terms_at AND (h.observed_at,h.id)>(old.observed_at,old.id))
    OR s.rate IS NULL OR s.rate<0 OR s.rate>1 OR s.rate::text IN('NaN','Infinity','-Infinity')));
 IF issue_count>0 THEN RAISE EXCEPTION 'union_earning_agreement_unverified:%',issue_count USING ERRCODE='55000'; END IF;
 SELECT COALESCE(sum(amount),0) INTO bank_total FROM public.union_wallet_transactions
  WHERE union_id=p_union_id AND wallet='rake_wallet' AND direction='credit' AND tx_type='rake' AND created_at>=p_start AND created_at<p_end;
 SELECT COALESCE(sum(s.rake_credit),0),COALESCE(sum(s.rake_credit) FILTER(WHERE (s.contract->>'is_union_house')::boolean),0),
  md5(COALESCE(string_agg(md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.tournament_id,s.earned_at,s.rake_credit,s.contract)::text),
    '' ORDER BY s.source_type,s.source_id),'')) INTO source_total,house_total,fingerprint
  FROM public.accounting_payable_earning_sources s WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end;
 IF source_total IS DISTINCT FROM bank_total THEN RAISE EXCEPTION 'union_earned_rake_does_not_conserve_bank' USING ERRCODE='55000'; END IF;
 WITH source_rates AS (
  SELECT s.club_id,COALESCE(f.game_type,'cash') AS game_type,s.rake_credit,
   COALESCE(CASE COALESCE(f.game_type,'cash') WHEN 'cash' THEN s.contract->'union_agreement'->'terms'->>'rate_cash'
    WHEN 'mtt' THEN s.contract->'union_agreement'->'terms'->>'rate_mtt' WHEN 'sng' THEN s.contract->'union_agreement'->'terms'->>'rate_sng'
    WHEN 'spin' THEN s.contract->'union_agreement'->'terms'->>'rate_spin' WHEN 'satellite' THEN s.contract->'union_agreement'->'terms'->>'rate_satellite' END,
    s.contract->'union_agreement'->'terms'->>'club_commission_rate')::numeric AS rate
  FROM public.accounting_payable_earning_sources s LEFT JOIN public.accounting_tournament_fee_sources f
   ON s.source_type='tournament_fee_accrual' AND f.id=s.source_id
  WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end AND COALESCE((s.contract->>'is_union_house')::boolean,false) IS FALSE
 ), basis AS (
  SELECT club_id,game_type,sum(rake_credit) AS rake_in,
   CASE WHEN sum(rake_credit)>0 THEN sum(rake_credit*rate)/sum(rake_credit) ELSE 0 END AS rate,
   trunc(sum(rake_credit*rate),2) AS payout FROM source_rates GROUP BY club_id,game_type
 ) SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY club_id,game_type),'[]') INTO detail FROM basis b;
 RETURN jsonb_build_object('accounting_version',3,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'period_rake',bank_total,'earned_rake',source_total,'house_rake',house_total,'source_fingerprint',fingerprint,'basis_detail',detail);
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_union_club_rake_basis(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_live boolean DEFAULT false)
 RETURNS TABLE(club_id uuid, game_type text, rake_in numeric, rate numeric, payout numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sref text;
BEGIN
  IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RETURN;
  END IF;

  /* THE WITNESS FIRST. A period that has been closed stored the rows it was
     paid from; a statement for that period describes THAT, never a
     recomputation over attribution tables that may since have moved. */
  v_sref := p_union_id::text || ':'
    || to_char(p_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(p_end   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  IF EXISTS (SELECT 1 FROM public.ca_settlements s
              WHERE s.settlement_type = 'union_rakeback_close' AND s.union_id = p_union_id
                AND s.state = 'final' AND s.external_ref = v_sref
                AND s.totals ? 'basis_detail') THEN
    RETURN QUERY
      SELECT (d->>'club_id')::uuid, d->>'game_type',
             (d->>'rake_in')::numeric, (d->>'rate')::numeric, (d->>'payout')::numeric
        FROM public.ca_settlements s
        CROSS JOIN LATERAL jsonb_array_elements(s.totals->'basis_detail') d
       WHERE s.settlement_type = 'union_rakeback_close' AND s.union_id = p_union_id
         AND s.state = 'final' AND s.external_ref = v_sref;
    RETURN;
  END IF;

  -- Open/current statements and the close read exactly the same certified
  -- source plan. An old hourly projection cannot replace earning contracts.
  RETURN QUERY SELECT (d->>'club_id')::uuid,d->>'game_type',(d->>'rake_in')::numeric,
    (d->>'rate')::numeric,(d->>'payout')::numeric
   FROM jsonb_array_elements(public.fn_accounting_union_earned_plan(p_union_id,p_start,p_end)->'basis_detail')d;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close(p_union_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_plan jsonb; v_ledger_id uuid; v_prior_context jsonb; context_key text;
  v_wallet       public.union_wallets%ROWTYPE;
  v_period_total numeric := 0;
  v_payout_total numeric := 0;
  v_retained     numeric := 0;
  v_clubs_paid   integer := 0;
  v_club         record;
  v_new_rw       numeric;
  v_new_cb       numeric;
  v_rw_before    numeric;
  v_cb_before    numeric;
  v_clubs_before numeric := 0;
  v_clubs_after  numeric := 0;
  v_credit       jsonb;
  v_sref         text;
  v_sid          uuid;
  v_sstate       text;
  v_actor        uuid;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
  -- EMERGENCY SETTLEMENT LOCK CHECK
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_end <= p_period_start OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) THEN
    RETURN jsonb_build_object('success', false, 'error', 'bad_params');
  END IF;

  IF EXISTS (SELECT 1 FROM public.union_settlement_floor f
              WHERE f.union_id = p_union_id
                AND p_period_start < f.earliest_period_start) THEN
    RETURN jsonb_build_object('success', false, 'error', 'before_settlement_floor');
  END IF;

  -- Every entry point uses the union's calendar, including DST boundaries.
  IF p_period_start <> public.fn_union_week_start(p_period_start)
     OR p_period_end <> public.fn_union_week_start(p_period_end)
     OR p_period_end <> public.fn_union_week_start(p_period_start+interval '8 days')
     OR p_period_end > public.fn_union_week_start(now()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'period_not_closed_union_weeks');
  END IF;

  -- Accrual and bank producers acquire this exact scope before writing.
  PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||p_union_id::text||':'
    ||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text,0));

  IF EXISTS (
    SELECT 1 FROM union_rakeback_log
     WHERE union_id = p_union_id
       AND period_start = p_period_start AND period_end = p_period_end
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_executed');
  END IF;

  -- settlement walk: one row per (union, period), resumable after 'failed'
  v_sref := p_union_id::text || ':'
    || to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(p_period_end   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  SELECT id, state INTO v_sid, v_sstate
    FROM ca_settlements
   WHERE settlement_type = 'union_rakeback_close' AND external_ref = v_sref
   FOR UPDATE;
  IF v_sid IS NULL THEN
    INSERT INTO ca_settlements (id, settlement_type, external_ref, state, union_id, totals)
    VALUES (gen_random_uuid(), 'union_rakeback_close', v_sref, 'open', p_union_id, '{}'::jsonb)
    RETURNING id INTO v_sid;
  ELSIF v_sstate = 'final' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_executed', 'settlement_id', v_sid);
  ELSIF v_sstate = 'failed' THEN
    UPDATE ca_settlements SET state = 'open', error_detail = NULL WHERE id = v_sid;  -- resume
  ELSE
    -- intermediate states never persist (single transaction), so anything
    -- else here is a concurrent close of the same period. Refuse loudly.
    RETURN jsonb_build_object('success', false, 'error', 'close_already_in_state_' || v_sstate,
                              'settlement_id', v_sid);
  END IF;

  UPDATE ca_settlements SET state = 'locked_for_calculation' WHERE id = v_sid;

  SELECT * INTO v_wallet FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_wallet.union_id IS NULL THEN
    UPDATE ca_settlements SET state = 'failed', error_detail = 'no_wallet' WHERE id = v_sid;
    RETURN jsonb_build_object('success', false, 'error', 'no_wallet', 'settlement_id', v_sid);
  END IF;

  -- Recheck after the union wallet lock: concurrent overlapping closes cannot
  -- both consume the same rake credits under different period identities.
  IF EXISTS (SELECT 1 FROM public.union_rakeback_log l
              WHERE l.union_id = p_union_id
                AND l.period_start < p_period_end AND l.period_end > p_period_start) THEN
    UPDATE public.ca_settlements SET state = 'failed', error_detail = 'overlapping_closed_period' WHERE id = v_sid;
    RETURN jsonb_build_object('success', false, 'error', 'overlapping_closed_period', 'settlement_id', v_sid);
  END IF;

  BEGIN
    PERFORM 1 FROM public.union_wallet_transactions t WHERE t.union_id=p_union_id
      AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
      AND t.created_at>=p_period_start AND t.created_at<p_period_end ORDER BY t.id FOR SHARE;
    v_source_plan:=public.fn_accounting_union_earned_plan(p_union_id,p_period_start,p_period_end);
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.ca_settlements SET state='failed',error_detail=left(SQLERRM,2000) WHERE id=v_sid;
    RETURN jsonb_build_object('success',false,'error','union_earning_source_not_certified','detail',SQLERRM,'settlement_id',v_sid);
  END;

  /* THE PERIOD (unchanged): everything the rake treasury received. Each credit
     now also carries the GAME TYPE it came from: the named tournament's
     tournament_type, or cash when it names none. */
  DROP TABLE IF EXISTS _uwrb_credits;
  CREATE TEMP TABLE _uwrb_credits ON COMMIT DROP AS
  WITH raw AS (
    SELECT t.id, t.amount, t.notes, t.created_at,
           substring(t.notes from '\[tournament ([0-9a-f-]+)\]')::uuid AS tournament_id
      FROM union_wallet_transactions t
     WHERE t.union_id = p_union_id
       AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
       AND t.created_at >= p_period_start AND t.created_at < p_period_end
  )
  SELECT r.id, r.amount, r.notes, r.created_at, r.tournament_id,
         CASE WHEN r.tournament_id IS NULL THEN 'cash'
              ELSE COALESCE(lower(tr.tournament_type), 'other') END AS game_type
    FROM raw r
    LEFT JOIN tournaments tr ON tr.id = r.tournament_id;

  DROP TABLE IF EXISTS _uwrb_by_type;
  /* THE BASIS (Dan, 2026-09-03) lives in fn_union_club_rake_basis since
     Phase 6 (20260907): the statement and the reconciliation report read
     the same function, so what is paid and what is described cannot
     diverge. The block that used to be here is that function, verbatim. */
  CREATE TEMP TABLE _uwrb_by_type ON COMMIT DROP AS
  SELECT b.club_id, b.game_type, b.rake_in, b.rate, b.payout
    FROM public.fn_union_club_rake_basis(p_union_id, p_period_start, p_period_end, true) b;

  /* The per-club roll-up the money section pays from. */
  DROP TABLE IF EXISTS _uwrb;
  CREATE TEMP TABLE _uwrb ON COMMIT DROP AS
  SELECT club_id,
         round(sum(rake_in), 2) AS rake_in,
         round(sum(payout), 2)  AS payout
    FROM _uwrb_by_type
   GROUP BY club_id;

  SELECT round(COALESCE(SUM(amount), 0), 2) INTO v_period_total FROM _uwrb_credits;
  SELECT round(COALESCE(SUM(payout), 0), 2) INTO v_payout_total
    FROM _uwrb WHERE club_id IS NOT NULL AND club_id <> p_union_id;
  IF v_period_total IS DISTINCT FROM (v_source_plan->>'period_rake')::numeric THEN
    RAISE EXCEPTION 'union_rake_bank_changed_during_close' USING ERRCODE='55000';
  END IF;
  v_retained := round(v_period_total - v_payout_total, 2);

  /* a share can never exceed what the treasury received: the attribution is
     a view of the same credits, so this only trips on a data fault */
  IF v_payout_total > v_period_total THEN
    UPDATE ca_settlements SET state = 'failed', error_detail = 'attribution_exceeds_treasury' WHERE id = v_sid;
    RETURN jsonb_build_object('success', false, 'error', 'attribution_exceeds_treasury',
      'period_rake', v_period_total, 'payout', v_payout_total, 'settlement_id', v_sid);
  END IF;

  UPDATE ca_settlements
     SET state = 'calculated',
         totals = jsonb_build_object('period_rake', v_period_total, 'payout_total', v_payout_total,
                                     'retained', v_retained,
                                     'basis', 'immutable_earned_sources_matched_to_bank',
                                     'accounting_version',3,
                                     'source_fingerprint',v_source_plan->'source_fingerprint',
                                     'house_rake',v_source_plan->'house_rake',
                                     'rate_model', 'observed_per_source_truncated_per_club_game',
                                     'basis_by_club', (SELECT COALESCE(jsonb_object_agg(club_id::text, rake_in), '{}'::jsonb) FROM _uwrb),
                                     'payout_by_club', (SELECT COALESCE(jsonb_object_agg(club_id::text, payout), '{}'::jsonb) FROM _uwrb),
                                     'basis_detail', (SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id', club_id, 'game_type', game_type, 'rake_in', rake_in, 'rate', rate, 'payout', payout) ORDER BY club_id, game_type), '[]'::jsonb) FROM _uwrb_by_type),
                                     'basis_by_game_type', (SELECT COALESCE(jsonb_object_agg(game_type, x), '{}'::jsonb)
                                                              FROM (SELECT game_type,
                                                                           jsonb_build_object('basis', round(sum(rake_in), 2),
                                                                                              'payout', round(sum(payout), 2)) AS x
                                                                      FROM _uwrb_by_type GROUP BY game_type) g),
                                     'rates', (SELECT COALESCE(jsonb_object_agg(club_id::text || ':' || game_type, rate), '{}'::jsonb)
                                                 FROM _uwrb_by_type))
   WHERE id = v_sid;

  IF v_period_total <= 0 THEN
    INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
    VALUES (p_union_id, p_period_start, p_period_end, 0, now());
    UPDATE ca_settlements SET state = 'validated' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'ledger_posted' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'post_commit_verified' WHERE id = v_sid;
    UPDATE ca_settlements SET state = 'final' WHERE id = v_sid;
    RETURN jsonb_build_object('success', true, 'clubs_paid', 0,
      'period_rake', 0, 'total_rakeback', 0, 'union_retained', 0, 'note', 'no_rake',
      'settlement_id', v_sid);
  END IF;

  /* SEPARATE POTS (Phase 2.1). The rake treasury owes the whole period: the
     clubs' share leaves it as rakeback, the union's share leaves it for the
     general bank. The general bank is never a source. A treasury that cannot
     cover the period refuses the close whole - never partial, never from the
     bank - and says so. Who eats a short treasury is Dan's ruling
     (roadmap decision 4). */
  IF v_period_total > COALESCE(v_wallet.rake_wallet, 0) THEN
    UPDATE ca_settlements SET state = 'failed', error_detail = 'insufficient_rake_treasury' WHERE id = v_sid;
    PERFORM public.fn_ca_raise_drift_incident(
      'rakeback_close', 'incorrect_rakeback', 'critical',
      'rakeback-insufficient:' || p_union_id::text || ':' || to_char(p_period_start, 'YYYY-MM-DD'),
      v_period_total - COALESCE(v_wallet.rake_wallet, 0),
      v_period_total,
      COALESCE(v_wallet.rake_wallet, 0),
      'settlement', 'union', p_union_id, NULL, p_union_id,
      NULL, NULL, NULL, v_sid::text, NULL, NULL,
      'union rake treasury cannot cover the period it owes; close refused before any movement (the general bank is never a source)',
      true,
      jsonb_build_object('rake_wallet', v_wallet.rake_wallet,
                         'chip_balance', v_wallet.chip_balance,
                         'period_total', v_period_total,
                         'payout', v_payout_total, 'retained', v_retained,
                         'period_start', p_period_start, 'period_end', p_period_end));
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_rake_treasury', 'retryable', true,
      'period_rake', v_period_total, 'payout', v_payout_total,
      'rake_wallet', v_wallet.rake_wallet, 'chip_balance', v_wallet.chip_balance,
      'settlement_id', v_sid);
  END IF;

  UPDATE ca_settlements SET state = 'validated' WHERE id = v_sid;

  SELECT jsonb_object_agg(k,current_setting(k,true)) INTO v_prior_context FROM unnest(ARRAY[
    'app.ledger_autoskip_clubs','app.ledger_autoskip_union_wallets','app.ledger_category',
    'app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_settlement'])k;
  -- guarded money section: all of it lands, or none of it does
  BEGIN
    /* One declaration for every balance write below. The union_wallets
       auto-ledger is skipped: the union side of each club credit is the
       from-leg of the club's own row, and the retained share is written
       explicitly. */
    PERFORM public.fn_ca_declare_ledger('rakeback', 'union_wallet', p_union_id, v_sid, NULL,
                                        ARRAY['union_wallets','clubs']);
    v_actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

    v_rw_before := round(COALESCE(v_wallet.rake_wallet, 0), 2);
    v_cb_before := round(COALESCE(v_wallet.chip_balance, 0), 2);
    SELECT round(COALESCE(SUM(c.chip_treasury), 0), 2) INTO v_clubs_before
      FROM clubs c
     WHERE c.id IN (SELECT club_id FROM _uwrb
                     WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0);

    FOR v_club IN
      SELECT club_id, rake_in, payout FROM _uwrb
       WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0 ORDER BY club_id
    LOOP
      v_credit := fn_credit_treasury(
        v_club.club_id, v_club.payout,
        'Union weekly rakeback ' || to_char(p_period_start, 'YYYY-MM-DD')
          || '..' || to_char(p_period_end, 'YYYY-MM-DD'),
        jsonb_build_object('union_id', p_union_id,
                           'period_start', p_period_start, 'period_end', p_period_end,
                           'rake_basis', v_club.rake_in, 'rate', 'per_game_type',
                           'by_game_type', (SELECT COALESCE(jsonb_object_agg(game_type,
                                                     jsonb_build_object('basis', rake_in, 'rate', rate, 'payout', payout)), '{}'::jsonb)
                                              FROM _uwrb_by_type g WHERE g.club_id = v_club.club_id),
                           'settlement_id', v_sid),
        'union_close:' || v_sid::text || ':' || v_club.club_id::text
      );
      IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'treasury credit failed for club %: %', v_club.club_id, v_credit;
      END IF;
      -- The earning union is explicit even if the club has since left or
      -- joined another union. Do not derive this journal scope from the club's
      -- current union_id via its generic balance trigger.
      INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,
        club_id,union_id,description,idempotency_key,metadata,pre_to_balance,post_to_balance)
      VALUES(v_actor,'union_wallet',p_union_id,'club_treasury',v_club.club_id,v_club.payout,'rakeback',
        v_club.club_id,p_union_id,'Union weekly rakeback from recorded earnings',
        'union_close:'||v_sid::text||':'||v_club.club_id::text,
        jsonb_build_object('settlement_id',v_sid,'period_start',p_period_start,'period_end',p_period_end,
          'rake_basis',v_club.rake_in,'accounting_version',3,'source_fingerprint',v_source_plan->'source_fingerprint'),
        (v_credit->>'balance_before')::numeric,(v_credit->>'balance_after')::numeric) RETURNING id INTO v_ledger_id;
      IF NOT EXISTS(SELECT 1 FROM public.settlement_invoices i WHERE i.source_ledger_id=v_ledger_id AND i.status='paid'
        AND i.net_amount=v_club.payout AND i.chips_transferred AND i.message_sent
        AND EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=i.id)) THEN
        RAISE EXCEPTION 'union_close_invoice_receipt_missing' USING ERRCODE='23514';
      END IF;
      v_clubs_paid := v_clubs_paid + 1;
    END LOOP;

    -- one debit per pot: the treasury pays the whole period; the retained
    -- share moves to the general bank
    UPDATE union_wallets
       SET rake_wallet       = rake_wallet - v_period_total,
           chip_balance      = chip_balance + v_retained,
           total_settlements = COALESCE(total_settlements, 0) + v_payout_total,
           updated_at        = now()
     WHERE union_id = p_union_id
     RETURNING round(rake_wallet, 2), round(chip_balance, 2) INTO v_new_rw, v_new_cb;

    INSERT INTO union_wallet_transactions
      (union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes)
    SELECT p_union_id, club_id, payout, 'rakeback', 'rake_wallet', 'debit', v_new_rw,
           'Weekly rakeback to club at the per-game-type rate (period '
             || to_char(p_period_start, 'YYYY-MM-DD') || '..'
             || to_char(p_period_end, 'YYYY-MM-DD') || ')'
      FROM _uwrb
     WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0;

    IF v_retained > 0 THEN
      INSERT INTO union_wallet_transactions
        (union_id, amount, tx_type, wallet, direction, balance_after, notes)
      VALUES
        (p_union_id, v_retained, 'rake_hold', 'rake_wallet', 'debit', v_new_rw,
         'Union retained share + self-club rake, out of the rake treasury (period '
           || to_char(p_period_start, 'YYYY-MM-DD') || '..'
           || to_char(p_period_end, 'YYYY-MM-DD') || ')'),
        (p_union_id, v_retained, 'rake_hold', 'chip_balance', 'credit', v_new_cb,
         'Union retained share + self-club rake, into the general bank (period '
           || to_char(p_period_start, 'YYYY-MM-DD') || '..'
           || to_char(p_period_end, 'YYYY-MM-DD') || ')');

      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, to_type, to_entity_id,
         amount, category, union_id, description, idempotency_key, metadata)
      VALUES
        (v_actor, 'union_wallet', p_union_id, 'union_bank', p_union_id,
         v_retained, 'treasury_transfer', p_union_id,
         'Weekly union close ' || to_char(p_period_start, 'YYYY-MM-DD') || '..'
           || to_char(p_period_end, 'YYYY-MM-DD')
           || ': retained share ' || v_retained || ' of period rake ' || v_period_total
           || ' moves from the rake treasury to the general bank (clubs paid '
           || v_payout_total || ')',
         'union_close:' || v_sid::text || ':retained',
         jsonb_build_object('settlement_id', v_sid, 'period_start', p_period_start,
                            'period_end', p_period_end, 'period_rake', v_period_total,
                            'payout_total', v_payout_total, 'clubs_paid', v_clubs_paid)) RETURNING id INTO v_ledger_id;
      IF NOT EXISTS(SELECT 1 FROM public.settlement_invoices i WHERE i.source_ledger_id=v_ledger_id AND i.status='paid'
        AND i.net_amount=v_retained AND i.chips_transferred AND i.message_sent
        AND EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=i.id)) THEN
        RAISE EXCEPTION 'union_retained_invoice_receipt_missing' USING ERRCODE='23514';
      END IF;
    END IF;

    /* CONSERVATION, ASSERTED ON THE BALANCES THEMSELVES (not on the plan).
       What left the treasury must equal what the clubs and the bank received,
       to the cent, or none of it lands. */
    SELECT round(COALESCE(SUM(c.chip_treasury), 0), 2) INTO v_clubs_after
      FROM clubs c
     WHERE c.id IN (SELECT club_id FROM _uwrb
                     WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0);

    IF round((v_new_rw - v_rw_before) + (v_new_cb - v_cb_before) + (v_clubs_after - v_clubs_before), 2) <> 0
       OR round(v_new_rw - v_rw_before, 2) <> round(-v_period_total, 2)
       OR round(v_clubs_after - v_clubs_before, 2) <> round(v_payout_total, 2)
       OR round(v_new_cb - v_cb_before, 2) <> round(v_retained, 2) THEN
      RAISE EXCEPTION 'conservation violation in the weekly union close: treasury % -> %, bank % -> %, clubs % -> %, period % payout % retained %',
        v_rw_before, v_new_rw, v_cb_before, v_new_cb, v_clubs_before, v_clubs_after,
        v_period_total, v_payout_total, v_retained;
    END IF;

    UPDATE ca_settlements
       SET state = 'ledger_posted',
           totals = totals || jsonb_build_object('clubs_paid', v_clubs_paid,
                                                 'retained', v_retained,
                                                 'rw_debit', v_period_total,
                                                 'conservation', 'asserted')
     WHERE id = v_sid;

    INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
    VALUES (p_union_id, p_period_start, p_period_end, v_payout_total, now());

  EXCEPTION WHEN OTHERS THEN
    -- every money movement above just rolled back to the section start
    UPDATE ca_settlements
       SET state = 'failed', error_detail = left(SQLERRM, 2000)
     WHERE id = v_sid;
    PERFORM public.fn_ca_raise_drift_incident(
      'rakeback_close', 'incorrect_rakeback', 'critical',
      'rakeback-close-failed:' || p_union_id::text || ':' || to_char(p_period_start, 'YYYY-MM-DD'),
      0, NULL, NULL,
      'settlement', 'union', p_union_id, NULL, p_union_id,
      NULL, NULL, NULL, v_sid::text, NULL, NULL,
      left('weekly rakeback close aborted mid-flight and rolled back cleanly: ' || SQLERRM, 500),
      true,
      jsonb_build_object('sqlstate', SQLSTATE,
                         'period_start', p_period_start, 'period_end', p_period_end,
                         'clubs_paid_before_abort', v_clubs_paid));
    RETURN jsonb_build_object('success', false, 'error', 'close_failed', 'retryable', true,
      'detail', SQLERRM, 'settlement_id', v_sid);
  END;

  FOR context_key IN SELECT jsonb_object_keys(v_prior_context) LOOP
    PERFORM set_config(context_key,COALESCE(v_prior_context->>context_key,''),true);
  END LOOP;
  UPDATE ca_settlements SET state = 'post_commit_verified' WHERE id = v_sid;
  UPDATE ca_settlements SET state = 'final' WHERE id = v_sid;

  RETURN jsonb_build_object('success', true,
    'clubs_paid', v_clubs_paid,
    'period_rake', v_period_total,
    'total_rakeback', v_payout_total,
    'union_retained', v_retained,
    'retained_to_bank', v_retained,
    'rake_wallet_after', v_new_rw,
    'chip_balance_after', v_new_cb,
    'conservation', 'asserted',
    'settlement_id', v_sid);
END
$function$;
REVOKE ALL ON FUNCTION public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_union_club_rake_basis(uuid,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_club_rake_basis(uuid,timestamptz,timestamptz,boolean) TO service_role;
COMMENT ON FUNCTION public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz) IS 'Private Round 1, invoked by the single weekly coordinator; complete observed source contracts, exact bank-receipt conservation, original frozen final basis, full funding and rollback.';

-- Component 20260914142256_weekly_statements_follow_recorded_union_and_standalone_books.sql
-- One weekly statement and one existing delivery path for recorded union and
-- standalone books. Historical issued figures stay frozen. New figures require
-- the certified earning sources, exact private bank receipts and routed stages.
-- Depends on mixed source140015, certificate141013, R1 source14141800 and the
-- coordinator's canonical fn_accounting_week_clubs/settled-period creation.

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure))<>'fd8af5960df5b5da23b4e9a6497ae63b'
 OR md5(pg_get_functiondef('public.fn_issue_club_weekly_accounting(uuid,timestamptz,timestamptz)'::regprocedure))<>'3d37ae48c223ec49afc1ad468237e0b5'
 OR md5(pg_get_functiondef('public.fn_deliver_accounting_invoice(uuid)'::regprocedure))<>'8aeee5f47863f0496c9cdf86490eb084'
 OR md5(pg_get_functiondef('public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure))<>'ecda7ce1a97da6c9048ee8b0d6fbd6b5'
 THEN RAISE EXCEPTION 'weekly statement source changed before scope upgrade';END IF;
 IF (SELECT count(*) FROM public.ca_money_rpc_registry WHERE proname IN('fn_club_weekly_accounting_summary','fn_issue_club_weekly_accounting') AND status='approved')<>2
 THEN RAISE EXCEPTION 'weekly statement writer registration missing';END IF;
END $guard$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_issue_scope_weekly_accounting','approved','One private generic statement issuer for recorded union and standalone periods. Exact validated scope required. Uses existing immutable settlement invoice and its synchronous Messenger/notification delivery. No balance writes.');
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_week_quality(p_club_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE event record;scope_union uuid;actual_union uuid;related boolean;unknown_scope boolean;
 proof jsonb;active_ids uuid[];refunded_ids uuid[];checked int:=0;issue_count bigint;reason text;
BEGIN
 IF p_club_id IS NULL OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from>=p_to
 THEN RAISE EXCEPTION 'invalid_accounting_tournament_week' USING ERRCODE='22023';END IF;
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023';END IF;
 FOR event IN
  WITH candidates AS (
   SELECT tournament_id FROM public.accounting_tournament_fee_recognitions WHERE recognized_at>=p_from AND recognized_at<p_to
   UNION SELECT tournament_id FROM public.tournament_rake_settlements WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_terminal_settlements WHERE COALESCE(settled_at,completed_at)>=p_from AND COALESCE(settled_at,completed_at)<p_to
   UNION SELECT tournament_id FROM public.tournament_cancellation_receipts WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_satellite_settlements WHERE settled_at>=p_from AND settled_at<p_to
  )
  SELECT c.tournament_id,r.recognized_at,r.status,r.net_rake,r.union_id,r.bank_club_id,r.source_fingerprint,
   b.settled_at AS bank_at,b.amount AS bank_amount,b.union_id AS bank_union,b.club_id AS fee_bank_club
   FROM candidates c LEFT JOIN public.accounting_tournament_fee_recognitions r USING(tournament_id)
    LEFT JOIN public.tournament_rake_settlements b USING(tournament_id) ORDER BY c.tournament_id
 LOOP
  IF COALESCE(event.bank_at,event.recognized_at) IS NOT NULL
   AND NOT(COALESCE(event.bank_at,event.recognized_at)>=p_from AND COALESCE(event.bank_at,event.recognized_at)<p_to)
   AND (event.recognized_at IS NULL OR NOT(event.recognized_at>=p_from AND event.recognized_at<p_to)) THEN CONTINUE;END IF;
  actual_union:=COALESCE(event.union_id,event.bank_union,(SELECT min(s.union_id::text)::uuid
   FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
   HAVING count(DISTINCT COALESCE(s.union_id::text,'private'))=1));
  -- Current union membership only widens conflict detection. It never sets
  -- a payable source's historical coordinator or a player's payer.
  related:=COALESCE(actual_union=scope_union,false) OR COALESCE(event.bank_club_id=p_club_id,false)
   OR COALESCE(event.fee_bank_club=p_club_id,false)
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
      AND (s.club_id=p_club_id OR (scope_union IS NOT NULL AND s.coordinator_union_id=scope_union)))
   OR EXISTS(SELECT 1 FROM public.tournament_refund_entitlements e WHERE e.tournament_id=event.tournament_id AND e.refund_wallet_club_id=p_club_id);
  -- A private legacy event with unproved coordinator history cannot be silently
  -- assigned to today's standalone/union scope. The affected week stays open.
  unknown_scope:=actual_union IS NULL AND (event.status IS NULL OR event.status='banked_accrual_deferred')
   AND (COALESCE(event.net_rake,event.bank_amount,0)>0
    OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount<>0))
   AND (NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount>0)
    OR EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
     WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount>0
      AND (b.status IS DISTINCT FROM 'captured' OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
       OR r.rake_amount IS DISTINCT FROM(SELECT sum(s.rake_credit) FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id)))
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
     AND (NOT(s.contract ? 'coordinator_union_id') OR s.contract->'membership'->>'history_id' IS NULL
      OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text)));
  IF NOT related AND NOT unknown_scope THEN CONTINUE;END IF;
  checked:=checked+1;
  IF event.status IS NULL THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_terminal_recognition_missing','tournament_id',event.tournament_id,'unknown_scope',unknown_scope);
  END IF;
  IF event.status='banked_accrual_deferred' THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_deferred','tournament_id',event.tournament_id,'unknown_scope',unknown_scope);
  END IF;
  -- An eventual normal/satellite terminal receipt may follow a banked fee in
  -- another week. Only original fee-bank/recognition time chooses its liability.
  IF event.bank_at IS NOT NULL AND (event.bank_at IS DISTINCT FROM event.recognized_at
    OR event.bank_amount IS DISTINCT FROM event.net_rake OR event.bank_union IS DISTINCT FROM event.union_id) THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_bank_disagrees','tournament_id',event.tournament_id);
  END IF;
  BEGIN proof:=public.fn_accounting_tournament_fee_net_plan(event.tournament_id);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '55000' THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_net_source_evidence_invalid','detail',SQLERRM,'tournament_id',event.tournament_id);
  END;
  IF proof->>'status' IS DISTINCT FROM 'proven' OR proof->>'source_fingerprint' IS DISTINCT FROM event.source_fingerprint
    OR (proof->>'net_fee')::numeric IS DISTINCT FROM event.net_rake OR NULLIF(proof->>'union_id','')::uuid IS DISTINCT FROM event.union_id
    OR (event.status='recognized') IS DISTINCT FROM(event.net_rake>0)
    OR (event.status='cancelled') IS DISTINCT FROM(event.net_rake=0) THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_disagrees_with_sources','tournament_id',event.tournament_id);
  END IF;
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO active_ids FROM jsonb_array_elements_text(proof->'active_source_ids');
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO refunded_ids FROM jsonb_array_elements_text(proof->'refunded_source_ids');
  SELECT count(*) INTO issue_count FROM public.accounting_tournament_fee_sources s
   LEFT JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id
   WHERE s.tournament_id=event.tournament_id AND (rs.source_id IS NULL OR rs.tournament_id IS DISTINCT FROM s.tournament_id
    OR rs.recognized_at IS DISTINCT FROM event.recognized_at
    OR NOT(s.id=ANY(active_ids||refunded_ids))
    OR rs.disposition IS DISTINCT FROM CASE WHEN s.id=ANY(active_ids) THEN 'earned' ELSE 'refunded' END
    OR rs.rake_credit IS DISTINCT FROM CASE WHEN s.id=ANY(active_ids) THEN s.rake_credit ELSE 0 END
    OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text
    OR (s.contract->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit
    OR (s.contract->>'terms_at')::timestamptz IS DISTINCT FROM s.charged_at OR s.charged_at>event.recognized_at
    OR NULLIF(s.contract->>'union_id','')::uuid IS DISTINCT FROM s.union_id
    OR NULLIF(s.contract->>'coordinator_union_id','')::uuid IS DISTINCT FROM s.coordinator_union_id);
  IF issue_count>0 OR EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources rs
   LEFT JOIN public.accounting_tournament_fee_sources s ON s.id=rs.source_id
   WHERE rs.tournament_id=event.tournament_id AND (s.id IS NULL OR s.tournament_id IS DISTINCT FROM event.tournament_id))
   OR (SELECT COALESCE(sum(rake_credit),0) FROM public.accounting_tournament_recognized_sources WHERE tournament_id=event.tournament_id AND disposition='earned') IS DISTINCT FROM event.net_rake THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognized_source_receipts_incomplete','tournament_id',event.tournament_id);
  END IF;
 END LOOP;
 RETURN jsonb_build_object('status','ready','checked',checked);
END $function$;
CREATE OR REPLACE FUNCTION public.fn_club_weekly_accounting_summary(p_period_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
#variable_conflict use_variable
DECLARE period public.settlement_periods%ROWTYPE;close_row public.ca_settlements%ROWTYPE;frozen jsonb;
 scope_kind text;scope_id uuid;run_status text;union_basis numeric:=0;private_basis numeric:=0;private_banked numeric:=0;
 expected numeric:=0;received numeric:=0;outgoing numeric:=0;downstream numeric:=0;roles jsonb;down_roles jsonb;
 unknown_roles int;missing_periods int;receipt_issues int;source_issues int:=0;rows_count int;source_count int;stage_count int;
 ledger_ids jsonb;private_ledger_ids jsonb:='[]';source_fingerprint text;quality jsonb;bank record;bank_sources int;bank_sum numeric;bad_sources int;
 ready boolean;close_count int;
BEGIN
 SELECT * INTO period FROM public.settlement_periods WHERE id=p_period_id;
 IF NOT FOUND OR period.club_id IS NULL THEN RAISE EXCEPTION 'club_accounting_period_missing' USING ERRCODE='22023';END IF;
 IF NOT public.fn_caller_is_engine() AND NOT EXISTS(SELECT 1 FROM public.fn_accounting_party_users('club',period.club_id)u WHERE u.user_id=auth.uid())
  AND (period.union_id IS NULL OR auth.uid() IS NULL OR NOT public.fn_is_union_overseer(period.union_id,auth.uid()))
 THEN RAISE EXCEPTION 'club_accounting_not_authorised' USING ERRCODE='42501';END IF;
 -- Issued statements are historical documents. Never replace their original
 -- accounting basis with later membership, receipts, or agreement changes.
 SELECT i.breakdown INTO frozen FROM public.settlement_invoices i WHERE i.club_id=period.club_id AND i.period_id=period.id
  AND i.invoice_type='club_weekly_accounting' AND i.message_sent;
 IF FOUND THEN RETURN frozen;END IF;
 scope_kind:=CASE WHEN period.union_id IS NULL THEN 'club' ELSE 'union' END;scope_id:=COALESCE(period.union_id,period.club_id);
 SELECT r.status INTO run_status FROM public.union_accounting_runs r WHERE r.period_start=period.start_at AND r.period_end=period.end_at
  AND (r.union_id=period.union_id OR (period.union_id IS NULL AND r.union_id IS NULL AND to_jsonb(r)->>'standalone_club_id'=period.club_id::text));
 IF period.union_id IS NOT NULL THEN
  SELECT count(*) INTO close_count FROM public.ca_settlements s WHERE s.union_id=period.union_id AND s.settlement_type='union_rakeback_close'
   AND s.state='final' AND s.external_ref=period.union_id::text||':'||to_char(period.start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ||'..'||to_char(period.end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
  IF close_count=1 THEN
   SELECT * INTO close_row FROM public.ca_settlements s WHERE s.union_id=period.union_id AND s.settlement_type='union_rakeback_close'
    AND s.state='final' AND s.external_ref=period.union_id::text||':'||to_char(period.start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
     ||'..'||to_char(period.end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
   expected:=COALESCE((close_row.totals->'payout_by_club'->>period.club_id::text)::numeric,0);
  END IF;
  IF close_count<>1 OR close_row.totals->>'accounting_version' IS DISTINCT FROM '3' THEN source_issues:=source_issues+1;END IF;
 END IF;
 SELECT COALESCE(sum(s.rake_credit) FILTER(WHERE s.union_id IS NOT NULL),0),COALESCE(sum(s.rake_credit) FILTER(WHERE s.union_id IS NULL),0),count(*),
  md5(COALESCE(string_agg(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.earned_at,s.rake_credit,s.contract)::text,'' ORDER BY s.source_type,s.source_id),'')),
  count(*) FILTER(WHERE s.rake_credit IS NULL OR s.rake_credit<0 OR s.rake_credit<>round(s.rake_credit,2) OR s.rake_credit::text IN('NaN','Infinity','-Infinity')
   OR (s.union_id IS NOT NULL AND s.union_id IS DISTINCT FROM period.union_id))
 INTO union_basis,private_basis,source_count,source_fingerprint,bad_sources
 FROM public.accounting_payable_earning_sources s WHERE s.club_id=period.club_id AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id
  AND s.earned_at>=period.start_at AND s.earned_at<period.end_at;
 source_issues:=source_issues+bad_sources;
 IF NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=period.start_at) THEN source_issues:=source_issues+1;END IF;
 IF period.union_id IS NOT NULL AND union_basis IS DISTINCT FROM COALESCE((close_row.totals->'basis_by_club'->>period.club_id::text)::numeric,0)
 THEN source_issues:=source_issues+1;END IF;
 quality:=public.fn_accounting_tournament_week_quality(period.club_id,period.start_at,period.end_at);
 IF quality->>'status' IS DISTINCT FROM 'ready' THEN source_issues:=source_issues+1;END IF;
 -- Private earnings count as funding only when the exact source group matches
 -- a real deposit into this club. A different club's treasury is not funding.
 FOR bank IN
  SELECT 'cash_rake_accrual'::text AS source_type,b.rake_record_id AS source_group,b.club_ledger_id AS ledger_id,b.amount,b.banked_at,
   b.club_id,b.union_id,b.union_transaction_id,NULL::uuid AS tournament_id
  FROM public.accounting_cash_bank_receipts b WHERE b.union_id IS NULL AND
   ((b.club_id=period.club_id AND b.banked_at>=period.start_at AND b.banked_at<period.end_at) OR EXISTS(
    SELECT 1 FROM public.accounting_payable_earning_sources s WHERE s.source_type='cash_rake_accrual' AND s.rake_record_id=b.rake_record_id
     AND s.club_id=period.club_id AND s.union_id IS NULL AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id
     AND s.earned_at>=period.start_at AND s.earned_at<period.end_at))
  UNION ALL
  SELECT 'tournament_fee_accrual',f.tournament_id,f.bank_journal_id,f.net_rake,f.recognized_at,f.bank_club_id,f.union_id,f.union_wallet_transaction_id,f.tournament_id
  FROM public.accounting_tournament_fee_recognitions f WHERE f.union_id IS NULL AND f.net_rake>0 AND
   ((f.bank_club_id=period.club_id AND f.recognized_at>=period.start_at AND f.recognized_at<period.end_at) OR EXISTS(
    SELECT 1 FROM public.accounting_payable_earning_sources s WHERE s.source_type='tournament_fee_accrual' AND s.tournament_id=f.tournament_id
     AND s.club_id=period.club_id AND s.union_id IS NULL AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id
     AND s.earned_at>=period.start_at AND s.earned_at<period.end_at))
 LOOP
  SELECT count(*),COALESCE(sum(s.rake_credit),0),count(*) FILTER(WHERE s.club_id IS DISTINCT FROM period.club_id OR s.union_id IS NOT NULL
   OR s.coordinator_union_id IS DISTINCT FROM period.union_id OR s.earned_at IS DISTINCT FROM bank.banked_at)
  INTO bank_sources,bank_sum,bad_sources FROM public.accounting_payable_earning_sources s WHERE s.source_type=bank.source_type
   AND CASE WHEN bank.source_type='cash_rake_accrual' THEN s.rake_record_id=bank.source_group ELSE s.tournament_id=bank.source_group END;
  -- An entirely certified deposit belonging to another recorded week scope is
  -- excluded; missing evidence cannot establish such an exclusion.
  IF bank_sources>0 AND NOT EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources s WHERE s.source_type=bank.source_type
   AND CASE WHEN bank.source_type='cash_rake_accrual' THEN s.rake_record_id=bank.source_group ELSE s.tournament_id=bank.source_group END
   AND s.club_id=period.club_id AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id) THEN CONTINUE;END IF;
  IF bank_sources=0 OR bad_sources>0 OR bank_sum IS DISTINCT FROM bank.amount OR bank.club_id IS DISTINCT FROM period.club_id
   OR bank.union_transaction_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=bank.ledger_id AND l.status='posted'
    AND l.to_type='club_treasury' AND l.to_entity_id=period.club_id AND l.club_id=period.club_id AND l.category='rake'
    AND l.amount=bank.amount AND l.created_at=bank.banked_at AND bank.banked_at>=period.start_at AND bank.banked_at<period.end_at
    AND ((bank.source_type='cash_rake_accrual' AND l.from_type='table_stack')
     OR (bank.source_type='tournament_fee_accrual' AND l.from_type='prize_liability' AND l.from_entity_id=bank.tournament_id)))
  THEN source_issues:=source_issues+1;ELSE private_banked:=private_banked+bank.amount;private_ledger_ids:=private_ledger_ids||jsonb_build_array(bank.ledger_id);END IF;
 END LOOP;
 IF private_banked IS DISTINCT FROM private_basis THEN source_issues:=source_issues+1;END IF;
 WITH transfers AS (
  SELECT l.*,i.to_entity_type,i.breakdown->>'payee_role_at_transfer' AS payee_role,
   (i.id IS NULL OR i.net_amount IS DISTINCT FROM l.amount OR i.status IS DISTINCT FROM 'paid' OR i.chips_transferred IS DISTINCT FROM true
    OR i.message_sent IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d
     JOIN public.social_messages m ON m.id=d.message_id JOIN public.notifications n ON n.id=d.notification_id
     WHERE d.invoice_id=i.id AND m.media_metadata->>'invoice_id'=i.id::text AND n.user_id=d.recipient_id)) AS receipt_bad
  FROM public.chip_ledger l LEFT JOIN public.settlement_invoices i ON i.source_ledger_id=l.id
  WHERE l.club_id=period.club_id AND l.union_id IS NOT DISTINCT FROM period.union_id AND l.status='posted' AND l.category IN('rakeback','commission')
   AND (l.settlement_id=close_row.id::text OR
    (CASE WHEN pg_input_is_valid(l.metadata->>'period_start','timestamptz') THEN (l.metadata->>'period_start')::timestamptz END=period.start_at
     AND CASE WHEN pg_input_is_valid(l.metadata->>'period_end','timestamptz') THEN (l.metadata->>'period_end')::timestamptz END=period.end_at))
 ), typed AS (
  SELECT *,CASE WHEN to_entity_type='player' THEN 'player' WHEN payee_role IN('super_agent','agent','sub_agent') THEN payee_role ELSE 'unclassified' END AS tier
  FROM transfers
 ), club_out AS (SELECT * FROM typed WHERE from_type='club_treasury' AND from_entity_id=period.club_id AND to_type IN('player_wallet','agent_wallet')),
 down_out AS (SELECT * FROM typed WHERE from_type IN('player_wallet','agent_wallet') AND to_type IN('player_wallet','agent_wallet'))
 SELECT (SELECT COALESCE(sum(amount),0) FROM typed WHERE from_type IN('union_wallet','union_bank') AND from_entity_id=period.union_id AND to_type='club_treasury' AND to_entity_id=period.club_id),
  (SELECT COALESCE(sum(amount),0) FROM club_out),(SELECT COALESCE(sum(amount),0) FROM down_out),
  (SELECT COALESCE(jsonb_object_agg(tier,paid),'{}') FROM (SELECT tier,sum(amount)paid FROM club_out GROUP BY tier)x),
  (SELECT COALESCE(jsonb_object_agg(tier,paid),'{}') FROM (SELECT tier,sum(amount)paid FROM down_out GROUP BY tier)x),
  (SELECT count(*) FROM typed WHERE to_type IN('player_wallet','agent_wallet') AND tier='unclassified'),
  (SELECT count(*) FROM typed WHERE receipt_bad OR amount IS NULL OR amount<=0 OR amount<>round(amount,2) OR amount::text IN('NaN','Infinity','-Infinity')
   OR (from_type IN('club_treasury','player_wallet','agent_wallet') AND
    (metadata->>'routing_version' IS DISTINCT FROM '3' OR metadata->>'accounting_scope_kind' IS DISTINCT FROM scope_kind OR metadata->>'accounting_scope_id' IS DISTINCT FROM scope_id::text))),
  (SELECT count(*) FROM typed),(SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]') FROM typed)
 INTO received,outgoing,downstream,roles,down_roles,unknown_roles,receipt_issues,rows_count,ledger_ids;
 SELECT count(*) INTO missing_periods FROM public.chip_ledger l WHERE l.club_id=period.club_id AND l.status='posted' AND l.category IN('rakeback','commission')
  AND l.from_type IN('club_treasury','player_wallet','agent_wallet') AND l.to_type IN('player_wallet','agent_wallet')
  AND l.created_at>=period.start_at AND l.created_at<period.end_at+interval '1 day'
  AND (l.metadata->>'period_start' IS NULL OR l.metadata->>'period_end' IS NULL
   OR NOT pg_input_is_valid(l.metadata->>'period_start','timestamptz') OR NOT pg_input_is_valid(l.metadata->>'period_end','timestamptz'))
  AND (close_row.id IS NULL OR l.settlement_id IS DISTINCT FROM close_row.id::text);
 SELECT count(*) INTO stage_count FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind=scope_kind AND r.scope_id=scope_id
  AND r.period_start=period.start_at AND r.period_end=period.end_at AND r.round_no IN(2,3)
  AND r.result->>'success'='true' AND r.result->>'routing_version'='3' AND r.result->>'source_contract_version'='3'
  AND r.result->>'scope_kind'=scope_kind AND r.result->>'scope_id'=scope_id::text AND (r.result->>'shortfalls')::numeric=0;
 ready:=source_issues=0 AND receipt_issues=0 AND unknown_roles=0 AND missing_periods=0 AND stage_count=2 AND expected=received
  AND period.status IN('settled','closed');
 RETURN jsonb_build_object('accounting_version',3,'scope_kind',scope_kind,'scope_id',scope_id,'period_id',period.id,'club_id',period.club_id,'union_id',period.union_id,
  'period_start',period.start_at,'period_end',period.end_at,'currency','CHIPS','rake_earned',union_basis+private_basis,
  'union_rake_earned',union_basis,'private_rake_earned',private_basis,'private_rake_banked',private_banked,'rake_received',received,'expected_union_receipt',expected,
  'total_rake_funding',received+private_banked,'paid_super_agents',COALESCE((roles->>'super_agent')::numeric,0),'paid_agents',COALESCE((roles->>'agent')::numeric,0),
  'paid_sub_agents',COALESCE((roles->>'sub_agent')::numeric,0),'paid_players',COALESCE((roles->>'player')::numeric,0),'paid_unclassified',COALESCE((roles->>'unclassified')::numeric,0),
  'total_paid_by_club',outgoing,'retained_by_club',received+private_banked-outgoing,'downstream_redistributed',downstream,
  'downstream_paid_super_agents',COALESCE((down_roles->>'super_agent')::numeric,0),'downstream_paid_agents',COALESCE((down_roles->>'agent')::numeric,0),
  'downstream_paid_sub_agents',COALESCE((down_roles->>'sub_agent')::numeric,0),'downstream_paid_players',COALESCE((down_roles->>'player')::numeric,0),
  'transfer_count',rows_count,'source_ledger_ids',ledger_ids,'private_bank_ledger_ids',private_ledger_ids,'source_count',source_count,'source_fingerprint',source_fingerprint,
  'unclassified_role_count',unknown_roles,'missing_period_count',missing_periods,'receipt_issue_count',receipt_issues,'source_issue_count',source_issues,'certified_stage_count',stage_count,
  'tournament_quality',quality,'ready_to_issue',ready,'status',CASE WHEN run_status='complete' AND ready THEN 'complete' ELSE 'needs_reconciliation' END,'run_status',run_status,
  'basis_source','Recorded Earning Sources And Posted Bank Receipts',
  'note','Direct Club Payments Count Once. Downstream Transfers Are Separate. Retained Rake Is This Week''s Funding Less Direct Payments, Not The Treasury Balance Or An Additional Bill.');
END $function$;

CREATE FUNCTION public.fn_issue_scope_weekly_accounting(p_scope_kind text,p_scope_id uuid,p_from timestamptz,p_to timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
#variable_conflict use_variable
DECLARE scope record;club uuid;period public.settlement_periods%ROWTYPE;report jsonb;invoice uuid;issued int:=0;period_count int;clubs uuid[];delivery jsonb;expected_users int;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to)
  OR p_from IS DISTINCT FROM public.fn_union_week_start(p_from) OR p_to IS DISTINCT FROM public.fn_union_week_start(p_from+interval '8 days') OR p_to>now()
 THEN RAISE EXCEPTION 'weekly_statement_requires_closed_week' USING ERRCODE='22023';END IF;
 IF current_setting('app.accounting_validated_scope',true) IS DISTINCT FROM p_scope_kind||':'||p_scope_id::text||':'||p_from::text||':'||p_to::text
 THEN RAISE EXCEPTION 'weekly_statement_requires_validated_scope' USING ERRCODE='23514';END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_from,p_to);
 SELECT COALESCE(array_agg(x.club_id ORDER BY x.club_id),ARRAY[]::uuid[]) INTO clubs FROM (
  SELECT c.club_id FROM public.fn_accounting_week_clubs(scope.union_id,scope.standalone_club_id,p_from,p_to)c
  UNION SELECT s.club_id FROM public.accounting_payable_earning_sources s WHERE s.earned_at>=p_from AND s.earned_at<p_to
   AND (s.coordinator_union_id=scope.union_id OR (scope.standalone_club_id=s.club_id AND s.coordinator_union_id IS NULL))
  UNION SELECT sp.club_id FROM public.settlement_periods sp WHERE sp.start_at=p_from AND sp.end_at=p_to AND sp.club_id IS NOT NULL
   AND (sp.union_id=scope.union_id OR (sp.club_id=scope.standalone_club_id AND sp.union_id IS NULL))
 )x WHERE x.club_id IS DISTINCT FROM scope.union_id;
 FOREACH club IN ARRAY clubs LOOP
  SELECT count(*) INTO period_count FROM public.settlement_periods sp WHERE sp.club_id=club AND sp.union_id IS NOT DISTINCT FROM scope.union_id AND sp.start_at=p_from AND sp.end_at=p_to;
  IF period_count<>1 THEN RAISE EXCEPTION 'weekly_statement_period_missing_or_duplicated' USING ERRCODE='23514',DETAIL=jsonb_build_object('club_id',club,'period_count',period_count)::text;END IF;
  SELECT * INTO period FROM public.settlement_periods sp WHERE sp.club_id=club AND sp.union_id IS NOT DISTINCT FROM scope.union_id AND sp.start_at=p_from AND sp.end_at=p_to FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('club_weekly_invoice:'||period.id::text,0));
  SELECT i.id INTO invoice FROM public.settlement_invoices i WHERE i.period_id=period.id AND i.club_id=club AND i.invoice_type='club_weekly_accounting';
  IF invoice IS NULL THEN
   report:=public.fn_club_weekly_accounting_summary(period.id);
   IF report->>'ready_to_issue' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'club_weekly_statement_requires_reconciliation' USING ERRCODE='23514',DETAIL=report::text;END IF;
   report:=report||jsonb_build_object('status','complete');
   INSERT INTO public.settlement_invoices(club_id,period_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,gross_amount,net_amount,deductions,breakdown,status,notes)
   VALUES(club,period.id,'club_weekly_accounting','club',club::text,'club',club::text,(report->>'total_rake_funding')::numeric,(report->>'retained_by_club')::numeric,
    (report->>'total_paid_by_club')::numeric,report,'generated','Consolidated Weekly Club Accounting. The Net Movement Is Not An Additional Bill Or Transfer.') RETURNING id INTO invoice;
   issued:=issued+1;
  END IF;
  delivery:=public.fn_deliver_accounting_invoice(invoice);
  SELECT count(*) INTO expected_users FROM public.fn_accounting_party_users('club',club);
  IF delivery->>'success' IS DISTINCT FROM 'true' OR expected_users=0 OR EXISTS(
   SELECT 1 FROM public.fn_accounting_party_users('club',club)u WHERE NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d
    JOIN public.social_messages m ON m.id=d.message_id JOIN public.notifications n ON n.id=d.notification_id
    WHERE d.invoice_id=invoice AND d.recipient_id=u.user_id AND m.media_metadata->>'invoice_id'=invoice::text AND n.user_id=u.user_id
     AND m.message_type='invoice' AND n.metadata->>'invoice_id'=invoice::text))
  THEN RAISE EXCEPTION 'club_weekly_statement_delivery_incomplete' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN jsonb_build_object('success',true,'scope_kind',p_scope_kind,'scope_id',p_scope_id,'period_start',p_from,'period_end',p_to,'clubs',cardinality(clubs),'issued',issued);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_issue_club_weekly_accounting(p_union_id uuid,p_from timestamptz,p_to timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
#variable_conflict use_variable
DECLARE previous_scope text;result jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 previous_scope:=current_setting('app.accounting_validated_scope',true);
 IF previous_scope IS DISTINCT FROM 'union:'||p_union_id::text||':'||p_from::text||':'||p_to::text THEN
  IF current_setting('app.union_accounting_validated_period',true) IS DISTINCT FROM p_union_id::text||':'||p_from::text||':'||p_to::text
  THEN RAISE EXCEPTION 'weekly_statement_requires_validated_cascade' USING ERRCODE='23514';END IF;
  PERFORM set_config('app.accounting_validated_scope','union:'||p_union_id::text||':'||p_from::text||':'||p_to::text,true);
 END IF;
 result:=public.fn_issue_scope_weekly_accounting('union',p_union_id,p_from,p_to);
 PERFORM set_config('app.accounting_validated_scope',COALESCE(previous_scope,''),true);
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_deliver_accounting_invoice(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_variable
DECLARE inv public.settlement_invoices%ROWTYPE; sender uuid; issuer_name text; recipient_name text;
 issuer_kind text; issuer_id uuid; recipient_id uuid; scope_id uuid; page_id uuid; users uuid[]; issuer_users uuid[]; recipient_users uuid[];
 person uuid; conv uuid; msg uuid; note uuid; body text; meta jsonb; count_sent int:=0; n int; line record;
BEGIN
 SELECT * INTO inv FROM public.settlement_invoices WHERE id=p_invoice_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_invoice_missing' USING ERRCODE='23514'; END IF;
 IF inv.net_amount IS NULL OR inv.net_amount::text IN('NaN','Infinity','-Infinity') OR inv.net_amount<>round(inv.net_amount,2)
 THEN RAISE EXCEPTION 'invalid_invoice_amount' USING ERRCODE='23514'; END IF;
 issuer_kind:=inv.from_entity_type; issuer_id:=inv.from_entity_id::uuid; recipient_id:=inv.to_entity_id::uuid;
 scope_id:=COALESCE(inv.club_id,issuer_id);
 SELECT array_agg(user_id ORDER BY user_id) INTO issuer_users FROM public.fn_accounting_party_users(inv.from_entity_type,issuer_id);
 SELECT array_agg(user_id ORDER BY user_id) INTO recipient_users FROM public.fn_accounting_party_users(inv.to_entity_type,recipient_id);
 IF COALESCE(cardinality(issuer_users),0)=0 OR COALESCE(cardinality(recipient_users),0)=0
 THEN RAISE EXCEPTION 'accounting_invoice_recipient_missing' USING ERRCODE='23514'; END IF;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO users FROM unnest(issuer_users||recipient_users) x;
 -- Club senders receive one weekly summary; individual payees still get their receipt immediately.
 IF inv.from_entity_type='club' AND inv.to_entity_type IN('agent','player')
    AND inv.source_ledger_id IS NOT NULL AND inv.breakdown->>'category' IN('rakeback','commission') THEN
   users:=recipient_users;
 END IF;
 IF inv.invoice_type IN('union_weekly_squareup','union_weekly_credit_note') THEN
   issuer_kind:='union';issuer_id:=(inv.breakdown->>'union_id')::uuid;
 END IF;
 sender:=CASE WHEN issuer_kind='club' THEN (SELECT owner_id FROM public.clubs WHERE id=issuer_id)
              WHEN issuer_kind='union' THEN (SELECT owner_id FROM public.unions WHERE id=issuer_id)
              ELSE issuer_id END;
 IF sender IS NULL OR NOT sender=ANY(issuer_users||recipient_users) THEN RAISE EXCEPTION 'accounting_invoice_sender_missing' USING ERRCODE='23514'; END IF;
 issuer_name:=CASE WHEN issuer_kind='club' THEN (SELECT name FROM public.clubs WHERE id=issuer_id)
                   WHEN issuer_kind='union' THEN (SELECT name FROM public.unions WHERE id=issuer_id)
                   ELSE (SELECT username FROM public.profiles WHERE id=issuer_id) END;
 recipient_name:=CASE WHEN inv.to_entity_type='club' THEN (SELECT name FROM public.clubs WHERE id=recipient_id)
                      WHEN inv.to_entity_type='union' THEN (SELECT name FROM public.unions WHERE id=recipient_id)
                      ELSE (SELECT username FROM public.profiles WHERE id=recipient_id) END;
 IF inv.invoice_number IS NULL THEN
   UPDATE public.settlement_invoices SET invoice_number=public.fn_accounting_next_invoice_number() WHERE id=inv.id RETURNING invoice_number INTO inv.invoice_number;
 END IF;
 IF inv.invoice_type IN('union_weekly_squareup','union_weekly_credit_note') THEN recipient_name:=(SELECT name FROM public.clubs WHERE id=inv.club_id); END IF;
 body:=CASE WHEN inv.invoice_type='club_weekly_accounting' THEN 'Weekly Club Statement ' ELSE 'Invoice ' END||inv.invoice_number||E'\nIssued By: '||COALESCE(issuer_name,inv.from_entity_type)||E'\nFor: '||COALESCE(recipient_name,inv.to_entity_type)
  ||E'\nDirection: '||initcap(inv.from_entity_type)||' To '||initcap(inv.to_entity_type)
  ||E'\nAmount: '||to_char(abs(inv.net_amount),'FM999,999,999,999,990.00')||' Chips'
  ||E'\nStatus: '||initcap(inv.status)
  ||CASE WHEN inv.chips_transferred THEN E'\nTransfer Recorded: '||COALESCE(inv.transferred_at,inv.created_at)::text ELSE '' END
  ||CASE WHEN inv.due_at IS NOT NULL THEN E'\nDue: '||to_char(inv.due_at AT TIME ZONE 'America/Chicago','YYYY-MM-DD HH24:MI')||' Chicago Time' ELSE '' END
  ||CASE WHEN inv.breakdown ? 'period_start' THEN E'\nPeriod: '||(inv.breakdown->>'period_start')||' To '||COALESCE(inv.breakdown->>'period_end','') ELSE '' END
  ||CASE WHEN inv.notes IS NOT NULL THEN E'\n'||inv.notes ELSE '' END;
 FOR line IN SELECT key,value FROM jsonb_each_text(COALESCE(inv.breakdown,'{}'))
   WHERE key IN('rake_generated','rakeback_due','union_fee_kept','players_won','settled_in_chips','eco_amount','presettled','rake_earned','union_rake_earned','private_rake_earned','private_rake_banked','total_rake_funding','rake_received','paid_super_agents','paid_agents','paid_sub_agents','paid_players','total_paid_by_club','retained_by_club','downstream_redistributed','downstream_paid_super_agents','downstream_paid_agents','downstream_paid_sub_agents','downstream_paid_players') ORDER BY key
 LOOP
   IF line.value IS NOT NULL THEN body:=body||E'\n'||initcap(replace(line.key,'_',' '))||': '||to_char(line.value::numeric,'FM999,999,999,999,990.00'); END IF;
 END LOOP;
 meta:=jsonb_build_object('kind','accounting_invoice' ,'invoice_id',inv.id,'invoice_number',inv.invoice_number,
   'club_id',inv.club_id,'source_ledger_id',inv.source_ledger_id,'source_credit_invoice_id',inv.source_credit_invoice_id,
   'source_credit_payment_id',inv.source_credit_payment_id,'amount',inv.net_amount,'currency','CHIPS','conversationId',NULL,'status',inv.status,
   'invoice_type',inv.invoice_type,'from_entity_type',inv.from_entity_type,'from_entity_id',inv.from_entity_id,
   'to_entity_type',inv.to_entity_type,'to_entity_id',inv.to_entity_id,'lines',inv.breakdown-'source_ledger_ids');
 SELECT id INTO page_id FROM public.social_pages WHERE linked_entity_id=scope_id::text AND linked_entity_type='club' ORDER BY id LIMIT 1;
 FOREACH person IN ARRAY users LOOP
   IF EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=inv.id AND d.recipient_id=person) THEN CONTINUE; END IF;
   -- One private accounting conversation per issuer, sender, scope and recipient.
   PERFORM pg_advisory_xact_lock(hashtextextended('accounting_conversation:'||scope_id::text||':'||issuer_id::text||':'||sender::text||':'||person::text,0));
   SELECT conversation_id INTO conv FROM public.accounting_conversations c
    WHERE c.scope_id=scope_id AND c.issuer_type=issuer_kind AND c.issuer_id=issuer_id AND c.sender_id=sender AND c.recipient_id=person;
   IF conv IS NULL THEN
     INSERT INTO public.social_conversations(is_group,group_name,context_entity_id,context_entity_type)
      VALUES(true,COALESCE(issuer_name,'Account')||' Accounting',page_id,CASE WHEN page_id IS NULL THEN NULL ELSE 'club' END) RETURNING id INTO conv;
     INSERT INTO public.social_conversation_participants(conversation_id,user_id,context_entity_id,context_entity_type)
      SELECT conv,x,page_id,CASE WHEN page_id IS NULL THEN NULL ELSE 'club' END FROM (SELECT DISTINCT unnest(ARRAY[sender,person]) AS x) members;
     INSERT INTO public.accounting_conversations(scope_id,issuer_type,issuer_id,sender_id,recipient_id,conversation_id)
      VALUES(scope_id,issuer_kind,issuer_id,sender,person,conv);
   END IF;
   -- Refuse a conversation whose audience changed instead of leaking invoices.
   IF EXISTS(SELECT 1 FROM public.social_conversation_participants WHERE conversation_id=conv AND user_id<>ALL(ARRAY[sender,person]))
      OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants WHERE conversation_id=conv AND user_id=person)
      OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants WHERE conversation_id=conv AND user_id=sender)
   THEN RAISE EXCEPTION 'accounting_conversation_audience_changed' USING ERRCODE='23514'; END IF;
   INSERT INTO public.social_messages(conversation_id,sender_id,content,message_type,media_metadata)
    VALUES(conv,sender,body,'invoice',meta) RETURNING id INTO msg;
   UPDATE public.social_conversations SET last_message_at=now(),last_message_preview=left(body,100),updated_at=now() WHERE id=conv;
   meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);
   INSERT INTO public.notifications(user_id,type,title,message,data,read,action_url,metadata)
    VALUES(person,'accounting_invoice',CASE WHEN inv.invoice_type='club_weekly_accounting' THEN 'Weekly Club Statement ' ELSE 'Invoice ' END||inv.invoice_number,
     CASE WHEN inv.chips_transferred AND inv.breakdown->>'category'='rakeback' THEN 'Rakeback Transfer Recorded: ' WHEN inv.chips_transferred AND inv.breakdown->>'category'='commission' THEN 'Commission Transfer Recorded: ' WHEN inv.chips_transferred THEN 'Transfer Recorded: ' ELSE 'Invoice Issued: ' END||to_char(abs(inv.net_amount),'FM999,999,999,999,990.00')||' Chips',
     meta,false,'/hub/messenger?conversation='||conv::text,meta) RETURNING id INTO note;
   INSERT INTO public.accounting_invoice_deliveries(invoice_id,recipient_id,message_id,notification_id) VALUES(inv.id,person,msg,note);
   count_sent:=count_sent+1;
 END LOOP;
 SELECT count(*) INTO n FROM public.accounting_invoice_deliveries WHERE invoice_id=inv.id;
 UPDATE public.settlement_invoices SET message_sent=true,message_sent_at=COALESCE(message_sent_at,now()) WHERE id=inv.id;
 RETURN jsonb_build_object('success',true,'invoice_id',inv.id,'delivered',n,'new_deliveries',count_sent);
END $function$
;

REVOKE ALL ON FUNCTION public.fn_issue_scope_weekly_accounting(text,uuid,timestamptz,timestamptz),public.fn_issue_club_weekly_accounting(uuid,timestamptz,timestamptz),public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_club_weekly_accounting_summary(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_weekly_accounting_summary(uuid) TO authenticated,service_role;

-- Component 20260914142600_unions_and_standalone_clubs_share_one_weekly_run_journal.sql
-- One scheduler and one durable run table serve union and standalone books.
-- Standalone payouts use the same certified preparation and routed stages;
-- no legacy per-club payout batches or time-only completion markers remain.

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_process_weekly_accounting(uuid)'::regprocedure))<>'8e476a438eaeb9658d6907df9b7af289'
 OR md5(pg_get_functiondef('public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure))<>'696bf335fa7f9a3739b3c23793a38255'
 OR md5(pg_get_functiondef('public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure))<>'533711f43e862b8cd521895ab3209662'
 OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.union_accounting_runs'::regclass AND attname='standalone_club_id' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'weekly coordinator scope preimage changed';END IF;
 IF EXISTS(SELECT 1 FROM public.settlement_periods WHERE union_id IS NULL AND club_id IS NOT NULL GROUP BY club_id,start_at,end_at HAVING count(*)>1)
 THEN RAISE EXCEPTION 'standalone accounting periods require duplicate reconciliation';END IF;
END $guard$;
ALTER TABLE public.union_accounting_runs DROP CONSTRAINT union_accounting_runs_pkey;
ALTER TABLE public.union_accounting_runs ALTER COLUMN union_id DROP NOT NULL;
ALTER TABLE public.union_accounting_runs ADD COLUMN standalone_club_id uuid REFERENCES public.clubs(id),
 ADD COLUMN scope_kind text GENERATED ALWAYS AS(CASE WHEN union_id IS NOT NULL THEN 'union' ELSE 'club' END) STORED,
 ADD COLUMN scope_id uuid GENERATED ALWAYS AS(COALESCE(union_id,standalone_club_id)) STORED,
 ADD CONSTRAINT accounting_run_has_one_scope CHECK((union_id IS NULL)<>(standalone_club_id IS NULL)),
 ADD PRIMARY KEY(scope_kind,scope_id,period_start,period_end),
 ADD UNIQUE(union_id,period_start,period_end);
CREATE UNIQUE INDEX settlement_periods_standalone_week ON public.settlement_periods(club_id,start_at,end_at) WHERE union_id IS NULL AND club_id IS NOT NULL;
DROP POLICY union_accounting_runs_scoped_read ON public.union_accounting_runs;
CREATE POLICY union_accounting_runs_scoped_read ON public.union_accounting_runs FOR SELECT TO authenticated USING(
 (union_id IS NOT NULL AND public.ca_can_oversee_union(union_id)) OR
 (standalone_club_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.fn_accounting_party_users('club',standalone_club_id)p WHERE p.user_id=auth.uid())));
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.union_accounting_runs FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.union_accounting_runs TO authenticated,service_role;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_mark_scope_accounting_settled','approved','Private period object writer shared by union and standalone books; exact scope/week, serialized, unique periods, no wallet changes. The single coordinator issues documents before commit.'),
 ('fn_process_weekly_accounting_scope','approved','The single private weekly coordinator implementation for exact union or standalone scope; preserved scheduler wrapper delegates here. Full source, route, funding, and document witnesses required.');
CREATE OR REPLACE FUNCTION public.fn_accounting_week_clubs(p_union_id uuid,p_club_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(club_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_to<=p_from
 THEN RAISE EXCEPTION 'invalid_accounting_scope' USING ERRCODE='22023'; END IF;
 IF p_club_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.is_union IS NOT TRUE) THEN
   RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT p_club_id;
 ELSE
  RETURN QUERY WITH initial AS (
   SELECT DISTINCT ON(h.entity_key) h.after_terms FROM public.accounting_agreement_history h
    WHERE h.entity_type='union_clubs' AND h.observed_at<=p_from ORDER BY h.entity_key,h.observed_at DESC,h.id DESC
  ), members_during_week AS (
   SELECT after_terms FROM initial UNION ALL SELECT h.after_terms FROM public.accounting_agreement_history h
    WHERE h.entity_type='union_clubs' AND h.observed_at>p_from AND h.observed_at<p_to
  ) SELECT x.id FROM (
   SELECT (m.after_terms->>'club_id')::uuid AS id FROM members_during_week m WHERE m.after_terms->>'union_id'=p_union_id::text
   UNION SELECT s.club_id FROM public.accounting_payable_earning_sources s
    WHERE s.coordinator_union_id=p_union_id AND s.earned_at>=p_from AND s.earned_at<p_to
   UNION SELECT c.club_id FROM public.accounting_rakeback_period_calculations c
    WHERE c.coordinator_union_id=p_union_id AND c.period_start=(p_from AT TIME ZONE 'America/Los_Angeles')::date
     AND c.period_end=(p_to AT TIME ZONE 'America/Los_Angeles')::date-1
   UNION SELECT sp.club_id FROM public.settlement_periods sp WHERE sp.union_id=p_union_id AND sp.start_at=p_from AND sp.end_at=p_to
  )x WHERE x.id IS NOT NULL AND x.id<>p_union_id ORDER BY x.id;
 END IF;
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_mark_scope_accounting_settled(p_scope_kind text,p_scope_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE u_id uuid;c_id uuid;clubs uuid[];period public.settlement_periods%ROWTYPE;n int;club uuid;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_scope_kind IS NULL OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL
  OR p_from IS NULL OR p_to IS NULL OR p_from IS DISTINCT FROM public.fn_union_week_start(p_from)
  OR p_to IS DISTINCT FROM public.fn_union_week_start(p_from+interval '8 days') THEN
  RAISE EXCEPTION 'invalid_accounting_settled_scope' USING ERRCODE='22023'; END IF;
 u_id:=CASE WHEN p_scope_kind='union' THEN p_scope_id END;c_id:=CASE WHEN p_scope_kind='club' THEN p_scope_id END;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_scope_kind||'-accounting:'||p_scope_id::text||':'||extract(epoch FROM p_from)::text||':'||extract(epoch FROM p_to)::text,0));
 SELECT COALESCE(array_agg(w.club_id),ARRAY[]::uuid[]) INTO clubs FROM public.fn_accounting_week_clubs(u_id,c_id,p_from,p_to)w;
 IF u_id IS NOT NULL THEN clubs:=array_append(clubs,NULL::uuid); END IF;
 FOREACH club IN ARRAY clubs LOOP
  SELECT count(*) INTO n FROM public.settlement_periods sp WHERE sp.club_id IS NOT DISTINCT FROM club
    AND sp.union_id IS NOT DISTINCT FROM u_id AND sp.start_at=p_from AND sp.end_at=p_to;
  IF n>1 THEN RAISE EXCEPTION 'accounting_week_has_duplicate_periods' USING ERRCODE='55000'; END IF;
  SELECT * INTO period FROM public.settlement_periods sp WHERE sp.club_id IS NOT DISTINCT FROM club
    AND sp.union_id IS NOT DISTINCT FROM u_id AND sp.start_at=p_from AND sp.end_at=p_to FOR UPDATE;
  IF NOT FOUND THEN
   INSERT INTO public.settlement_periods(club_id,union_id,period_number,year,start_at,end_at,status,settled_at,settled_by)
    VALUES(club,u_id,extract(week FROM p_from AT TIME ZONE 'America/Los_Angeles')::int,
     extract(isoyear FROM p_from AT TIME ZONE 'America/Los_Angeles')::int,p_from,p_to,'settled',now(),auth.uid());
  ELSIF period.status IS NULL OR period.status NOT IN('open','processing','settled','closed') THEN
   RAISE EXCEPTION 'accounting_week_period_state_requires_reconciliation' USING ERRCODE='55000';
  ELSIF period.status NOT IN('settled','closed') THEN
   UPDATE public.settlement_periods SET status='settled',settled_at=now(),settled_by=auth.uid(),updated_at=now() WHERE id=period.id;
  END IF;
 END LOOP;
END $function$;
REVOKE ALL ON FUNCTION public.fn_mark_scope_accounting_settled(text,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- Only retry-alert comparison uses this projection. The full failure result,
-- including every attempted receipt ID, remains in the run journal/alert.
CREATE FUNCTION public.fn_accounting_failure_identity(p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $function$
DECLARE result jsonb;decoded jsonb;item record;
BEGIN
 IF p_result IS NULL THEN RETURN NULL;END IF;
 CASE jsonb_typeof(p_result)
 WHEN 'object' THEN
  result:='{}'::jsonb;
  FOR item IN SELECT key,value FROM jsonb_each(p_result) LOOP
   IF item.key IN('period_id','source_ledger_ids','settlement_id','elapsed_seconds','clock_ran_out') THEN CONTINUE;END IF;
   result:=result||jsonb_build_object(item.key,public.fn_accounting_failure_identity(item.value));
  END LOOP;
  RETURN result;
 WHEN 'array' THEN
  SELECT COALESCE(jsonb_agg(public.fn_accounting_failure_identity(a.value) ORDER BY a.ordinality),'[]'::jsonb)
   INTO result FROM jsonb_array_elements(p_result) WITH ORDINALITY a;
  RETURN result;
 WHEN 'string' THEN
  -- PostgreSQL exception DETAIL often contains a serialized JSON report.
  -- Decode only structured reports; retain ordinary error text unchanged.
  BEGIN decoded:=(p_result#>>'{}')::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN RETURN p_result;END;
  IF jsonb_typeof(decoded) IN('object','array') THEN RETURN public.fn_accounting_failure_identity(decoded);END IF;
  RETURN p_result;
 ELSE RETURN p_result;
 END CASE;
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_failure_identity(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_process_weekly_accounting_scope(p_union_id uuid,p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_stage2 jsonb;v_stage3 jsonb;v_statements jsonb;v_validated_before text;
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
  IF (p_union_id IS NOT NULL AND p_club_id IS NOT NULL)
    OR (p_union_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.unions WHERE id=p_union_id))
    OR (p_club_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id AND is_union IS NOT TRUE)) THEN
    RAISE EXCEPTION 'invalid_weekly_accounting_scope' USING ERRCODE='22023';END IF;
  -- Transaction locks release on errors and also work in reused connections.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
    RETURN jsonb_build_object('success',true,'skipped',true,'reason','already_running');
  END IF;
  IF public.fn_platform_frozen() OR extract(minute FROM v_now) >= 45 THEN
    RETURN jsonb_build_object('success',true,'skipped',true,'reason','maintenance_window');
  END IF;

  FOR v_union IN SELECT u.id, f.earliest_period_start
    FROM public.unions u LEFT JOIN public.union_settlement_floor f ON f.union_id=u.id WHERE p_club_id IS NULL AND (p_union_id IS NULL OR u.id=p_union_id) ORDER BY u.id
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

      PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||v_union.id::text||':'||extract(epoch FROM v_from)::text||':'||extract(epoch FROM v_end)::text,0));
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
        JOIN public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc ON uc.club_id=rp.club_id
        WHERE rp.status='pending' AND rp.rakeback_amount>0
          AND rp.period_start >= (v_from AT TIME ZONE 'UTC')::date
          AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') <= v_end)
        AND NOT EXISTS (SELECT 1 FROM public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc
          WHERE uc.club_id<>v_union.id
            AND NOT EXISTS (SELECT 1 FROM public.settlement_invoices si
              WHERE si.club_id=uc.club_id AND si.invoice_type='union_weekly_squareup'
                AND si.breakdown->>'union_id'=v_union.id::text
                AND (si.breakdown->>'period_start')::timestamptz=v_from
                AND (si.breakdown->>'period_end')::timestamptz=v_end
                AND si.message_sent=true AND si.status<>'cancelled'));

      v_complete:=v_complete AND NOT EXISTS(SELECT 1 FROM public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc
        WHERE uc.club_id<>v_union.id AND NOT EXISTS(
          SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
          WHERE i.club_id=uc.club_id AND i.invoice_type='club_weekly_accounting' AND i.message_sent
            AND sp.club_id=uc.club_id AND sp.union_id=v_union.id AND sp.start_at=v_from AND sp.end_at=v_end AND sp.status IN('settled','closed') AND i.status<>'cancelled'));
      -- Completion is proved by the actual posted source receipts, not only
      -- the coordinator's summary JSON or another union's period document.
      v_complete:=v_complete AND EXISTS(SELECT 1 FROM public.ca_settlements c
        WHERE c.settlement_type='union_rakeback_close' AND c.union_id=v_union.id AND c.state='final'
         AND c.totals->>'accounting_version'='3' AND c.external_ref=v_union.id::text||':'
          ||to_char(v_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')||'..'
          ||to_char(v_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        AND NOT EXISTS(SELECT 1 FROM generate_series(2,3) n WHERE NOT EXISTS(
          SELECT 1 FROM public.accounting_routed_settlement_runs r
           WHERE r.scope_kind='union' AND r.scope_id=v_union.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=n
            AND r.result->>'routing_version'='3' AND r.result->>'source_version'='2'
            AND r.result->>'success'='true' AND r.result->'shortfalls'='0'::jsonb
            AND r.result=(v_previous->CASE WHEN n=2 THEN 'round2_club_to_agents' ELSE 'round3_agents_to_players' END)-'duplicate'));
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
            AND (rr.club_id=v_union.id OR EXISTS(SELECT 1 FROM public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc WHERE uc.club_id=rr.club_id))
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
          v_result:=v_previous||jsonb_build_object('success',true,'already_posted',true);
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
        IF public.fn_accounting_failure_identity(v_previous) IS DISTINCT FROM public.fn_accounting_failure_identity(v_result) THEN
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

  -- Standalone and formerly standalone earnings use this same coordinator,
  -- run table, preparation, routed stages and document sender.
  IF p_union_id IS NULL AND v_now>=public.fn_union_accounting_run_at(v_to) THEN
    FOR v_club IN
      WITH pending_scope AS (
        SELECT s.club_id,min(public.fn_union_week_start(s.earned_at)) AS first_week
         FROM public.accounting_payable_earning_sources s WHERE s.coordinator_union_id IS NULL AND s.earned_at<v_to GROUP BY s.club_id
        UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
         WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
        UNION ALL SELECT rp.club_id,min(public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles'))
         FROM public.rakeback_periods rp WHERE rp.status='pending' AND rp.period_end<(v_to AT TIME ZONE 'America/Los_Angeles')::date
          AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=rp.club_id) GROUP BY rp.club_id
        UNION ALL SELECT a.club_id,public.fn_union_prev_week_start(v_now) FROM public.agents a
         WHERE NOT COALESCE(a.is_prepaid,false) AND a.credit_used>0 AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=a.club_id)
      ) SELECT x.club_id AS id,min(x.first_week) AS first_week FROM pending_scope x JOIN public.clubs c ON c.id=x.club_id
       WHERE c.is_union IS NOT TRUE AND (p_club_id IS NULL OR x.club_id=p_club_id) GROUP BY x.club_id ORDER BY x.club_id
    LOOP
      v_from:=v_club.first_week;
      WHILE v_from<v_to LOOP
        v_end:=public.fn_union_week_start(v_from+interval '8 days');v_due:=public.fn_union_accounting_run_at(v_end);
        IF v_now<v_due THEN EXIT;END IF;
        IF v_checked>=8 OR clock_timestamp()-v_now>interval '15 minutes'
          OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
          RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,'more_remaining',true,'detail',v_results);
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('club-accounting:'||v_club.id::text||':'||extract(epoch FROM v_from)::text||':'||extract(epoch FROM v_end)::text,0));
        SELECT result INTO v_previous FROM public.union_accounting_runs q
          WHERE q.standalone_club_id=v_club.id AND q.period_start=v_from AND q.period_end=v_end;
        IF v_previous->>'success'='true' AND v_previous->>'accounting_version'='3'
          AND EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
            AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=2 AND r.result=v_previous->'round2')
          AND EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
            AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=3 AND r.result=v_previous->'round3')
          AND EXISTS(SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
            WHERE sp.club_id=v_club.id AND sp.union_id IS NULL AND sp.start_at=v_from AND sp.end_at=v_end
             AND sp.status IN('settled','closed') AND i.club_id=v_club.id
             AND i.invoice_type='club_weekly_accounting' AND i.message_sent AND i.status<>'cancelled') THEN
          v_from:=v_end;CONTINUE;
        END IF;
        INSERT INTO public.union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,started_at)
          VALUES(v_club.id,v_from,v_end,v_due,'running',1,clock_timestamp())
          ON CONFLICT(scope_kind,scope_id,period_start,period_end) DO UPDATE
          SET status='running',attempts=union_accounting_runs.attempts+1,started_at=clock_timestamp();
        -- Preparation writes a durable queue result even if wallet work below
        -- refuses. No source calculator reports an unpersisted ready flag.
        BEGIN v_preparation:=public.fn_prepare_accounting_week(NULL,v_club.id,v_from,v_end);
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
          v_preparation:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
        END;
        BEGIN
          IF v_preparation->>'success' IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;END IF;
          PERFORM public.fn_assert_cash_commission_period(NULL,v_club.id,v_from,v_end);
          v_stage2:=public.fn_settle_accounting_commission_stage('club',v_club.id,v_from,v_end);
          v_stage3:=public.fn_settle_accounting_rakeback_stage('club',v_club.id,v_from,v_end);
          IF v_stage2->>'success' IS DISTINCT FROM 'true' OR v_stage3->>'success' IS DISTINCT FROM 'true'
            OR v_stage2->>'routing_version' IS DISTINCT FROM '3' OR v_stage3->>'routing_version' IS DISTINCT FROM '3'
            OR v_stage2->>'source_version' IS DISTINCT FROM '2' OR v_stage3->>'source_version' IS DISTINCT FROM '2'
            OR v_stage2->'shortfalls' IS DISTINCT FROM '0'::jsonb OR v_stage3->'shortfalls' IS DISTINCT FROM '0'::jsonb
            OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
              AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=2 AND r.result=(v_stage2-'duplicate'))
            OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
              AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=3 AND r.result=(v_stage3-'duplicate')) THEN
            RAISE EXCEPTION 'weekly_routing_receipt_not_confirmed' USING ERRCODE='23514';END IF;
          v_credit:=public.fn_generate_scope_credit_invoices(v_club.id,v_from,v_end);
          IF v_credit->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'weekly_credit_invoice_incomplete' USING ERRCODE='23514';END IF;
          PERFORM public.fn_mark_scope_accounting_settled('club',v_club.id,v_from,v_end);
          v_validated_before:=current_setting('app.accounting_validated_scope',true);
          PERFORM set_config('app.accounting_validated_scope','club:'||v_club.id::text||':'||v_from::text||':'||v_end::text,true);
          v_statements:=public.fn_issue_scope_weekly_accounting('club',v_club.id,v_from,v_end);
          PERFORM set_config('app.accounting_validated_scope',COALESCE(v_validated_before,''),true);
          IF v_statements->>'success' IS DISTINCT FROM 'true' OR NOT EXISTS(
            SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
             WHERE sp.club_id=v_club.id AND sp.union_id IS NULL AND sp.start_at=v_from AND sp.end_at=v_end
              AND sp.status IN('settled','closed') AND i.club_id=v_club.id
              AND i.invoice_type='club_weekly_accounting' AND i.message_sent AND i.status<>'cancelled') THEN
            RAISE EXCEPTION 'weekly_club_statement_delivery_incomplete' USING ERRCODE='23514';END IF;
          v_result:=jsonb_build_object('success',true,'scope_kind','club','scope_id',v_club.id,'period_start',v_from,'period_end',v_end,
            'round2',v_stage2-'duplicate','round3',v_stage3-'duplicate','credit_invoices',v_credit,'club_weekly_statements',v_statements,'accounting_version',3);
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
          v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
        END;
        UPDATE public.union_accounting_runs SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' ELSE 'failed' END,
          finished_at=clock_timestamp(),result=v_result WHERE standalone_club_id=v_club.id AND period_start=v_from AND period_end=v_end;
        IF v_result->>'success' IS DISTINCT FROM 'true' THEN
          v_failed:=v_failed+1;
          IF public.fn_accounting_failure_identity(v_previous) IS DISTINCT FROM public.fn_accounting_failure_identity(v_result) THEN
            INSERT INTO public.financial_alerts(source,severity,message,context) VALUES('weekly_club_accounting','critical','Weekly club accounting is incomplete',
              jsonb_build_object('club_id',v_club.id,'period_start',v_from,'period_end',v_end,'result',v_result));
          END IF;
        END IF;
        v_checked:=v_checked+1;
        v_results:=v_results||jsonb_build_array(jsonb_build_object('club_id',v_club.id,'period_start',v_from,'period_end',v_end,'result',v_result));
        IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT;END IF;
        v_from:=v_end;
      END LOOP;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
    'observed_at',clock_timestamp(),'detail',v_results);
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_process_weekly_accounting(p_union_id uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $function$
 SELECT public.fn_process_weekly_accounting_scope(p_union_id,NULL::uuid)
$function$;

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
      JOIN public.fn_accounting_week_clubs(p_union_id,NULL,v_from,v_to) uc ON uc.club_id=rp.club_id
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
  PERFORM public.fn_mark_scope_accounting_settled('union',p_union_id,v_from,v_to);

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

  IF EXISTS (SELECT 1 FROM public.fn_accounting_week_clubs(p_union_id,NULL,v_from,v_to) uc
    WHERE uc.club_id<>p_union_id
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
REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_process_weekly_accounting(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON TABLE public.union_accounting_runs IS 'Canonical weekly accounting run journal for union and standalone club scopes; legacy table name retained for existing union readers. Complete requires shared routed receipts and delivered weekly documents.';

-- Component 20260914143500_weekly_conservation_requires_recorded_scope_and_payment_receipts.sql
-- Complete weekly conservation uses the recorded book, including departed
-- clubs, and proves every stage against its durable receipt.

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_union_settlement_conservation_assert(uuid,timestamptz,timestamptz,jsonb,jsonb,jsonb)'::regprocedure))<>'e8ccbf772a8122cdf0679183717337cd'
 THEN RAISE EXCEPTION 'weekly conservation preimage changed';END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_union_settlement_conservation_assert(p_union_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_r1 jsonb, p_r2 jsonb, p_r3 jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rake     numeric := (p_r1->>'period_rake')::numeric;
  v_paid     numeric := (p_r1->>'total_rakeback')::numeric;
  v_retained numeric := (p_r1->>'union_retained')::numeric;
  v_r2_amt   numeric := (p_r2->>'amount')::numeric;
  v_r3_amt   numeric := (p_r3->>'amount')::numeric;
  v_neg      text;
  v_checked  int := 0; v_totals jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
  IF p_union_id IS NULL OR p_from IS NULL OR p_to IS NULL OR p_from IS DISTINCT FROM public.fn_union_week_start(p_from)
   OR p_to IS DISTINCT FROM public.fn_union_week_start(p_from+interval '8 days') THEN
   RAISE EXCEPTION 'invalid_conservation_scope' USING ERRCODE='22023'; END IF;
  SELECT c.totals INTO v_totals FROM public.ca_settlements c
   WHERE c.settlement_type='union_rakeback_close' AND c.union_id=p_union_id AND c.state='final'
    AND c.external_ref=p_union_id::text||':'||to_char(p_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
     ||'..'||to_char(p_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
  IF v_totals IS NULL OR v_totals->>'accounting_version' IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'CONSERVATION_UNVERIFIED: exact recorded earning close is missing'; END IF;
  IF p_r1->>'error'='already_executed' THEN
    v_rake:=(v_totals->>'period_rake')::numeric;
    v_paid:=(v_totals->>'payout_total')::numeric;
    v_retained:=(v_totals->>'retained')::numeric;
  ELSIF p_r1->>'success' IS DISTINCT FROM 'true'
   OR (v_totals->>'period_rake')::numeric IS DISTINCT FROM v_rake
   OR (v_totals->>'payout_total')::numeric IS DISTINCT FROM v_paid
   OR (v_totals->>'retained')::numeric IS DISTINCT FROM v_retained THEN
    RAISE EXCEPTION 'CONSERVATION_UNVERIFIED: Round 1 response differs from its posted close'; END IF;
  IF EXISTS(SELECT 1 FROM (VALUES(2,p_r2),(3,p_r3)) input(round_no,receipt)
    WHERE input.receipt->>'success' IS DISTINCT FROM 'true'
     OR input.receipt->>'routing_version' IS DISTINCT FROM '3'
     OR input.receipt->>'source_version' IS DISTINCT FROM '2'
     OR input.receipt->'shortfalls' IS DISTINCT FROM '0'::jsonb
     OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='union' AND r.scope_id=p_union_id
      AND r.period_start=p_from AND r.period_end=p_to AND r.round_no=input.round_no AND r.result=(input.receipt-'duplicate'))) THEN
    RAISE EXCEPTION 'CONSERVATION_UNVERIFIED: routed payment receipts do not match the exact union week'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.union_wallets w WHERE w.union_id=p_union_id)
   OR EXISTS(SELECT 1 FROM public.fn_accounting_week_clubs(p_union_id,NULL,p_from,p_to) s
    WHERE NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=s.club_id)) THEN
    RAISE EXCEPTION 'CONSERVATION_UNVERIFIED: an accounting wallet is missing'; END IF;
  IF v_rake IS NULL OR v_paid IS NULL OR v_retained IS NULL OR v_r2_amt IS NULL OR v_r3_amt IS NULL THEN
    RAISE EXCEPTION 'CONSERVATION_UNVERIFIED: settlement totals are missing';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(ARRAY[v_rake,v_paid,v_retained,v_r2_amt,v_r3_amt]) n
    WHERE n::text IN ('NaN','Infinity','-Infinity') OR n<0 OR n<>round(n,2)) THEN
    RAISE EXCEPTION 'CONSERVATION_BREACH: settlement totals must be finite nonnegative whole cents';
  END IF;
  IF v_rake <> v_paid+v_retained THEN
    RAISE EXCEPTION 'CONSERVATION_BREACH round1_arithmetic: rake % <> paid % + retained %',v_rake,v_paid,v_retained;
  END IF;
  IF v_paid>v_rake THEN RAISE EXCEPTION 'CONSERVATION_BREACH round1_overpay'; END IF;
  v_checked := v_checked+2;

  -- 6. Rounds 2 and 3 never move a negative amount.
  IF COALESCE(v_r2_amt, 0) < 0 THEN
    RAISE EXCEPTION 'CONSERVATION_BREACH round2_negative_amount: %', v_r2_amt;
  END IF;
  IF COALESCE(v_r3_amt, 0) < 0 THEN
    RAISE EXCEPTION 'CONSERVATION_BREACH round3_negative_amount: %', v_r3_amt;
  END IF;
  v_checked := v_checked + 2;

  -- 3 + 4 + 5. Nothing this union touches may be negative afterwards.
  SELECT string_agg(x.pool || ' = ' || COALESCE(x.amt::text,'NULL'), '; ') INTO v_neg
    FROM (
      SELECT 'union chip wallet' AS pool, w.chip_balance AS amt
        FROM union_wallets w
       WHERE w.union_id = p_union_id AND (w.chip_balance < 0 OR w.chip_balance IS NULL OR w.chip_balance::text IN('NaN','Infinity','-Infinity') OR w.chip_balance<>round(w.chip_balance,2))
      UNION ALL
      SELECT 'union rake wallet', w.rake_wallet
        FROM union_wallets w
       WHERE w.union_id = p_union_id AND (w.rake_wallet < 0 OR w.rake_wallet IS NULL OR w.rake_wallet::text IN('NaN','Infinity','-Infinity') OR w.rake_wallet<>round(w.rake_wallet,2))
      UNION ALL
      SELECT 'club treasury ' || c.name, c.chip_treasury
        FROM clubs c
        JOIN public.fn_accounting_week_clubs(p_union_id,NULL,p_from,p_to) uc ON uc.club_id = c.id
       WHERE (c.chip_treasury < 0 OR c.chip_treasury IS NULL OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
      UNION ALL
      SELECT 'member wallet ' || cm.user_id::text, cm.chip_balance
        FROM club_members cm
        JOIN public.fn_accounting_week_clubs(p_union_id,NULL,p_from,p_to) uc ON uc.club_id = cm.club_id
       WHERE (cm.chip_balance < 0 OR cm.chip_balance IS NULL OR cm.chip_balance::text IN('NaN','Infinity','-Infinity') OR cm.chip_balance<>round(cm.chip_balance,2))
    ) x;

  IF v_neg IS NOT NULL THEN
    RAISE EXCEPTION 'CONSERVATION_BREACH negative_pool after settlement: %', left(v_neg, 400);
  END IF;
  v_checked := v_checked + 3;

  RETURN jsonb_build_object(
    'conservation', 'asserted',
    'checks', v_checked,
    'period_start', p_from, 'period_end', p_to,
    'round1_rake', v_rake, 'round1_paid', v_paid, 'round1_retained', v_retained,
    'round2_amount', v_r2_amt, 'round3_amount', v_r3_amt);
END $function$;
REVOKE ALL ON FUNCTION public.fn_union_settlement_conservation_assert(uuid,timestamptz,timestamptz,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Component 20260914144442_cash_accounting_refusals_are_durable_and_retryable.sql
-- One durable cash-source work authority delegates the existing liability and
-- stats writers. Refusal is never success; retry cannot lose downstream work.
-- No historical repair, new payout writer, wallet transfer, or rate change.

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_credit_agent_commissions_batch(jsonb)'::regprocedure))<>'0649a58a4a82bcc1f4835abf63093b43'
 OR md5(pg_get_functiondef('public.apply_rakeback_player_stats(uuid,uuid,uuid,integer,numeric)'::regprocedure))<>'7f2b71a539db1b9c5cf6dbf6a489d40e'
 THEN RAISE EXCEPTION 'cash batch or stats authority changed since review'; END IF;
 IF to_regprocedure('public.fn_accrue_cash_hand_commissions(uuid)') IS NULL
 OR to_regclass('public.accounting_period_recompute_requests') IS NULL THEN
 RAISE EXCEPTION 'canonical cash source and period queue dependencies required';END IF;
END $guard$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_credit_agent_commissions_batch','approved','Existing batch delegates cash records to the one durable source authority. Legacy callers retain separate failure counts; source receipts distinguish durable refusal from credit.'),
 ('fn_process_cash_accounting_source','approved','Calls existing whole-hand liability and idempotent stats writers, queues existing full-week calculation, then records one durable source outcome. Financial subtransaction rolls back on refusal; no payout or rate calculation.'),
 ('fn_retry_cash_accounting_sources','approved','Bounded retry delegates the same cash-source authority; no alternate money writer.')
 ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
CREATE TABLE public.accounting_cash_source_receipts(
 id uuid PRIMARY KEY,
 rake_record_id uuid NOT NULL REFERENCES public.rake_records(id),
 attempt bigint NOT NULL CHECK(attempt>0),
 earned_at timestamptz NOT NULL,
 source_fingerprint text NOT NULL,
 status text NOT NULL CHECK(status IN('accrued','blocked')),
 reason text,
 sqlstate text,
 error_detail text,
 scope jsonb NOT NULL,
 result jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(rake_record_id,attempt),
 CHECK((status='blocked')=(reason IS NOT NULL)),
 CHECK(scope->>'kind' IN('union','club','unknown'))
);
CREATE TABLE public.accounting_cash_source_work(
 rake_record_id uuid PRIMARY KEY REFERENCES public.rake_records(id),
 receipt_id uuid NOT NULL REFERENCES public.accounting_cash_source_receipts(id),
 source_fingerprint text NOT NULL,
 status text NOT NULL CHECK(status IN('accrued','blocked')),
 attempts bigint NOT NULL CHECK(attempts>0),
 next_attempt_at timestamptz NOT NULL
);
CREATE INDEX accounting_cash_source_work_retry ON public.accounting_cash_source_work(next_attempt_at,rake_record_id) WHERE status='blocked';
ALTER TABLE public.accounting_cash_source_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_cash_source_work ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_cash_source_receipts,public.accounting_cash_source_work FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_cash_source_receipts,public.accounting_cash_source_work TO service_role;
CREATE TRIGGER accounting_cash_source_receipts_immutable BEFORE UPDATE OR DELETE ON public.accounting_cash_source_receipts FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_source_receipts_no_truncate BEFORE TRUNCATE ON public.accounting_cash_source_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE FUNCTION public.fn_cash_source_refusal_scope(p_rake_record_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE r public.rake_records%ROWTYPE;b public.accounting_cash_bank_receipts%ROWTYPE;
 n int; historical_union uuid; cutoff timestamptz;
BEGIN
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id;
 SELECT * INTO b FROM public.accounting_cash_bank_receipts WHERE rake_record_id=r.id;
 -- A source's bank receipt is immutable. A real union deposit identifies its
 -- book even when a player's attribution or commercial terms are incomplete.
 IF b.union_id IS NOT NULL AND b.amount=r.rake_amount AND b.banked_at=r.created_at
  AND EXISTS(SELECT 1 FROM public.union_wallet_transactions t WHERE t.id=b.union_transaction_id
   AND t.union_id=b.union_id AND t.wallet='rake_wallet' AND t.direction='credit'
   AND t.tx_type='rake' AND t.amount=b.amount AND t.created_at=b.banked_at) THEN
  RETURN jsonb_build_object('kind','union','id',b.union_id,'proof','union_bank_receipt');
 END IF;
 IF b.union_id IS NULL AND b.club_id=r.club_id AND b.amount=r.rake_amount AND b.banked_at=r.created_at
  AND EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=b.club_ledger_id
   AND l.to_type='club_treasury' AND l.to_entity_id=b.club_id AND l.club_id=b.club_id
   AND l.category='rake' AND l.amount=b.amount AND l.created_at=b.banked_at) THEN
  SELECT count(*),(array_agg((h.after_terms->>'union_id')::uuid))[1] INTO n,historical_union FROM (
   SELECT DISTINCT ON(entity_key) after_terms FROM public.accounting_agreement_history
    WHERE entity_type='union_clubs' AND club_id=b.club_id AND observed_at<=r.created_at
    ORDER BY entity_key,observed_at DESC,id DESC)h
   WHERE h.after_terms IS NOT NULL AND h.after_terms->>'club_id'=b.club_id::text;
  IF n=1 AND historical_union IS NOT NULL THEN
   RETURN jsonb_build_object('kind','union','id',historical_union,'proof','private_bank_and_observed_membership');
  END IF;
  SELECT starts_at INTO cutoff FROM public.accounting_cash_accrual_cutover WHERE singleton;
  -- After source cutover the installed observer covers all union membership
  -- transitions. Before it, absence of a historical row proves no absence.
  IF n=0 AND r.created_at>=cutoff THEN
   RETURN jsonb_build_object('kind','club','id',b.club_id,'proof','private_bank_after_history_cutover');
  END IF;
 END IF;
 RETURN jsonb_build_object('kind','unknown','id',NULL,'proof','coordinator_not_proven');
END $function$;

CREATE FUNCTION public.fn_process_cash_accounting_source(p_rake_record_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE r public.rake_records%ROWTYPE;w public.accounting_cash_source_work%ROWTYPE;
 receipt public.accounting_cash_source_receipts%ROWTYPE; fingerprint text;result jsonb;credits jsonb:='[]';
 status_value text:='accrued';reason_value text;state_value text;detail_value text;scope jsonb;
 player record;club record;week_start date;next_attempt bigint; applied boolean;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id;
 IF NOT FOUND OR COALESCE(r.is_tournament,false) OR r.tournament_id IS NOT NULL THEN
  RAISE EXCEPTION 'cash_source_record_required' USING ERRCODE='22023'; END IF;
 -- Share the existing hand authority. Nothing locks work rows before this.
 PERFORM pg_advisory_xact_lock(hashtextextended(CASE WHEN r.hand_id IS NULL THEN 'accounting_cash_source:'||r.id::text
  ELSE 'accounting_cash_hand:'||r.hand_id::text END,0));
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR SHARE;
 SELECT md5(jsonb_build_object('id',r.id,'hand',r.hand_id,'club',r.club_id,'rake',r.rake_amount,
  'earned_at',r.created_at,'metadata',r.metadata,'attributions',COALESCE(jsonb_agg(
   jsonb_build_array(a.id,a.hand_id,a.player_id,a.club_id,a.weighted_rake_credit) ORDER BY a.id),'[]'::jsonb))::text)
  INTO fingerprint FROM public.rake_attributions a WHERE a.rake_record_id=r.id;
 SELECT * INTO w FROM public.accounting_cash_source_work WHERE rake_record_id=r.id;
 IF w.status='accrued' AND w.source_fingerprint=fingerprint THEN
  SELECT * INTO receipt FROM public.accounting_cash_source_receipts WHERE id=w.receipt_id;
  RETURN receipt.result||jsonb_build_object('duplicate',true);
 END IF;
 next_attempt:=COALESCE(w.attempts,0)+1;
 BEGIN
  IF r.hand_id IS NULL OR NOT isfinite(r.created_at) OR r.rake_amount IS NULL OR r.rake_amount<=0
   OR r.rake_amount::text IN('NaN','Infinity','-Infinity') OR r.rake_amount<>round(r.rake_amount,2)
   OR (SELECT count(*) FROM public.rake_records WHERE hand_id=r.hand_id)<>1 THEN
   RAISE EXCEPTION 'cash_source_identity_or_amount_invalid' USING ERRCODE='23514'; END IF;
  result:=public.fn_accrue_cash_hand_commissions(r.hand_id);
  IF result->>'status'='legacy_unverified' AND result->>'recorded'='true' THEN
   status_value:='blocked';reason_value:='cash_source_legacy_unverified';state_value:='55000';
  ELSE
   IF result->>'status' IS DISTINCT FROM 'accrued' OR result->>'recorded' IS DISTINCT FROM 'true'
    OR result->>'source_version' IS DISTINCT FROM '2'
    OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches WHERE rake_record_id=r.id AND status='accrued') THEN
    RAISE EXCEPTION 'cash_source_accrual_receipt_invalid' USING ERRCODE='23514'; END IF;
   week_start:=(public.fn_union_week_start(r.created_at) AT TIME ZONE 'America/Los_Angeles')::date;
   FOR player IN SELECT * FROM public.accounting_cash_rake_sources WHERE rake_record_id=r.id ORDER BY club_id,player_id LOOP
    applied:=public.apply_rakeback_player_stats(r.id,player.player_id,player.club_id,1,player.rake_credit);
    IF NOT EXISTS(SELECT 1 FROM public.rakeback_stats_applied a WHERE a.rake_record_id=r.id AND a.user_id=player.player_id
      AND a.hands=1 AND a.rake=player.rake_credit) THEN
     RAISE EXCEPTION 'cash_source_player_stats_receipt_invalid' USING ERRCODE='23514'; END IF;
    credits:=credits||jsonb_build_array(jsonb_build_object('player_id',player.player_id,'club_id',player.club_id,
      'rake_credit',player.rake_credit,'period_start',week_start,'period_end',week_start+6));
   END LOOP;
   IF jsonb_array_length(credits)=0 THEN RAISE EXCEPTION 'cash_source_contributor_receipts_missing' USING ERRCODE='23514'; END IF;
   -- Queue the existing complete-week calculator; do not invent another
   -- calculator or depend on a later hand arriving to repair this source.
   FOR club IN SELECT DISTINCT club_id FROM public.accounting_cash_rake_sources WHERE rake_record_id=r.id ORDER BY club_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||club.club_id::text||':'||week_start::text,0));
    INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
     VALUES(club.club_id,week_start,week_start+6)
     ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL;
   END LOOP;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS reason_value=MESSAGE_TEXT,state_value=RETURNED_SQLSTATE,detail_value=PG_EXCEPTION_DETAIL;
  status_value:='blocked';credits:='[]';
 END;
 scope:=public.fn_cash_source_refusal_scope(r.id);
 receipt.id:=gen_random_uuid();
 result:=jsonb_build_object('receipt_version',3,'receipt_id',receipt.id,'rake_record_id',r.id,'hand_id',r.hand_id,
  'earned_at',r.created_at,'status',status_value,'recorded',true,'attempt',next_attempt,
  'source_fingerprint',fingerprint,'reason',reason_value,'sqlstate',state_value,'scope',scope,'credits',credits);
 INSERT INTO public.accounting_cash_source_receipts(id,rake_record_id,attempt,earned_at,source_fingerprint,status,reason,sqlstate,error_detail,scope,result)
  VALUES(receipt.id,r.id,next_attempt,r.created_at,fingerprint,status_value,reason_value,state_value,detail_value,scope,result);
 INSERT INTO public.accounting_cash_source_work(rake_record_id,receipt_id,source_fingerprint,status,attempts,next_attempt_at)
  VALUES(r.id,receipt.id,fingerprint,status_value,next_attempt,clock_timestamp()+make_interval(secs=>LEAST(3600,60*next_attempt)::int))
  ON CONFLICT(rake_record_id) DO UPDATE SET receipt_id=EXCLUDED.receipt_id,source_fingerprint=EXCLUDED.source_fingerprint,
   status=EXCLUDED.status,attempts=EXCLUDED.attempts,next_attempt_at=EXCLUDED.next_attempt_at;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_credit_agent_commissions_batch(p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='300s' AS $function$
DECLARE it jsonb;r jsonb;receipts jsonb:='[]';record_id uuid;v_ok int:=0;v_failed int:=0;v_blocked int:=0;first_error text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items)>2000 THEN
  RETURN jsonb_build_object('ok',0,'failed',0,'error','p_items must be a jsonb array of at most 2000 items'); END IF;
 FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  BEGIN
   IF it->>'source_type' IN('cash_rake_record','rake_settlement') THEN
    IF it->>'source_type'='cash_rake_record' THEN record_id:=(it->>'source_id')::uuid;
    ELSE
     SELECT id INTO STRICT record_id FROM public.rake_records WHERE hand_id=(it->>'source_id')::uuid;
     -- Keep the legacy caller's scope validation. A batched user cannot move
     -- one contributor's recorded earning into a different club.
     IF NOT EXISTS(SELECT 1 FROM public.rake_attributions WHERE rake_record_id=record_id
      AND player_id=(it->>'user_id')::uuid AND club_id=(it->>'club_id')::uuid
      AND weighted_rake_credit=(it->>'rake_credit')::numeric) THEN
      RAISE EXCEPTION 'cash_source_legacy_input_not_proven' USING ERRCODE='23514'; END IF;
    END IF;
    r:=public.fn_process_cash_accounting_source(record_id);receipts:=receipts||jsonb_build_array(r);
    IF r->>'status'='accrued' THEN v_ok:=v_ok+1;
    ELSE v_failed:=v_failed+1;v_blocked:=v_blocked+1;first_error:=COALESCE(first_error,r->>'reason'); END IF;
   ELSE
    PERFORM public.credit_agent_commission_from_rake((it->>'user_id')::uuid,(it->>'club_id')::uuid,
     COALESCE((it->>'rake_credit')::numeric,0),it->>'source_type',NULLIF(it->>'source_id','')::uuid,it->>'notes');
    v_ok:=v_ok+1;
   END IF;
  EXCEPTION WHEN OTHERS THEN v_failed:=v_failed+1;first_error:=COALESCE(first_error,SQLERRM);
  END;
 END LOOP;
 RETURN jsonb_build_object('receipt_version',3,'ok',v_ok,'failed',v_failed,'blocked',v_blocked,'first_error',first_error,'receipts',receipts);
END $function$;

CREATE FUNCTION public.fn_retry_cash_accounting_sources(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='300s' AS $function$
DECLARE w record;r jsonb;receipts jsonb:='[]';v_ok int:=0;v_blocked int:=0;v_failed int:=0;first_error text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>200 THEN RAISE EXCEPTION 'invalid_cash_retry_limit' USING ERRCODE='22023'; END IF;
 -- Do not lock work rows here: all callers acquire the original hand lock
 -- first. SKIP LOCKED on work would invert that order against direct callers.
 FOR w IN SELECT rake_record_id FROM public.accounting_cash_source_work WHERE status='blocked'
  AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,rake_record_id LIMIT p_limit LOOP
  BEGIN
   r:=public.fn_process_cash_accounting_source(w.rake_record_id);receipts:=receipts||jsonb_build_array(r);
   IF r->>'status'='accrued' THEN v_ok:=v_ok+1; ELSE v_blocked:=v_blocked+1; END IF;
  EXCEPTION WHEN OTHERS THEN v_failed:=v_failed+1;first_error:=COALESCE(first_error,SQLERRM);END;
 END LOOP;
 RETURN jsonb_build_object('receipt_version',3,'ok',v_ok,'blocked',v_blocked,'failed',v_failed+v_blocked,
  'first_error',first_error,'receipts',receipts);
END $function$;

CREATE FUNCTION public.fn_cash_source_refusals_for_period(p_union_id uuid,p_club_id uuid,p_from timestamptz,p_to timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE problems jsonb;
BEGIN
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from)
  OR NOT isfinite(p_to) OR p_to<=p_from THEN RAISE EXCEPTION 'invalid_cash_refusal_scope' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('rake_record_id',r.rake_record_id,'reason',r.reason,'scope',r.scope)
  ORDER BY r.rake_record_id),'[]'::jsonb) INTO problems
 FROM public.accounting_cash_source_work w JOIN public.accounting_cash_source_receipts r ON r.id=w.receipt_id
 WHERE w.status='blocked' AND (NOT isfinite(r.earned_at) OR(r.earned_at>=p_from AND r.earned_at<p_to))
 AND(r.scope->>'kind'='unknown' OR(r.scope->>'kind'='union' AND r.scope->>'id'=p_union_id::text)
  OR(r.scope->>'kind'='club' AND r.scope->>'id'=p_club_id::text));
 RETURN jsonb_build_object('status',CASE WHEN jsonb_array_length(problems)=0 THEN 'ready' ELSE 'blocked' END,
  'count',jsonb_array_length(problems),'sources',problems);
END $function$;

REVOKE ALL ON FUNCTION public.fn_cash_source_refusal_scope(uuid),public.fn_process_cash_accounting_source(uuid),public.fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz),public.fn_retry_cash_accounting_sources(integer),public.fn_credit_agent_commissions_batch(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb),public.fn_retry_cash_accounting_sources(integer) TO service_role;

-- Component 20260914145000_legacy_claims_enter_only_automatic_weekly_accounting.sql
-- Apply only with the scoped weekly coordinator activation bundle.
-- Old browser claims cannot pay. Trusted compatibility callers enter the one
-- coordinator, which owns due time, source certification, money and documents.

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE expected record;actual text;scope_definition text;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('public.fn_agent_claim_commission(uuid,uuid,integer)','bcb8ff3ffb25d8b6a9e1537845050fdd'),
  ('public.fn_claim_rakeback(uuid)','01e25e9908d76f1bdbc749f57f106f21'),
  ('public.fn_execute_union_rakeback(uuid,timestamptz,timestamptz)','de06da455424cbd5c38d6934a2dfca60'),
  ('public.fn_run_pending_rakeback_settlement(integer)','000eecf4f81d2e24affa3967676b8263'),
  ('public.settle_club_rakeback(uuid)','85cf74f076fd3cc2f834b4b29a01c647'),
  ('public.fn_settle_club_rakeback_batch(uuid,integer,numeric,integer)','8e2f3e6648aaa603acb438fbcfb46b92'),
  ('public.fn_close_settlement_period(uuid)','e129b4ff2ba84faa8f0dee88b494d21f')
 ) AS preimage(signature,digest) LOOP
  SELECT md5(pg_get_functiondef(to_regprocedure(expected.signature))) INTO actual;
  IF actual IS DISTINCT FROM expected.digest THEN
   RAISE EXCEPTION 'automatic accounting legacy door preimage changed: %',expected.signature;
  END IF;
 END LOOP;
 IF to_regprocedure('public.fn_process_weekly_accounting_scope(uuid,uuid)') IS NULL THEN
  RAISE EXCEPTION 'scoped weekly coordinator must be installed with this cutover';END IF;
 SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) INTO scope_definition;
 IF has_function_privilege('authenticated','public.fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE')
  OR has_function_privilege('service_role','public.fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE')
  OR scope_definition ~ 'public\.(fn_close_settlement_period|fn_settle_club_rakeback_batch)\('
  OR (SELECT regexp_replace(prosrc,'[[:space:]]','','g') FROM pg_proc WHERE oid='public.fn_process_weekly_accounting(uuid)'::regprocedure)
    IS DISTINCT FROM 'SELECTpublic.fn_process_weekly_accounting_scope(p_union_id,NULL::uuid)' THEN
  RAISE EXCEPTION 'weekly coordinator must be private, scoped and independent of legacy payers';END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_agent_claim_commission(p_club_id uuid,p_op_id uuid DEFAULT NULL::uuid,p_max_rows integer DEFAULT 1000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL THEN RETURN jsonb_build_object('success',false,'error','Authentication Required','amount',0,'rows_settled',0,'more',false,'op_id',p_op_id);END IF;
 IF p_club_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=actor AND m.status IN('active','approved')) THEN
  RETURN jsonb_build_object('success',false,'error','You Are Not An Active Member Of This Club','amount',0,'rows_settled',0,'more',false,'op_id',p_op_id);END IF;
 -- No balance read, replay receipt, settlement stamp or wallet write. A zero
 -- below is the amount moved by this retired request, not the amount owed.
 RETURN jsonb_build_object('success',false,'code','automatic_weekly_settlement','error','Commission Is Settled Automatically Every Monday At 4:00 AM Central Time. View Invoices For Recorded Transfers.',
  'authority','fn_process_weekly_accounting','schedule','Monday 04:00 America/Chicago','amount',0,'rows_settled',0,'more',false,'op_id',p_op_id,'club_id',p_club_id);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_claim_rakeback(p_club_id uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $function$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL THEN RETURN jsonb_build_object('success',false,'error','Authentication Required','periods_claimed',0,'total_payout',0);END IF;
 IF p_club_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=actor AND m.status IN('active','approved')) THEN
  RETURN jsonb_build_object('success',false,'error','You Are Not An Active Member Of This Club','periods_claimed',0,'total_payout',0);END IF;
 RETURN jsonb_build_object('success',false,'code','automatic_weekly_settlement','error','Rakeback Is Settled Automatically Every Monday At 4:00 AM Central Time. View Invoices For Recorded Transfers.',
  'authority','fn_process_weekly_accounting','schedule','Monday 04:00 America/Chicago','periods_claimed',0,'total_payout',0,'club_id',p_club_id);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_settle_club_rakeback_batch(p_club_id uuid,p_max_periods integer DEFAULT 40,p_budget_seconds numeric DEFAULT 4.0,p_max_warm_days integer DEFAULT 2)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF p_club_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.is_union IS NOT TRUE) THEN
  RETURN jsonb_build_object('success',false,'error','club_not_found','periods_settled',0,'total_payout',0);END IF;
 IF NOT public.fn_caller_is_engine() THEN
  IF actor IS NULL OR (NOT public.fn_is_platform_admin() AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.owner_id=actor)) THEN
   RETURN jsonb_build_object('success',false,'error','not_authorised','periods_settled',0,'total_payout',0);END IF;
  RETURN jsonb_build_object('success',false,'code','automatic_weekly_settlement','error','Rakeback Is Settled Automatically Every Monday At 4:00 AM Central Time.',
   'authority','fn_process_weekly_accounting','club_id',p_club_id,'periods_settled',0,'total_payout',0);
 END IF;
 -- A club compatibility request can process only that club's standalone books.
 -- It cannot widen to all clubs or impersonate a union-wide request.
 RETURN public.fn_process_weekly_accounting_scope(NULL,p_club_id);
END $function$;

CREATE OR REPLACE FUNCTION public.settle_club_rakeback(p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN RETURN public.fn_settle_club_rakeback_batch(p_club_id,40,4.0,2);END $function$;

CREATE OR REPLACE FUNCTION public.fn_execute_union_rakeback(p_union_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE actor uuid:=auth.uid();owner uuid;reference_time timestamptz:=clock_timestamp();
BEGIN
 SELECT owner_id INTO owner FROM public.unions WHERE id=p_union_id;
 IF owner IS NULL THEN RETURN jsonb_build_object('success',false,'error','union_not_found','clubs_paid',0,'total_rakeback',0,'union_retained',0);END IF;
 IF NOT public.fn_caller_is_engine() THEN
  IF actor IS NULL OR actor<>owner THEN RETURN jsonb_build_object('success',false,'error','not_authorized','clubs_paid',0,'total_rakeback',0,'union_retained',0);END IF;
  RETURN jsonb_build_object('success',false,'code','automatic_weekly_settlement','error','Union Accounting Is Settled Automatically Every Monday At 4:00 AM Central Time.',
   'authority','fn_process_weekly_accounting','union_id',p_union_id,'clubs_paid',0,'total_rakeback',0,'union_retained',0);
 END IF;
 -- This compatibility signature cannot request an arbitrary historical or
 -- future week. The coordinator alone chooses due weeks and chronological repair.
 IF p_period_start IS DISTINCT FROM public.fn_union_prev_week_start(reference_time)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(reference_time) THEN
  RETURN jsonb_build_object('success',false,'error','requested_period_requires_weekly_accounting','union_id',p_union_id,'clubs_paid',0,'total_rakeback',0,'union_retained',0);END IF;
 RETURN public.fn_process_weekly_accounting(p_union_id);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_run_pending_rakeback_settlement(p_max_clubs integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN
  IF auth.uid() IS NULL OR NOT public.fn_is_platform_admin() THEN
   RETURN jsonb_build_object('success',false,'error','not_authorized','clubs_processed',0,'periods_settled',0,'total_payout',0);END IF;
  RETURN jsonb_build_object('success',false,'code','automatic_weekly_settlement','error','Accounting Is Settled Automatically Every Monday At 4:00 AM Central Time.',
   'authority','fn_process_weekly_accounting','clubs_processed',0,'periods_settled',0,'total_payout',0);
 END IF;
 -- The old p_max_clubs knob cannot create a competing per-club payout loop.
 -- The single coordinator owns its bounded due-work budget and durable results.
 RETURN public.fn_process_weekly_accounting(NULL);
END $function$;

REVOKE ALL ON FUNCTION public.fn_agent_claim_commission(uuid,uuid,integer),public.fn_claim_rakeback(uuid),public.settle_club_rakeback(uuid),public.fn_execute_union_rakeback(uuid,timestamptz,timestamptz),public.fn_run_pending_rakeback_settlement(integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_claim_commission(uuid,uuid,integer),public.fn_claim_rakeback(uuid),public.settle_club_rakeback(uuid),public.fn_execute_union_rakeback(uuid,timestamptz,timestamptz),public.fn_run_pending_rakeback_settlement(integer) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_club_rakeback_batch(uuid,integer,numeric,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_club_rakeback_batch(uuid,integer,numeric,integer) TO service_role;
-- Retain the old close body as historical evidence, but nobody can invoke it
-- through the API. Its two former definer callers have been replaced above.
REVOKE ALL ON FUNCTION public.fn_close_settlement_period(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.fn_agent_claim_commission(uuid,uuid,integer) IS 'Retired manual payout: returns an explicit automatic weekly settlement refusal; never mutates balances or settlement records.';
COMMENT ON FUNCTION public.fn_claim_rakeback(uuid) IS 'Retired manual payout: returns an explicit automatic weekly settlement refusal; never calls the legacy period payer.';

-- Component 20260914145706_cash_compatibility_calls_share_durable_source_authority.sql
-- Compatibility callers share the durable cash source authority. The inner
-- whole-hand liability writer remains private to it; no new formula or payer.
-- Refused legacy calls raise: their old void/success-only callers cannot
-- distinguish a durable refusal from a successful financial operation.

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text)'::regprocedure))<>'5d3eeb5f5f261449ffb11df640c18d66'
 OR md5(pg_get_functiondef('public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid)'::regprocedure))<>'efff8097caf387d175fe1003327f5a99'
 OR md5(pg_get_functiondef('public.fn_process_cash_accounting_source(uuid)'::regprocedure))<>'4269a18e6fd4e0b9616663f18b40e516'
 OR md5(pg_get_functiondef('public.fn_accrue_cash_hand_commissions(uuid)'::regprocedure))<>'5924f6c736ee21d0e23ef5febbba6391'
 THEN RAISE EXCEPTION 'cash compatibility authority changed since review'; END IF;
END $guard$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('credit_agent_commission_from_rake','approved','Legacy service cash inputs delegate the same durable source authority and require a successful accrued receipt. Existing noncash branch unchanged. Source failure raises so void callers cannot misreport success.'),
 ('calculate_cascading_commission','approved','Legacy service hand compatibility delegates the same durable source authority and requires a successful accrued receipt. No independent amount or rate calculation.')
 ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake(p_agent_user_id uuid, p_club_id uuid, p_rake_credit numeric, p_source_type text DEFAULT 'rake_settlement'::text, p_source_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_record uuid;
  v_source_result jsonb;
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
    SELECT id INTO STRICT v_source_record FROM public.rake_records WHERE hand_id=p_source_id;
    v_source_result:=public.fn_process_cash_accounting_source(v_source_record);
    IF v_source_result->>'status' IS DISTINCT FROM 'accrued'
     OR v_source_result->>'recorded' IS DISTINCT FROM 'true'
     OR v_source_result->>'receipt_version' IS DISTINCT FROM '3' THEN
      RAISE EXCEPTION 'cash_source_requires_reconciliation' USING ERRCODE='55000',DETAIL=v_source_result::text;
    END IF;
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
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE source public.rake_records%ROWTYPE;result jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_rake_record_id IS NOT NULL THEN
  SELECT * INTO source FROM public.rake_records WHERE id=p_rake_record_id;
 ELSE
  IF p_hand_id IS NULL THEN RAISE EXCEPTION 'cash_hand_id_required' USING ERRCODE='22023'; END IF;
  SELECT * INTO STRICT source FROM public.rake_records WHERE hand_id=p_hand_id;
 END IF;
 IF source.id IS NULL OR source.hand_id IS NULL OR (p_hand_id IS NOT NULL AND p_hand_id<>source.hand_id)
  OR (p_table_id IS NOT NULL AND p_table_id IS DISTINCT FROM source.table_id)
  OR (p_club_id IS NOT NULL AND p_club_id<>source.club_id AND NOT EXISTS(
   SELECT 1 FROM public.rake_attributions WHERE rake_record_id=source.id AND club_id=p_club_id))
  OR (p_player_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rake_attributions
   WHERE rake_record_id=source.id AND player_id=p_player_user_id)) THEN
  RAISE EXCEPTION 'cash_commission_source_mismatch' USING ERRCODE='23514'; END IF;
 -- The caller's amount is never a financial basis. The durable source owns
 -- every player's original share and the observed hierarchy agreement.
 result:=public.fn_process_cash_accounting_source(source.id);
 IF result->>'status' IS DISTINCT FROM 'accrued' OR result->>'recorded' IS DISTINCT FROM 'true'
  OR result->>'receipt_version' IS DISTINCT FROM '3' THEN
  RAISE EXCEPTION 'cash_source_requires_reconciliation' USING ERRCODE='55000',DETAIL=result::text;
 END IF;
 RETURN result||jsonb_build_object('success',true);
END $function$;
REVOKE ALL ON FUNCTION public.fn_accrue_cash_hand_commissions(uuid),public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text),public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text),public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid) TO service_role;

-- Component 20260914150500_agent_agreements_preserve_club_scope_and_atomic_role_changes.sql
-- Guard agent agreement writes without rewriting any existing commercial rate.
-- Existing cap conflicts may be improved, but not introduced or worsened.

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_create_agent(uuid,uuid,text,uuid,numeric,numeric,numeric,boolean)'::regprocedure))<>'187ba10367041b03c9b1a815f158f1f0'
 OR md5(pg_get_functiondef('public.fn_admin_update_agent(uuid,text,text,numeric,numeric,numeric,uuid,text,boolean)'::regprocedure))<>'d1ce4c9a2245cc60f6d02481ee73db52'
 OR md5(pg_get_functiondef('public.fn_agent_downline_commission(uuid)'::regprocedure))<>'12ea17703c4362a6c2499a8afba59f50' THEN
  RAISE EXCEPTION 'agent agreement function preimage changed';END IF;
 IF EXISTS(SELECT 1 FROM public.agents c LEFT JOIN public.agents p ON p.id=c.parent_agent_id
   WHERE c.parent_agent_id IS NOT NULL AND (p.id IS NULL OR c.club_id IS DISTINCT FROM p.club_id)) THEN
  RAISE EXCEPTION 'existing agent parent scope requires reconciliation';END IF;
 IF EXISTS(WITH RECURSIVE walk AS (
   SELECT id AS start_id,id,parent_agent_id,ARRAY[id] AS path,false AS cycle FROM public.agents
   UNION ALL SELECT w.start_id,a.id,a.parent_agent_id,w.path||a.id,a.id=ANY(w.path)
   FROM walk w JOIN public.agents a ON a.id=w.parent_agent_id WHERE NOT w.cycle
  ) SELECT 1 FROM walk WHERE cycle) THEN
  RAISE EXCEPTION 'existing agent hierarchy cycle requires reconciliation';END IF;
END $guard$;
CREATE UNIQUE INDEX agents_agreement_club_and_id ON public.agents(club_id,id);
ALTER TABLE public.agents ADD CONSTRAINT agents_parent_in_same_club
 FOREIGN KEY(club_id,parent_agent_id) REFERENCES public.agents(club_id,id) NOT VALID;
ALTER TABLE public.agents VALIDATE CONSTRAINT agents_parent_in_same_club;

CREATE FUNCTION public.fn_guard_agent_agreement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE parent public.agents%ROWTYPE;child record;field text;new_value numeric;old_value numeric;parent_value numeric;child_value numeric;
 old_terms jsonb;new_terms jsonb;parent_terms jsonb;new_edge boolean;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.club_id IS DISTINCT FROM OLD.club_id) THEN
  RAISE EXCEPTION 'agent financial account identity is immutable; create a separate account for another club or user' USING ERRCODE='23514';END IF;
 -- All agreement RPCs take this same club lock before reading terms. Direct
 -- writes also pass this guard; the financial account's club is immutable.
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||NEW.club_id::text,0));
 old_terms:=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 new_terms:=to_jsonb(NEW);
 new_edge:=TG_OP='INSERT' OR NEW.parent_agent_id IS DISTINCT FROM OLD.parent_agent_id OR NEW.club_id IS DISTINCT FROM OLD.club_id;
 IF NEW.parent_agent_id IS NOT NULL THEN
  SELECT * INTO parent FROM public.agents WHERE id=NEW.parent_agent_id AND club_id=NEW.club_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'parent agent must belong to the same club' USING ERRCODE='23514';END IF;
  IF NEW.parent_agent_id=NEW.id OR EXISTS(WITH RECURSIVE chain AS (
    SELECT id,parent_agent_id FROM public.agents WHERE id=NEW.parent_agent_id AND club_id=NEW.club_id
    UNION SELECT a.id,a.parent_agent_id FROM public.agents a JOIN chain c ON a.id=c.parent_agent_id WHERE a.club_id=NEW.club_id
   ) SELECT 1 FROM chain WHERE id=NEW.id) THEN
   RAISE EXCEPTION 'agent hierarchy cannot contain a cycle' USING ERRCODE='23514';END IF;
  IF new_edge AND (parent.role='sub_agent' OR parent.status IS DISTINCT FROM 'active') THEN
   RAISE EXCEPTION 'new parent must be an active agent or super agent' USING ERRCODE='23514';END IF;
  parent_terms:=to_jsonb(parent);
 END IF;
 IF NEW.role='sub_agent' AND (TG_OP='INSERT' OR NEW.role IS DISTINCT FROM OLD.role)
  AND EXISTS(SELECT 1 FROM public.agents c WHERE c.parent_agent_id=NEW.id) THEN
  RAISE EXCEPTION 'a sub-agent cannot have agent children' USING ERRCODE='23514';END IF;

 FOREACH field IN ARRAY ARRAY['commission_rate','player_rakeback_rate','credit_limit'] LOOP
  new_value:=(new_terms->>field)::numeric;old_value:=(old_terms->>field)::numeric;
  IF TG_OP='INSERT' OR new_value IS DISTINCT FROM old_value THEN
   IF new_value IS NULL OR new_value::text IN('NaN','Infinity','-Infinity') OR new_value<0
    OR (field='credit_limit' AND new_value<>round(new_value,2))
    OR (field='commission_rate' AND new_value>0.70)
    OR (field='player_rakeback_rate' AND new_value>0.50) THEN
    RAISE EXCEPTION 'invalid agent agreement value: %',field USING ERRCODE='23514';END IF;
  END IF;
  IF NEW.parent_agent_id IS NOT NULL AND (new_edge OR new_value IS DISTINCT FROM old_value) THEN
   parent_value:=(parent_terms->>field)::numeric;
   IF parent_value IS NOT NULL AND greatest(new_value-parent_value,0)>
      (CASE WHEN new_edge THEN 0 ELSE greatest(old_value-parent_value,0) END) THEN
    RAISE EXCEPTION 'agent % cannot exceed or worsen its parent cap',field USING ERRCODE='23514';END IF;
  END IF;
  IF TG_OP='UPDATE' AND new_value IS DISTINCT FROM old_value THEN
   FOR child IN SELECT to_jsonb(a) AS terms FROM public.agents a WHERE a.parent_agent_id=NEW.id AND a.club_id=NEW.club_id LOOP
    child_value:=(child.terms->>field)::numeric;
    IF child_value IS NOT NULL AND greatest(child_value-new_value,0)>greatest(child_value-old_value,0) THEN
     RAISE EXCEPTION 'agent % cannot be reduced below an existing child agreement',field USING ERRCODE='23514';END IF;
   END LOOP;
  END IF;
 END LOOP;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_guard_agent_agreement() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER zz_guard_agent_agreement BEFORE INSERT OR UPDATE OF id,user_id,club_id,parent_agent_id,role,commission_rate,player_rakeback_rate,credit_limit ON public.agents FOR EACH ROW EXECUTE FUNCTION public.fn_guard_agent_agreement();

CREATE OR REPLACE FUNCTION public.fn_create_agent(p_user_id uuid, p_club_id uuid, p_role text, p_parent_agent_id uuid, p_commission_rate numeric, p_player_rakeback_rate numeric, p_credit_limit numeric, p_is_prepaid boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_membership_user uuid; v_member_role text;
  v_parent_role text; v_parent_comm numeric; v_parent_rake numeric; v_parent_limit numeric;
  v_new_id uuid; v_role_res jsonb;
  v_is_staff boolean; v_comm numeric; v_rake numeric; v_prepaid boolean;
BEGIN
  IF p_user_id IS NULL OR p_club_id IS NULL THEN RETURN jsonb_build_object('success',false,'error','user and club required'); END IF;
  IF v_caller IS NULL THEN RETURN jsonb_build_object('success',false,'error','authentication required'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  IF NOT EXISTS (SELECT 1 FROM clubs c WHERE c.id=p_club_id AND (c.owner_id=v_caller
     OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id=p_club_id AND cm.user_id=v_caller AND cm.role IN ('owner','co_owner','admin') AND cm.status IN ('active','approved')))) THEN
    RETURN jsonb_build_object('success',false,'error','not authorized to manage this club''s agents'); END IF;
  IF p_role IS NULL OR p_role NOT IN ('super_agent','agent','sub_agent') THEN RETURN jsonb_build_object('success',false,'error','invalid role'); END IF;
  IF p_commission_rate IS NULL OR p_commission_rate < 0 OR p_commission_rate > 0.7 THEN RETURN jsonb_build_object('success',false,'error','commission rate must be 0-0.7'); END IF;
  IF p_player_rakeback_rate IS NULL OR p_player_rakeback_rate < 0 OR p_player_rakeback_rate > 0.5 THEN RETURN jsonb_build_object('success',false,'error','rakeback rate must be 0-0.5'); END IF;
  IF p_credit_limit IS NULL OR p_credit_limit::text IN ('NaN','Infinity','-Infinity') OR p_credit_limit < 0 OR p_credit_limit <> round(p_credit_limit,2) THEN RETURN jsonb_build_object('success',false,'error','credit_limit must be finite, nonnegative and in whole chip cents'); END IF;
  IF EXISTS (SELECT 1 FROM agents WHERE user_id=p_user_id AND club_id=p_club_id) THEN RETURN jsonb_build_object('success',false,'error','already an agent in this club'); END IF;

  SELECT user_id, role INTO v_membership_user, v_member_role
    FROM club_members WHERE club_id=p_club_id AND user_id=p_user_id;

  -- Dan, 2026-08-31: "OWNERS AND CO OWNERS CAN AND SHOULD HAVE AGENT WALLETS,
  -- THAT WAS A MISTAKE."
  --
  -- PR #2132 refused outright here, on the reasoning that staff earn no
  -- rakeback so making one an agent is a demotion wearing a create button. That
  -- conflated two separate things. The agents row is BOTH the commission
  -- profile AND the agent wallet, and Dan's chip flow - main bank to agent
  -- wallet to agents and players - requires an owner or a co-owner to hold one.
  -- What they must not get is a rate, and what they must not lose is their
  -- title. Both are handled below instead of refusing the whole operation.
  v_is_staff := v_member_role IN ('owner','co_owner','admin');

  -- Owners keep earning (Dan, B-02, 2026-08-31). A co-owner and an admin do
  -- not, so their wallet is minted at zero rather than at whatever the caller
  -- typed; trg_agents_staff_earn_no_rakeback would zero it anyway, and doing it
  -- here means the row and the request agree instead of silently differing.
  IF v_member_role IN ('co_owner','admin') THEN
    v_comm := 0;
    v_rake := 0;
  ELSE
    v_comm := p_commission_rate;
    v_rake := p_player_rakeback_rate;
  END IF;

  -- Prepaid or a line, and how much. There is no third option, and the pair
  -- that means "can send nothing at all" is refused rather than stored.
  v_prepaid := COALESCE(p_is_prepaid, false);
  IF v_prepaid AND p_credit_limit <> 0 THEN
    RETURN jsonb_build_object('success',false,'error','a prepaid agent carries no credit line, so the limit must be 0');
  END IF;
  IF NOT v_prepaid AND p_credit_limit <= 0 THEN
    RETURN jsonb_build_object('success',false,'needs_funding',true,
      'error','choose prepaid, or give a credit limit greater than 0');
  END IF;

  IF p_parent_agent_id IS NOT NULL THEN
    SELECT role, commission_rate, player_rakeback_rate, credit_limit
      INTO v_parent_role, v_parent_comm, v_parent_rake, v_parent_limit
      FROM agents WHERE id=p_parent_agent_id AND club_id=p_club_id AND status='active';
    IF v_parent_role IS NULL THEN RETURN jsonb_build_object('success',false,'error','parent agent not found'); END IF;
    IF v_parent_role = 'sub_agent' THEN RETURN jsonb_build_object('success',false,'error','sub-agents cannot have sub-agents'); END IF;
    IF v_comm > v_parent_comm THEN RETURN jsonb_build_object('success',false,'error','commission rate cannot exceed parent rate'); END IF;
    IF v_rake > v_parent_rake THEN RETURN jsonb_build_object('success',false,'error','rakeback rate cannot exceed parent rate'); END IF;
    IF v_parent_limit IS NOT NULL AND p_credit_limit > v_parent_limit THEN
      RETURN jsonb_build_object('success',false,'error','credit limit cannot exceed parent agent limit'); END IF;
  END IF;

  INSERT INTO agents (user_id, club_id, membership_id, role, parent_agent_id, commission_rate, player_rakeback_rate, credit_limit, credit_used, is_prepaid)
  VALUES (p_user_id, p_club_id, COALESCE(v_membership_user, p_user_id), p_role, p_parent_agent_id, v_comm, v_rake, p_credit_limit, 0, v_prepaid)
  RETURNING id INTO v_new_id;

  -- THE TITLE SURVIVES THE WALLET. Giving an owner an agent wallet must not
  -- write 'agent' over 'owner' in club_members - that is a demotion nobody
  -- asked for, and fn_club_grantable_roles would refuse it anyway (an owner is
  -- never demotable through this door), so the whole create would fail with a
  -- confusing permission error. Only a player being made into an agent has a
  -- club role to change.
  IF NOT v_is_staff AND v_membership_user IS NOT NULL AND v_member_role IS DISTINCT FROM p_role THEN
    v_role_res := public.fn_club_set_member_role(
      p_club_id, p_user_id, p_role, v_caller, v_comm, v_rake, v_prepaid, p_credit_limit);
    IF NOT COALESCE((v_role_res ->> 'success')::boolean, false) THEN
      RAISE EXCEPTION 'agent_role_change_refused' USING ERRCODE='PAG01';
    END IF;
  END IF;

  RETURN jsonb_build_object('success',true,'agent_id',v_new_id,
    'club_role_unchanged', v_is_staff, 'club_role', v_member_role);
EXCEPTION WHEN SQLSTATE 'PAG01' THEN
  -- This block rolls back the agent insert/update and every role-callee write.
  RETURN COALESCE(v_role_res,jsonb_build_object('success',false,'error','role change refused'));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_admin_update_agent(p_agent_id uuid, p_status text DEFAULT NULL::text, p_role text DEFAULT NULL::text, p_credit_limit numeric DEFAULT NULL::numeric, p_commission_rate numeric DEFAULT NULL::numeric, p_player_rakeback_rate numeric DEFAULT NULL::numeric, p_assigned_by uuid DEFAULT NULL::uuid, p_credit_reason text DEFAULT NULL::text, p_is_prepaid boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_club_id uuid; v_user_id uuid; v_parent uuid; v_old_limit numeric; v_parent_limit numeric;
  v_member_role text; v_role_res jsonb;
  v_prepaid_now boolean; v_limit_now numeric; v_used_now numeric;
  v_prepaid_after boolean; v_limit_after numeric;
  v_touches_funding boolean;
BEGIN
  IF p_agent_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'agent id required'); END IF;
  IF v_caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'authentication required'); END IF;
  SELECT club_id, user_id, parent_agent_id, credit_limit INTO v_club_id, v_user_id, v_parent, v_old_limit
  FROM agents WHERE id = p_agent_id;
  IF v_club_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'agent not found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||v_club_id::text,0));
  SELECT user_id,parent_agent_id,credit_limit INTO v_user_id,v_parent,v_old_limit FROM public.agents WHERE id=p_agent_id AND club_id=v_club_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','agent scope changed');END IF;
  IF NOT EXISTS (
    SELECT 1 FROM clubs c WHERE c.id = v_club_id AND (
      c.owner_id = v_caller
      OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = v_club_id AND cm.user_id = v_caller
                 AND cm.role IN ('owner','co_owner','admin') AND cm.status IN ('active','approved')))
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to manage this club''s agents');
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('active','suspended','frozen') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid status'); END IF;
  IF p_role IS NOT NULL AND p_role NOT IN ('super_agent','agent','sub_agent') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid role'); END IF;
  IF p_credit_limit IS NOT NULL AND (p_credit_limit::text IN ('NaN','Infinity','-Infinity') OR p_credit_limit < 0 OR p_credit_limit <> round(p_credit_limit,2)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'credit_limit must be finite, nonnegative and in whole chip cents'); END IF;
  -- The table CHECK is 0..0.70 and 0..0.50. Validating against 0..100 let a
  -- caller who meant "25%" past this line and into a raw 23514 from Postgres.
  IF p_commission_rate IS NOT NULL AND (p_commission_rate < 0 OR p_commission_rate > 0.70) THEN
    RETURN jsonb_build_object('success', false, 'error', 'commission_rate must be between 0 and 0.70'); END IF;
  IF p_player_rakeback_rate IS NOT NULL AND (p_player_rakeback_rate < 0 OR p_player_rakeback_rate > 0.50) THEN
    RETURN jsonb_build_object('success', false, 'error', 'player_rakeback_rate must be between 0 and 0.50'); END IF;

  -- ---------------------------------------------------------------------------
  -- THE FUNDING PAIR
  -- ---------------------------------------------------------------------------
  SELECT COALESCE(is_prepaid, false), COALESCE(credit_limit, 0), COALESCE(credit_used, 0)
    INTO v_prepaid_now, v_limit_now, v_used_now
    FROM agents WHERE id = p_agent_id;

  v_touches_funding := (p_is_prepaid IS NOT NULL OR p_credit_limit IS NOT NULL);
  v_prepaid_after   := COALESCE(p_is_prepaid, v_prepaid_now);
  v_limit_after     := COALESCE(p_credit_limit, v_limit_now);

  IF v_touches_funding THEN
    -- Granting a line IS the choice of credit. Refusing here instead would
    -- dead-end every "raise this agent's limit" call against a prepaid agent,
    -- and no screen moves them to credit first.
    IF p_is_prepaid IS NULL AND COALESCE(p_credit_limit, 0) > 0 THEN
      v_prepaid_after := false;
    END IF;

    -- And moving somebody TO prepaid closes the line, for the same reason in
    -- reverse: prepaid and a line cannot both be true.
    IF COALESCE(p_is_prepaid, false) AND p_credit_limit IS NULL THEN
      v_limit_after := 0;
    END IF;

    -- Saying both, and contradicting yourself, is still a mistake worth naming.
    IF v_prepaid_after AND COALESCE(v_limit_after, 0) <> 0 THEN
      RETURN jsonb_build_object('success', false,
        'error', 'a prepaid agent carries no credit line. Send prepaid on its own, or a credit limit on its own.');
    END IF;

    -- The pair that can send nothing at all.
    IF NOT v_prepaid_after AND COALESCE(v_limit_after, 0) <= 0 THEN
      RETURN jsonb_build_object('success', false, 'needs_funding', true,
        'error', 'an agent on credit needs a limit greater than 0. Set them prepaid instead, or give a limit.');
    END IF;

    -- A debt outlives the line it was drawn against, so the line cannot simply
    -- be taken away while it is still owed.
    IF v_prepaid_after AND v_used_now > 0 THEN
      RETURN jsonb_build_object('success', false,
        'error', 'this agent still owes ' || trim(to_char(v_used_now, 'FM999,999,999,990.00'))
                 || ' chips on their credit line. Settle the invoice before moving them to prepaid.',
        'credit_used', v_used_now);
    END IF;

    -- Lowering a limit below what has already been drawn violates check_credit
    -- and used to reach the client as a raw 23514 with no explanation.
    IF NOT v_prepaid_after AND v_limit_after < v_used_now THEN
      RETURN jsonb_build_object('success', false,
        'error', 'that limit is below the ' || trim(to_char(v_used_now, 'FM999,999,999,990.00'))
                 || ' chips already drawn. Take a payment first, or set a limit of at least that much.',
        'credit_used', v_used_now, 'requested_limit', v_limit_after);
    END IF;
  END IF;

  IF v_touches_funding AND v_parent IS NOT NULL THEN
    SELECT credit_limit INTO v_parent_limit FROM agents WHERE id = v_parent AND club_id=v_club_id;
    IF v_parent_limit IS NOT NULL AND v_limit_after > v_parent_limit THEN
      RETURN jsonb_build_object('success', false, 'error', 'credit limit cannot exceed parent agent limit');
    END IF;
  END IF;

  SELECT role INTO v_member_role FROM club_members
   WHERE club_id = v_club_id AND user_id = v_user_id;

  -- Dan, B-02, 2026-08-31: OWNERS KEEP EARNING. This list used to include
  -- 'owner', which no rule anywhere else does: trg_agents_staff_earn_no_rakeback
  -- covers co_owner and admin only, and one live owner already holds an active
  -- agents row at 0.30 / 0.20 that this branch would have refused to edit.
  IF v_member_role IN ('co_owner','admin')
     AND (COALESCE(p_commission_rate, 0) <> 0 OR COALESCE(p_player_rakeback_rate, 0) <> 0)
     AND p_role IS NULL THEN
    RETURN jsonb_build_object('success', false,
      'error', 'this member is club staff and earns no rakeback. Change their role first.');
  END IF;

  -- The role change goes through the one door, so the grant matrix, the
  -- downline guard, the funding choice and the audit row apply here too. The
  -- RESOLVED funding pair is forwarded, not the raw arguments: the callee
  -- applies the same prepaid-or-a-line rule, and sending it a bare NULL where
  -- this call has already decided would make the two disagree.
  IF p_role IS NOT NULL AND v_member_role IS NOT NULL AND v_member_role <> p_role THEN
    v_role_res := public.fn_club_set_member_role(
      v_club_id, v_user_id, p_role, v_caller,
      p_commission_rate, p_player_rakeback_rate,
      CASE WHEN v_touches_funding THEN v_prepaid_after ELSE NULL END,
      CASE WHEN v_touches_funding THEN v_limit_after   ELSE NULL END);
    IF NOT COALESCE((v_role_res ->> 'success')::boolean, false) THEN
      RAISE EXCEPTION 'agent_role_change_refused' USING ERRCODE='PAG01';
    END IF;
  END IF;

  UPDATE agents SET
    status = COALESCE(p_status, status),
    role = COALESCE(p_role, role),
    credit_limit = CASE WHEN v_touches_funding THEN v_limit_after ELSE credit_limit END,
    commission_rate = COALESCE(p_commission_rate, commission_rate),
    player_rakeback_rate = COALESCE(p_player_rakeback_rate, player_rakeback_rate),
    is_prepaid = CASE WHEN v_touches_funding THEN v_prepaid_after ELSE is_prepaid END,
    updated_at = now()
  WHERE id = p_agent_id;

  IF v_touches_funding AND v_limit_after <> COALESCE(v_old_limit, -1) THEN
    INSERT INTO credit_assignments (agent_id, assigned_by, old_limit, new_limit, reason)
    VALUES (p_agent_id, v_caller, v_old_limit, v_limit_after, p_credit_reason);
  END IF;

  RETURN jsonb_build_object('success', true, 'agent_id', p_agent_id, 'club_id', v_club_id,
    'is_prepaid', CASE WHEN v_touches_funding THEN v_prepaid_after ELSE v_prepaid_now END,
    'credit_limit', CASE WHEN v_touches_funding THEN v_limit_after ELSE v_limit_now END);
EXCEPTION WHEN SQLSTATE 'PAG01' THEN
  -- This block rolls back the agent insert/update and every role-callee write.
  RETURN COALESCE(v_role_res,jsonb_build_object('success',false,'error','role change refused'));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_agent_downline_commission(p_club_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_id',  d.id,
           'user_id',   d.user_id,
           'club_id',   d.club_id,
           'unclaimed', COALESCE(t.unclaimed, 0))), '[]'::jsonb)
    INTO v_result
    FROM public.agents me
    JOIN public.agents d ON d.parent_agent_id = me.id AND d.club_id=me.club_id
    LEFT JOIN LATERAL (
           SELECT SUM(ac.amount) AS unclaimed
             FROM public.agent_commissions ac
            WHERE ac.club_id = d.club_id
              AND ac.user_id = d.user_id
              AND ac.settled_at IS NULL AND NOT public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at)
         ) t ON TRUE
   WHERE me.user_id = v_uid
     AND (p_club_id IS NULL OR me.club_id = p_club_id);

  RETURN v_result;
END;
$function$;

-- Component 20260914152500_unresolved_cash_sources_prevent_weekly_close.sql
-- Candidate only: unresolved cash sources prevent weekly close before payer work.

SET LOCAL lock_timeout='3s';
DO $guard$
BEGIN
 IF (SELECT md5(pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure)))
  IS DISTINCT FROM 'eb7124bc10101dafa7f85c52c7bfd796' THEN
  RAISE EXCEPTION 'accounting_preparation_preimage_changed';
 END IF;
 IF (SELECT md5(pg_get_functiondef('public.fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure)))
  IS DISTINCT FROM 'ac7d777693e79eca6a13084b51cd1305' THEN
  RAISE EXCEPTION 'cash_source_refusal_checker_preimage_changed';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_prepare_accounting_week(p_union_id uuid,p_club_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE clubs uuid[];club uuid;result jsonb;problems jsonb:='[]';from_date date;to_date date;ready boolean;verified boolean;source_check jsonb;
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
 -- The source queue is part of this book. Check it under the same week lock,
 -- before discovery, payer locks, calculations, or any financial stage.
 source_check:=public.fn_cash_source_refusals_for_period(p_union_id,p_club_id,p_from,p_to);
 IF source_check->>'status' IS DISTINCT FROM 'ready'
  OR source_check->'count' IS DISTINCT FROM '0'::jsonb
  OR source_check->'sources' IS DISTINCT FROM '[]'::jsonb THEN
  RETURN jsonb_build_object('success',false,'accounting_version',3,
   'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',0,
   'problems',jsonb_build_array(jsonb_build_object('reason','cash_source_refusals_pending',
    'source_check',source_check)));
 END IF;
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
UPDATE public.ca_money_rpc_registry
 SET notes='Private single-coordinator preparation requires zero unresolved cash source receipts before any discovery, payer lock or weekly calculation. Complete durable period certificates remain mandatory.'
 WHERE proname='fn_prepare_accounting_week';

COMMIT;
