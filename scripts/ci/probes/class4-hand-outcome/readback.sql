-- Independent empty-state and source readback, outside the primary rollback transaction.
\set ON_ERROR_STOP on
DO $$ BEGIN
 IF current_user<>'postgres' OR current_setting('server_version_num')::integer<>170011
    OR current_database()<>'class4_native_'||replace(current_setting('app.class4_execution_uuid'),'-','')
    OR current_setting('session_replication_role')<>'origin'
    OR NOT has_parameter_privilege('postgres','session_replication_role','SET')
    OR has_parameter_privilege('service_role','session_replication_role','SET')
    OR has_parameter_privilege('authenticated','session_replication_role','SET')
    OR has_parameter_privilege('anon','session_replication_role','SET')
    OR NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indexrelid=to_regclass('public.ca_drift_incidents_alert_uuid_idx')
        AND i.indrelid='public.ca_drift_incidents'::regclass AND i.indisvalid AND i.indisready
        AND pg_get_indexdef(i.indexrelid)=$index$CREATE INDEX ca_drift_incidents_alert_uuid_idx ON public.ca_drift_incidents USING btree ((((metadata ->> 'alert_id'::text))::uuid)) WHERE ((metadata ->> 'alert_id'::text) ~ '^[0-9a-fA-F-]{36}$'::text)$index$
    )
    OR EXISTS(SELECT 1 FROM public.financial_alerts)
    OR EXISTS(SELECT 1 FROM public.hand_atomic_commits)
    OR EXISTS(SELECT 1 FROM public.ca_drift_incidents)
    OR EXISTS(SELECT 1 FROM public.ca_incident_events)
 THEN RAISE EXCEPTION 'Class4 independent empty catalog/endpoint readback failed'; END IF;
END $$;
SELECT jsonb_build_object(
 'server_version_num',current_setting('server_version_num')::integer,
 'resolver_definition_md5',md5(pg_get_functiondef('public.fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure)),
 'bridge_definition_md5',md5(pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure)),
 'raiser_definition_md5',md5(pg_get_functiondef('public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure)),
 'financial_alerts',(SELECT count(*) FROM public.financial_alerts),
 'canonical_hands',(SELECT count(*) FROM public.hand_atomic_commits),
 'mirrors',(SELECT count(*) FROM public.ca_drift_incidents),
 'incident_events',(SELECT count(*) FROM public.ca_incident_events),
 'notifications',(SELECT count(*) FROM public.notifications),
 'push_outbox',(SELECT count(*) FROM public.push_outbox),
 'operational_alert_events',(SELECT count(*) FROM public.operational_alert_events));
