-- 20261020160107_lightning_fold_uses_a_separate_restricted_session.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '3s';

-- Preserve the inherited PUBLIC read-only baseline. This migration grants no
-- table privileges and never grants membership in service_role or postgres.
DO $preconditions$
BEGIN
  IF md5(pg_get_functiondef('public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)'::regprocedure)) <> '4b7a841a1e5baba34a1f5ccab702a455'
     OR md5(pg_get_functiondef('smarter_private.fn_smarter_data_api_pre_request()'::regprocedure)) <> 'b799597b6f91d7e59688bff5d1fa9c5a' THEN
    RAISE EXCEPTION 'Lightning fold lane dependency changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='engine_lightning_fold')
     OR EXISTS (SELECT 1 FROM vault.secrets WHERE name='engine_lightning_fold_url') THEN
    RAISE EXCEPTION 'Lightning fold lane already exists; do not rotate or replay';
  END IF;
END $preconditions$;

-- The password is generated and stored inside this transaction. No agent,
-- workflow input, host environment file or report receives its value.
DO $login$
DECLARE password_value text := replace(gen_random_uuid()::text || gen_random_uuid()::text,'-','');
BEGIN
  CREATE ROLE engine_lightning_fold LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8;
  EXECUTE format('ALTER ROLE engine_lightning_fold PASSWORD %L',password_value);
  PERFORM vault.create_secret(
    format('postgresql://engine_lightning_fold.kuklfnapbkmacvwxktbh:%s@aws-0-us-west-2.pooler.supabase.com:5432/postgres',password_value),
    'engine_lightning_fold_url','Fixed Lightning fold only; separate Supavisor session-mode login');
END $login$;
ALTER ROLE engine_lightning_fold SET statement_timeout='8s';
ALTER ROLE engine_lightning_fold SET lock_timeout='2s';
ALTER ROLE engine_lightning_fold SET idle_in_transaction_session_timeout='10s';
ALTER ROLE engine_lightning_fold SET synchronous_commit='on';
ALTER ROLE engine_lightning_fold SET search_path='pg_catalog';
GRANT USAGE ON SCHEMA smarter_private TO engine_lightning_fold;

CREATE FUNCTION smarter_private.fn_engine_lightning_fast_fold(
  p_hand_id uuid,p_player_id uuid,p_request_id uuid,p_fold_type text,p_committed numeric,p_actor_headers jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $function$
DECLARE actor text; protocol text; key_count integer;
BEGIN
  IF session_user <> 'engine_lightning_fold' OR current_user <> 'service_role' THEN
    RAISE EXCEPTION 'LIGHTNING_FOLD_SESSION_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF current_setting('synchronous_commit') <> 'on' THEN
    RAISE EXCEPTION 'LIGHTNING_FOLD_DURABLE_COMMIT_REQUIRED' USING ERRCODE='22023';
  END IF;
  IF p_actor_headers IS NULL OR jsonb_typeof(p_actor_headers) <> 'object' THEN
    RAISE EXCEPTION 'LIGHTNING_FOLD_ACTOR_INVALID' USING ERRCODE='22023';
  END IF;
  actor := p_actor_headers->>'x-smarter-data-actor';
  protocol := p_actor_headers->>'x-smarter-data-protocol';
  SELECT count(*) INTO key_count FROM jsonb_object_keys(p_actor_headers);
  IF EXISTS (SELECT 1 FROM jsonb_each(p_actor_headers) e
    WHERE e.key NOT IN ('x-smarter-data-actor','x-smarter-data-protocol','x-smarter-tournament-id','x-smarter-tournament-lease-generation')
       OR jsonb_typeof(e.value) <> 'string')
     OR NOT ((actor='service' AND protocol='1' AND key_count=2)
          OR (actor='tournament-manager' AND protocol='2' AND key_count=4
              AND p_actor_headers ? 'x-smarter-tournament-id'
              AND p_actor_headers ? 'x-smarter-tournament-lease-generation'))
     OR actor IS NULL OR protocol IS NULL THEN
    RAISE EXCEPTION 'LIGHTNING_FOLD_ACTOR_INVALID' USING ERRCODE='22023';
  END IF;

  -- Arbitrary custom GUCs are not authority. Only the fixed, session-bound
  -- wrapper establishes service authority; the original hook checks actor
  -- protocol and the exact live manager generation inside this transaction.
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.headers',p_actor_headers::text,true);
  PERFORM set_config('request.method','POST',true);
  PERFORM set_config('request.path','rpc/fn_lightning_fast_fold',true);
  PERFORM smarter_private.fn_smarter_data_api_pre_request();
  RETURN public.fn_lightning_fast_fold(p_hand_id,p_player_id,p_request_id,p_fold_type,p_committed);
END $function$;
REVOKE ALL ON FUNCTION smarter_private.fn_engine_lightning_fast_fold(uuid,uuid,uuid,text,numeric,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

-- Non-superuser postgres can transfer ownership only while the recipient has
-- CREATE on this schema. The temporary grant is invisible outside this one
-- transaction and restored to its prior effective value before commit.
DO $owner$
DECLARE already_allowed boolean := has_schema_privilege('service_role','smarter_private','CREATE');
BEGIN
  IF NOT already_allowed THEN GRANT CREATE ON SCHEMA smarter_private TO service_role; END IF;
  ALTER FUNCTION smarter_private.fn_engine_lightning_fast_fold(uuid,uuid,uuid,text,numeric,jsonb) OWNER TO service_role;
  IF NOT already_allowed THEN REVOKE CREATE ON SCHEMA smarter_private FROM service_role; END IF;
END $owner$;
GRANT EXECUTE ON FUNCTION smarter_private.fn_engine_lightning_fast_fold(uuid,uuid,uuid,text,numeric,jsonb) TO engine_lightning_fold;

CREATE FUNCTION public.fn_engine_lightning_fold_session_url() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='engine_lightning_fold_url' LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public.fn_engine_lightning_fold_session_url() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_engine_lightning_fold_session_url() TO service_role;

DO $verify$
BEGIN
  IF pg_has_role('engine_lightning_fold','service_role','MEMBER')
     OR pg_has_role('engine_lightning_fold','postgres','MEMBER')
     OR has_function_privilege('engine_lightning_fold','public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)','EXECUTE')
     OR has_function_privilege('engine_lightning_fold','public.fn_engine_lightning_fold_session_url()','EXECUTE')
     OR has_schema_privilege('engine_lightning_fold','smarter_private','CREATE') THEN
    RAISE EXCEPTION 'Lightning fold lane privilege verification failed';
  END IF;
END $verify$;
-- @live-proof: (SELECT pg_get_userbyid(proowner)='service_role' AND prosecdef FROM pg_proc WHERE oid='smarter_private.fn_engine_lightning_fast_fold(uuid,uuid,uuid,text,numeric,jsonb)'::regprocedure)
-- @live-proof: (SELECT has_function_privilege('engine_lightning_fold','smarter_private.fn_engine_lightning_fast_fold(uuid,uuid,uuid,text,numeric,jsonb)','EXECUTE') AND NOT has_function_privilege('engine_lightning_fold','public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)','EXECUTE'))

COMMIT;
