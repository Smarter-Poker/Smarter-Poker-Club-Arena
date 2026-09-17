-- SOURCE CANDIDATE ONLY. UNRUN / UNAPPLIED. Club Arena owns the database.
-- Requires the captured push_subscriptions schema, its existing per-account
-- endpoint/device uniqueness, and service-only enrollment through World Hub.
-- No existing endpoint is retired by installing this file. Conflicting active
-- ownership aborts installation for investigation instead of choosing a user.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$
BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'push_ownership_owner_required'; END IF;
 IF to_regprocedure('public.fn_change_push_subscription_ownership(uuid,jsonb,boolean)') IS NOT NULL
    OR to_regclass('public.push_subscriptions_one_active_endpoint_uidx') IS NOT NULL
 THEN RAISE EXCEPTION 'push_ownership_contract_already_exists'; END IF;
 IF md5(pg_get_functiondef('public.fn_caller_is_engine()'::regprocedure))
    IS DISTINCT FROM 'd9a70f1d932538025e656bfe2b4d091d'
 THEN RAISE EXCEPTION 'push_ownership_engine_authority_changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.push_subscriptions'::regclass
    AND relowner='postgres'::regrole AND relrowsecurity AND NOT relforcerowsecurity)
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.push_subscriptions'::regclass
      AND conname='push_subscriptions_user_id_endpoint_key' AND contype='u'
      AND pg_get_constraintdef(oid)='UNIQUE (user_id, endpoint)')
    OR pg_get_indexdef(to_regclass('public.push_subscriptions_one_active_per_device_uidx')) IS DISTINCT FROM
      'CREATE UNIQUE INDEX push_subscriptions_one_active_per_device_uidx ON public.push_subscriptions USING btree (user_id, device_id) WHERE (is_active AND (device_id IS NOT NULL))'
    OR NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.push_subscriptions_one_active_per_device_uidx')
      AND indisunique AND indisvalid AND indisready)
 THEN RAISE EXCEPTION 'push_ownership_schema_changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.notification_preferences')
    AND relowner='postgres'::regrole AND relkind='r')
    OR EXISTS(SELECT 1 FROM (VALUES('user_id','uuid'::regtype),('push_enabled','boolean'::regtype),
        ('browser_push','boolean'::regtype),('updated_at','timestamptz'::regtype)) expected(name,type)
      WHERE NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.notification_preferences')
        AND a.attname=expected.name AND a.atttypid=expected.type AND NOT a.attisdropped))
 THEN RAISE EXCEPTION 'push_ownership_preference_contract_changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='public.push_subscriptions'::regclass
     AND p.polcmd IN('a','w','*') AND p.polpermissive
     AND EXISTS(SELECT 1 FROM pg_roles client CROSS JOIN LATERAL unnest(p.polroles) granted(role_id)
       WHERE client.rolname IN('anon','authenticated') AND
         CASE WHEN granted.role_id=0 THEN true ELSE pg_has_role(client.oid,granted.role_id,'USAGE') END))
 THEN RAISE EXCEPTION 'push_ownership_client_writer_present'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('anon','authenticated')
    AND (rolsuper OR rolbypassrls OR pg_has_role(rolname,'service_role','USAGE')))
 THEN RAISE EXCEPTION 'push_ownership_client_role_bypass'; END IF;
 IF EXISTS(SELECT 1 FROM public.push_subscriptions WHERE is_active GROUP BY endpoint HAVING count(*)>1)
 THEN RAISE EXCEPTION 'push_ownership_existing_active_conflict'; END IF;
END $guard$;

-- This enforces uniqueness even against a trusted writer that does not take
-- the enrollment lock. The existing per-user/device index remains in force.
CREATE UNIQUE INDEX push_subscriptions_one_active_endpoint_uidx
 ON public.push_subscriptions(endpoint) WHERE is_active;

