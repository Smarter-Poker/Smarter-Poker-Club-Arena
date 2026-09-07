-- Complete the original union settlement only after invoices and financial
-- stages succeed. Preserve prior round records with the latest retry outcome.
-- Missing figures cannot pass a conservation assertion; finalized Round 1
-- replay totals are loaded from its exact immutable settlement identity.
BEGIN;
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
  -- Idempotent Round 1 replies omit totals. Recover its immutable finalized
  -- settlement record for this exact union/period before asserting arithmetic.
  IF (v_rake IS NULL OR v_paid IS NULL OR v_retained IS NULL)
     AND p_r1->>'error'='already_executed' THEN
    SELECT c.totals INTO v_totals FROM public.ca_settlements c
    WHERE c.settlement_type='union_rakeback_close' AND c.union_id=p_union_id AND c.state='final'
      AND c.external_ref=p_union_id::text || ':'
        || to_char(p_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
        || to_char(p_to at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
    v_rake := (v_totals->>'period_rake')::numeric;
    v_paid := (v_totals->>'payout_total')::numeric;
    v_retained := (v_totals->>'retained')::numeric;
  END IF;
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
       WHERE w.union_id = p_union_id AND (w.chip_balance < 0 OR w.chip_balance IS NULL)
      UNION ALL
      SELECT 'union rake wallet', w.rake_wallet
        FROM union_wallets w
       WHERE w.union_id = p_union_id AND (w.rake_wallet < 0 OR w.rake_wallet IS NULL)
      UNION ALL
      SELECT 'club treasury ' || c.name, c.chip_treasury
        FROM clubs c
        JOIN union_clubs uc ON uc.club_id = c.id
       WHERE uc.union_id = p_union_id AND (c.chip_treasury < 0 OR c.chip_treasury IS NULL)
      UNION ALL
      SELECT 'member wallet ' || cm.user_id::text, cm.chip_balance
        FROM club_members cm
        JOIN union_clubs uc ON uc.club_id = cm.club_id
       WHERE uc.union_id = p_union_id AND (cm.chip_balance < 0 OR cm.chip_balance IS NULL)
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
    RETURN jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'before_settlement_floor',
      'period_start', v_from, 'period_end', v_to,
      'settlement_floor', v_floor,
      'note', 'This period is below the union settlement floor and must not be '
              || 'settled. No round was run.');
  END IF;

  -- ROUND 1 - union rake treasury pays the clubs their 90%.
  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payers, payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 1, 'union_to_clubs', 1,
          COALESCE((v_r1->>'clubs_paid')::int,0),
          COALESCE((v_r1->>'total_rakeback')::numeric,0), v_r1)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  IF COALESCE((v_r1->>'success')::boolean, false) IS NOT TRUE
     AND COALESCE(v_r1->>'error','') <> 'already_executed' THEN
    RETURN jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round1_failed: ' || COALESCE(v_r1->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1,
      'note', 'Rounds 2, 3 and 4 were not run. A club is not asked to pay its '
              || 'agents out of a treasury the union has not funded.');
  END IF;

  -- ROUND 2 - clubs pay their super agents and agents.
  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
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
     OR (v_r2 ? 'success' AND COALESCE((v_r2->>'success')::boolean, true) IS FALSE
         AND COALESCE(v_r2->>'error','') <> 'already_executed') THEN
    RETURN jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round2_contract_violated_or_failed: ' || COALESCE(v_r2->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'note', 'Rounds 3 and 4 were not run.');
  END IF;

  -- ROUND 3 - agents pay their players.
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 3, 'agents_to_players',
          COALESCE((v_r3->>'payees')::int,0), COALESCE((v_r3->>'amount')::numeric,0),
          COALESCE((v_r3->>'shortfalls')::int,0), v_r3)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=union_settlement_rounds.detail || jsonb_build_object('latest_attempt',EXCLUDED.detail);

  -- Same contract assertion for round 3.
  IF (v_r3->>'amount') IS NULL OR (v_r3->>'payees') IS NULL
     OR (v_r3 ? 'success' AND COALESCE((v_r3->>'success')::boolean, true) IS FALSE
         AND COALESCE(v_r3->>'error','') <> 'already_executed') THEN
    RETURN jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round3_contract_violated_or_failed: ' || COALESCE(v_r3->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3,
      'note', 'Round 4 was not run; no statement is issued for a settlement '
              || 'that did not complete.');
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

  IF public.fn_union_setting(p_union_id, 'weekly_invoices_enabled', 1) <> 1 THEN
    v_inv := jsonb_build_object(
      'success', true, 'skipped', true, 'invoices', 0,
      'reason', 'weekly_invoices_disabled: invoice rake basis '
                || '(fn_union_rake_paid_readonly, first-joined club) disagrees with the '
                || 'basis round 1 pays on (ca_union_rake_attribution, seat played). '
                || 'Money moved; statement held pending reconciliation.');
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
CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_to    timestamptz := public.fn_union_week_start(now());
  v_from  timestamptz := public.fn_union_prev_week_start(now());
  v_total int;
  v_done  int;
  v_eligible int;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'platform_frozen', 'period_start', v_from, 'period_end', v_to);
  END IF;

  IF EXTRACT(minute FROM now()) >= 45 THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'too_close_to_maintenance_break', 'period_start', v_from, 'period_end', v_to);
  END IF;

  IF v_to < now() - interval '3 days' THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'period_closed_more_than_three_days_ago',
      'period_start', v_from, 'period_end', v_to, 'now', now());
  END IF;

  -- THE FLOOR. A period below every union's floor is not "due" at all.
  SELECT count(*) INTO v_eligible
    FROM unions u
    LEFT JOIN union_settlement_floor f ON f.union_id = u.id
   WHERE f.earliest_period_start IS NULL OR v_from >= f.earliest_period_start;

  IF v_eligible = 0 THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'before_settlement_floor',
      'period_start', v_from, 'period_end', v_to,
      'note', 'Every union floors this period. Nothing was run.');
  END IF;

  -- Count completion for each eligible union, not the presence of Round 1.
  v_total := v_eligible;
  SELECT count(*) INTO v_done FROM public.unions u
  LEFT JOIN public.union_settlement_floor f ON f.union_id=u.id
  WHERE (f.earliest_period_start IS NULL OR v_from>=f.earliest_period_start)
    AND EXISTS (SELECT 1 FROM public.union_settlement_rounds r
      WHERE r.union_id=u.id AND r.period_start=v_from AND r.period_end=v_to AND r.round_no=4
        AND r.detail->>'success'='true' AND COALESCE(r.detail->>'skipped','false')<>'true')
    AND NOT EXISTS (SELECT 1 FROM generate_series(2,3) n
      WHERE NOT EXISTS (SELECT 1 FROM public.union_settlement_rounds r
        WHERE r.union_id=u.id AND r.period_start=v_from AND r.period_end=v_to AND r.round_no=n
          AND COALESCE(r.detail->'latest_attempt',r.detail)->>'amount' IS NOT NULL
          AND COALESCE(r.detail->'latest_attempt',r.detail)->>'payees' IS NOT NULL
          AND COALESCE((COALESCE(r.detail->'latest_attempt',r.detail)->>'shortfalls')::int,0)=0
          AND COALESCE(COALESCE(r.detail->'latest_attempt',r.detail)->>'success','true')<>'false'));

  IF v_total > 0 AND v_done >= v_total THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'already_settled', 'period_start', v_from, 'period_end', v_to);
  END IF;

  RETURN public.fn_union_settlement_cascade_all(v_from, v_to);
END $function$;
REVOKE ALL ON FUNCTION public.fn_union_settlement_conservation_assert(uuid,timestamptz,timestamptz,jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_settlement_conservation_assert(uuid,timestamptz,timestamptz,jsonb,jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_settlement_cascade_due() TO service_role;
COMMIT;
