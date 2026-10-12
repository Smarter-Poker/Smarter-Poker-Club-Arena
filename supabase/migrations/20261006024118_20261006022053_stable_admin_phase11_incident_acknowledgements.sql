BEGIN;
DO $preflight$
BEGIN
  IF to_regclass('public.ca_operator_role_permissions') IS NULL
     OR to_regclass('public.ca_drift_incidents') IS NULL
     OR to_regclass('public.operational_alert_events') IS NULL
     OR to_regclass('public.engine_alerts') IS NULL
     OR to_regclass('public.deploy_alerts') IS NULL
     OR to_regclass('public.financial_alerts') IS NULL THEN
    RAISE EXCEPTION 'stable admin incident acknowledgement prerequisites are missing';
  END IF;
END
$preflight$;
CREATE TABLE public.ca_operator_incident_ack_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table text NOT NULL CHECK (source_table IN ('ca_drift_incidents','operational_alert_events','engine_alerts','deploy_alerts','financial_alerts')),
  source_identity text NOT NULL CHECK (length(source_identity) BETWEEN 1 AND 512),
  action text NOT NULL CHECK (action IN ('acknowledge', 'release')),
  actor_id uuid NOT NULL,
  note text NOT NULL CHECK (length(note) BETWEEN 3 AND 500),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 120),
  operation_id uuid NOT NULL UNIQUE,
  observed_status text,
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE public.ca_operator_incident_ack_events IS 'Append-only operator ownership overlay. Acknowledge/release never resolves or mutates its source incident.';
CREATE INDEX ca_operator_incident_ack_events_source_idx ON public.ca_operator_incident_ack_events (source_table, source_identity, created_at DESC, id DESC);
ALTER TABLE public.ca_operator_incident_ack_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_operator_incident_ack_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_operator_incident_ack_events TO service_role;
CREATE FUNCTION public.fn_ca_operator_incident_ack_events_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN
  RAISE EXCEPTION 'incident acknowledgement events are append-only' USING ERRCODE = '55000';
END
$function$;
CREATE TRIGGER ca_operator_incident_ack_events_no_update_delete BEFORE UPDATE OR DELETE ON public.ca_operator_incident_ack_events FOR EACH ROW EXECUTE FUNCTION public.fn_ca_operator_incident_ack_events_append_only();
CREATE TRIGGER ca_operator_incident_ack_events_no_truncate BEFORE TRUNCATE ON public.ca_operator_incident_ack_events FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_operator_incident_ack_events_append_only();
CREATE VIEW public.ca_operator_incident_ack_current WITH (security_invoker = true) AS
SELECT DISTINCT ON (source_table, source_identity) id,source_table,source_identity,action,actor_id,note,request_id,operation_id,observed_status,observed_at,created_at
FROM public.ca_operator_incident_ack_events ORDER BY source_table, source_identity, created_at DESC, id DESC;
REVOKE ALL ON public.ca_operator_incident_ack_current FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_operator_incident_ack_current TO service_role;
CREATE FUNCTION public.fn_ca_operator_record_incident_ack_event(
  p_source_table text,p_source_identity text,p_action text,p_actor_id uuid,p_note text,p_request_id text,p_operation_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $function$
DECLARE
  v_existing public.ca_operator_incident_ack_events%ROWTYPE;
  v_event public.ca_operator_incident_ack_events%ROWTYPE;
  v_observed_status text;
  v_observed_at timestamptz;
BEGIN
  IF p_source_table IS NULL OR p_source_table NOT IN ('ca_drift_incidents','operational_alert_events','engine_alerts','deploy_alerts','financial_alerts') THEN
    RAISE EXCEPTION 'invalid incident source' USING ERRCODE = '22023';
  END IF;
  IF p_source_identity IS NULL OR length(p_source_identity) NOT BETWEEN 1 AND 512 THEN RAISE EXCEPTION 'invalid incident identity' USING ERRCODE = '22023'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('acknowledge','release') THEN RAISE EXCEPTION 'invalid incident acknowledgement action' USING ERRCODE = '22023'; END IF;
  IF p_actor_id IS NULL OR p_operation_id IS NULL THEN RAISE EXCEPTION 'actor and operation id are required' USING ERRCODE = '22023'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'incident acknowledgement note must be 3 to 500 characters' USING ERRCODE = '22023'; END IF;
  IF p_request_id IS NULL OR length(p_request_id) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'request id is required' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_operation_id::text, 0));
  SELECT * INTO v_existing FROM public.ca_operator_incident_ack_events WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF v_existing.source_table IS DISTINCT FROM p_source_table OR v_existing.source_identity IS DISTINCT FROM p_source_identity OR v_existing.action IS DISTINCT FROM p_action OR v_existing.actor_id IS DISTINCT FROM p_actor_id OR v_existing.note IS DISTINCT FROM btrim(p_note) THEN
      RAISE EXCEPTION 'operation id was already used for a different acknowledgement' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('event',to_jsonb(v_existing),'replayed',true);
  END IF;
  CASE p_source_table
    WHEN 'ca_drift_incidents' THEN SELECT status,last_seen_at INTO v_observed_status,v_observed_at FROM public.ca_drift_incidents WHERE id::text=p_source_identity;
    WHEN 'operational_alert_events' THEN SELECT status,last_received_at INTO v_observed_status,v_observed_at FROM public.operational_alert_events WHERE id::text=p_source_identity;
    WHEN 'engine_alerts' THEN SELECT status,received_at INTO v_observed_status,v_observed_at FROM public.engine_alerts WHERE id::text=p_source_identity;
    WHEN 'deploy_alerts' THEN SELECT 'alert',created_at INTO v_observed_status,v_observed_at FROM public.deploy_alerts WHERE alert_key::text=p_source_identity;
    WHEN 'financial_alerts' THEN SELECT CASE WHEN resolved THEN 'resolved' ELSE 'open' END,created_at INTO v_observed_status,v_observed_at FROM public.financial_alerts WHERE id::text=p_source_identity;
  END CASE;
  IF NOT FOUND THEN RAISE EXCEPTION 'incident source row not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.ca_operator_incident_ack_events(source_table,source_identity,action,actor_id,note,request_id,operation_id,observed_status,observed_at)
  VALUES(p_source_table,p_source_identity,p_action,p_actor_id,btrim(p_note),p_request_id,p_operation_id,v_observed_status,v_observed_at) RETURNING * INTO v_event;
  RETURN jsonb_build_object('event',to_jsonb(v_event),'replayed',false);
END
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_operator_record_incident_ack_event(text,text,text,uuid,text,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_operator_record_incident_ack_event(text,text,text,uuid,text,text,uuid) TO service_role;
INSERT INTO public.ca_operator_role_permissions(role_key,permission)
SELECT role_key,'incidents.ack' FROM (VALUES ('owner'),('god'),('superadmin'),('admin'),('operations'),('compliance')) AS roles(role_key)
ON CONFLICT (role_key,permission) DO NOTHING;
DO $postapply$
BEGIN
  IF to_regclass('public.ca_operator_incident_ack_events') IS NULL OR to_regclass('public.ca_operator_incident_ack_current') IS NULL OR to_regprocedure('public.fn_ca_operator_record_incident_ack_event(text,text,text,uuid,text,text,uuid)') IS NULL THEN RAISE EXCEPTION 'incident acknowledgement contract did not install completely'; END IF;
  IF (SELECT count(*) FROM public.ca_operator_role_permissions WHERE permission='incidents.ack') <> 6 THEN RAISE EXCEPTION 'incidents.ack role seed is incomplete'; END IF;
END
$postapply$;
COMMIT;