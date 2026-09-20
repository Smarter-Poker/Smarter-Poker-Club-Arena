-- Notification-only logical restore of two synthetic preexisting principals.
-- Executed after the authentic schema prefix (all FKs/unique constraints),
-- before its first trigger is attached. No signup, Mint or financial fixture.
BEGIN;
SET LOCAL statement_timeout='8s';
CREATE TEMP TABLE restore_identity AS SELECT :'execution_uuid'::uuid execution,
  :'ordinary_user_uuid'::uuid ordinary_user;
DO $$ BEGIN
  IF current_user<>'fixture_bootstrap' OR NOT EXISTS(SELECT 1 FROM restore_identity
    WHERE current_database()='qual_owner_notify_'||replace(execution::text,'-','')
      AND ordinary_user<>'47965354-0e56-43ef-931c-ddaab82af765'::uuid)
    OR EXISTS(SELECT 1 FROM auth.users) OR EXISTS(SELECT 1 FROM public.profiles)
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal)
  THEN RAISE EXCEPTION 'preexisting principal restore boundary rejected'; END IF;
END $$;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
SELECT id,'authenticated','authenticated',label||'@example.invalid','{}','{}'
FROM (SELECT '47965354-0e56-43ef-931c-ddaab82af765'::uuid id,'qual_owner'::text label
      UNION ALL SELECT ordinary_user,'qual_ordinary' FROM restore_identity) q;
INSERT INTO public.profiles(id,username,email,role,is_horse,diamonds,diamond_balance)
SELECT id,label,label||'@example.invalid','user',false,0,0
FROM (SELECT '47965354-0e56-43ef-931c-ddaab82af765'::uuid id,'qual_owner'::text label
      UNION ALL SELECT ordinary_user,'qual_ordinary' FROM restore_identity) q;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
