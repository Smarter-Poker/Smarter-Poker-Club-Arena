\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Isolated captured PostgreSQL 17 + 164000 + 164500.
-- Synthetic subscriptions only; no endpoint is dialed. Entire fixture rolls back.
BEGIN;
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
    OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
    OR to_regprocedure('public.fn_rotate_push_subscription(uuid,jsonb,jsonb)') IS NULL
 THEN RAISE EXCEPTION 'isolated real rotation catalog required'; END IF;
END $guard$;
CREATE FUNCTION pg_temp.rotation_check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'rotation failed: %',label; END IF;
 RAISE NOTICE 'rotation passed: %',label;
END$$;
CREATE FUNCTION pg_temp.rotation_snapshot() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('subscriptions',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.push_subscriptions s),'[]'),
   'preferences',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id) FROM public.notification_preferences p),'[]'));
$$;
CREATE FUNCTION pg_temp.rotation_expected(endpoint_value text,actor uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('id',id,'endpoint',endpoint,'device_id',device_id,'transport',transport,
   'p256dh',p256dh,'auth',auth,'rotation_revision',rotation_revision::text)
 FROM public.push_subscriptions WHERE endpoint=endpoint_value AND user_id=actor AND is_active;
$$;
CREATE FUNCTION pg_temp.rotation_refused(actor uuid,expected jsonb,replacement jsonb,label text,
 expected_state text DEFAULT '23514',expected_message text DEFAULT 'push_rotation_conflict') RETURNS void LANGUAGE plpgsql AS $$
DECLARE before_state jsonb:=pg_temp.rotation_snapshot(); got_error boolean:=false;
BEGIN
 BEGIN
   PERFORM public.fn_rotate_push_subscription(actor,expected,replacement);
 EXCEPTION WHEN OTHERS THEN
   IF SQLSTATE IS DISTINCT FROM expected_state OR SQLERRM IS DISTINCT FROM expected_message THEN RAISE; END IF;
   got_error:=true;
 END;
 PERFORM pg_temp.rotation_check(got_error AND pg_temp.rotation_snapshot() IS NOT DISTINCT FROM before_state,label);
END$$;
DO $temp$ DECLARE n name; BEGIN
 SELECT nspname INTO STRICT n FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon,authenticated,service_role',n);
END $temp$;
GRANT EXECUTE ON FUNCTION pg_temp.rotation_check(boolean,text) TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION pg_temp.rotation_expected(text,uuid),pg_temp.rotation_snapshot(),
 pg_temp.rotation_refused(uuid,jsonb,jsonb,text,text,text) TO service_role;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT ('e6450000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,3)n;
INSERT INTO public.users(id,username) SELECT ('e6450000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'rotation_'||n FROM generate_series(1,3)n;
INSERT INTO public.profiles(id,username,display_name) SELECT ('e6450000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'rotation_'||n,'Rotation '||n FROM generate_series(1,3)n;
SET LOCAL session_replication_role=origin;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claim.sub='';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL ROLE service_role;
SELECT pg_temp.rotation_check(public.fn_caller_is_engine(),'actual service role admission');
SELECT public.fn_change_push_subscription_ownership('e6450000-0000-4000-8000-000000000001',
 '{"endpoint":"https://fcm.googleapis.com/fixture-rotation-old","transport":"webpush","auth":"old-secret","p256dh":"old-key","device_id":"rotation-device-01","device_label":"Preserved label","platform":"web"}',true);
DO $success$ DECLARE expected jsonb; receipt jsonb; snapshot jsonb; prefs jsonb;
 replacement jsonb:='{"endpoint":"https://fcm.googleapis.com/fixture-rotation-new","auth":"new-secret","p256dh":"new-key"}';
BEGIN
 expected:=pg_temp.rotation_expected('https://fcm.googleapis.com/fixture-rotation-old','e6450000-0000-4000-8000-000000000001');
 prefs:=pg_temp.rotation_snapshot()->'preferences';
 receipt:=public.fn_rotate_push_subscription('e6450000-0000-4000-8000-000000000001',expected,replacement);
 PERFORM pg_temp.rotation_check((receipt->>'success'='true' AND receipt->'schema_version'='1'::jsonb
   AND receipt->>'source_subscription_id'=expected->>'id' AND receipt->'source_revision'='"1"'::jsonb
   AND receipt->'retired_revision'='"2"'::jsonb AND receipt->'rotation_revision'='"1"'::jsonb
   AND receipt->>'endpoint'=replacement->>'endpoint' AND receipt->>'old_endpoint'=expected->>'endpoint'
   AND receipt->>'device_id'=expected->>'device_id' AND receipt->>'user_id'='e6450000-0000-4000-8000-000000000001'
   AND receipt->>'transport'='webpush') IS TRUE,'exact typed success receipt with decimal revisions');
 PERFORM pg_temp.rotation_check((SELECT NOT is_active AND rotation_revision=2 AND last_failure_reason='rotated'
   FROM public.push_subscriptions WHERE id=(expected->>'id')::uuid),'old row retired once');
 PERFORM pg_temp.rotation_check((SELECT is_active AND user_id='e6450000-0000-4000-8000-000000000001'
   AND endpoint=replacement->>'endpoint' AND auth='new-secret' AND p256dh='new-key'
   AND device_id='rotation-device-01' AND device_label='Preserved label' AND platform='web'
   AND failure_count=0 AND last_failure_reason IS NULL AND rotation_revision=1
   FROM public.push_subscriptions WHERE id=(receipt->>'subscription_id')::uuid),'replacement identity and metadata exact');
 PERFORM pg_temp.rotation_check(pg_temp.rotation_snapshot()->'preferences' IS NOT DISTINCT FROM prefs,'rotation does not enable or change preferences');
 PERFORM pg_temp.rotation_refused('e6450000-0000-4000-8000-000000000001',expected,replacement,'lost-response retry makes no further writes');
END $success$;

-- Actual enrollment remains the only account reassignment authority.
DO $aba$ DECLARE expected jsonb; snapshot jsonb;
 sub jsonb:='{"endpoint":"https://fcm.googleapis.com/fixture-rotation-aba","transport":"webpush","auth":"same-secret","p256dh":"same-key","device_id":"rotation-device-aba"}';
 replacement jsonb:='{"endpoint":"https://fcm.googleapis.com/fixture-rotation-aba-new","auth":"new-secret","p256dh":"new-key"}';
BEGIN
 PERFORM public.fn_change_push_subscription_ownership('e6450000-0000-4000-8000-000000000001',sub,true);
 expected:=pg_temp.rotation_expected(sub->>'endpoint','e6450000-0000-4000-8000-000000000001');
 PERFORM public.fn_change_push_subscription_ownership('e6450000-0000-4000-8000-000000000002',sub,true);
 PERFORM pg_temp.rotation_refused('e6450000-0000-4000-8000-000000000001',expected,replacement,'A observation cannot rotate after B takeover');
 PERFORM public.fn_change_push_subscription_ownership('e6450000-0000-4000-8000-000000000001',sub,true);
 PERFORM pg_temp.rotation_check((SELECT rotation_revision=3 AND id=(expected->>'id')::uuid FROM public.push_subscriptions
   WHERE user_id='e6450000-0000-4000-8000-000000000001' AND endpoint=sub->>'endpoint'),'ABA reuses row but advances revision');
 PERFORM pg_temp.rotation_refused('e6450000-0000-4000-8000-000000000001',expected,replacement,'same row and keys after ABA cannot satisfy old version');
 expected:=pg_temp.rotation_expected(sub->>'endpoint','e6450000-0000-4000-8000-000000000001');
 UPDATE public.push_subscriptions SET rotation_revision=1 WHERE id=(expected->>'id')::uuid;
 PERFORM pg_temp.rotation_check((SELECT rotation_revision=4 FROM public.push_subscriptions WHERE id=(expected->>'id')::uuid),'caller cannot reset revision');
 PERFORM pg_temp.rotation_refused('e6450000-0000-4000-8000-000000000001',expected,replacement,'intervening telemetry/update invalidates observation');
END $aba$;

DO $refusals$ DECLARE expected jsonb; changed jsonb; field text;
 actor uuid:='e6450000-0000-4000-8000-000000000001';
 replacement jsonb:='{"endpoint":"https://fcm.googleapis.com/fixture-rotation-refusal-new","auth":"new-secret","p256dh":"new-key"}';
BEGIN
 expected:=pg_temp.rotation_expected('https://fcm.googleapis.com/fixture-rotation-new',actor);
 PERFORM pg_temp.rotation_refused('e6450000-0000-4000-8000-000000000002',expected,replacement,'another actor cannot rotate source');
 FOREACH field IN ARRAY ARRAY['auth','p256dh','endpoint','device_id','rotation_revision'] LOOP
   changed:=jsonb_set(expected,ARRAY[field],to_jsonb(CASE WHEN field='rotation_revision' THEN '999' ELSE 'wrong-recorded-value' END));
   PERFORM pg_temp.rotation_refused(actor,changed,replacement,'mismatched '||field);
 END LOOP;
 PERFORM pg_temp.rotation_refused(actor,expected-'auth',replacement,'missing secret', '22023','invalid_push_rotation');
 PERFORM pg_temp.rotation_refused(actor,expected-'device_id',replacement,'legacy missing device', '22023','invalid_push_rotation');
 PERFORM pg_temp.rotation_refused(actor,jsonb_set(expected,'{rotation_revision}','1'),replacement,'numeric revision is not an exact string','22023','invalid_push_rotation');
 PERFORM pg_temp.rotation_refused(actor,jsonb_set(expected,'{rotation_revision}','null'),replacement,'null revision refused','22023','invalid_push_rotation');
 PERFORM pg_temp.rotation_refused(actor,jsonb_set(expected,'{transport}','"fcm"'),replacement,'FCM rotation unsupported','22023','invalid_push_rotation');
 PERFORM pg_temp.rotation_refused(actor,expected,jsonb_set(replacement,'{endpoint}',expected->'endpoint'),'self overwrite refused','22023','invalid_push_rotation');
 -- Existing inactive target is not resurrected or overwritten.
 PERFORM pg_temp.rotation_refused(actor,expected,jsonb_set(replacement,'{endpoint}','"https://fcm.googleapis.com/fixture-rotation-old"'),'inactive target refused');
 -- A second account on the recorded device but a different endpoint cannot be
 -- silently retired. This is a collision, not proof which account is correct.
 PERFORM public.fn_change_push_subscription_ownership('e6450000-0000-4000-8000-000000000002',
   '{"endpoint":"https://fcm.googleapis.com/fixture-rotation-other-owner","transport":"webpush","auth":"other-secret","p256dh":"other-key","device_id":"rotation-device-01"}',true);
 PERFORM pg_temp.rotation_refused(actor,expected,replacement,'another active same-device account is preserved');
 PERFORM pg_temp.rotation_refused(actor,expected,jsonb_set(replacement,'{endpoint}','"https://fcm.googleapis.com/fixture-rotation-other-owner"'),'target owner is never taken over');
END $refusals$;
RESET ROLE;
-- A real late INSERT trigger failure must roll back retirement and its revision.
CREATE FUNCTION pg_temp.reject_rotation_target() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.endpoint='https://fcm.googleapis.com/fixture-rotation-rollback-new' THEN RAISE EXCEPTION 'fixture_rotation_insert_refused'; END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER fixture_rotation_late_refusal AFTER INSERT ON public.push_subscriptions FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_rotation_target();
SET LOCAL ROLE service_role;
SELECT public.fn_change_push_subscription_ownership('e6450000-0000-4000-8000-000000000003',
 '{"endpoint":"https://fcm.googleapis.com/fixture-rotation-rollback","transport":"webpush","auth":"old-secret","p256dh":"old-key","device_id":"rotation-device-03"}',true);
SELECT pg_temp.rotation_refused('e6450000-0000-4000-8000-000000000003',
 pg_temp.rotation_expected('https://fcm.googleapis.com/fixture-rotation-rollback','e6450000-0000-4000-8000-000000000003'),
 '{"endpoint":"https://fcm.googleapis.com/fixture-rotation-rollback-new","auth":"new-secret","p256dh":"new-key"}',
 'late failure restores full subscriptions, revision and preferences','P0001','fixture_rotation_insert_refused');
RESET ROLE;
DROP TRIGGER fixture_rotation_late_refusal ON public.push_subscriptions;
-- A trigger that silently skips the replacement must also abort retirement.
CREATE FUNCTION pg_temp.skip_rotation_target() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.endpoint='https://fcm.googleapis.com/fixture-rotation-skipped-new' THEN RETURN NULL; END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER fixture_rotation_skip BEFORE INSERT ON public.push_subscriptions FOR EACH ROW EXECUTE FUNCTION pg_temp.skip_rotation_target();
SET LOCAL ROLE service_role;
SELECT pg_temp.rotation_refused('e6450000-0000-4000-8000-000000000003',
 pg_temp.rotation_expected('https://fcm.googleapis.com/fixture-rotation-rollback','e6450000-0000-4000-8000-000000000003'),
 '{"endpoint":"https://fcm.googleapis.com/fixture-rotation-skipped-new","auth":"new-secret","p256dh":"new-key"}',
 'quiet skipped insert cannot commit source retirement','23514','push_rotation_write_unconfirmed');
RESET ROLE;
DROP TRIGGER fixture_rotation_skip ON public.push_subscriptions;
-- Seed an otherwise unreachable counter boundary in this rollback-only fixture.
-- Re-enable the real trigger BEFORE any test call; no fake authority function.
ALTER TABLE public.push_subscriptions DISABLE TRIGGER push_subscription_rotation_revision;
UPDATE public.push_subscriptions SET rotation_revision=9007199254740993 WHERE endpoint='https://fcm.googleapis.com/fixture-rotation-rollback';
ALTER TABLE public.push_subscriptions ENABLE TRIGGER push_subscription_rotation_revision;
SET LOCAL ROLE service_role;
DO $precision$ DECLARE expected jsonb; result jsonb; BEGIN
 expected:=pg_temp.rotation_expected('https://fcm.googleapis.com/fixture-rotation-rollback','e6450000-0000-4000-8000-000000000003');
 result:=public.fn_rotate_push_subscription('e6450000-0000-4000-8000-000000000003',expected,
   '{"endpoint":"https://fcm.googleapis.com/fixture-rotation-large-revision","auth":"new-secret","p256dh":"new-key"}');
 PERFORM pg_temp.rotation_check(result->'source_revision'='"9007199254740993"'::jsonb
   AND result->'retired_revision'='"9007199254740994"'::jsonb,'revision stays decimal text beyond JS safe integer');
END $precision$;
RESET ROLE;
ALTER TABLE public.push_subscriptions DISABLE TRIGGER push_subscription_rotation_revision;
UPDATE public.push_subscriptions SET rotation_revision=9223372036854775807 WHERE endpoint='https://fcm.googleapis.com/fixture-rotation-large-revision';
ALTER TABLE public.push_subscriptions ENABLE TRIGGER push_subscription_rotation_revision;
SET LOCAL ROLE service_role;
SELECT pg_temp.rotation_refused('e6450000-0000-4000-8000-000000000003',
 pg_temp.rotation_expected('https://fcm.googleapis.com/fixture-rotation-large-revision','e6450000-0000-4000-8000-000000000003'),
 '{"endpoint":"https://fcm.googleapis.com/fixture-rotation-overflow","auth":"new-secret","p256dh":"new-key"}',
 'overflow aborts without wrapping or retirement','22003','bigint out of range');
RESET ROLE;
SELECT pg_temp.rotation_check(NOT has_function_privilege('anon','public.fn_rotate_push_subscription(uuid,jsonb,jsonb)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.fn_rotate_push_subscription(uuid,jsonb,jsonb)','EXECUTE')
 AND has_function_privilege('service_role','public.fn_rotate_push_subscription(uuid,jsonb,jsonb)','EXECUTE'),'actual service-only RPC grants');
SET LOCAL ROLE authenticated;
-- Even forged service-role GUCs must not bypass EXECUTE rights.
DO $acl$ BEGIN
 BEGIN
  PERFORM public.fn_rotate_push_subscription('e6450000-0000-4000-8000-000000000001','{}','{}');
  RAISE EXCEPTION 'authenticated client entered rotation';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $acl$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $acl$ BEGIN
 BEGIN
  PERFORM public.fn_rotate_push_subscription('e6450000-0000-4000-8000-000000000001','{}','{}');
  RAISE EXCEPTION 'anonymous client entered rotation';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $acl$;
RESET ROLE;
ROLLBACK;
