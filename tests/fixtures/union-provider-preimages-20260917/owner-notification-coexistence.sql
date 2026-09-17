-- FIXTURE ONLY / UNRUN. Current production metadata overlay; no application rows.
-- Load after the retained original schema/access and ALL catalog bootstraps,
-- before legacy financial fixtures and the complete candidate. Not a migration.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public,pg_catalog;
DO $isolated$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR current_setting('session_replication_role')<>'origin'
 THEN RAISE EXCEPTION 'current_production_fixture_requires_isolated_pg17_owner';END IF;
END $isolated$;
LOCK TABLE public.notifications IN ACCESS EXCLUSIVE MODE;
DO $preimage$ BEGIN
IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('fn_record_operational_alert','fn_is_owner_operational_notification','fn_try_record_owner_notification','fn_capture_owner_notification_destination')) THEN RAISE EXCEPTION 'owner_destination_fixture_function_name_preexists';END IF;
IF to_regclass('public.operational_alert_events') IS NOT NULL THEN RAISE EXCEPTION 'owner_destination_fixture_preexists' USING DETAIL='operational_alert_events';END IF;
IF to_regclass('public.operational_notification_destinations') IS NOT NULL THEN RAISE EXCEPTION 'owner_destination_fixture_preexists' USING DETAIL='operational_notification_destinations';END IF;
IF to_regclass('public.operational_alert_pending_idx') IS NOT NULL THEN RAISE EXCEPTION 'owner_destination_fixture_preexists' USING DETAIL='operational_alert_pending_idx';END IF;
IF to_regclass('public.operational_notification_destinations_pending_idx') IS NOT NULL THEN RAISE EXCEPTION 'owner_destination_fixture_preexists' USING DETAIL='operational_notification_destinations_pending_idx';END IF;
IF to_regprocedure('public.fn_capture_owner_notification_destination()') IS NOT NULL THEN RAISE EXCEPTION 'owner_destination_fixture_function_preexists' USING DETAIL='public.fn_capture_owner_notification_destination()';END IF;
IF to_regprocedure('public.fn_is_owner_operational_notification(uuid, text, text, jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'owner_destination_fixture_function_preexists' USING DETAIL='public.fn_is_owner_operational_notification(uuid, text, text, jsonb)';END IF;
IF to_regprocedure('public.fn_try_record_owner_notification(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'owner_destination_fixture_function_preexists' USING DETAIL='public.fn_try_record_owner_notification(uuid)';END IF;
IF to_regprocedure('public.fn_record_operational_alert(text,text,text,text,text,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'owner_destination_fixture_function_preexists' USING DETAIL='public.fn_record_operational_alert(text,text,text,text,text,jsonb)';END IF;
IF md5(pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure)) IS DISTINCT FROM 'a726e393ab7ef02aa7a5a9f0622bee64'
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.notifications'::regclass
  AND tgname='trg_mirror_notification_to_push_outbox' AND tgenabled='O' AND NOT tgisinternal
  AND pg_get_triggerdef(oid)='CREATE TRIGGER trg_mirror_notification_to_push_outbox AFTER INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION fn_mirror_notification_to_push_outbox()')
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.notifications'::regclass AND tgname='zz_capture_owner_notification_destination')
 THEN RAISE EXCEPTION 'owner_destination_fixture_notification_preimage_changed';END IF;
IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_sequence s ON s.seqrelid=c.oid
 WHERE c.oid=to_regclass('public.operational_alert_events_id_seq') AND c.relowner='postgres'::regrole
 AND c.relkind='S' AND c.relacl IS NULL AND s.seqtypid='bigint'::regtype AND s.seqstart=1 AND s.seqincrement=1
 AND s.seqmin=1 AND s.seqmax=9223372036854775807 AND s.seqcache=1 AND NOT s.seqcycle)
 OR EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_class'::regclass
  AND objid=to_regclass('public.operational_alert_events_id_seq') AND refclassid='pg_class'::regclass)
 OR EXISTS(SELECT 1 FROM pg_depend WHERE refclassid='pg_class'::regclass
  AND refobjid=to_regclass('public.operational_alert_events_id_seq'))
 THEN RAISE EXCEPTION 'owner_destination_fixture_orphan_sequence_changed';END IF;
