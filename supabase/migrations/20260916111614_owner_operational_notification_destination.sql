-- SOURCE CANDIDATE ONLY. Apply only inside the admitted, reviewed publication
-- transaction after full native qualification. See the adjacent contract.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

DO $guard$
BEGIN
  IF current_setting('server_version_num')::integer < 150000 THEN
    RAISE EXCEPTION 'security-invoker views require PostgreSQL 15 or later';
  END IF;
  IF md5(pg_get_functiondef('public.fn_record_operational_alert(text,text,text,text,text,jsonb)'::regprocedure))
      IS DISTINCT FROM '36601e205494e8768f5a1dce09f4a186' THEN
    RAISE EXCEPTION 'operational inbox authority changed; re-review required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.notifications'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'notification row security is required';
  END IF;
  IF md5(pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure))
      IS DISTINCT FROM 'a726e393ab7ef02aa7a5a9f0622bee64'
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.notifications'::regclass
      AND tgname='trg_mirror_notification_to_push_outbox' AND tgenabled='O'
      AND tgtype=5 AND NOT tgdeferrable AND NOT tginitdeferred AND NOT tgisinternal
      AND tgnargs=0 AND tgattr::text='' AND tgqual IS NULL AND tgconstraint=0
      AND tgoldtable IS NULL AND tgnewtable IS NULL
      AND tgfoid='public.fn_mirror_notification_to_push_outbox()'::regprocedure) THEN
    RAISE EXCEPTION 'notification mirror authority changed; re-review required';
  END IF;
END;
$guard$;

