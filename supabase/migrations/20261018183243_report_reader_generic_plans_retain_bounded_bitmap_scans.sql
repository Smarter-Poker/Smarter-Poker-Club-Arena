-- 20261018183243_report_reader_generic_plans_retain_bounded_bitmap_scans.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A real JAQK bomb-pot request still timed out after the source-day fix.
-- The exact generic catchup SELECT measured 8080ms with its index scan and
-- 142ms with a bitmap scan. Keep that plan local to the owning function.
-- A real union 14-day request also exhausted its default 8s request budget
-- while computing the existing current/previous window aggregates. Its full
-- read includes breakdown, two windows, series and freshness scans. Give this
-- report the established bounded 20s aggregate budget and 64MB sort memory.
-- Both SQL bodies, calculations, authorization and source records stay exact.
-- @live-proof: 'enable_indexscan=off'=ANY((SELECT proconfig FROM pg_proc WHERE oid='public.fn_ca_bomb_pot_catchup(uuid,integer)'::regprocedure)) AND 'statement_timeout=20s'=ANY((SELECT proconfig FROM pg_proc WHERE oid='public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer,integer,text,text)'::regprocedure))
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_bomb_pot_catchup(uuid,integer)'::regprocedure)) <> '829d113edcb4f5848ba5180abce5752c'
 OR md5(pg_get_functiondef('public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer,integer,text,text)'::regprocedure)) <> '509fd3ba5a479ef970158ab87f786bfa'
 THEN RAISE EXCEPTION 'Report reader source or settings changed before bounded-plan qualification'; END IF;
END $guard$;
ALTER FUNCTION public.fn_ca_bomb_pot_catchup(uuid,integer) SET enable_indexscan=off;
ALTER FUNCTION public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer,integer,text,text) SET statement_timeout='20s';
ALTER FUNCTION public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer,integer,text,text) SET work_mem='64MB';
REVOKE ALL ON FUNCTION public.fn_ca_bomb_pot_catchup(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_bomb_pot_catchup(uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer,integer,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer,integer,text,text) TO authenticated,service_role;
COMMIT;
