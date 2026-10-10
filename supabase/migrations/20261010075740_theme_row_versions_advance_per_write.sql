-- Tier: 3
-- Author: Codex, authorized Stable Admin launch recovery
-- Affects: public.update_user_theme_settings_timestamp(); existing theme UPDATE trigger
-- Reserved by scripts/new-migration.mjs. Installed migrations remain immutable.
-- First RPC partial save inserts defaults and updates in one transaction. NOW()
-- gives both events the same version; preserve full-microsecond strict ordering.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $guard$
DECLARE p pg_proc%ROWTYPE;
BEGIN
 SELECT * INTO STRICT p FROM pg_proc WHERE oid='public.update_user_theme_settings_timestamp()'::regprocedure;
 IF p.proowner <> 'postgres'::regrole OR p.prosecdef OR p.provolatile <> 'v' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[] OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'Theme timestamp security/config/grants drift'; END IF;
 IF md5(p.prosrc) NOT IN ('da5ac28a58c8b4bb30209bf0d3d7082c','ba1df5a065cbb19f3763fc13a4048b7b') THEN RAISE EXCEPTION 'Theme timestamp preimage differs'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.user_theme_settings'::regclass AND tgname='trg_user_theme_settings_updated' AND tgfoid=p.oid AND tgtype=19 AND tgenabled='O') THEN RAISE EXCEPTION 'Theme timestamp trigger differs'; END IF;
END;
$guard$;
CREATE OR REPLACE FUNCTION public.update_user_theme_settings_timestamp()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at := GREATEST(clock_timestamp(), OLD.updated_at + INTERVAL '1 microsecond');
  RETURN NEW;
END;
$function$;
DO $post$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.update_user_theme_settings_timestamp()'::regprocedure) <> 'ba1df5a065cbb19f3763fc13a4048b7b' THEN RAISE EXCEPTION 'Theme timestamp postimage differs'; END IF;
END;
$post$;
COMMIT;

-- Rollback: execute as a NEW forward migration only; never replay this version.
-- BEGIN;
-- SET LOCAL lock_timeout = '3s';
-- SET LOCAL statement_timeout = '30s';
-- DO $rollback$
-- DECLARE p pg_proc%ROWTYPE;
-- BEGIN
-- SELECT * INTO STRICT p FROM pg_proc WHERE oid='public.update_user_theme_settings_timestamp()'::regprocedure;
-- IF p.proowner <> 'postgres'::regrole OR p.prosecdef OR p.provolatile <> 'v' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[] OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'Theme timestamp security/config/grants drift'; END IF;
-- IF md5(p.prosrc) <> 'ba1df5a065cbb19f3763fc13a4048b7b' THEN RAISE EXCEPTION 'Theme timestamp rollback owner drifted'; END IF;
-- END;
-- $rollback$;
-- CREATE OR REPLACE FUNCTION public.update_user_theme_settings_timestamp()
-- RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
-- AS $function$
-- BEGIN
--   NEW.updated_at = NOW();
--   RETURN NEW;
-- END;
-- $function$;
-- COMMIT;
