-- 20261016132741_inventory_proofs_bind_the_weekly_close_lifetime.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
-- The installed 72-hour proof lifetime changed fn_accounting_close_certificate,
-- but the finite inventory authority still pinned its 12-hour definition. All
-- other 39 sources match. An unqualified generation disables both cache reads
-- and writes, so preparation repeatedly reconstructs raw inventory and times
-- out before its first payment round. Observed in the original union week,
-- with a fully rolled-back 240-second diagnostic on 2026-10-16.
-- Replace only that exact certificate pin and add the new lifetime helper as
-- a 41st exact dependency. Every existing source/owner check remains. The
-- matcher itself participates in the generation: existing caches must be
-- recertified by the normal accounting path. No proof or financial row changes.
-- Native PostgreSQL loads all 40 actual source definitions, reproduces the
-- unqualified generation, then tests the full migration, renewed cache reads,
-- expiry, drift refusal, rollback and replay. The 240-second tick is unchanged.
-- @live-proof: (SELECT md5(pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure))='3399cc47118164e0fff885520fdab271')
-- @live-proof: (SELECT smarter_private.original_inventory_proof_sources_match())
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public;
DO $guard$BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.sub',true),'') IS NOT NULL THEN RAISE EXCEPTION 'inventory_lifetime_operator_refused' USING ERRCODE='42501';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'inventory_lifetime_override_refused';END IF;
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN RAISE EXCEPTION 'inventory_lifetime_settlement_lane_owned';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'inventory_lifetime_freeze_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'inventory_lifetime_reader_owned';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('original-seven-cash-discharge',0)) THEN RAISE EXCEPTION 'inventory_lifetime_discharge_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261016132741') THEN RAISE EXCEPTION 'inventory_lifetime_history_replay';END IF;
END $guard$;

DO $install$
DECLARE
 sig constant regprocedure:='smarter_private.original_inventory_proof_sources_match()'::regprocedure;
 d text:=pg_get_functiondef(sig); before jsonb;
 old_pin constant text:='7b4a5f4572a45db069b6058899614021';
 new_pin constant text:='f4d3b9bd8722bb1d8f13f0615ff9537f';
 anchor constant text:=')x(signature,body_md5)';
 dependency constant text:=',(''public.fn_accounting_close_proof_lifetime()'',''80e026be0041fd1bdb04114c87ec368c''))x(signature,body_md5)';
BEGIN
 IF md5(d)<>'4a98179afccf2d31c127f50ed5ab9270'
 OR md5(pg_get_functiondef('public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)'::regprocedure))<>new_pin
 OR md5(pg_get_functiondef('public.fn_accounting_close_proof_lifetime()'::regprocedure))<>'80e026be0041fd1bdb04114c87ec368c'
 THEN RAISE EXCEPTION 'inventory_lifetime_preimage_refused';END IF;
 IF (length(d)-length(replace(d,old_pin,'')))/32<>1
 OR (length(d)-length(replace(d,'count(*)=40','')))/length('count(*)=40')<>1
 OR (length(d)-length(replace(d,anchor,'')))/length(anchor)<>1
 THEN RAISE EXCEPTION 'inventory_lifetime_anchor_refused';END IF;
 SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(p.proowner::regrole::text,p.prosecdef,p.provolatile,p.proacl::text,p.proconfig)) INTO before
 FROM pg_proc p WHERE p.oid IN(sig,'public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)'::regprocedure,'public.fn_accounting_close_proof_lifetime()'::regprocedure);
 IF (SELECT count(*) FROM pg_proc p WHERE p.oid IN(sig,'public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)'::regprocedure,'public.fn_accounting_close_proof_lifetime()'::regprocedure) AND p.proowner='postgres'::regrole AND NOT p.prosecdef)<>3 THEN RAISE EXCEPTION 'inventory_lifetime_metadata_refused';END IF;
 IF (SELECT proacl::text FROM pg_proc WHERE oid=sig) IS DISTINCT FROM '{postgres=X/postgres}'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_accounting_close_proof_lifetime()'::regprocedure) IS DISTINCT FROM '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
 THEN RAISE EXCEPTION 'inventory_lifetime_acl_refused';END IF;
 EXECUTE replace(replace(replace(d,old_pin,new_pin),'count(*)=40','count(*)=41'),anchor,dependency);
 IF md5(pg_get_functiondef(sig))<>'3399cc47118164e0fff885520fdab271' THEN RAISE EXCEPTION 'inventory_lifetime_postimage_refused';END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'inventory_lifetime_sources_refused';END IF;
 IF (SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(p.proowner::regrole::text,p.prosecdef,p.provolatile,p.proacl::text,p.proconfig)) FROM pg_proc p WHERE p.oid IN(sig,'public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)'::regprocedure,'public.fn_accounting_close_proof_lifetime()'::regprocedure)) IS DISTINCT FROM before THEN RAISE EXCEPTION 'inventory_lifetime_security_changed';END IF;
END $install$;

COMMIT;
