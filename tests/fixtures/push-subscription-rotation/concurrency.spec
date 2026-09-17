# UNRUN. Actual PostgreSQL isolationtester; disposable PG17 captured catalog
# plus 164000 and 164500. No fake lock or financial/source function.
setup
{
 SET session_replication_role=replica;
 INSERT INTO auth.users(id) VALUES ('e6460000-0000-4000-8000-000000000001'),('e6460000-0000-4000-8000-000000000002');
 INSERT INTO public.users(id,username) VALUES ('e6460000-0000-4000-8000-000000000001','rotation_concurrent_a'),('e6460000-0000-4000-8000-000000000002','rotation_concurrent_b');
 INSERT INTO public.profiles(id,username,display_name) VALUES ('e6460000-0000-4000-8000-000000000001','rotation_concurrent_a','Rotation A'),('e6460000-0000-4000-8000-000000000002','rotation_concurrent_b','Rotation B');
 SET session_replication_role=origin;
 SET ROLE service_role;
 SET request.jwt.claim.role='service_role';
 SET request.jwt.claims='{"role":"service_role"}';
 SELECT public.fn_change_push_subscription_ownership('e6460000-0000-4000-8000-000000000001',
  '{"endpoint":"https://fcm.googleapis.com/fixture-rotate-race-old","transport":"webpush","auth":"same-secret","p256dh":"same-key","device_id":"rotate-race-device"}',true);
 RESET ROLE;
}
teardown
{
 SET session_replication_role=replica;
 DELETE FROM public.push_subscriptions WHERE user_id IN('e6460000-0000-4000-8000-000000000001','e6460000-0000-4000-8000-000000000002');
 DELETE FROM public.notification_preferences WHERE user_id IN('e6460000-0000-4000-8000-000000000001','e6460000-0000-4000-8000-000000000002');
 DELETE FROM public.profiles WHERE id IN('e6460000-0000-4000-8000-000000000001','e6460000-0000-4000-8000-000000000002');
 DELETE FROM public.users WHERE id IN('e6460000-0000-4000-8000-000000000001','e6460000-0000-4000-8000-000000000002');
 DELETE FROM auth.users WHERE id IN('e6460000-0000-4000-8000-000000000001','e6460000-0000-4000-8000-000000000002');
 SET session_replication_role=origin;
}
session "a"
step "a_begin" { BEGIN; SET LOCAL ROLE service_role; SET LOCAL request.jwt.claim.role='service_role'; SET LOCAL request.jwt.claims='{"role":"service_role"}'; }
step "a_observe" {
 CREATE TEMP TABLE observed AS SELECT jsonb_build_object('id',id,'endpoint',endpoint,'transport',transport,'auth',auth,
  'p256dh',p256dh,'device_id',device_id,'rotation_revision',rotation_revision::text) AS expected
  FROM public.push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fixture-rotate-race-old' AND user_id='e6460000-0000-4000-8000-000000000001' AND is_active;
}
step "a_rotate_refused" {
 DO $$DECLARE expected jsonb; BEGIN
  SELECT o.expected INTO STRICT expected FROM observed o;
  BEGIN
   PERFORM public.fn_rotate_push_subscription('e6460000-0000-4000-8000-000000000001',expected,
    '{"endpoint":"https://fcm.googleapis.com/fixture-rotate-race-new","auth":"new-secret","p256dh":"new-key"}');
   RAISE EXCEPTION 'stale rotation unexpectedly committed';
  EXCEPTION WHEN check_violation THEN IF SQLERRM<>'push_rotation_conflict' THEN RAISE; END IF; END;
  IF EXISTS(SELECT 1 FROM public.push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fixture-rotate-race-new') THEN
   RAISE EXCEPTION 'refusal created a replacement'; END IF;
 END$$;
}
step "a_commit" { COMMIT; }
step "verify_b" {
 DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fixture-rotate-race-old'
    AND user_id='e6460000-0000-4000-8000-000000000002' AND is_active)
    OR EXISTS(SELECT 1 FROM public.push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fixture-rotate-race-old'
    AND user_id='e6460000-0000-4000-8000-000000000001' AND is_active)
 THEN RAISE EXCEPTION 'B takeover changed after stale rotation'; END IF; END$$;
}
step "verify_aba" {
 DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fixture-rotate-race-old'
    AND user_id='e6460000-0000-4000-8000-000000000001' AND is_active AND rotation_revision=3)
 THEN RAISE EXCEPTION 'ABA revision/owner changed after stale rotation'; END IF; END$$;
}
step "verify_device" {
 DO $$BEGIN
 IF (SELECT count(*) FROM public.push_subscriptions WHERE device_id='rotate-race-device' AND is_active)<>2
    OR NOT EXISTS(SELECT 1 FROM public.push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fixture-rotate-race-other'
       AND user_id='e6460000-0000-4000-8000-000000000002' AND is_active)
 THEN RAISE EXCEPTION 'recorded cross-account device conflict not preserved'; END IF; END$$;
}
session "b"
step "b_begin" { BEGIN; SET LOCAL ROLE service_role; SET LOCAL request.jwt.claim.role='service_role'; SET LOCAL request.jwt.claims='{"role":"service_role"}'; }
step "b_takeover" { SELECT public.fn_change_push_subscription_ownership('e6460000-0000-4000-8000-000000000002',
 '{"endpoint":"https://fcm.googleapis.com/fixture-rotate-race-old","transport":"webpush","auth":"same-secret","p256dh":"same-key","device_id":"rotate-race-device"}',true); }
step "b_back_to_a" { SELECT public.fn_change_push_subscription_ownership('e6460000-0000-4000-8000-000000000001',
 '{"endpoint":"https://fcm.googleapis.com/fixture-rotate-race-old","transport":"webpush","auth":"same-secret","p256dh":"same-key","device_id":"rotate-race-device"}',true); }
step "b_other_endpoint" { SELECT public.fn_change_push_subscription_ownership('e6460000-0000-4000-8000-000000000002',
 '{"endpoint":"https://fcm.googleapis.com/fixture-rotate-race-other","transport":"webpush","auth":"same-secret","p256dh":"same-key","device_id":"rotate-race-device"}',true); }
step "b_commit" { COMMIT; }
permutation "a_begin" "a_observe" "b_begin" "b_takeover" "a_rotate_refused" "b_commit" "a_commit" "verify_b"
permutation "a_begin" "a_observe" "b_begin" "b_takeover" "b_back_to_a" "a_rotate_refused" "b_commit" "a_commit" "verify_aba"
permutation "a_begin" "a_observe" "b_begin" "b_other_endpoint" "a_rotate_refused" "b_commit" "a_commit" "verify_device"
