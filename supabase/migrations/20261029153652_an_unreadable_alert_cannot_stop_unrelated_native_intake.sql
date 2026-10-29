-- A failed individual read remains unread and visible, but cannot hold every
-- unrelated alert behind the same accepted native queue operation forever.
-- A deferral is an explicit service-only terminal intake attempt, never an ACK,
-- incident resolution, retry schedule or financial mutation.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE TABLE smarter_private.ca_native_alert_read_failures (
 wake_id uuid PRIMARY KEY,
 reader_task_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE smarter_private.ca_native_alert_read_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.ca_native_alert_read_failures FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_native_alert_pending(p_channel text,p_active uuid[] DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pending jsonb; ack boolean;
BEGIN
 IF NOT public.fn_ca_native_alert_capability(p_channel) THEN RAISE EXCEPTION 'native receive capability required' USING ERRCODE='42501'; END IF;
 IF p_active IS NULL OR cardinality(p_active)>32 OR array_position(p_active,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'expected at most 32 opaque delivery ids';
 END IF;
 -- Legacy wire name means this accepted batch has a durable outcome. A failed
 -- read has its own record and remains read_at=NULL in the authoritative inbox.
 SELECT count(*)=cardinality(p_active) AND coalesce(bool_and(d.read_at IS NOT NULL OR f.wake_id IS NOT NULL),true)
 INTO ack FROM smarter_private.ca_native_alert_deliveries d
 LEFT JOIN smarter_private.ca_native_alert_read_failures f USING(wake_id)
 WHERE d.wake_id=ANY(p_active);
 SELECT coalesce(jsonb_agg(wake_id ORDER BY created_at,wake_id),'[]'::jsonb) INTO pending FROM (
  SELECT d.wake_id,d.created_at FROM smarter_private.ca_native_alert_deliveries d
  WHERE d.read_at IS NULL AND NOT EXISTS(
   SELECT 1 FROM smarter_private.ca_native_alert_read_failures f WHERE f.wake_id=d.wake_id)
  ORDER BY d.created_at,d.wake_id LIMIT 32
 ) s;
 RETURN jsonb_build_object('version',1,'active_acknowledged',ack,'pending',pending);
END $$;

CREATE FUNCTION public.fn_ca_defer_native_alert(p_wake_id uuid,p_reader_task_id uuid,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE channel text;
BEGIN
 IF p_reader_task_id IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN
  RAISE EXCEPTION 'explicit reader and failure reason required';
 END IF;
 PERFORM 1 FROM smarter_private.ca_native_alert_deliveries WHERE wake_id=p_wake_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown native alert delivery'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.ca_native_alert_deliveries WHERE wake_id=p_wake_id AND read_at IS NOT NULL) THEN
  RAISE EXCEPTION 'already read native alert delivery';
 END IF;
 INSERT INTO smarter_private.ca_native_alert_read_failures(wake_id,reader_task_id,reason)
 VALUES(p_wake_id,p_reader_task_id,btrim(p_reason)) ON CONFLICT(wake_id) DO NOTHING;
 BEGIN
  SELECT 'ca-native-alert-intake-v1:'||decrypted_secret INTO STRICT channel FROM vault.decrypted_secrets
  WHERE name='ca_native_alert_receive_capability_v1' AND decrypted_secret ~ '^[0-9a-f]{64}$';
  PERFORM realtime.send(jsonb_build_object('version',1),'intake_acknowledged',channel,true);
 EXCEPTION WHEN OTHERS THEN RAISE WARNING 'native alert failure signal unavailable SQLSTATE=%',SQLSTATE;
 END;
 RETURN jsonb_build_object('deferred',p_wake_id,'read',false);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_defer_native_alert(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_defer_native_alert(uuid,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_read_native_alert(p_wake_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('wake_id',d.wake_id,'inbox',to_jsonb(e),
  'stored_inbox_characters',length(to_jsonb(e)::text),
  'stored_inbox_md5',md5(to_jsonb(e)::text),
  'read_failure',(SELECT to_jsonb(f) FROM smarter_private.ca_native_alert_read_failures f WHERE f.wake_id=d.wake_id))
 FROM smarter_private.ca_native_alert_deliveries d
 JOIN public.operational_alert_events e ON e.id=d.inbox_event_id WHERE d.wake_id=p_wake_id
$$;
-- Existing reader-silence counts all read_at=NULL rows, including failures.
-- Full read and ACK remain service-only. No existing grants are broadened.
COMMIT;
