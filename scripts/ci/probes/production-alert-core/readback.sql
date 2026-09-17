-- Separate read-only observer after rollback-scoped qualification.
BEGIN READ ONLY;
SET LOCAL statement_timeout='8s';
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.financial_alerts)
 OR EXISTS(SELECT 1 FROM public.ca_drift_incidents)
 OR EXISTS(SELECT 1 FROM public.ca_incident_events)
 OR EXISTS(SELECT 1 FROM public.ca_incident_recipients)
 OR EXISTS(SELECT 1 FROM public.ca_incident_file_failures)
 OR md5(pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure))<>'3771aeef9008e35c6af3d03f220ebb3b'
 OR md5(pg_get_functiondef('public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure))<>'bd239239efefc237fd69f3217ceab367'
 OR md5(pg_get_functiondef('public.fn_ca_escalate_reconcile_criticals(interval)'::regprocedure))<>'99d0c516efc1617abb175821a92d325e'
 THEN RAISE EXCEPTION 'core qualification did not roll back to exact empty source baseline'; END IF; END $$;
COMMIT;
