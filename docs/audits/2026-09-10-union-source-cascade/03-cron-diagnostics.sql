-- Dormant candidate: retain nonfinal semantics and report possible committed payments accurately.
BEGIN;
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='10s';
DO $gate$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_union_settlement_cascade_all(timestamptz,timestamptz)'::regprocedure)<> 'afc636f5ccfc3ebb964869d529cfa78a' THEN
  RAISE EXCEPTION 'Original cron wrapper changed; review exact source before replacement' USING ERRCODE='23514';
 END IF;
END $gate$;
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
            '. Settlement is not complete for those unions. Payments may already have moved; inspect each Union result and its durable receipts before retry or reconciliation.' ||
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
COMMIT;
