BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('fn_union_settlement_cascade_due()'::regprocedure))<>'9b1fde4a61df0416750fdc52593bfcc9'
 OR md5(pg_get_functiondef('fn_union_weekly_rakeback_close_all(uuid)'::regprocedure))<>'47828b78ce64337d2da669c7f5c806a7'
 OR md5(pg_get_functiondef('fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure))<>'025c1935b893c649be3fa98b9bd35e22'
 OR md5(pg_get_functiondef('fn_settle_club_rakeback_batch(uuid,integer,numeric,integer)'::regprocedure))<>'ef13668bc3a7ac6b1f4520f75578d50a' THEN RAISE EXCEPTION 'weekly accounting coordinator source changed since review'; END IF;
END $guard$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_generate_scope_credit_invoices','approved','Private exact-club drawn-credit invoicing, called inside the same weekly transaction. Delegates to the existing debt-locked invoice writer and delivery triggers. No direct wallet writes.'),
 ('fn_process_weekly_accounting','approved','Single weekly coordinator, with optional exact union scope for legacy callers. Runs all union stages under the existing per-period lock and durable result journal. Isolates standalone club batches and credit invoices in one rollback scope, retaining explicit retry state. All callers require trusted server authority.');
CREATE FUNCTION public.fn_generate_scope_credit_invoices(p_club_id uuid,p_from timestamptz,p_to timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE agent record; available numeric; result jsonb; generated int:=0; duplicate int:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from>=p_to OR p_to>now() THEN
  RAISE EXCEPTION 'invalid_credit_scope' USING ERRCODE='22023'; END IF;
 FOR agent IN SELECT a.id,a.credit_used FROM public.agents a WHERE a.club_id=p_club_id AND NOT COALESCE(a.is_prepaid,false) AND a.credit_used>0 ORDER BY a.id FOR UPDATE LOOP
  IF agent.credit_used::text IN('NaN','Infinity','-Infinity') OR agent.credit_used<>round(agent.credit_used,2) THEN
   RAISE EXCEPTION 'invalid_drawn_credit' USING ERRCODE='23514'; END IF;
  SELECT agent.credit_used-COALESCE(sum(amount_remaining),0) INTO available FROM public.credit_invoices
   WHERE agent_id=agent.id AND status IN('pending','partial','overdue','disputed');
  IF available<0 THEN RAISE EXCEPTION 'credit_debt_overinvoiced' USING ERRCODE='23514'; END IF;
  IF available=0 THEN CONTINUE; END IF;
  result:=public.fn_generate_credit_invoice(agent.id,p_from,p_to,available,p_to+interval '2 days');
  IF result->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'credit_invoice_generation_failed' USING DETAIL=result::text; END IF;
  IF result->>'duplicate'='true' THEN duplicate:=duplicate+1; ELSE generated:=generated+1; END IF;
 END LOOP;
 RETURN jsonb_build_object('success',true,'generated',generated,'duplicate',duplicate,'failed',0);
END $function$;
REVOKE ALL ON FUNCTION public.fn_generate_scope_credit_invoices(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_generate_scope_credit_invoices(uuid,timestamptz,timestamptz) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid, p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_credit_club record;
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

  FOR v_credit_club IN SELECT club_id FROM public.union_clubs WHERE union_id=p_union_id AND club_id<>p_union_id ORDER BY club_id LOOP
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
CREATE FUNCTION public.fn_process_weekly_accounting(p_union_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club record; v_pass int; v_batch jsonb; v_credit jsonb; v_started timestamptz; 
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
      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='2' THEN
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

      -- Only this block may move chips. Any refused downstream stage raises
      -- and rolls back the whole union attempt, while the failure record below
      -- survives. Other unions have independent ledgers and transaction scopes.
      BEGIN
        IF EXISTS(SELECT 1 FROM public.rake_records rr LEFT JOIN public.daemon_state ds ON ds.daemon='rakeback_settler'
          WHERE NOT COALESCE(rr.is_tournament,false) AND rr.tournament_id IS NULL AND rr.rake_amount>0
            AND rr.created_at>=v_from AND rr.created_at<v_end
            AND (rr.club_id=v_union.id OR EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.union_id=v_union.id AND uc.club_id=rr.club_id))
            AND (ds.high_water_mark IS NULL OR rr.created_at>ds.high_water_mark OR
              (rr.created_at=ds.high_water_mark AND (ds.high_water_mark_id IS NULL OR rr.id>ds.high_water_mark_id)))) THEN
          RAISE EXCEPTION 'weekly_rake_source_not_fully_accrued';
        END IF;
        IF v_orphans>0 THEN
          RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_rakeback_wrong_club',
            DETAIL=jsonb_build_object('pending_periods',v_orphans,'pending_amount',v_orphan_amount)::text;
        END IF;
        IF v_complete AND v_previous->>'accounting_version'='2' THEN
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

      IF v_result->>'success'='true' THEN v_result:=v_result||jsonb_build_object('accounting_version',2); END IF;
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
        v_started:=clock_timestamp();v_pass:=0;
        LOOP
          v_batch:=public.fn_settle_club_rakeback_batch(v_club.id,40,4.0,2);
          IF v_batch->>'success' IS DISTINCT FROM 'true' OR COALESCE((v_batch->>'errors')::int,0)>0 THEN
            RAISE EXCEPTION 'standalone_weekly_payout_failed' USING DETAIL=v_batch::text; END IF;
          EXIT WHEN COALESCE((v_batch->>'periods_remaining')::int,0)=0;
          v_pass:=v_pass+1;
          IF COALESCE((v_batch->>'periods_settled')::int,0)=0 OR v_pass>=250 OR clock_timestamp()-v_started>interval '30 seconds' THEN
            RAISE EXCEPTION 'standalone_weekly_payout_incomplete' USING DETAIL=v_batch::text; END IF;
        END LOOP;
        v_credit:=public.fn_generate_scope_credit_invoices(v_club.id,v_from,v_to);
        INSERT INTO public.daemon_state(daemon,high_water_mark,updated_at)
         VALUES('weekly_accounting:'||v_club.id::text,v_to,clock_timestamp())
         ON CONFLICT(daemon) DO UPDATE SET high_water_mark=excluded.high_water_mark,updated_at=excluded.updated_at;
        v_result:=jsonb_build_object('success',true,'credit_invoices',v_credit,'accounting_version',2);
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
REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_process_weekly_accounting(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade_due() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 RETURN public.fn_process_weekly_accounting(NULL);
END $function$;
CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close_all(p_union_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 RETURN public.fn_process_weekly_accounting(p_union_id);
END $function$;
REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade_due(),public.fn_union_weekly_rakeback_close_all(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_settlement_cascade_due(),public.fn_union_weekly_rakeback_close_all(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_settle_club_rakeback_batch(p_club_id uuid, p_max_periods integer DEFAULT 40, p_budget_seconds numeric DEFAULT 4.0, p_max_warm_days integer DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_period     record;
  v_day        record;
  v_res        jsonb;
  v_settled    int := 0;
  v_deferred   int := 0;
  v_errors     int := 0;
  v_retries    int := 0;
  v_warmed     int := 0;
  v_total      numeric := 0;
  v_reasons    jsonb := '{}'::jsonb;
  v_reason     text;
  v_remaining  int;
  v_budget     numeric;
  v_elapsed    numeric;
  v_treasury   numeric;
  v_smallest   numeric;
  v_owed       numeric;
  v_attempt    int;
  v_sqlstate   text;
  v_err        text;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_club_id required');
  END IF;

  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL
          OR (NOT public.fn_is_platform_admin()
              AND NOT EXISTS (SELECT 1 FROM public.clubs c
                               WHERE c.id = p_club_id AND c.owner_id = auth.uid()))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorised');
  END IF;

  IF EXISTS(SELECT 1 FROM public.union_clubs WHERE club_id=p_club_id) OR EXISTS(SELECT 1 FROM public.unions WHERE id=p_club_id) THEN
    RETURN jsonb_build_object('success',false,'error','union_requires_weekly_accounting_coordinator','club_id',p_club_id,'periods_settled',0,'total_payout',0);
  END IF;
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
      'periods_settled', 0, 'total_payout', 0, 'deferred', 0, 'errors', 0,
      'note', 'platform_frozen', 'clock_ran_out', false);
  END IF;

  v_budget := GREATEST(COALESCE(p_budget_seconds, 4.0), 0.5);
  IF p_max_periods IS NULL OR p_max_periods < 1 THEN p_max_periods := 40; END IF;

  SELECT count(*), COALESCE(min(NULLIF(COALESCE(rakeback_amount, rakeback_earned, 0), 0)), 0),
         COALESCE(sum(COALESCE(rakeback_amount, rakeback_earned, 0)), 0)
    INTO v_remaining, v_smallest, v_owed
    FROM public.rakeback_periods
   WHERE club_id = p_club_id AND status = 'pending' AND period_end < CURRENT_DATE;

  IF v_remaining = 0 THEN
    RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
      'periods_settled', 0, 'total_payout', 0, 'deferred', 0, 'errors', 0,
      'periods_remaining', 0, 'note', 'nothing due', 'clock_ran_out', false);
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM public.clubs WHERE id = p_club_id;
  IF v_treasury < v_smallest THEN
    UPDATE public.rakeback_periods
       SET deferred_reason = 'insufficient_club_treasury',
           deferred_at = NOW(), defer_count = defer_count + 1
     WHERE club_id = p_club_id AND status = 'pending' AND period_end < CURRENT_DATE
       AND deferred_reason IS DISTINCT FROM 'insufficient_club_treasury';

    RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
      'periods_settled', 0, 'total_payout', 0, 'errors', 0,
      'deferred', v_remaining,
      'deferred_reasons', jsonb_build_object('insufficient_club_treasury', v_remaining),
      'periods_remaining', v_remaining,
      'treasury', round(v_treasury, 2), 'owed', round(v_owed, 2),
      'shortfall', round(v_owed - v_treasury, 2),
      'note', 'club cannot fund its smallest pending payout',
      'elapsed_seconds', round(extract(epoch FROM (clock_timestamp() - v_started))::numeric, 3),
      'clock_ran_out', false);
  END IF;

  FOR v_day IN
    SELECT DISTINCT d::date AS day
      FROM public.rakeback_periods rp
      CROSS JOIN LATERAL generate_series(rp.period_start, rp.period_end, interval '1 day') d
     WHERE rp.club_id = p_club_id
       AND rp.status = 'pending'
       AND rp.period_end < CURRENT_DATE
       AND NOT EXISTS (SELECT 1 FROM public.rakeback_daily_state s
                        WHERE s.club_id = p_club_id AND s.day = d::date)
     ORDER BY 1
     LIMIT GREATEST(COALESCE(p_max_warm_days, 2), 0)
  LOOP
    EXIT WHEN extract(epoch FROM (clock_timestamp() - v_started)) > v_budget * 0.6;
    BEGIN
      PERFORM public.fn_rakeback_recompute_day(p_club_id, v_day.day, false);
      v_warmed := v_warmed + 1;
    EXCEPTION WHEN OTHERS THEN
      -- A day that will not roll up is not a reason to skip paying the
      -- periods that do. The payer falls back to the direct scan.
      v_errors := v_errors + 1;
    END;
  END LOOP;

  FOR v_period IN
    SELECT id FROM public.rakeback_periods
     WHERE club_id = p_club_id AND status = 'pending'
       AND period_end < CURRENT_DATE
     -- Least-refused first. A deferred period stays pending because the
     -- money is still owed, so ordering by age alone lets a permanently
     -- refusing head of queue starve everything behind it.
     ORDER BY defer_count, period_end, id
     LIMIT p_max_periods
  LOOP
    EXIT WHEN extract(epoch FROM (clock_timestamp() - v_started)) > v_budget;

    v_attempt := 0;
    LOOP
      v_attempt := v_attempt + 1;
      BEGIN
        v_res := public.fn_close_settlement_period(v_period.id);
        EXIT;                                   -- closed, or refused cleanly
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
        -- 40P01 deadlock_detected, 55P03 lock_not_available, 40001 serialization
        IF v_sqlstate IN ('40P01','55P03','40001') AND v_attempt < 3 THEN
          v_retries := v_retries + 1;
          PERFORM pg_sleep(0.05 * v_attempt);
          CONTINUE;                              -- the period is untouched; try again
        END IF;
        v_res := jsonb_build_object('success', false,
                   'deferred', 'error_' || v_sqlstate,
                   'detail', left(v_err, 200));
        v_errors := v_errors + 1;
        BEGIN
          UPDATE public.rakeback_periods
             SET deferred_reason = 'error_' || v_sqlstate,
                 deferred_at = NOW(), defer_count = defer_count + 1
           WHERE id = v_period.id;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        EXIT;
      END;
    END LOOP;

    IF COALESCE((v_res->>'success')::boolean, false) THEN
      v_settled := v_settled + 1;
      v_total   := v_total + COALESCE((v_res->>'payout')::numeric, 0);
    ELSE
      v_deferred := v_deferred + 1;
      v_reason   := COALESCE(v_res->>'deferred', v_res->>'error', 'unknown');
      v_reasons  := jsonb_set(v_reasons, ARRAY[v_reason],
                      to_jsonb(COALESCE((v_reasons->>v_reason)::int, 0) + 1), true);
    END IF;
  END LOOP;

  SELECT count(*) INTO v_remaining FROM public.rakeback_periods
   WHERE club_id = p_club_id AND status = 'pending' AND period_end < CURRENT_DATE;

  v_elapsed := round(extract(epoch FROM (clock_timestamp() - v_started))::numeric, 3);

  RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
    'periods_settled', v_settled, 'total_payout', round(v_total, 2),
    'deferred', v_deferred, 'deferred_reasons', v_reasons,
    'errors', v_errors, 'lock_retries', v_retries,
    'days_warmed', v_warmed, 'periods_remaining', v_remaining,
    'treasury', round(v_treasury, 2),
    'elapsed_seconds', v_elapsed,
    'clock_ran_out', v_elapsed > v_budget);
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_deliver_accounting_invoice(uuid),public.fn_invoice_accounting_ledger_transfer(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_deliver_accounting_invoice(uuid),public.fn_invoice_accounting_ledger_transfer(uuid) TO service_role;
COMMIT;
