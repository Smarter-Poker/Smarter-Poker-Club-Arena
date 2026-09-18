\set ON_ERROR_STOP on
-- Same captured canonical actor identity-only restore as original principals.sql.
-- No email, password, profile, session, wallet, or authority impersonation.
BEGIN;
DO $$ BEGIN IF current_user<>'fixture_bootstrap' OR session_user<>'fixture_bootstrap'
 OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_mixed_qualification.execution_uuid'),'-','')
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal)
 OR (SELECT count(*) FROM auth.users)<>3 OR (SELECT count(*) FROM public.profiles)<>3
 OR EXISTS(SELECT 1 FROM auth.users WHERE id='2d1cd6c3-5700-4af9-a271-d4863fdab20d')
 THEN RAISE EXCEPTION 'exact synthetic principal restore boundary required'; END IF; END $$;
INSERT INTO auth.users(id,aud,role,raw_app_meta_data,raw_user_meta_data)
VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,'authenticated','authenticated','{}'::jsonb,'{}'::jsonb);
DO $$ BEGIN IF (SELECT count(*) FROM auth.users)<>4 OR (SELECT count(*) FROM public.profiles)<>3
 OR EXISTS(SELECT 1 FROM public.profiles WHERE id='2d1cd6c3-5700-4af9-a271-d4863fdab20d')
 OR EXISTS(SELECT 1 FROM auth.sessions) THEN RAISE EXCEPTION 'identity-only postimage differs'; END IF; END $$;
COMMIT;
