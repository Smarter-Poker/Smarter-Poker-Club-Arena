-- Separate committed observer, using the actual non-superuser postgres role.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout='8s';
SET LOCAL timezone='UTC';
SELECT set_config('qualification.ordinary_user',:'ordinary_user_uuid',true);
DO $$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
   OR (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
   OR (SELECT count(*) FROM auth.users)<>2 OR (SELECT count(*) FROM public.profiles)<>2
   OR (SELECT array_agg(id ORDER BY id) FROM auth.users) IS DISTINCT FROM
      (SELECT array_agg(id ORDER BY id) FROM (VALUES('47965354-0e56-43ef-931c-ddaab82af765'::uuid),
        (current_setting('qualification.ordinary_user')::uuid)) q(id))
   OR (SELECT array_agg(id ORDER BY id) FROM public.profiles) IS DISTINCT FROM
      (SELECT array_agg(id ORDER BY id) FROM (VALUES('47965354-0e56-43ef-931c-ddaab82af765'::uuid),
        (current_setting('qualification.ordinary_user')::uuid)) q(id))
   OR EXISTS(SELECT 1 FROM public.profiles WHERE diamonds IS DISTINCT FROM 0 OR diamond_balance IS DISTINCT FROM 0
     OR is_horse IS DISTINCT FROM false OR role IS DISTINCT FROM 'user')
   OR EXISTS(SELECT 1 FROM auth.users WHERE encrypted_password IS NOT NULL
     OR email NOT LIKE '%@example.invalid')
   OR (SELECT count(*) FROM public.notifications)<>2
   OR (SELECT count(*) FROM public.operational_alert_events)<>1
   OR EXISTS(SELECT 1 FROM public.push_outbox)
 THEN RAISE EXCEPTION 'committed notification fixture readback rejected'; END IF;
END $$;
SELECT jsonb_build_object('notifications',(SELECT jsonb_agg(to_jsonb(n) ORDER BY id)
  FROM public.notifications n),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id)
  FROM public.operational_alert_events e),'pushes',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id)
  FROM public.push_outbox p));
COMMIT;