IF EXISTS(SELECT 1 FROM public.operational_alert_events_id_seq WHERE last_value<>1 OR is_called)
 THEN RAISE EXCEPTION 'owner_destination_fixture_orphan_sequence_used';END IF;
END $preimage$;
-- Exact known fixture orphan only, with RESTRICT and no cascade. No table rows exist.
DROP SEQUENCE public.operational_alert_events_id_seq RESTRICT;
CREATE TABLE public.operational_alert_events (
 id bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.operational_alert_events_id_seq START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 NO CYCLE) NOT NULL,
 source text NOT NULL,
 event_key text NOT NULL,
 alertname text NOT NULL,
 status text NOT NULL,
 severity text NOT NULL,
 payload jsonb NOT NULL,
 received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
 last_received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
 delivery_count bigint DEFAULT 1 NOT NULL,
 investigation_status text DEFAULT 'new'::text NOT NULL,
 investigation jsonb DEFAULT '{}'::jsonb NOT NULL,
 CONSTRAINT operational_alert_events_alertname_check CHECK (((length(alertname) >= 1) AND (length(alertname) <= 240))),
 CONSTRAINT operational_alert_events_event_key_check CHECK (((length(event_key) >= 1) AND (length(event_key) <= 512))),
 CONSTRAINT operational_alert_events_investigation_status_check CHECK ((investigation_status = ANY (ARRAY['new'::text, 'investigating'::text, 'blocked'::text, 'verified_fixed'::text, 'historical'::text, 'test'::text]))),
 CONSTRAINT operational_alert_events_payload_check CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 262144))),
 CONSTRAINT operational_alert_events_pkey PRIMARY KEY (id),
 CONSTRAINT operational_alert_events_severity_check CHECK (((length(severity) >= 1) AND (length(severity) <= 40))),
 CONSTRAINT operational_alert_events_source_check CHECK (((length(source) >= 1) AND (length(source) <= 120))),
 CONSTRAINT operational_alert_events_source_event_key_key UNIQUE (source, event_key),
 CONSTRAINT operational_alert_events_status_check CHECK ((status = ANY (ARRAY['firing'::text, 'resolved'::text, 'info'::text])))
);
ALTER TABLE public.operational_alert_events OWNER TO postgres;
ALTER TABLE public.operational_alert_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operational_alert_events FROM PUBLIC,anon,authenticated,service_role;
GRANT ALL PRIVILEGES ON public.operational_alert_events TO service_role;
CREATE INDEX operational_alert_pending_idx ON public.operational_alert_events USING btree (investigation_status, id);
CREATE TABLE public.operational_notification_destinations (
 notification_id uuid NOT NULL,
 recipient_user_id uuid NOT NULL,
 target_task_id uuid DEFAULT '01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid NOT NULL,
 original_notification jsonb NOT NULL,
 inbox_event_id bigint,
 captured_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
 last_attempt_at timestamp with time zone,
 last_error text,
 CONSTRAINT operational_notification_destinatio_original_notification_check CHECK ((jsonb_typeof(original_notification) = 'object'::text)),
 CONSTRAINT operational_notification_destinations_inbox_event_id_fkey FOREIGN KEY (inbox_event_id) REFERENCES operational_alert_events(id),
 CONSTRAINT operational_notification_destinations_pkey PRIMARY KEY (notification_id),
 CONSTRAINT operational_notification_destinations_recipient_user_id_check CHECK ((recipient_user_id = '47965354-0e56-43ef-931c-ddaab82af765'::uuid)),
 CONSTRAINT operational_notification_destinations_target_task_id_check CHECK ((target_task_id = '01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid))
);
ALTER TABLE public.operational_notification_destinations OWNER TO postgres;
ALTER TABLE public.operational_notification_destinations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operational_notification_destinations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.operational_notification_destinations TO service_role;
CREATE INDEX operational_notification_destinations_pending_idx ON public.operational_notification_destinations USING btree (captured_at, notification_id) WHERE (inbox_event_id IS NULL);
REVOKE ALL ON SEQUENCE public.operational_alert_events_id_seq FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,UPDATE,USAGE ON SEQUENCE public.operational_alert_events_id_seq TO anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_record_operational_alert(p_source text, p_event_key text, p_alertname text, p_status text, p_severity text, p_payload jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_id bigint;
BEGIN
  INSERT INTO public.operational_alert_events(source,event_key,alertname,status,severity,payload)
  VALUES(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload)
  ON CONFLICT (source,event_key) DO UPDATE
  SET last_received_at=clock_timestamp(), delivery_count=operational_alert_events.delivery_count+1
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;
ALTER FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_is_owner_operational_notification(p_user uuid, p_type text, p_title text, p_data jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE(p_user='47965354-0e56-43ef-931c-ddaab82af765'::uuid AND (
    p_type IN ('financial_incident','financial_incident_resolved','financial_attestation',
      'engine_break_failed','engine_break_recovered','guarantee_bank_short',
      'guarantee_bank_recovered','estate_digest')
    OR (p_type='system' AND (
      p_title IN ('Push Health Alert','Notifications May Not Be Reaching This Device')
      OR p_title ~ '^Horse Fleet (Alert|Recovered): '
      OR (jsonb_typeof(p_data)='object' AND p_data->>'component'='club-arena-engine'
        AND jsonb_typeof(p_data->'alertname')='string' AND NULLIF(p_data->>'alertname','') IS NOT NULL)
    ))
  ),false);
$function$;
ALTER FUNCTION public.fn_is_owner_operational_notification(uuid, text, text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_is_owner_operational_notification(uuid, text, text, jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_is_owner_operational_notification(uuid, text, text, jsonb) TO anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_try_record_owner_notification(p_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE d public.operational_notification_destinations%ROWTYPE; n jsonb; v_id bigint;
  v_name text; v_status text; v_severity text;
BEGIN
  SELECT * INTO STRICT d FROM public.operational_notification_destinations
    WHERE notification_id=p_id FOR UPDATE;
  n := d.original_notification;
  BEGIN
    IF n->>'id' IS DISTINCT FROM p_id::text OR n->>'user_id' IS DISTINCT FROM d.recipient_user_id::text
      OR NOT public.fn_is_owner_operational_notification(d.recipient_user_id,n->>'type',n->>'title',n->'data') THEN
      RAISE EXCEPTION 'operational destination original identity mismatch';
    END IF;
    v_name := left(COALESCE(NULLIF(n->'data'->>'alertname',''),(n->>'type')||':'||(n->>'title')),240);
    v_status := CASE WHEN n->'data'->>'green'='true' OR (n->>'type') ~ '(_resolved|_recovered)$'
        OR (n->>'type'='system' AND (n->>'title') ~ '^Horse Fleet Recovered: ')
        THEN 'resolved' ELSE 'firing' END;
    v_severity := CASE WHEN n->'data'->>'severity' IN ('critical','warning','info')
        THEN n->'data'->>'severity' ELSE 'warning' END;
    v_id := d.inbox_event_id;
    IF v_id IS NULL THEN
      v_id := public.fn_record_operational_alert('owner-operational-notifications',p_id::text,
        v_name,v_status,v_severity,
        jsonb_build_object('original_notification',n,'captured_at',d.captured_at,
          'target_task_id',d.target_task_id));
    END IF;
    IF v_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.operational_alert_events e
      WHERE e.id=v_id AND e.source='owner-operational-notifications'
        AND e.event_key=p_id::text AND e.payload->>'target_task_id'=d.target_task_id::text
        AND e.alertname=v_name AND e.status=v_status AND e.severity=v_severity
        -- Existing intake preserves an earlier snapshot. Only acknowledgement
        -- state/timestamps may differ; content, identity and all other fields
        -- must match. The complete current original remains in the destination.
        AND ((e.payload->'original_notification')-ARRAY['read','is_read','read_at','updated_at'])
          =(n-ARRAY['read','is_read','read_at','updated_at'])
    ) THEN RAISE EXCEPTION 'operational destination receipt mismatch'; END IF;
    UPDATE public.operational_notification_destinations SET inbox_event_id=v_id,
      last_attempt_at=clock_timestamp(),last_error=NULL WHERE notification_id=p_id;
    RETURN v_id;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.operational_notification_destinations SET inbox_event_id=NULL,last_attempt_at=clock_timestamp(),
      last_error=SQLSTATE||':'||left(SQLERRM,1000) WHERE notification_id=p_id;
    RETURN NULL;
  END;
END;
$function$;
ALTER FUNCTION public.fn_try_record_owner_notification(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_try_record_owner_notification(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_capture_owner_notification_destination()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF public.fn_is_owner_operational_notification(NEW.user_id,NEW.type,NEW.title,NEW.data) THEN
    INSERT INTO public.operational_notification_destinations(notification_id,recipient_user_id,original_notification)
      VALUES(NEW.id,NEW.user_id,to_jsonb(NEW));
    PERFORM public.fn_try_record_owner_notification(NEW.id);
    -- Preserve the original row byte-for-byte, including _push. The DB mirror
    -- predicate below and gateway destination branch suppress personal sends.
    -- This also lets the existing administrative reader recover the same exact
    -- original if the first recorder attempt failed.
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_capture_owner_notification_destination() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_capture_owner_notification_destination() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER trg_mirror_notification_to_push_outbox ON public.notifications;
CREATE TRIGGER trg_mirror_notification_to_push_outbox AFTER INSERT ON public.notifications FOR EACH ROW WHEN ((NOT fn_is_owner_operational_notification(new.user_id, new.type, new.title, new.data))) EXECUTE FUNCTION fn_mirror_notification_to_push_outbox();
CREATE TRIGGER zz_capture_owner_notification_destination BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION fn_capture_owner_notification_destination();
DO $readback$ BEGIN
IF md5(pg_get_functiondef(to_regprocedure('public.fn_capture_owner_notification_destination()'))) IS DISTINCT FROM '765a320465a49f71c26c4b747d61f1fd' OR (SELECT array_agg(x::text ORDER BY x::text) FROM pg_proc p,LATERAL unnest(p.proacl)x WHERE p.oid=to_regprocedure('public.fn_capture_owner_notification_destination()')) IS DISTINCT FROM ARRAY['postgres=X/postgres']::text[] THEN RAISE EXCEPTION 'current_production_fixture_function_readback' USING DETAIL='public.fn_capture_owner_notification_destination()';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_is_owner_operational_notification(uuid, text, text, jsonb)'))) IS DISTINCT FROM '8c2c62359d92dcbd3b3621a762b981ca' OR (SELECT array_agg(x::text ORDER BY x::text) FROM pg_proc p,LATERAL unnest(p.proacl)x WHERE p.oid=to_regprocedure('public.fn_is_owner_operational_notification(uuid, text, text, jsonb)')) IS DISTINCT FROM ARRAY['anon=X/postgres','authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'current_production_fixture_function_readback' USING DETAIL='public.fn_is_owner_operational_notification(uuid, text, text, jsonb)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_try_record_owner_notification(uuid)'))) IS DISTINCT FROM 'bbc44eb76b74576906f55e9ae370a508' OR (SELECT array_agg(x::text ORDER BY x::text) FROM pg_proc p,LATERAL unnest(p.proacl)x WHERE p.oid=to_regprocedure('public.fn_try_record_owner_notification(uuid)')) IS DISTINCT FROM ARRAY['postgres=X/postgres']::text[] THEN RAISE EXCEPTION 'current_production_fixture_function_readback' USING DETAIL='public.fn_try_record_owner_notification(uuid)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_record_operational_alert(text,text,text,text,text,jsonb)'))) IS DISTINCT FROM '36601e205494e8768f5a1dce09f4a186' OR (SELECT array_agg(x::text ORDER BY x::text) FROM pg_proc p,LATERAL unnest(p.proacl)x WHERE p.oid=to_regprocedure('public.fn_record_operational_alert(text,text,text,text,text,jsonb)')) IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[] THEN RAISE EXCEPTION 'current_production_fixture_function_readback' USING DETAIL='public.fn_record_operational_alert(text,text,text,text,text,jsonb)';END IF;
IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.notifications'::regclass AND tgname='trg_accounting_push_after_delivery' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE CONSTRAINT TRIGGER trg_accounting_push_after_delivery AFTER INSERT ON public.notifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.type = ''accounting_invoice''::text)) EXECUTE FUNCTION fn_mirror_notification_to_push_outbox()') THEN RAISE EXCEPTION 'owner_destination_fixture_trigger_readback' USING DETAIL='trg_accounting_push_after_delivery';END IF;
IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.notifications'::regclass AND tgname='trg_mirror_notification_to_push_outbox' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER trg_mirror_notification_to_push_outbox AFTER INSERT ON public.notifications FOR EACH ROW WHEN ((NOT fn_is_owner_operational_notification(new.user_id, new.type, new.title, new.data))) EXECUTE FUNCTION fn_mirror_notification_to_push_outbox()') THEN RAISE EXCEPTION 'owner_destination_fixture_trigger_readback' USING DETAIL='trg_mirror_notification_to_push_outbox';END IF;
IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.notifications'::regclass AND tgname='zz_capture_owner_notification_destination' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER zz_capture_owner_notification_destination BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION fn_capture_owner_notification_destination()') THEN RAISE EXCEPTION 'owner_destination_fixture_trigger_readback' USING DETAIL='zz_capture_owner_notification_destination';END IF;
END $readback$;

