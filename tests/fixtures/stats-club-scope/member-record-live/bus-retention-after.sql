DO $$ BEGIN
 IF public.fn_prune_bus_event_log(1) <> 1 THEN RAISE EXCEPTION 'Retention batch bound not enforced'; END IF;
 IF (SELECT count(*) FROM bus_event_log WHERE created_at < now()-interval '7 days') <> 1 THEN RAISE EXCEPTION 'Expected exactly one expired row remaining'; END IF;
 IF public.fn_prune_bus_event_log(50000) <> 1 OR public.fn_prune_bus_event_log(50000) <> 0 THEN RAISE EXCEPTION 'Retention completion/replay failed'; END IF;
 IF (SELECT count(*) FROM bus_event_log) <> 2 OR NOT EXISTS(SELECT 1 FROM bus_event_log WHERE payload='{"keep":true}') OR NOT EXISTS(SELECT 1 FROM bus_event_log WHERE payload='{"unknown_age":true}') THEN RAISE EXCEPTION 'Retention deleted current or unknown-age evidence'; END IF;
 BEGIN PERFORM fn_prune_bus_event_log(0); RAISE EXCEPTION 'Zero accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM fn_prune_bus_event_log(NULL); RAISE EXCEPTION 'NULL accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM fn_prune_bus_event_log(50001); RAISE EXCEPTION 'Unbounded input accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 IF has_function_privilege('anon','public.fn_prune_bus_event_log(integer)','EXECUTE') OR has_function_privilege('authenticated','public.fn_prune_bus_event_log(integer)','EXECUTE') OR has_function_privilege('service_role','public.fn_prune_bus_event_log(integer)','EXECUTE') THEN RAISE EXCEPTION 'Cleanup callable by application roles'; END IF;
 IF (SELECT count(*) FROM cron.job WHERE jobname='bus-event-log-retention-daily' AND schedule='41 6 * * *' AND command LIKE '%statement_timeout%' AND command LIKE '%50000%') <> 1 THEN RAISE EXCEPTION 'Daily bounded cleanup not scheduled'; END IF;
END $$;
\echo BUS_RETENTION PASS: expired only, exact batch cap, current/unknown retained, replay safe, invalid limits refused, application roles denied, daily bounded owner
