-- Local fixture: exact tracked cron callers and established ACLs.
CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade_all(
  p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union   record;
  v_one     jsonb;
  v_results jsonb := '[]'::jsonb;
  v_unions  int := 0;
  v_failed  int := 0;
  v_retries int := 0;
  v_from    timestamptz := COALESCE(p_period_start, public.fn_union_prev_week_start(now()));
  v_to      timestamptz := COALESCE(p_period_end,   public.fn_union_week_start(now()));
  v_r1 numeric := 0; v_r2 numeric := 0; v_r3 numeric := 0;
  v_attempt  int;
  v_sqlstate text; v_msg text; v_detail text; v_context text;
  v_max_attempts constant int := 3;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR v_union IN SELECT u.id FROM unions u LOOP
    v_attempt := 0;

    <<attempts>>
    LOOP
      v_attempt := v_attempt + 1;
      BEGIN
        v_one := public.fn_union_settlement_cascade(v_union.id, v_from, v_to);
        IF v_attempt > 1 THEN
          v_one := v_one || jsonb_build_object('attempts', v_attempt);
        END IF;
        EXIT attempts;

      EXCEPTION
        WHEN deadlock_detected OR serialization_failure THEN
          GET STACKED DIAGNOSTICS
            v_sqlstate = RETURNED_SQLSTATE,
            v_msg      = MESSAGE_TEXT,
            v_detail   = PG_EXCEPTION_DETAIL,
            v_context  = PG_EXCEPTION_CONTEXT;

          -- Out of attempts, or no longer safe to start another one.
          IF v_attempt >= v_max_attempts
             OR public.fn_platform_frozen()
             OR EXTRACT(minute FROM now()) >= 45 THEN
            v_one := jsonb_build_object(
              'union_id', v_union.id, 'success', false,
              'error', v_msg, 'sqlstate', v_sqlstate, 'retryable', true,
              'attempts', v_attempt,
              'gave_up_because',
                CASE WHEN v_attempt >= v_max_attempts THEN 'attempts_exhausted'
                     WHEN public.fn_platform_frozen() THEN 'platform_frozen'
                     ELSE 'too_close_to_maintenance_break' END,
              'exception_detail', v_detail,
              'exception_context', v_context);
            EXIT attempts;
          END IF;

          v_retries := v_retries + 1;
          PERFORM pg_sleep(CASE v_attempt WHEN 1 THEN 3 ELSE 7 END);

        WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS
            v_sqlstate = RETURNED_SQLSTATE,
            v_msg      = MESSAGE_TEXT,
            v_detail   = PG_EXCEPTION_DETAIL,
            v_context  = PG_EXCEPTION_CONTEXT;
          v_one := jsonb_build_object(
            'union_id', v_union.id, 'success', false,
            'error', v_msg, 'sqlstate', v_sqlstate, 'retryable', false,
            'attempts', v_attempt,
            'exception_detail', v_detail,
            'exception_context', v_context);
          EXIT attempts;
      END;
    END LOOP attempts;

    IF COALESCE((v_one->>'success')::boolean, false) THEN
      v_unions := v_unions + 1;
      v_r1 := v_r1 + COALESCE((v_one->'round1_union_to_clubs'->>'total_rakeback')::numeric, 0);
      v_r2 := v_r2 + COALESCE((v_one->'round2_club_to_agents'->>'amount')::numeric, 0);
      v_r3 := v_r3 + COALESCE((v_one->'round3_agents_to_players'->>'amount')::numeric, 0);
    ELSE
      v_failed := v_failed + 1;
    END IF;
    v_results := v_results || jsonb_build_array(v_one);
  END LOOP;

  IF v_failed > 0 THEN
    INSERT INTO financial_alerts (source, severity, message, context)
    VALUES ('fn_union_settlement_cascade_all', 'critical',
            v_failed || ' of ' || (v_failed + v_unions) ||
            ' unions failed weekly settlement for ' ||
            to_char(v_from, 'YYYY-MM-DD') || ' to ' || to_char(v_to, 'YYYY-MM-DD') ||
            '. No rakeback moved and no invoices issued for those unions.' ||
            CASE WHEN v_retries > 0 THEN ' Retried ' || v_retries || ' time(s).' ELSE '' END,
            jsonb_build_object('period_start', v_from, 'period_end', v_to,
                               'unions_failed', v_failed, 'unions_settled', v_unions,
                               'retries', v_retries,
                               'detail', v_results));
  END IF;

  RETURN jsonb_build_object(
    'success', (v_failed = 0),
    'unions_settled', v_unions,
    'unions_failed', v_failed,
    'retries', v_retries,
    'period_start', v_from,
    'period_end', v_to,
    'round1_union_to_clubs', v_r1,
    'round2_club_to_agents', v_r2,
    'round3_agents_to_players', v_r3,
    'ran_at', now(),
    'detail', v_results
  );
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
          AND (COALESCE(r.detail->'latest_attempt',r.detail)->'shortfalls')='0'::jsonb
          AND COALESCE(COALESCE(r.detail->'latest_attempt',r.detail)->>'success','true')<>'false'));

  IF v_total > 0 AND v_done >= v_total THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'already_settled', 'period_start', v_from, 'period_end', v_to);
  END IF;

  RETURN public.fn_union_settlement_cascade_all(v_from, v_to);
END $function$;

REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade_all(timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_union_settlement_cascade_all(timestamptz,timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade_due() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_union_settlement_cascade_due() TO service_role;
