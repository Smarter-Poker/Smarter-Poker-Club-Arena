# UNRUN PostgreSQL isolationtester source. Requires the real captured catalog
# including notification_preferences and the ownership candidate, in an isolated
# disposable database. No production endpoint, request, or sender is exercised.
setup
{
  SET session_replication_role=replica;
  INSERT INTO auth.users(id) VALUES
    ('e6190000-0000-4000-8000-000000000001'),('e6190000-0000-4000-8000-000000000002');
  INSERT INTO public.users(id,username) VALUES
    ('e6190000-0000-4000-8000-000000000001','push_concurrent_a'),('e6190000-0000-4000-8000-000000000002','push_concurrent_b');
  INSERT INTO public.profiles(id,username,display_name) VALUES
    ('e6190000-0000-4000-8000-000000000001','push_concurrent_a','Push Concurrent A'),('e6190000-0000-4000-8000-000000000002','push_concurrent_b','Push Concurrent B');
  SET session_replication_role=origin;
}
teardown
{
  DELETE FROM public.push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fixture-concurrent';
  DELETE FROM public.notification_preferences WHERE user_id IN('e6190000-0000-4000-8000-000000000001','e6190000-0000-4000-8000-000000000002');
  DELETE FROM public.profiles WHERE id IN('e6190000-0000-4000-8000-000000000001','e6190000-0000-4000-8000-000000000002');
  DELETE FROM public.users WHERE id IN('e6190000-0000-4000-8000-000000000001','e6190000-0000-4000-8000-000000000002');
  DELETE FROM auth.users WHERE id IN('e6190000-0000-4000-8000-000000000001','e6190000-0000-4000-8000-000000000002');
}
session "a"
step "a_begin" { BEGIN; SET LOCAL ROLE service_role; SET LOCAL request.jwt.claims='{"role":"service_role"}'; SET LOCAL request.jwt.claim.role='service_role'; }
step "a_enroll" { SELECT public.fn_change_push_subscription_ownership('e6190000-0000-4000-8000-000000000001','{"endpoint":"https://fcm.googleapis.com/fixture-concurrent","transport":"webpush","auth":"same-device-secret","p256dh":"fixture-key"}',true); }
step "a_commit" { COMMIT; }
step "verify_a" { DO $$BEGIN IF (SELECT count(*) FROM public.push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fixture-concurrent' AND is_active)<>1 OR NOT EXISTS(SELECT 1 FROM public.push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fixture-concurrent' AND is_active AND user_id='e6190000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'last serialized owner A missing or duplicate active ownership'; END IF; END$$; }
session "b"
step "b_begin" { BEGIN; SET LOCAL ROLE service_role; SET LOCAL request.jwt.claims='{"role":"service_role"}'; SET LOCAL request.jwt.claim.role='service_role'; }
step "b_enroll" { SELECT public.fn_change_push_subscription_ownership('e6190000-0000-4000-8000-000000000002','{"endpoint":"https://fcm.googleapis.com/fixture-concurrent","transport":"webpush","auth":"same-device-secret","p256dh":"fixture-key"}',true); }
step "b_commit" { COMMIT; }
step "verify_b" { DO $$BEGIN IF (SELECT count(*) FROM public.push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fixture-concurrent' AND is_active)<>1 OR NOT EXISTS(SELECT 1 FROM public.push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fixture-concurrent' AND is_active AND user_id='e6190000-0000-4000-8000-000000000002') THEN RAISE EXCEPTION 'last serialized owner B missing or duplicate active ownership'; END IF; END$$; }
permutation "a_begin" "b_begin" "a_enroll" "b_enroll" "a_commit" "b_commit" "verify_b"
permutation "a_begin" "b_begin" "b_enroll" "a_enroll" "b_commit" "a_commit" "verify_a"
