-- An inbox commit emits an opaque wake event; only the privileged consumer reads
-- alert contents and acknowledges intake. No timer, financial writer or release.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';

CREATE TABLE smarter_private.ca_native_alert_deliveries (
  wake_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_event_id bigint NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz,
  reader_task_id uuid CHECK (reader_task_id='01a09b86-5ba8-7290-8657-1041f13dd3ca')
);
ALTER TABLE smarter_private.ca_native_alert_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.ca_native_alert_deliveries FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX ca_native_alert_pending ON smarter_private.ca_native_alert_deliveries(created_at,wake_id) WHERE read_at IS NULL;

-- A dedicated 256-bit receive capability lives only in the existing canonical
-- Vault/Keychain stores, never in source or the public Supabase client key.
CREATE FUNCTION public.fn_ca_native_alert_capability(p_channel text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(p_channel='ca-native-alert-intake-v1:'||(
   SELECT decrypted_secret FROM vault.decrypted_secrets
   WHERE name='ca_native_alert_receive_capability_v1' AND decrypted_secret ~ '^[0-9a-f]{64}$'
 ),false)
$$;
REVOKE ALL ON FUNCTION public.fn_ca_native_alert_capability(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_native_alert_capability(text) TO anon,authenticated,service_role;

CREATE FUNCTION smarter_private.ca_native_alert_signal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w uuid; channel text;
BEGIN
  IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME<>'operational_alert_events'
     OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'invalid native alert binding';
  END IF;
  IF NEW.payload->>'target_task_id' IS NOT NULL AND NEW.payload->>'target_task_id'<>'01a09b86-5ba8-7290-8657-1041f13dd3ca' THEN RETURN NEW; END IF;
  INSERT INTO smarter_private.ca_native_alert_deliveries(inbox_event_id)
    VALUES(NEW.id) ON CONFLICT(inbox_event_id) DO NOTHING RETURNING wake_id INTO w;
  IF w IS NOT NULL THEN
    BEGIN
      SELECT 'ca-native-alert-intake-v1:'||decrypted_secret INTO STRICT channel FROM vault.decrypted_secrets WHERE name='ca_native_alert_receive_capability_v1' AND decrypted_secret ~ '^[0-9a-f]{64}$';
      PERFORM realtime.send(jsonb_build_object('version',1,'wake_id',w),'inbox_committed',channel,true);
    EXCEPTION WHEN OTHERS THEN
      -- The durable delivery remains pending. A reconnect reads that exact
      -- outbox; a missing realtime hint never erases the inbox receipt.
      RAISE WARNING 'native alert signal unavailable SQLSTATE=%',SQLSTATE;
    END;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION smarter_private.ca_native_alert_signal() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ca_native_alert_committed AFTER INSERT ON public.operational_alert_events
 FOR EACH ROW EXECUTE FUNCTION smarter_private.ca_native_alert_signal();

-- Receive-only opaque channel. No original IDs, payloads, amounts or recipients.
-- Restrictive INSERT policy also prevents a future broad writer policy from
-- allowing an untrusted client to forge an intake/ack signal on this topic.
CREATE POLICY ca_native_alert_receive ON realtime.messages FOR SELECT TO anon,authenticated
 USING (public.fn_ca_native_alert_capability(realtime.topic()));
CREATE POLICY ca_native_alert_no_client_send ON realtime.messages AS RESTRICTIVE FOR INSERT TO anon,authenticated
 WITH CHECK (left(coalesce(realtime.topic(),''),length('ca-native-alert-intake-v1:'))<>'ca-native-alert-intake-v1:');

CREATE FUNCTION public.fn_ca_native_alert_pending(p_channel text,p_active uuid[] DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pending jsonb; ack boolean;
BEGIN
  IF NOT public.fn_ca_native_alert_capability(p_channel) THEN RAISE EXCEPTION 'native receive capability required' USING ERRCODE='42501'; END IF;
  IF p_active IS NULL OR cardinality(p_active)>32 OR array_position(p_active,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'expected at most 32 opaque delivery ids';
  END IF;
  SELECT count(*)=cardinality(p_active) AND coalesce(bool_and(read_at IS NOT NULL),true)
    INTO ack FROM smarter_private.ca_native_alert_deliveries WHERE wake_id=ANY(p_active);
  SELECT coalesce(jsonb_agg(wake_id ORDER BY created_at,wake_id),'[]'::jsonb) INTO pending FROM (
    SELECT wake_id,created_at FROM smarter_private.ca_native_alert_deliveries
     WHERE read_at IS NULL ORDER BY created_at,wake_id LIMIT 32
  ) s;
  RETURN jsonb_build_object('version',1,'active_acknowledged',ack,'pending',pending);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_native_alert_pending(text,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_native_alert_pending(text,uuid[]) TO anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_read_native_alert(p_wake_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('wake_id',d.wake_id,'inbox',to_jsonb(e))
 FROM smarter_private.ca_native_alert_deliveries d
 JOIN public.operational_alert_events e ON e.id=d.inbox_event_id WHERE d.wake_id=p_wake_id
$$;
REVOKE ALL ON FUNCTION public.fn_ca_read_native_alert(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_read_native_alert(uuid) TO service_role;

CREATE FUNCTION public.fn_ca_ack_native_alert(p_wake_ids uuid[],p_reader_task_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer; channel text;
BEGIN
  IF p_reader_task_id IS DISTINCT FROM '01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid
    OR p_wake_ids IS NULL OR cardinality(p_wake_ids) NOT BETWEEN 1 AND 32
    OR array_position(p_wake_ids,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT x) FROM unnest(p_wake_ids) x)<>cardinality(p_wake_ids) THEN
    RAISE EXCEPTION 'invalid native alert acknowledgement';
  END IF;
  IF (SELECT count(*) FROM smarter_private.ca_native_alert_deliveries WHERE wake_id=ANY(p_wake_ids))<>cardinality(p_wake_ids) THEN
    RAISE EXCEPTION 'unknown native alert delivery';
  END IF;
  UPDATE smarter_private.ca_native_alert_deliveries SET read_at=coalesce(read_at,clock_timestamp()),reader_task_id=p_reader_task_id
    WHERE wake_id=ANY(p_wake_ids);
  GET DIAGNOSTICS n=ROW_COUNT;
  -- This means read, never resolved. Financial state and investigation status
  -- remain with their existing authorized owners.
  BEGIN
    SELECT 'ca-native-alert-intake-v1:'||decrypted_secret INTO STRICT channel FROM vault.decrypted_secrets WHERE name='ca_native_alert_receive_capability_v1' AND decrypted_secret ~ '^[0-9a-f]{64}$';
    PERFORM realtime.send(jsonb_build_object('version',1),'intake_acknowledged',channel,true);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'native alert ack signal unavailable SQLSTATE=%',SQLSTATE;
  END;
  RETURN jsonb_build_object('acknowledged',n,'reader_task_id',p_reader_task_id);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_ack_native_alert(uuid[],uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ack_native_alert(uuid[],uuid) TO service_role;
COMMIT;