CREATE FUNCTION public.fn_change_push_subscription_ownership(p_user_id uuid,p_subscription jsonb,p_enabled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE endpoint_value text:=p_subscription->>'endpoint';
 transport_value text:=p_subscription->>'transport'; platform_value text:=p_subscription->>'platform';
 auth_value text:=p_subscription->>'auth'; key_value text:=p_subscription->>'p256dh';
 device_value text:=p_subscription->>'device_id'; replaces_value text:=p_subscription->>'replaces_endpoint';
 displaced uuid[]:='{}'; incumbent public.push_subscriptions%ROWTYPE;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_user_id IS NULL OR p_enabled IS NULL OR jsonb_typeof(p_subscription) IS DISTINCT FROM 'object'
    OR endpoint_value IS NULL OR length(endpoint_value)<1 OR length(endpoint_value)>4096
 THEN RAISE EXCEPTION 'invalid_push_subscription' USING ERRCODE='22023'; END IF;
 -- Enrollment is rare and bounded. One transaction lock also orders device
 -- replacement and logout, avoiding reversed endpoint/device lock ordering.
 PERFORM pg_advisory_xact_lock(hashtextextended('push_subscription_ownership:v1',0));
 IF p_enabled THEN
   IF transport_value IS NULL OR transport_value NOT IN('webpush','fcm')
      OR (platform_value IS NOT NULL AND platform_value NOT IN('web','ios','android'))
      OR (transport_value='webpush' AND (COALESCE(auth_value,'')='' OR COALESCE(key_value,'')=''))
      OR (device_value IS NOT NULL AND device_value !~ '^[A-Za-z0-9-]{8,64}$')
   THEN RAISE EXCEPTION 'invalid_push_subscription' USING ERRCODE='22023'; END IF;
   -- The caller already validates endpoint hosts, native token shape and key
   -- lengths. This service-only transaction repeats ownership proof while
   -- holding the same lock that protects retirement and replacement.
   FOR incumbent IN SELECT * FROM public.push_subscriptions
     WHERE endpoint=endpoint_value AND is_active AND user_id<>p_user_id ORDER BY id FOR UPDATE LOOP
     IF incumbent.transport IS DISTINCT FROM transport_value OR
        (transport_value='webpush' AND incumbent.auth IS DISTINCT FROM auth_value)
     THEN RAISE EXCEPTION 'push_subscription_possession_mismatch' USING ERRCODE='23514'; END IF;
     displaced:=array_append(displaced,incumbent.user_id);
   END LOOP;
   UPDATE public.push_subscriptions SET is_active=false,last_failure_reason='reassigned_to_other_user',updated_at=now()
     WHERE endpoint=endpoint_value AND is_active AND user_id<>p_user_id;
   IF device_value IS NOT NULL THEN
     UPDATE public.push_subscriptions SET is_active=false,last_failure_reason='superseded_same_device',updated_at=now()
       WHERE user_id=p_user_id AND device_id=device_value AND is_active AND endpoint<>endpoint_value;
   END IF;
   IF replaces_value IS NOT NULL AND replaces_value<>endpoint_value THEN
     UPDATE public.push_subscriptions SET is_active=false,last_failure_reason='superseded',updated_at=now()
       WHERE user_id=p_user_id AND endpoint=replaces_value AND is_active;
   END IF;
   INSERT INTO public.push_subscriptions(user_id,endpoint,p256dh,auth,transport,platform,user_agent,device_label,
     device_id,is_active,failure_count,last_failure_reason,updated_at)
   VALUES(p_user_id,endpoint_value,key_value,auth_value,transport_value,platform_value,
     left(p_subscription->>'user_agent',500),left(p_subscription->>'device_label',120),device_value,true,0,NULL,now())
   ON CONFLICT(user_id,endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,transport=EXCLUDED.transport,
     platform=EXCLUDED.platform,user_agent=EXCLUDED.user_agent,device_label=EXCLUDED.device_label,
     device_id=EXCLUDED.device_id,is_active=true,failure_count=0,last_failure_reason=NULL,updated_at=EXCLUDED.updated_at;
   INSERT INTO public.notification_preferences(user_id,push_enabled,browser_push,updated_at)
     VALUES(p_user_id,true,true,now()) ON CONFLICT(user_id) DO UPDATE
     SET push_enabled=true,browser_push=true,updated_at=EXCLUDED.updated_at;
 ELSE
   UPDATE public.push_subscriptions SET is_active=false,updated_at=now()
     WHERE user_id=p_user_id AND endpoint=endpoint_value AND is_active;
   IF NOT EXISTS(SELECT 1 FROM public.push_subscriptions WHERE user_id=p_user_id AND is_active) THEN
     INSERT INTO public.notification_preferences(user_id,push_enabled,updated_at) VALUES(p_user_id,false,now())
       ON CONFLICT(user_id) DO UPDATE SET push_enabled=false,updated_at=EXCLUDED.updated_at;
   END IF;
 END IF;
 RETURN jsonb_build_object('schema_version',1,'success',true,'user_id',p_user_id,
   'endpoint',endpoint_value,'enabled',p_enabled,'displaced_user_ids',to_jsonb(displaced));
END $function$;
REVOKE ALL ON FUNCTION public.fn_change_push_subscription_ownership(uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_change_push_subscription_ownership(uuid,jsonb,boolean) TO service_role;
COMMIT;