DO $catalog_readback$ DECLARE expected jsonb;actual jsonb;target oid;BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($expected$[{"acl":["postgres=arwdDxtm/postgres","service_role=arwdDxtm/postgres"],"rls":true,"kind":"r","name":"operational_alert_events","owner":"postgres","columns":[{"acl":null,"name":"id","type":"bigint","number":1,"default":null,"identity":"a","not_null":true,"generated":""},{"acl":null,"name":"source","type":"text","number":2,"default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"event_key","type":"text","number":3,"default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"alertname","type":"text","number":4,"default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"status","type":"text","number":5,"default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"severity","type":"text","number":6,"default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"payload","type":"jsonb","number":7,"default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"received_at","type":"timestamp with time zone","number":8,"default":"clock_timestamp()","identity":"","not_null":true,"generated":""},{"acl":null,"name":"last_received_at","type":"timestamp with time zone","number":9,"default":"clock_timestamp()","identity":"","not_null":true,"generated":""},{"acl":null,"name":"delivery_count","type":"bigint","number":10,"default":"1","identity":"","not_null":true,"generated":""},{"acl":null,"name":"investigation_status","type":"text","number":11,"default":"'new'::text","identity":"","not_null":true,"generated":""},{"acl":null,"name":"investigation","type":"jsonb","number":12,"default":"'{}'::jsonb","identity":"","not_null":true,"generated":""}],"indexes":[{"name":"operational_alert_events_pkey","ready":true,"valid":true,"definition":"CREATE UNIQUE INDEX operational_alert_events_pkey ON public.operational_alert_events USING btree (id)"},{"name":"operational_alert_events_source_event_key_key","ready":true,"valid":true,"definition":"CREATE UNIQUE INDEX operational_alert_events_source_event_key_key ON public.operational_alert_events USING btree (source, event_key)"},{"name":"operational_alert_pending_idx","ready":true,"valid":true,"definition":"CREATE INDEX operational_alert_pending_idx ON public.operational_alert_events USING btree (investigation_status, id)"}],"options":null,"policies":null,"triggers":null,"force_rls":false,"constraints":[{"name":"operational_alert_events_alertname_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (((length(alertname) >= 1) AND (length(alertname) <= 240)))"},{"name":"operational_alert_events_event_key_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (((length(event_key) >= 1) AND (length(event_key) <= 512)))"},{"name":"operational_alert_events_investigation_status_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((investigation_status = ANY (ARRAY['new'::text, 'investigating'::text, 'blocked'::text, 'verified_fixed'::text, 'historical'::text, 'test'::text])))"},{"name":"operational_alert_events_payload_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 262144)))"},{"name":"operational_alert_events_pkey","type":"p","deferred":false,"validated":true,"deferrable":false,"definition":"PRIMARY KEY (id)"},{"name":"operational_alert_events_severity_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (((length(severity) >= 1) AND (length(severity) <= 40)))"},{"name":"operational_alert_events_source_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (((length(source) >= 1) AND (length(source) <= 120)))"},{"name":"operational_alert_events_source_event_key_key","type":"u","deferred":false,"validated":true,"deferrable":false,"definition":"UNIQUE (source, event_key)"},{"name":"operational_alert_events_status_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((status = ANY (ARRAY['firing'::text, 'resolved'::text, 'info'::text])))"}]},{"acl":["postgres=arwdDxtm/postgres","service_role=r/postgres"],"rls":true,"kind":"r","name":"operational_notification_destinations","owner":"postgres","columns":[{"acl":null,"name":"notification_id","type":"uuid","number":1,"default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"recipient_user_id","type":"uuid","number":2,"default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"target_task_id","type":"uuid","number":3,"default":"'01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid","identity":"","not_null":true,"generated":""},{"acl":null,"name":"original_notification","type":"jsonb","number":4,"default":null,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"inbox_event_id","type":"bigint","number":5,"default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"captured_at","type":"timestamp with time zone","number":6,"default":"clock_timestamp()","identity":"","not_null":true,"generated":""},{"acl":null,"name":"last_attempt_at","type":"timestamp with time zone","number":7,"default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"last_error","type":"text","number":8,"default":null,"identity":"","not_null":false,"generated":""}],"indexes":[{"name":"operational_notification_destinations_pending_idx","ready":true,"valid":true,"definition":"CREATE INDEX operational_notification_destinations_pending_idx ON public.operational_notification_destinations USING btree (captured_at, notification_id) WHERE (inbox_event_id IS NULL)"},{"name":"operational_notification_destinations_pkey","ready":true,"valid":true,"definition":"CREATE UNIQUE INDEX operational_notification_destinations_pkey ON public.operational_notification_destinations USING btree (notification_id)"}],"options":null,"policies":null,"triggers":null,"force_rls":false,"constraints":[{"name":"operational_notification_destinatio_original_notification_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((jsonb_typeof(original_notification) = 'object'::text))"},{"name":"operational_notification_destinations_inbox_event_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (inbox_event_id) REFERENCES operational_alert_events(id)"},{"name":"operational_notification_destinations_pkey","type":"p","deferred":false,"validated":true,"deferrable":false,"definition":"PRIMARY KEY (notification_id)"},{"name":"operational_notification_destinations_recipient_user_id_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((recipient_user_id = '47965354-0e56-43ef-931c-ddaab82af765'::uuid))"},{"name":"operational_notification_destinations_target_task_id_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((target_task_id = '01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid))"}]}]$expected$::jsonb) LOOP
  target:=to_regclass('public.'||(expected->>'name'));
  SELECT jsonb_build_object('name',r.relname,'owner',pg_get_userbyid(r.relowner),'kind',r.relkind,
   'rls',r.relrowsecurity,'force_rls',r.relforcerowsecurity,'acl',(SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(r.relacl)a),'options',r.reloptions,
   'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'number',a.attnum,'type',format_type(a.atttypid,a.atttypmod),
     'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl) ORDER BY a.attnum)
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
   'constraints',(SELECT jsonb_agg(jsonb_build_object('name',conname,'type',contype,'definition',pg_get_constraintdef(oid),'validated',convalidated,
     'deferrable',condeferrable,'deferred',condeferred) ORDER BY conname) FROM pg_constraint WHERE conrelid=r.oid),
   'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ci.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY ci.relname)
     FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=r.oid),
   'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY policyname) FROM pg_policies p WHERE schemaname='public' AND tablename=r.relname),
   'triggers',(SELECT jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled,'definition',pg_get_triggerdef(oid)) ORDER BY tgname)
     FROM pg_trigger WHERE tgrelid=r.oid AND NOT tgisinternal)) INTO actual FROM pg_class r WHERE r.oid=target;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'owner_destination_fixture_table_readback' USING DETAIL=expected->>'name';END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_sequence s ON s.seqrelid=c.oid
   WHERE c.oid='public.operational_alert_events_id_seq'::regclass AND c.relowner='postgres'::regrole
   AND s.seqtypid='bigint'::regtype AND s.seqstart=1 AND s.seqincrement=1 AND s.seqmin=1
   AND s.seqmax=9223372036854775807 AND s.seqcache=1 AND NOT s.seqcycle)
  OR (SELECT array_agg(a::text ORDER BY a::text) FROM pg_class c,LATERAL unnest(c.relacl)a WHERE c.oid='public.operational_alert_events_id_seq'::regclass)
    IS DISTINCT FROM ARRAY['anon=rwU/postgres','authenticated=rwU/postgres','postgres=rwU/postgres','service_role=rwU/postgres']::text[]
  OR (SELECT count(*) FROM pg_depend WHERE classid='pg_class'::regclass AND objid='public.operational_alert_events_id_seq'::regclass
     AND refclassid='pg_class'::regclass)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_class'::regclass AND objid='public.operational_alert_events_id_seq'::regclass
     AND refclassid='pg_class'::regclass AND refobjid='public.operational_alert_events'::regclass AND refobjsubid=1 AND deptype='i')
 THEN RAISE EXCEPTION 'owner_destination_fixture_identity_readback';END IF;
END $catalog_readback$;
COMMIT;
