-- SOURCE CANDIDATE ONLY: UNRUN / UNAPPLIED. Requires component 164000.
-- Authenticated WH requests supply a verified actor; anonymous rotation refuses.
-- This is row-version CAS, NOT installation/account epoch or display proof.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$
BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'push_rotation_owner_required'; END IF;
 IF to_regprocedure('public.fn_rotate_push_subscription(uuid,jsonb,jsonb)') IS NOT NULL
    OR to_regprocedure('public.fn_push_subscription_rotation_revision()') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.push_subscriptions'::regclass
      AND attname='rotation_revision' AND NOT attisdropped)
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.push_subscriptions'::regclass
      AND tgname='push_subscription_rotation_revision')
 THEN RAISE EXCEPTION 'push_rotation_contract_already_exists'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_change_push_subscription_ownership(uuid,jsonb,boolean)')
    AND proowner='postgres'::regrole AND prosecdef AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
    AND prorettype='jsonb'::regtype AND proconfig=ARRAY['search_path=public']::text[]
    AND md5(prosrc)='2f40ec68f6cbdd2288c5dd2d313ca358')
    OR md5(pg_get_functiondef('public.fn_caller_is_engine()'::regprocedure))
       IS DISTINCT FROM 'd9a70f1d932538025e656bfe2b4d091d'
 THEN RAISE EXCEPTION 'push_rotation_predecessor_changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.push_subscriptions'::regclass
    AND relowner='postgres'::regrole AND relkind='r' AND relrowsecurity AND NOT relforcerowsecurity)
    OR pg_get_indexdef(to_regclass('public.push_subscriptions_one_active_endpoint_uidx')) IS DISTINCT FROM
       'CREATE UNIQUE INDEX push_subscriptions_one_active_endpoint_uidx ON public.push_subscriptions USING btree (endpoint) WHERE is_active'
    OR pg_get_indexdef(to_regclass('public.push_subscriptions_one_active_per_device_uidx')) IS DISTINCT FROM
       'CREATE UNIQUE INDEX push_subscriptions_one_active_per_device_uidx ON public.push_subscriptions USING btree (user_id, device_id) WHERE (is_active AND (device_id IS NOT NULL))'
    OR EXISTS(SELECT 1 FROM (VALUES('push_subscriptions_one_active_endpoint_uidx'),
       ('push_subscriptions_one_active_per_device_uidx')) expected(name)
       WHERE NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.'||expected.name)
         AND indisunique AND indisvalid AND indisready))
 THEN RAISE EXCEPTION 'push_rotation_schema_changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('anon','authenticated')
    AND (rolsuper OR rolbypassrls OR pg_has_role(rolname,'service_role','USAGE')))
    OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='public.push_subscriptions'::regclass
      AND p.polcmd IN('a','w','*') AND p.polpermissive
      AND EXISTS(SELECT 1 FROM pg_roles client CROSS JOIN LATERAL unnest(p.polroles) granted(role_id)
        WHERE client.rolname IN('anon','authenticated') AND
          CASE WHEN granted.role_id=0 THEN true ELSE pg_has_role(client.oid,granted.role_id,'USAGE') END))
    OR has_function_privilege('anon','public.fn_change_push_subscription_ownership(uuid,jsonb,boolean)','EXECUTE')
    OR has_function_privilege('authenticated','public.fn_change_push_subscription_ownership(uuid,jsonb,boolean)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.fn_change_push_subscription_ownership(uuid,jsonb,boolean)','EXECUTE')
 THEN RAISE EXCEPTION 'push_rotation_authority_changed'; END IF;
END $guard$;

-- Default installation does not certify historical ownership. INSERT resets to
-- 1 for a new row ID; every UPDATE increments, including an A->B->A enrollment
-- or telemetry. A caller cannot supply a reset. The bigint overflow aborts the
-- whole statement/transaction; it never wraps. These are not global epochs.
ALTER TABLE public.push_subscriptions ADD COLUMN rotation_revision bigint NOT NULL DEFAULT 1
 CHECK(rotation_revision>0);
CREATE FUNCTION public.fn_push_subscription_rotation_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 IF TG_OP='INSERT' THEN NEW.rotation_revision:=1;
 ELSE NEW.rotation_revision:=OLD.rotation_revision+1;
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_push_subscription_rotation_revision() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER push_subscription_rotation_revision BEFORE INSERT OR UPDATE ON public.push_subscriptions
 FOR EACH ROW EXECUTE FUNCTION public.fn_push_subscription_rotation_revision();

