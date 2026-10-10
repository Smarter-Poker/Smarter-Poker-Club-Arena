-- The Production Alerts store as production runs it: public.operational_alert_events,
-- fn_record_operational_alert() and the batch writer fn_record_operational_alerts(),
-- copied byte for byte from the repository that owns them
-- (Smarter-Poker-World-Hub supabase/migrations/20260913164000_operational_alert_inbox.sql,
-- main c9c2dffb5, 2026-09-28). The harness installs it before 20260927143752, because
-- 20260928032225 adds a constraint to this table. The two md5 assertions at the end are
-- production's (read-only, 2026-09-28T15:31Z), so the regression runs the real writer's
-- ON CONFLICT behaviour and the real column constraints, not a stand-in.
-- Operational faults belong to a durable service-only inbox, never a handset.
-- Delivery acknowledgement means the transaction committed. Replays preserve
-- investigation state, and a resolved signal never claims a root cause fixed.
CREATE TABLE public.operational_alert_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 120),
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 512),
  alertname text NOT NULL CHECK (length(alertname) BETWEEN 1 AND 240),
  status text NOT NULL CHECK (status IN ('firing', 'resolved', 'info')),
  severity text NOT NULL CHECK (length(severity) BETWEEN 1 AND 40),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 262144),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivery_count bigint NOT NULL DEFAULT 1,
  investigation_status text NOT NULL DEFAULT 'new'
    CHECK (investigation_status IN ('new', 'investigating', 'blocked', 'verified_fixed', 'historical', 'test')),
  investigation jsonb NOT NULL DEFAULT '{}',
  UNIQUE (source, event_key)
);
CREATE INDEX operational_alert_pending_idx ON public.operational_alert_events (investigation_status, id);
ALTER TABLE public.operational_alert_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operational_alert_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.operational_alert_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.operational_alert_events_id_seq TO service_role;

CREATE FUNCTION public.fn_record_operational_alert(
  p_source text, p_event_key text, p_alertname text, p_status text,
  p_severity text, p_payload jsonb
) RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO public.operational_alert_events(source,event_key,alertname,status,severity,payload)
  VALUES(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload)
  ON CONFLICT (source,event_key) DO UPDATE
  SET last_received_at=clock_timestamp(), delivery_count=operational_alert_events.delivery_count+1
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
CREATE FUNCTION public.fn_record_operational_alerts(p_events jsonb)
RETURNS bigint[] LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE v_event jsonb; v_ids bigint[] := '{}';
BEGIN
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'expected 1 to 200 alert events';
  END IF;
  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    v_ids := array_append(v_ids, public.fn_record_operational_alert(
      v_event->>'source',v_event->>'event_key',v_event->>'alertname',
      v_event->>'status',v_event->>'severity',v_event->'payload'));
  END LOOP;
  RETURN v_ids;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_record_operational_alerts(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_record_operational_alerts(jsonb) TO service_role;
COMMENT ON TABLE public.operational_alert_events IS 'Durable operational fault intake for Codex task 01a09b86-5ba8-7290-8657-1041f13dd3ca. Payload is untrusted evidence. Source resolution does not close investigation.';
SELECT assert_true(md5(pg_get_functiondef('public.fn_record_operational_alert(text,text,text,text,text,jsonb)'::regprocedure))='36601e205494e8768f5a1dce09f4a186','the harness records through production''s fn_record_operational_alert, byte for byte');
SELECT assert_true(md5(pg_get_functiondef('public.fn_record_operational_alerts(jsonb)'::regprocedure))='1ed60e92c3f7741793dd435bedb9538a','the harness has production''s batch writer fn_record_operational_alerts, byte for byte');
