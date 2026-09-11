-- DORMANT coactivation candidate. Requires all legacy source exclusions and
-- the actual captured source, bank, release, agent and player owners together.
-- No production activation is authorized by this archive.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
DO $preflight$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure)
    IS DISTINCT FROM '94de0d3c6af7fb39459b286089f4cf7d' THEN
  RAISE EXCEPTION 'Installed Union outer drift; re-review exact owner';
 END IF;
 IF to_regprocedure('public.fn_ca_dispatch_union_captured_funding(uuid,timestamptz,date,uuid[])') IS NULL THEN
  RAISE EXCEPTION 'Actual captured source dispatcher is missing';
 END IF;
END $preflight$;

CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid, p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_period_start, public.fn_union_prev_week_start(now()));
  v_to   timestamptz := COALESCE(p_period_end,   public.fn_union_week_start(now()));
  v_r1 jsonb; v_r2 jsonb; v_r3 jsonb; v_eco jsonb; v_inv jsonb;
  v_floor timestamptz;
  v_source jsonb;
  v_clubs uuid[];
  v_sqlstate text; v_msg text; v_detail text; v_context text;

BEGIN
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_union_overseer(p_union_id, auth.uid()))) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  -- Captured releases bind their request to the actual authenticated actor.
  -- Trusted service callers without a subject need a reviewed actor contract.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'captured_union_actor_required' USING ERRCODE='42501';
  END IF;

  -- THE FLOOR, checked before anything moves. Round 1 has always honoured it;
  -- nothing above round 1 did, so three further rounds ran on a floored week.
  SELECT f.earliest_period_start INTO v_floor
    FROM union_settlement_floor f WHERE f.union_id = p_union_id;

  IF v_floor IS NOT NULL AND v_from < v_floor THEN
    RETURN jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'before_settlement_floor',
      'period_start', v_from, 'period_end', v_to,
      'settlement_floor', v_floor,
      'note', 'This period is below the union settlement floor and must not be '
              || 'settled. No round was run.');
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

  -- Acquire one deterministic scope before any legacy or captured money owner.
  -- Original requested/booked clubs and pools include clubs that left the Union.
  v_clubs := public.fn_ca_union_captured_scope_clubs(p_union_id);
  PERFORM public.fn_lock_rakeback_payer_clubs(v_clubs);
  PERFORM public.fn_ca_assert_union_captured_locks(p_union_id,v_clubs);

  -- ROUND 1 - union rake treasury pays the clubs their legacy allocation.
  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);

  IF jsonb_typeof(v_r1) IS DISTINCT FROM 'object'
     OR NOT (COALESCE(v_r1->>'success','') = 'true' OR COALESCE(v_r1->>'error','') = 'already_executed')
     OR (v_r1 ? 'success' AND jsonb_typeof(v_r1->'success') IS DISTINCT FROM 'boolean')
     OR (v_r1->>'success' = 'true' AND (NOT v_r1 ? 'total_rakeback' OR NOT v_r1 ? 'clubs_paid'))
     OR (v_r1 ? 'total_rakeback' AND (
       jsonb_typeof(v_r1->'total_rakeback') IS DISTINCT FROM 'number'
       OR (v_r1->>'total_rakeback')::numeric < 0
       OR v_r1->>'total_rakeback' IN ('NaN','Infinity','-Infinity')))
     OR (v_r1 ? 'clubs_paid' AND (
       jsonb_typeof(v_r1->'clubs_paid') IS DISTINCT FROM 'number'
       OR (v_r1->>'clubs_paid')::numeric < 0
       OR (v_r1->>'clubs_paid')::numeric <> trunc((v_r1->>'clubs_paid')::numeric))) THEN
    RAISE EXCEPTION 'round1_contract_violated_or_failed: %',COALESCE(v_r1->>'error','unknown')
      USING ERRCODE='23514';
  END IF;

  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payers, payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 1, 'union_to_clubs', 1,
          COALESCE((v_r1->>'clubs_paid')::int,0),
          COALESCE((v_r1->>'total_rakeback')::numeric,0), v_r1)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  -- ROUND 2 - clubs pay their super agents and agents.
  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);

  -- Round 2 carries no 'success' key: it raises on error and returns
  -- {round,name,payees,amount,shortfalls,detail} otherwise, so a test for
  -- 'success' would be unreachable. Assert the CONTRACT instead - a round that
  -- stops reporting an amount must stop the cascade, not record 0 and carry on.
  IF (v_r2->>'amount') IS NULL OR (v_r2->>'payees') IS NULL
     OR (v_r2->>'shortfalls') IS NULL
     OR jsonb_typeof(v_r2->'shortfalls') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_r2->'amount') IS DISTINCT FROM 'number'
     OR (v_r2->>'amount')::numeric < 0
     OR v_r2->>'amount' IN ('NaN','Infinity','-Infinity')
     OR jsonb_typeof(v_r2->'payees') IS DISTINCT FROM 'number'
     OR (v_r2->>'payees')::numeric < 0
     OR (v_r2->>'payees')::numeric <> trunc((v_r2->>'payees')::numeric)
     OR (v_r2->>'shortfalls')::numeric < 0
     OR (v_r2->>'shortfalls')::numeric <> trunc((v_r2->>'shortfalls')::numeric)
     OR (v_r2 ? 'success' AND COALESCE((v_r2->>'success')::boolean, true) IS FALSE
         AND COALESCE(v_r2->>'error','') <> 'already_executed') THEN
    RAISE EXCEPTION 'round2_contract_violated_or_failed: %',COALESCE(v_r2->>'error','unknown')
      USING ERRCODE='23514';
  END IF;

  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 2, 'club_to_agents',
          COALESCE((v_r2->>'payees')::int,0), COALESCE((v_r2->>'amount')::numeric,0),
          COALESCE((v_r2->>'shortfalls')::int,0), v_r2)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=union_settlement_rounds.detail || jsonb_build_object('latest_attempt',EXCLUDED.detail);

  -- ROUND 3 - agents pay their players.
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);

  -- Same contract assertion for round 3.
  IF (v_r3->>'amount') IS NULL OR (v_r3->>'payees') IS NULL
     OR (v_r3->>'shortfalls') IS NULL
     OR jsonb_typeof(v_r3->'shortfalls') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_r3->'amount') IS DISTINCT FROM 'number'
     OR (v_r3->>'amount')::numeric < 0
     OR v_r3->>'amount' IN ('NaN','Infinity','-Infinity')
     OR jsonb_typeof(v_r3->'payees') IS DISTINCT FROM 'number'
     OR (v_r3->>'payees')::numeric < 0
     OR (v_r3->>'payees')::numeric <> trunc((v_r3->>'payees')::numeric)
     OR (v_r3->>'shortfalls')::numeric < 0
     OR (v_r3->>'shortfalls')::numeric <> trunc((v_r3->>'shortfalls')::numeric)
     OR (v_r3 ? 'success' AND COALESCE((v_r3->>'success')::boolean, true) IS FALSE
         AND COALESCE(v_r3->>'error','') <> 'already_executed') THEN
    RAISE EXCEPTION 'round3_contract_violated_or_failed: %',COALESCE(v_r3->>'error','unknown')
      USING ERRCODE='23514';
  END IF;

  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 3, 'agents_to_players',
          COALESCE((v_r3->>'payees')::int,0), COALESCE((v_r3->>'amount')::numeric,0),
          COALESCE((v_r3->>'shortfalls')::int,0), v_r3)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=union_settlement_rounds.detail || jsonb_build_object('latest_attempt',EXCLUDED.detail);

  -- Captured funding is separate from the legacy weekly gross/net contract.
  -- The bank cutoff is Pacific; source earning weeks use the UTC Monday date.
  v_source := public.fn_ca_dispatch_union_captured_funding(
    p_union_id,v_to,(v_to AT TIME ZONE 'UTC')::date,v_clubs);

  -- This candidate has no complete producer/bank/legacy/funding witness.
  -- An undeclared response field cannot activate the original finalizer.
  IF v_source ? 'common_finality'
     AND v_source->'common_finality' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'unsupported_common_finality_claim' USING ERRCODE='23514';
  END IF;

  -- Every partial attempt must conserve before returning and committing cash.
  PERFORM public.fn_union_settlement_conservation_assert(
    p_union_id,v_from,v_to,v_r1,v_r2,v_r3);
  PERFORM public.fn_ca_assert_union_captured_locks(p_union_id,v_clubs);

  -- A round can post funded recipients while reporting others still unpaid.
  -- Keep that durable progress, but do not mark the period settled or issue
  -- completion statements until every reported shortfall is zero.
  IF (v_r2->>'shortfalls')::numeric <> 0
     OR (v_r3->>'shortfalls')::numeric <> 0 THEN
    RETURN jsonb_build_object('success',false,'union_id',p_union_id,
      'error','recipient_shortfalls_remaining','period_start',v_from,'period_end',v_to,
      'round1_union_to_clubs',v_r1,'round2_club_to_agents',v_r2,
      'round3_agents_to_players',v_r3,'captured_source',v_source,'source_final',false);
  END IF;

  -- A finite observed payment set cannot close a producer period. Only a
  -- complete producer/bank/legacy/funding witness may permit final status.
  IF COALESCE((v_source->>'common_finality')::boolean,false) IS NOT TRUE THEN
    RETURN jsonb_build_object('success',false,'union_id',p_union_id,
      'error','source_finality_pending','period_start',v_from,'period_end',v_to,
      'round1_union_to_clubs',v_r1,'round2_club_to_agents',v_r2,
      'round3_agents_to_players',v_r3,'captured_source',v_source,'source_final',false);
  END IF;

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
    RETURN jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round4_invoices_failed: ' || COALESCE(v_inv->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
      'round4_invoices', v_inv);
  END IF;

  RETURN jsonb_build_object('success', true, 'union_id', p_union_id,
    'period_start', v_from, 'period_end', v_to,
    'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
    'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
    'round4_invoices', v_inv);
END $function$;
COMMIT;