CREATE FUNCTION public.fn_rotate_push_subscription(p_user_id uuid,p_expected jsonb,p_replacement jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE source public.push_subscriptions%ROWTYPE; target public.push_subscriptions%ROWTYPE;
 old_endpoint text:=p_expected->>'endpoint'; new_endpoint text:=p_replacement->>'endpoint';
 revision text:=p_expected->>'rotation_revision'; retired_revision text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_user_id IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_replacement) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_expected->'rotation_revision') IS DISTINCT FROM 'string'
    OR revision !~ '^[1-9][0-9]{0,18}$'
    OR COALESCE(p_expected->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR COALESCE(p_expected->>'device_id','') !~ '^[A-Za-z0-9-]{8,64}$'
    OR p_expected->>'transport' IS DISTINCT FROM 'webpush'
    OR COALESCE(length(old_endpoint),0) NOT BETWEEN 1 AND 4096
    OR COALESCE(length(new_endpoint),0) NOT BETWEEN 1 AND 4096
    OR old_endpoint=new_endpoint
    OR COALESCE(p_expected->>'p256dh','')='' OR COALESCE(p_expected->>'auth','')=''
    OR COALESCE(p_replacement->>'p256dh','')='' OR COALESCE(p_replacement->>'auth','')=''
 THEN RAISE EXCEPTION 'invalid_push_rotation' USING ERRCODE='22023'; END IF;
 -- Same lock/order as enrollment. The verified actor came from WH request
 -- authentication, never from an endpoint-owner lookup or request body.
 PERFORM pg_advisory_xact_lock(hashtextextended('push_subscription_ownership:v1',0));
 SELECT * INTO source FROM public.push_subscriptions WHERE id=(p_expected->>'id')::uuid FOR UPDATE;
 IF NOT FOUND OR NOT source.is_active OR source.user_id IS DISTINCT FROM p_user_id
    OR source.endpoint IS DISTINCT FROM old_endpoint OR source.transport IS DISTINCT FROM 'webpush'
    OR source.rotation_revision::text IS DISTINCT FROM revision
    OR source.p256dh IS DISTINCT FROM (p_expected->>'p256dh')
    OR source.auth IS DISTINCT FROM (p_expected->>'auth')
    OR source.device_id IS DISTINCT FROM (p_expected->>'device_id')
 THEN RAISE EXCEPTION 'push_rotation_conflict' USING ERRCODE='23514'; END IF;
 -- No ownership takeover, resurrection, same-device retirement or preferences
 -- changes belong to rotation. Foreground authenticated enrollment handles
 -- conflicts. Cross-account device collisions are refused, not assigned.
 IF EXISTS(SELECT 1 FROM public.push_subscriptions WHERE endpoint=new_endpoint)
    OR EXISTS(SELECT 1 FROM public.push_subscriptions WHERE device_id=source.device_id AND is_active AND id<>source.id)
 THEN RAISE EXCEPTION 'push_rotation_conflict' USING ERRCODE='23514'; END IF;
 UPDATE public.push_subscriptions SET is_active=false,last_failure_reason='rotated',updated_at=clock_timestamp()
   WHERE id=source.id RETURNING rotation_revision::text INTO retired_revision;
 IF retired_revision IS DISTINCT FROM (source.rotation_revision+1)::text THEN
   RAISE EXCEPTION 'push_rotation_write_unconfirmed' USING ERRCODE='23514';
 END IF;
 INSERT INTO public.push_subscriptions(user_id,endpoint,p256dh,auth,user_agent,device_label,
   device_id,transport,platform,is_active,failure_count,last_failure_reason,updated_at)
 VALUES(source.user_id,new_endpoint,p_replacement->>'p256dh',p_replacement->>'auth',source.user_agent,source.device_label,
   source.device_id,'webpush',source.platform,true,0,NULL,clock_timestamp()) RETURNING * INTO target;
 -- Re-read after triggers: a skipped/changed INSERT must not commit retirement.
 SELECT s.* INTO target FROM public.push_subscriptions s WHERE s.id=target.id;
 IF NOT FOUND OR target.id IS NULL OR target.id=source.id OR NOT target.is_active
    OR target.user_id IS DISTINCT FROM source.user_id OR target.endpoint IS DISTINCT FROM new_endpoint
    OR target.p256dh IS DISTINCT FROM (p_replacement->>'p256dh') OR target.auth IS DISTINCT FROM (p_replacement->>'auth')
    OR target.device_id IS DISTINCT FROM source.device_id OR target.device_label IS DISTINCT FROM source.device_label
    OR target.user_agent IS DISTINCT FROM source.user_agent OR target.platform IS DISTINCT FROM source.platform
    OR target.transport IS DISTINCT FROM 'webpush' OR target.rotation_revision IS DISTINCT FROM 1::bigint
    OR target.failure_count IS DISTINCT FROM 0 OR target.last_failure_reason IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM public.push_subscriptions s WHERE s.id=source.id AND NOT s.is_active
      AND s.rotation_revision::text=retired_revision AND s.last_failure_reason='rotated')
 THEN RAISE EXCEPTION 'push_rotation_write_unconfirmed' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('schema_version',1,'success',true,'user_id',source.user_id,
   'source_subscription_id',source.id,'source_revision',revision,'retired_revision',retired_revision,
   'subscription_id',target.id,'rotation_revision',target.rotation_revision::text,
   'old_endpoint',old_endpoint,'endpoint',target.endpoint,'device_id',target.device_id,'transport',target.transport);
END $function$;
REVOKE ALL ON FUNCTION public.fn_rotate_push_subscription(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_rotate_push_subscription(uuid,jsonb,jsonb) TO service_role;
DO $postcondition$
BEGIN
 IF has_function_privilege('anon','public.fn_rotate_push_subscription(uuid,jsonb,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.fn_rotate_push_subscription(uuid,jsonb,jsonb)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.fn_rotate_push_subscription(uuid,jsonb,jsonb)','EXECUTE')
    OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
       WHERE p.oid='public.fn_rotate_push_subscription(uuid,jsonb,jsonb)'::regprocedure
       AND (a.grantee NOT IN('postgres'::regrole,'service_role'::regrole) OR a.privilege_type<>'EXECUTE'))
 THEN RAISE EXCEPTION 'push_rotation_rpc_acl_not_service_only'; END IF;
END $postcondition$;
COMMIT;
