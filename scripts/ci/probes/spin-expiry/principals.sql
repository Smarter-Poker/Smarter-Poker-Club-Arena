-- SOURCE ONLY / UNRUN. Preserve three synthetic preexisting principals and
-- restore only the captured canonical cancellation actor's auth identity.
-- refund-actor-identity-capture.json SHA256
-- 39c7708688463dff37beb88cd4dc8853fba4dc0829705c329346db67c5badb87.
-- Actor has no profile, email, password, session, identity or funded balance.
-- Executed after the authentic schema prefix (all FKs/unique constraints),
-- before its first trigger is attached. No signup, Mint or financial fixture.
BEGIN;
SET LOCAL statement_timeout='8s';
CREATE TEMP TABLE restore_identity AS SELECT :'execution_uuid'::uuid execution,
  :'ordinary_user_uuid'::uuid ordinary_user;
DO $$ BEGIN
  IF current_user<>'fixture_bootstrap' OR NOT EXISTS(SELECT 1 FROM restore_identity
    WHERE current_database()='qual_spin_expiry_'||replace(execution::text,'-','')
      AND ordinary_user<>'47965354-0e56-43ef-931c-ddaab82af765'::uuid
      AND ordinary_user<>extensions.uuid_generate_v5(execution,'spin-player-2')
      AND '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid <> ALL(ARRAY[
        execution, ordinary_user, '47965354-0e56-43ef-931c-ddaab82af765'::uuid,
        extensions.uuid_generate_v5(execution,'spin-player-2')]))
    OR EXISTS(SELECT 1 FROM auth.users) OR EXISTS(SELECT 1 FROM public.profiles)
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal)
  THEN RAISE EXCEPTION 'preexisting principal restore boundary rejected'; END IF;
END $$;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
SELECT id,'authenticated','authenticated',label||'@example.invalid','{}','{}'
FROM (SELECT '47965354-0e56-43ef-931c-ddaab82af765'::uuid id,'qual_owner'::text label
      UNION ALL SELECT ordinary_user,'qual_ordinary' FROM restore_identity
      UNION ALL SELECT extensions.uuid_generate_v5(execution,'spin-player-2'),'qual_player2' FROM restore_identity) q;
INSERT INTO auth.users(id,aud,role,raw_app_meta_data,raw_user_meta_data)
VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,'authenticated','authenticated','{}'::jsonb,'{}'::jsonb);
INSERT INTO public.profiles(id,username,email,role,is_horse,diamonds,diamond_balance)
SELECT id,label,label||'@example.invalid','user',false,0,0
FROM (SELECT '47965354-0e56-43ef-931c-ddaab82af765'::uuid id,'qual_owner'::text label
      UNION ALL SELECT ordinary_user,'qual_ordinary' FROM restore_identity
      UNION ALL SELECT extensions.uuid_generate_v5(execution,'spin-player-2'),'qual_player2' FROM restore_identity) q;
SET CONSTRAINTS ALL IMMEDIATE;
DO $restored_principals$
DECLARE expected_profiles uuid[]; expected_auth uuid[];
BEGIN
  SELECT array_agg(id ORDER BY id) INTO expected_profiles
  FROM (SELECT '47965354-0e56-43ef-931c-ddaab82af765'::uuid id
        UNION ALL SELECT ordinary_user FROM restore_identity
        UNION ALL SELECT extensions.uuid_generate_v5(execution,'spin-player-2') FROM restore_identity) q;
  SELECT array_agg(id ORDER BY id) INTO expected_auth
  FROM (SELECT unnest(expected_profiles) id
        UNION ALL SELECT '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid) q;
  IF (SELECT count(*) FROM auth.users)<>4 OR (SELECT count(*) FROM public.profiles)<>3
     OR (SELECT array_agg(id ORDER BY id) FROM public.profiles) IS DISTINCT FROM expected_profiles
     OR (SELECT array_agg(id ORDER BY id) FROM auth.users) IS DISTINCT FROM expected_auth
     OR EXISTS(SELECT 1 FROM public.profiles WHERE diamonds IS DISTINCT FROM 0
       OR diamond_balance IS DISTINCT FROM 0 OR is_horse IS DISTINCT FROM false
       OR role IS DISTINCT FROM 'user')
     OR EXISTS(SELECT 1 FROM auth.sessions)
  THEN RAISE EXCEPTION 'exact restored principal set differs'; END IF;
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
END $restored_principals$;

COMMIT;
