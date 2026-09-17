-- SOURCE ONLY / UNRUN. Provider contamination check; no financial functions.
-- Preserve v3's bounded empty-table proof. The only new auth row is the captured
-- canonical cancellation actor, with no corresponding profile or credentials.
-- Capture SHA256 39c7708688463dff37beb88cd4dc8853fba4dc0829705c329346db67c5badb87.
BEGIN READ ONLY;
SET LOCAL statement_timeout='8s';
DO $$
DECLARE r record; occupied boolean;
BEGIN
  IF current_user<>'fixture_bootstrap' OR current_database()!~'^qual_spin_expiry_[0-9a-f]{32}$'
    OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname IN('auth','public') AND c.relkind IN('r','p'))>300
  THEN RAISE EXCEPTION 'bounded empty provider boundary rejected'; END IF;
  FOR r IN SELECT c.oid::regclass name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN('auth','public') AND c.relkind IN('r','p')
      AND c.oid NOT IN('auth.users'::regclass,'public.profiles'::regclass)
    ORDER BY c.oid
  LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s LIMIT 1)',r.name) INTO occupied;
    IF occupied THEN RAISE EXCEPTION 'unexpected provider row in %',r.name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM auth.users)<>4 OR (SELECT count(*) FROM public.profiles)<>3
    OR EXISTS(SELECT 1 FROM public.profiles WHERE diamonds IS DISTINCT FROM 0
      OR diamond_balance IS DISTINCT FROM 0 OR is_horse IS DISTINCT FROM false
      OR role IS DISTINCT FROM 'user')
  THEN RAISE EXCEPTION 'synthetic zero principal proof failed'; END IF;
  IF EXISTS(SELECT 1 FROM public.profiles p WHERE NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=p.id))
    OR EXISTS(SELECT 1 FROM auth.users u
      WHERE u.id<>'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid
        AND NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=u.id))
  THEN RAISE EXCEPTION 'auth/profile identity correspondence differs'; END IF;
  IF (SELECT count(*) FROM auth.users u
      WHERE u.id='2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid
        AND u.aud='authenticated' AND u.role='authenticated'
        AND u.email IS NULL AND u.encrypted_password IS NULL AND u.phone IS NULL
        AND u.raw_app_meta_data='{}'::jsonb AND u.raw_user_meta_data='{}'::jsonb
        AND u.is_sso_user=false AND u.is_anonymous=false AND u.email_change_confirm_status=0
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_each_text(to_jsonb(u)) f
          WHERE f.key NOT IN ('id','aud','role','raw_app_meta_data','raw_user_meta_data',
                              'is_sso_user','is_anonymous','email_change_confirm_status')
            AND f.value IS NOT NULL AND f.value<>''))<>1
    OR EXISTS(SELECT 1 FROM public.profiles WHERE id='2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid)
  THEN RAISE EXCEPTION 'canonical cancellation actor identity-only proof failed'; END IF;
END $$;
COMMIT;
