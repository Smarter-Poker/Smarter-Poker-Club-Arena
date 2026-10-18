-- 20261018195533_bomb_catchup_retains_its_qualified_generic_bitmap_plan.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A real JAQK request still timed out after bitmap scans were enabled.
-- The parameter-specific custom plan chose BitmapAnd with the table/hand-number
-- index and took 9184ms; the same prepared generic plan used the bounded
-- table/created-at index and took 142ms. PL/pgSQL otherwise starts with custom
-- plans, so qualifying only a generic plan did not cover a fresh backend.
-- Keep that qualified plan local to this function from its FIRST invocation.
-- SQL body, date bounds, rollup producer, archive and caller authority unchanged.
-- @live-proof: 'plan_cache_mode=force_generic_plan'=ANY((SELECT proconfig FROM pg_proc WHERE oid='public.fn_ca_bomb_pot_catchup(uuid,integer)'::regprocedure))
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_bomb_pot_catchup(uuid,integer)'::regprocedure)) <> '26c4154db312866a94e2a14167199abd'
 THEN RAISE EXCEPTION 'Bomb catchup plan source or settings changed'; END IF;
END $guard$;
ALTER FUNCTION public.fn_ca_bomb_pot_catchup(uuid,integer) SET plan_cache_mode=force_generic_plan;
REVOKE ALL ON FUNCTION public.fn_ca_bomb_pot_catchup(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_bomb_pot_catchup(uuid,integer) TO service_role;

COMMIT;
