\set ON_ERROR_STOP on
-- UNRUN. Full captured PostgreSQL 17 catalog, including the still-required
-- actual notification_preferences capture, then the ownership candidate.
BEGIN;
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
    OR to_regprocedure('public.fn_change_push_subscription_ownership(uuid,jsonb,boolean)') IS NULL
    OR to_regclass('public.notification_preferences') IS NULL
 THEN RAISE EXCEPTION 'isolated real subscription catalog required'; END IF;
END $guard$;
CREATE FUNCTION pg_temp.check_ownership(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ownership failed: %',label; END IF;
 RAISE NOTICE 'ownership passed: %',label;
END$$;
DO $temp$ DECLARE n name; BEGIN
 SELECT nspname INTO STRICT n FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated,service_role',n);
END $temp$;
GRANT EXECUTE ON FUNCTION pg_temp.check_ownership(boolean,text) TO authenticated,service_role;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT ('e6180000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,3)n;
INSERT INTO public.users(id,username) SELECT ('e6180000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'push_owner_'||n FROM generate_series(1,3)n;
INSERT INTO public.profiles(id,username,display_name) SELECT ('e6180000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'push_owner_'||n,'Push Owner '||n FROM generate_series(1,3)n;
SET LOCAL session_replication_role=origin;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claim.sub='';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL ROLE service_role;
SELECT pg_temp.check_ownership(public.fn_caller_is_engine(),'real service authority');
SELECT pg_temp.check_ownership(public.fn_change_push_subscription_ownership('e6180000-0000-4000-8000-000000000001',
 '{"endpoint":"https://fcm.googleapis.com/fixture-ownership","transport":"webpush","auth":"fixture-secret","p256dh":"fixture-key","device_id":"fixture-device-01"}',true)->>'success'='true','first enrollment commits');
SELECT pg_temp.check_ownership(public.fn_change_push_subscription_ownership('e6180000-0000-4000-8000-000000000002',
 '{"endpoint":"https://fcm.googleapis.com/fixture-ownership","transport":"webpush","auth":"fixture-secret","p256dh":"fixture-key","device_id":"fixture-device-01"}',true)->'displaced_user_ids'='["e6180000-0000-4000-8000-000000000001"]'::jsonb,'actual displaced owner returned after atomic takeover');
SELECT pg_temp.check_ownership(public.fn_change_push_subscription_ownership('e6180000-0000-4000-8000-000000000002',
 '{"endpoint":"https://fcm.googleapis.com/fixture-ownership","transport":"webpush","auth":"fixture-secret","p256dh":"fixture-key","device_id":"fixture-device-01"}',true)->'displaced_user_ids'='[]'::jsonb,'same enrollment retry does not repeat displaced-owner notification');
DO $mismatch$ BEGIN
 BEGIN
   PERFORM public.fn_change_push_subscription_ownership('e6180000-0000-4000-8000-000000000003',
    '{"endpoint":"https://fcm.googleapis.com/fixture-ownership","transport":"webpush","auth":"wrong-secret","p256dh":"fixture-key"}',true);
   RAISE EXCEPTION 'wrong endpoint secret accepted';
 EXCEPTION WHEN check_violation THEN
   IF SQLERRM<>'push_subscription_possession_mismatch' THEN RAISE; END IF;
 END;
END $mismatch$;
RESET ROLE;
SELECT pg_temp.check_ownership((SELECT count(*)=1 AND bool_and(user_id='e6180000-0000-4000-8000-000000000002') FROM public.push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fixture-ownership' AND is_active),'one active owner after takeover and refused forgery');
SELECT pg_temp.check_ownership((SELECT NOT is_active AND last_failure_reason='reassigned_to_other_user' FROM public.push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fixture-ownership' AND user_id='e6180000-0000-4000-8000-000000000001'),'old owner is durably retired');
SELECT pg_temp.check_ownership((SELECT push_enabled AND browser_push FROM public.notification_preferences WHERE user_id='e6180000-0000-4000-8000-000000000002'),'new subscription and preference committed together');

-- Failure injection is a real trigger on the last table written, not a mocked
-- business helper. Its error must roll back earlier ownership changes.
CREATE FUNCTION pg_temp.reject_fixture_preference() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.user_id='e6180000-0000-4000-8000-000000000003' THEN RAISE EXCEPTION 'fixture_preferences_refused'; END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER fixture_preference_refusal BEFORE INSERT OR UPDATE ON public.notification_preferences
 FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_fixture_preference();
SET LOCAL ROLE service_role;
DO $rollback$ BEGIN
 BEGIN
   PERFORM public.fn_change_push_subscription_ownership('e6180000-0000-4000-8000-000000000003',
    '{"endpoint":"https://fcm.googleapis.com/fixture-ownership","transport":"webpush","auth":"fixture-secret","p256dh":"fixture-key"}',true);
   RAISE EXCEPTION 'fixture refusal did not abort';
 EXCEPTION WHEN raise_exception THEN
   IF SQLERRM<>'fixture_preferences_refused' THEN RAISE; END IF;
 END;
END $rollback$;
RESET ROLE;
SELECT pg_temp.check_ownership((SELECT count(*)=1 AND bool_and(user_id='e6180000-0000-4000-8000-000000000002') FROM public.push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fixture-ownership' AND is_active)
 AND NOT EXISTS(SELECT 1 FROM public.push_subscriptions WHERE user_id='e6180000-0000-4000-8000-000000000003'),'late preference failure rolls back both retirement and new endpoint');
DROP TRIGGER fixture_preference_refusal ON public.notification_preferences;
DO $unique$ BEGIN
 BEGIN
   INSERT INTO public.push_subscriptions(user_id,endpoint,transport,auth,p256dh,is_active)
    VALUES('e6180000-0000-4000-8000-000000000003','https://fcm.googleapis.com/fixture-ownership','webpush','fixture-secret','fixture-key',true);
   RAISE EXCEPTION 'duplicate active endpoint accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
END $unique$;
SET LOCAL ROLE service_role;
SELECT public.fn_change_push_subscription_ownership('e6180000-0000-4000-8000-000000000002',
 '{"endpoint":"https://fcm.googleapis.com/fixture-replacement","transport":"webpush","auth":"fixture-secret-2","p256dh":"fixture-key-2","device_id":"fixture-device-01"}',true);
SELECT public.fn_change_push_subscription_ownership('e6180000-0000-4000-8000-000000000001','{"endpoint":"https://fcm.googleapis.com/fixture-replacement"}',false);
RESET ROLE;
SELECT pg_temp.check_ownership((SELECT count(*)=1 AND bool_and(endpoint='https://fcm.googleapis.com/fixture-replacement') FROM public.push_subscriptions WHERE user_id='e6180000-0000-4000-8000-000000000002' AND is_active),'device replacement preserves one endpoint and another account cannot deactivate it');
SET LOCAL ROLE service_role;
SELECT public.fn_change_push_subscription_ownership('e6180000-0000-4000-8000-000000000002','{"endpoint":"https://fcm.googleapis.com/fixture-replacement"}',false);
RESET ROLE;
SELECT pg_temp.check_ownership(NOT EXISTS(SELECT 1 FROM public.push_subscriptions WHERE user_id='e6180000-0000-4000-8000-000000000002' AND is_active)
 AND (SELECT NOT push_enabled FROM public.notification_preferences WHERE user_id='e6180000-0000-4000-8000-000000000002'),'last-device retirement commits preference off');
SELECT pg_temp.check_ownership(NOT has_function_privilege('anon','public.fn_change_push_subscription_ownership(uuid,jsonb,boolean)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.fn_change_push_subscription_ownership(uuid,jsonb,boolean)','EXECUTE'),'untrusted RPC callers cannot submit another account');
ROLLBACK;
