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
  v_pending jsonb; v_posted record;
  -- CHUNKED CLOSE (20261003): set by job 272's tick; see
  -- fn_process_weekly_accounting_scope. Off, this function is unchanged.
  v_chunked boolean := COALESCE(current_setting('app.weekly_accounting_chunked', true), '') = 'on';

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

  IF v_from IS NULL OR NOT isfinite(v_from) OR v_from<>public.fn_union_week_start(v_from)
   OR v_to IS DISTINCT FROM public.fn_union_week_start(v_from+interval '8 days') THEN
   RAISE EXCEPTION 'accounting_preparation_requires_closed_week' USING ERRCODE='22023';
  END IF;
  PERFORM public.fn_union_pnl_closed_book_barrier(v_to);
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

  -- THE UNION WALLET IS DEBITED LAST (20260929): round 1 leaves its rake
  -- wallet debit pending for this exact book; it is posted below, after the
  -- statements, so live hands are never queued behind the close.
  -- CHUNKED CLOSE (20261003): a round that commits in its own transaction
  -- posts its own union wallet debit (round 1's original undeferred path):
  -- a pending debit is a transaction-local setting and cannot outlive it.
  PERFORM set_config('app.union_close_defer_rake_debit', CASE WHEN v_chunked THEN '' ELSE p_union_id::text || ':'
    || to_char(v_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(v_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END, true);
  PERFORM set_config('app.union_close_pending_rake_debit', '', true);

  -- ROUND 1 - union rake treasury pays the clubs their 90%.
  PERFORM public.fn_assert_cash_commission_period(p_union_id,NULL,v_from,v_to);
  v_preparation:=public.fn_prepare_accounting_week(p_union_id,NULL,v_from,v_to);
  IF v_preparation->>'success' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;
  END IF;
  PERFORM public.fn_weekly_accounting_deadline_check();
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

  -- CHUNKED CLOSE (20261003): a round that moved money ends this attempt
  -- here; it commits with its receipts (union_rakeback_log, the final
  -- ca_settlements row, union_settlement_rounds round 1) and the next attempt
  -- skips it by them ('already_executed'). Nothing after this point - no
  -- period is marked settled, no statement or square-up is issued - until
  -- the attempt that finds every round committed.
  IF v_chunked AND v_r1->>'success' = 'true' THEN
    RETURN jsonb_build_object('success', false, 'chunk_committed', true, 'committed_round', 1,
      'union_id', p_union_id, 'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1);
  END IF;

  -- ROUND 2 - clubs pay their super agents and agents.
  PERFORM public.fn_weekly_accounting_deadline_check();
  -- CHUNKED CLOSE (20261003): a round 2 an earlier attempt committed is
  -- answered from its own receipt - exactly what the stage returns for it
  -- as a duplicate - instead of reading the whole week again to prove it.
  -- Every attempt has first re-run the book's barrier, accrual, refusal and
  -- preparation checks, under which no source of this closed week can change.
  IF v_chunked THEN
    SELECT r.result||jsonb_build_object('duplicate',true) INTO v_r2 FROM public.accounting_routed_settlement_runs r
     WHERE r.scope_kind='union' AND r.scope_id=p_union_id AND r.period_start=v_from AND r.period_end=v_to AND r.round_no=2;
  END IF;
  IF v_r2 IS NULL THEN
  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
  END IF;
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

  -- CHUNKED CLOSE (20261003): round 2 commits on its own only with no
  -- shortfall, exactly what the unchunked close would have kept; the next
  -- attempt finds its receipt (accounting_routed_settlement_runs round 2)
  -- and the stage returns it as a duplicate.
  IF v_chunked AND v_r2->>'duplicate' IS DISTINCT FROM 'true' THEN
    IF (v_r2->>'shortfalls')::numeric <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success',false,'union_id',p_union_id,
        'error','recipient_shortfalls_remaining','period_start',v_from,'period_end',v_to,
        'round1_union_to_clubs',v_r1,'round2_club_to_agents',v_r2))::text;
    END IF;
    RETURN jsonb_build_object('success', false, 'chunk_committed', true, 'committed_round', 2,
      'union_id', p_union_id, 'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2);
  END IF;

  -- ROUND 3 - agents pay their players.
  PERFORM public.fn_weekly_accounting_deadline_check();
  -- CHUNKED CLOSE (20261003): the same for a committed round 3.
  IF v_chunked THEN
    SELECT r.result||jsonb_build_object('duplicate',true) INTO v_r3 FROM public.accounting_routed_settlement_runs r
     WHERE r.scope_kind='union' AND r.scope_id=p_union_id AND r.period_start=v_from AND r.period_end=v_to AND r.round_no=3;
  END IF;
  IF v_r3 IS NULL THEN
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
  END IF;
  -- CHUNKED CLOSE (20261003, round 3 in batches): a batch that paid part of
  -- round 3 ends this attempt as a committed step; the next attempt pays on.
  IF v_chunked AND v_r3->>'batch_committed' = 'true' THEN
    RETURN jsonb_build_object('success', false, 'chunk_committed', true, 'committed_round', 3, 'stage', 'round3_batch',
      'union_id', p_union_id, 'period_start', v_from, 'period_end', v_to, 'round3_batch', v_r3);
  END IF;
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

  -- CHUNKED CLOSE (20261003): round 3 commits on its own only after every
  -- test the unchunked close applies to it - no shortfall, no pending player
  -- period, conservation asserted - and the attempt that finds all three
  -- rounds committed repeats those tests before it settles the period.
  IF v_chunked AND v_r3->>'duplicate' IS DISTINCT FROM 'true' THEN
    RETURN jsonb_build_object('success', false, 'chunk_committed', true, 'committed_round', 3,
      'union_id', p_union_id, 'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3);
  END IF;

  -- The period is an accounting object, not a by-product of invoicing.
  PERFORM public.fn_mark_scope_accounting_settled('union',p_union_id,v_from,v_to);

  IF public.fn_union_pnl_qualified_clubs(p_union_id,v_from,v_to)#>>'{eco_commercial_terms_evidence,segments,0,terms,eco_enabled}'='true' THEN
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

  PERFORM public.fn_weekly_accounting_deadline_check();
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

  PERFORM public.fn_weekly_accounting_deadline_check();
  FOR v_credit_club IN SELECT club_id FROM public.fn_accounting_week_clubs(p_union_id,NULL,v_from,v_to) ORDER BY club_id LOOP
    PERFORM public.fn_generate_scope_credit_invoices(v_credit_club.club_id,v_from,v_to);
  END LOOP;
  v_previous_validated:=current_setting('app.union_accounting_validated_period',true);
  PERFORM set_config('app.union_accounting_validated_period',p_union_id::text||':'||v_from::text||':'||v_to::text,true);
  v_club_statements:=public.fn_issue_club_weekly_accounting(p_union_id,v_from,v_to);
  PERFORM public.fn_weekly_accounting_deadline_check();
  PERFORM set_config('app.union_accounting_validated_period',COALESCE(v_previous_validated,''),true);
  v_pending := NULLIF(current_setting('app.union_close_pending_rake_debit', true), '')::jsonb;
  PERFORM set_config('app.union_close_defer_rake_debit', '', true);
  PERFORM set_config('app.union_close_pending_rake_debit', '', true);
  IF v_r1->>'success' = 'true' AND COALESCE((v_r1->>'period_rake')::numeric, 0) > 0 AND (v_pending IS NULL OR v_pending->>'settlement_id' IS DISTINCT FROM v_r1->>'settlement_id') THEN
    RAISE EXCEPTION 'union_close_rake_debit_not_pending' USING ERRCODE='55000';
  END IF;
  IF v_pending IS NOT NULL THEN
    IF v_r1->>'success' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'union_close_rake_debit_without_round1' USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_posted FROM public.fn_union_close_post_rake_debit(v_pending);
    v_r1 := v_r1 || jsonb_build_object('rake_wallet_after', v_posted.rw_after, 'chip_balance_after', v_posted.cb_after,
      'rake_debit_posted', 'last_write_of_cascade');
  END IF;
  RETURN jsonb_build_object('success', true, 'union_id', p_union_id, 'club_weekly_statements',v_club_statements,
    'period_start', v_from, 'period_end', v_to,
    'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
    'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
    'round4_invoices', v_inv);
END $function$