-- Routing is a destination decision, independent of read state and push
-- preferences. Ordinary financial messages and account-security notices are
-- deliberately absent. NULL input must never become an unknown decision.
CREATE FUNCTION public.fn_is_owner_operational_notification(
  p_user uuid, p_type text, p_title text, p_data jsonb
) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public AS $body$
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
$body$;
REVOKE ALL ON FUNCTION public.fn_is_owner_operational_notification(uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_is_owner_operational_notification(uuid,text,text,jsonb) TO anon,authenticated,service_role;

-- This durable destination outbox keeps the complete pre-routing original.
-- A recorder error cannot force a personal delivery or erase the alert. There
-- is no notification FK: deleting the producer row must not erase its evidence.
CREATE TABLE public.operational_notification_destinations (
  notification_id uuid PRIMARY KEY,
  recipient_user_id uuid NOT NULL CHECK (recipient_user_id='47965354-0e56-43ef-931c-ddaab82af765'::uuid),
  target_task_id uuid NOT NULL DEFAULT '01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid
    CHECK (target_task_id='01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid),
  original_notification jsonb NOT NULL CHECK (jsonb_typeof(original_notification)='object'),
  inbox_event_id bigint REFERENCES public.operational_alert_events(id),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_attempt_at timestamptz,
  last_error text
);
ALTER TABLE public.operational_notification_destinations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operational_notification_destinations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.operational_notification_destinations TO service_role;
CREATE INDEX operational_notification_destinations_pending_idx
  ON public.operational_notification_destinations(captured_at,notification_id)
  WHERE inbox_event_id IS NULL;

-- Caller must already hold this destination row's transaction lock. The local
-- exception block rolls back a failed recorder attempt but retains the original
-- durable destination. It does not catch failures to persist the original.
CREATE FUNCTION public.fn_try_record_owner_notification(p_id uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $body$
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
$body$;
REVOKE ALL ON FUNCTION public.fn_try_record_owner_notification(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_retry_owner_notification_destination(p_notification_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET statement_timeout = '8s' AS $body$
DECLARE v_id bigint;
BEGIN
  v_id := public.fn_try_record_owner_notification(p_notification_id);
  RETURN jsonb_build_object('notification_id',p_notification_id,
    'target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca', 'inbox_event_id',v_id);
END;
$body$;
REVOKE ALL ON FUNCTION public.fn_retry_owner_notification_destination(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_retry_owner_notification_destination(uuid) TO service_role;

CREATE FUNCTION public.fn_capture_owner_notification_destination()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $body$
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
$body$;
REVOKE ALL ON FUNCTION public.fn_capture_owner_notification_destination() FROM PUBLIC,anon,authenticated,service_role;
-- Existing BEFORE INSERT route/read-state normalization runs first. The
-- destination and original notification commit or roll back together.
CREATE TRIGGER zz_capture_owner_notification_destination
  BEFORE INSERT ON public.notifications FOR EACH ROW
  EXECUTE FUNCTION public.fn_capture_owner_notification_destination();

-- Change only the generic mirror's admission predicate. Its function body and
-- separate deferred accounting trigger remain intact. Invoices are outside
-- the operational classifier and keep their existing canonical delivery path.
DROP TRIGGER trg_mirror_notification_to_push_outbox ON public.notifications;
CREATE TRIGGER trg_mirror_notification_to_push_outbox AFTER INSERT ON public.notifications
  FOR EACH ROW WHEN (NOT public.fn_is_owner_operational_notification(NEW.user_id,NEW.type,NEW.title,NEW.data))
  EXECUTE FUNCTION public.fn_mirror_notification_to_push_outbox();

CREATE FUNCTION public.fn_notification_has_personal_destination(p_id uuid,p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $body$
  SELECT p_user IS DISTINCT FROM '47965354-0e56-43ef-931c-ddaab82af765'::uuid
    OR NOT EXISTS (SELECT 1 FROM public.operational_notification_destinations d
      WHERE d.notification_id=p_id AND d.recipient_user_id=p_user
        AND d.target_task_id='01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid);
$body$;
REVOKE ALL ON FUNCTION public.fn_notification_has_personal_destination(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_notification_has_personal_destination(uuid,uuid) TO anon,authenticated,service_role;
-- Retains every existing permissive owner policy and adds a destination check.
-- Applies to authenticated direct reads and Realtime visibility, not just CSS.
CREATE POLICY personal_notification_destination ON public.notifications
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.fn_notification_has_personal_destination(id,user_id));
CREATE VIEW public.personal_notifications WITH (security_invoker=true) AS
  SELECT n.* FROM public.notifications n
  WHERE public.fn_notification_has_personal_destination(n.id,n.user_id);
REVOKE ALL ON public.personal_notifications FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.personal_notifications TO authenticated,service_role;

-- Explicit bounded historical intake, not a background repair or release watcher.
-- It also admits historical originals oldest-first at the tail of the existing
-- inbox. Repeated calls preserve old ids, payloads and investigation state.
CREATE FUNCTION public.fn_capture_owner_notification_history(p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET statement_timeout = '8s' AS $body$
DECLARE n public.notifications%ROWTYPE; d record; added integer:=0; recorded integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'expected bounded limit 1..200';
  END IF;
  FOR n IN SELECT x.* FROM public.notifications x
    WHERE x.user_id='47965354-0e56-43ef-931c-ddaab82af765'::uuid
      AND public.fn_is_owner_operational_notification(x.user_id,x.type,x.title,x.data)
      AND NOT EXISTS (SELECT 1 FROM public.operational_notification_destinations y WHERE y.notification_id=x.id)
    ORDER BY x.created_at,x.id LIMIT p_limit
  LOOP
    INSERT INTO public.operational_notification_destinations(notification_id,recipient_user_id,original_notification)
      VALUES(n.id,n.user_id,to_jsonb(n)) ON CONFLICT(notification_id) DO NOTHING;
    added:=added+1;
  END LOOP;
  FOR d IN SELECT notification_id FROM public.operational_notification_destinations
    WHERE inbox_event_id IS NULL
    ORDER BY last_attempt_at NULLS FIRST,captured_at,notification_id LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    IF public.fn_try_record_owner_notification(d.notification_id) IS NOT NULL THEN recorded:=recorded+1; END IF;
  END LOOP;
  RETURN jsonb_build_object('candidates_seen',added,'inbox_receipts_recorded',recorded,
    'pending',EXISTS(SELECT 1 FROM public.operational_notification_destinations WHERE inbox_event_id IS NULL),
    'uncaptured',EXISTS(SELECT 1 FROM public.notifications x
      WHERE x.user_id='47965354-0e56-43ef-931c-ddaab82af765'::uuid
        AND public.fn_is_owner_operational_notification(x.user_id,x.type,x.title,x.data)
        AND NOT EXISTS(SELECT 1 FROM public.operational_notification_destinations captured WHERE captured.notification_id=x.id)));
END;
$body$;
REVOKE ALL ON FUNCTION public.fn_capture_owner_notification_history(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_capture_owner_notification_history(integer) TO service_role;
COMMIT;
