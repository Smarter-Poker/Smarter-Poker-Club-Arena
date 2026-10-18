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
-- Catchup SQL body, rollup producer, archive and caller authority unchanged.
-- The final read also selected the wrong table/hand-number scan (20s timeout).
-- A correlated hosted-table read uses its table/created-at bounds directly:
-- the exact 30-day JAQK SELECT measured 228ms and returned the same empty rows.
-- Keep that relation intact with OFFSET 0 and exclude future UTC dates.
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

DO $patch$
DECLARE original text; d text;
BEGIN
 original:=pg_get_functiondef('public.fn_club_bomb_pot_report(uuid,integer)'::regprocedure);
 IF md5(original)<>'e144edf49b1ac17266bcb94a658bdee4'
 THEN RAISE EXCEPTION 'Bomb final report source changed'; END IF;
 d:=replace(original,$before$FROM public.hand_history h
          WHERE h.table_id = ANY(ARRAY(SELECT t.id FROM public.tables t WHERE t.club_id = p_club_id))
           AND h.bomb_pot IS NOT NULL
           AND h.created_at >= v_live_from::timestamptz$before$,$after$FROM public.tables hosted
          CROSS JOIN LATERAL (
            SELECT h.id,h.table_id,h.bomb_pot,h.created_at,h.pot_size,h.rake_amount,h.players
              FROM public.hand_history h
             WHERE h.table_id=hosted.id AND h.bomb_pot IS NOT NULL
               AND h.created_at >= (v_live_from::timestamp AT TIME ZONE 'UTC')
               AND h.created_at < (((now() AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC')
             OFFSET 0
          ) h
          WHERE hosted.club_id=p_club_id$after$);
 IF d=original THEN RAISE EXCEPTION 'Bomb final hosted scan preimage missing'; END IF;
 EXECUTE d;
END $patch$;
ALTER FUNCTION public.fn_club_bomb_pot_report(uuid,integer) SET plan_cache_mode=force_generic_plan;
REVOKE ALL ON FUNCTION public.fn_club_bomb_pot_report(uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_club_bomb_pot_report(uuid,integer) TO authenticated,service_role;

COMMIT;
