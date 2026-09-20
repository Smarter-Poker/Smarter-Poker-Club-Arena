-- 20260918225134_the_profile_guard_admits_ledgered_diamond_wheel_spins.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- The authenticated v2 wheel (including contract v3) uses the same private
-- ledger writer as the old wheel. The profile guard named only the old wheel,
-- so the owner intake UPDATE raised 42501 and rolled the whole spin back.
-- Add only the reviewed wheel caller; retain direct-write rejection, all
-- existing guard text, private helper grants and monetary transaction bodies.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
DO $repair$
DECLARE
  v_before text;
  v_after text;
  v_old constant text := $old$     OR v_stack ~ 'function (public[.])?fn_wheel_spin_core[(]'$old$;
  v_new constant text := $new$     OR v_stack ~ 'function (public[.])?fn_wheel_spin_core[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_spin_v2[(]'$new$;
BEGIN
  IF md5(pg_get_functiondef('public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)'::regprocedure)) <> 'e84e46139211c4b06526330f83577941'
     OR has_function_privilege('anon','public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.add_diamonds_to_balance(uuid,integer,text,text,text,uuid)','EXECUTE')
     OR has_function_privilege('anon','public.add_diamonds_to_balance(uuid,integer,text,text,text,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Wheel ledger authority changed; review before extending its wallet guard';
  END IF;
  SELECT pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure) INTO v_before;
  IF md5(v_before) <> '5795bc906d2d041e5c5ba2a6d22e2b0e'
     OR strpos(v_before,v_old)=0 OR strpos(v_before,'fn_wheel_spin_v2')>0 THEN
    RAISE EXCEPTION 'Profile wallet guard changed; review before applying the exact extension';
  END IF;
  EXECUTE replace(v_before,v_old,v_new);
  SELECT pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure) INTO v_after;
  IF replace(v_after,v_new,v_old) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'Unrelated profile guard text changed';
  END IF;
  IF 'fn_guard_profile_privileged_columns'=ANY(public.fn_ca_guard_watchlist()) THEN
    PERFORM public.fn_ca_declare_guard_redefinition('fn_guard_profile_privileged_columns',
      'migration 20260918225134_the_profile_guard_admits_ledgered_diamond_wheel_spins');
  END IF;
END $repair$;

COMMIT;
