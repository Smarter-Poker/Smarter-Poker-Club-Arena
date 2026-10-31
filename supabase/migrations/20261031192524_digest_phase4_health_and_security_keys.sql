DO $migration$
DECLARE
  v_def text := pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure);
  a_h text := E'  ) INTO h;\n';
  a_sec text := E'  ) INTO sec;\n';
  add_h text := E'  ) INTO h;\n'
    || E'  -- PHASE 4 HEALTH KEYS (2026-10-31) -------------------------------------------\n'
    || E'  h := jsonb_set(h, ''{breaks,gate_opened}'', to_jsonb((SELECT count(*) FROM public.ca_break_scorecards\n'
    || E'         WHERE recorded_at >= s AND recorded_at < e AND gate_opened)));\n'
    || E'  h := jsonb_set(h, ''{alerts_new,critical_distinct}'', to_jsonb((SELECT count(DISTINCT alertname) FROM public.operational_alert_events\n'
    || E'         WHERE received_at >= s AND received_at < e AND investigation_status IS DISTINCT FROM ''informational''\n'
    || E'           AND payload->>''snapshot_kind'' IS DISTINCT FROM ''update_new'' AND severity = ''critical'')));\n'
    || E'  h := h || jsonb_build_object(\n'
    || E'    ''engine_restarts_outside_break'', (SELECT count(DISTINCT COALESCE(payload->''alert''->>''startsAt'', event_key))\n'
    || E'         FROM public.operational_alert_events WHERE alertname = ''EngineRestartedOutsideTheBreak'' AND status = ''firing''\n'
    || E'          AND received_at >= s AND received_at < e),\n'
    || E'    ''financial_alerts_open_actionable'', (SELECT count(DISTINCT COALESCE(source || '':'' || (context->>''dedupe_key''), id::text))\n'
    || E'         FROM public.financial_alerts WHERE NOT resolved AND severity IN (''critical'',''warning'')\n'
    || E'          AND source NOT LIKE ''drift_incident:%''),\n'
    || E'    ''tournaments_stuck_running'', (SELECT count(*) FROM public.tournaments t\n'
    || E'         WHERE t.status = ''RUNNING'' AND NOT COALESCE(t.on_break, false)\n'
    || E'           AND COALESCE(t.started_at, t.start_time) < now() - interval ''30 minutes''\n'
    || E'           AND NOT EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.tournament_id = t.id\n'
    || E'                            AND hh.created_at > now() - interval ''30 minutes'')),\n'
    || E'    ''tournaments_past_start_registering'', (SELECT overdue_start FROM public.fn_tournament_metrics()),\n'
    || E'    ''drift_open_manual_needed'', (SELECT count(*) FROM public.ca_drift_incidents WHERE resolved_at IS NULL\n'
    || E'         AND auto_repair_status = ''manual_needed''),\n'
    || E'    ''client_errors_distinct_users'', (SELECT count(DISTINCT user_id) FROM public.client_error_events\n'
    || E'         WHERE received_at >= s AND received_at < e AND user_id IS NOT NULL),\n'
    || E'    ''client_errors_top_share'', (SELECT round(max(n)::numeric / NULLIF(sum(n), 0), 4) FROM (\n'
    || E'         SELECT sum(occurrences) n FROM public.client_error_events WHERE received_at >= s AND received_at < e\n'
    || E'          GROUP BY COALESCE(NULLIF(code,''''), error_name, ''unknown'')) x));\n';
  add_sec text := E'  ) INTO sec;\n'
    || E'  sec := sec || jsonb_build_object(\n'
    || E'    ''recovery_probe_failures'', (SELECT count(*) FROM public.probe_heartbeats WHERE occurred_at >= s AND occurred_at < e\n'
    || E'         AND status = ''failed'' AND probe_name = ''recovery-probe''),\n'
    || E'    ''signup_probe_failures'', (SELECT count(*) FROM public.probe_heartbeats WHERE occurred_at >= s AND occurred_at < e\n'
    || E'         AND status = ''failed'' AND probe_name = ''signup-probe''),\n'
    || E'    ''trigger_audit_failures'', (SELECT count(*) FROM public.probe_heartbeats WHERE occurred_at >= s AND occurred_at < e\n'
    || E'         AND status = ''failed'' AND probe_name = ''trigger-audit''));\n';
BEGIN
  IF position('PHASE 4 HEALTH KEYS' IN v_def) > 0 THEN
    RAISE NOTICE 'already applied';
    RETURN;
  END IF;
  IF (length(v_def) - length(replace(v_def, a_h, ''))) / length(a_h) <> 1
     OR (length(v_def) - length(replace(v_def, a_sec, ''))) / length(a_sec) <> 1 THEN
    RAISE EXCEPTION 'fn_sp_daily_metrics_compute anchors not found exactly once';
  END IF;
  EXECUTE replace(replace(v_def, a_h, add_h), a_sec, add_sec);
END
$migration$;

ALTER FUNCTION public.fn_operational_alert_severity_rank(text) SET search_path TO 'pg_catalog';