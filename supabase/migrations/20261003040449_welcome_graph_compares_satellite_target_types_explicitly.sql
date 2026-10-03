-- 20261003040449_welcome_graph_compares_satellite_target_types_explicitly.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The complete welcome-package reset graph installed by 20261003021809 joined
-- the legacy tournaments.satellite_target UUID through target.id::text. The
-- native fixture had incorrectly declared that production UUID column as text,
-- so qualification passed while the first production reset-impact read failed
-- with 42883 (operator does not exist: text = uuid). Compare both canonical
-- target columns as UUIDs. No club, game, player, wallet, chip, receipt, or
-- consent row is changed.
--
-- @live-proof: ((SELECT count(*)=2 AND bool_and(a.atttypid='uuid'::regtype) FROM pg_attribute a WHERE a.attrelid='public.tournaments'::regclass AND a.attname IN('satellite_target','satellite_target_id') AND NOT a.attisdropped) AND (SELECT bool_and(p.prosrc LIKE '%target.id=t.satellite_target_id OR target.id=t.satellite_target%') AND bool_and(p.prosrc NOT LIKE '%target.id::text=t.satellite_target%') FROM pg_proc p WHERE p.oid=ANY(ARRAY['public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure,'public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure])))
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $repair_welcome_graph_satellite_target_type$
DECLARE
  v_proc regprocedure;
  v_before text;
  v_after text;
  v_source text;
  v_source_after text;
  v_old text := 'target.id=t.satellite_target_id OR target.id::text=t.satellite_target';
  v_new text := 'target.id=t.satellite_target_id OR target.id=t.satellite_target';
  v_old_hits integer;
  v_new_hits integer;
  v_metadata_before jsonb;
  v_metadata_after jsonb;
BEGIN
  IF NOT (
    SELECT count(*)=2 AND bool_and(a.atttypid='uuid'::regtype)
      FROM pg_attribute a
     WHERE a.attrelid='public.tournaments'::regclass
       AND a.attname IN('satellite_target','satellite_target_id')
       AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'WELCOME_GRAPH_SATELLITE_TARGET_TYPE_REFUSED';
  END IF;

  FOREACH v_proc IN ARRAY ARRAY[
    'public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure,
    'public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure
  ] LOOP
    v_before := pg_get_functiondef(v_proc);
    SELECT p.prosrc,
           jsonb_build_object(
             'owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
             'secdef',p.prosecdef,'volatile',p.provolatile,'parallel',p.proparallel,
             'leakproof',p.proleakproof,'language',p.prolang,'rettype',p.prorettype,
             'retset',p.proretset,'kind',p.prokind
           )
      INTO STRICT v_source,v_metadata_before
      FROM pg_proc p WHERE p.oid=v_proc;

    v_old_hits := (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
    v_new_hits := (length(v_before)-length(replace(v_before,v_new,'')))/length(v_new);
    IF v_old_hits=1 AND v_new_hits=0 THEN
      v_after := replace(v_before,v_old,v_new);
      IF replace(v_after,v_new,v_old) IS DISTINCT FROM v_before
         OR (length(v_after)-length(replace(v_after,v_new,'')))/length(v_new)<>1 THEN
        RAISE EXCEPTION 'WELCOME_GRAPH_SATELLITE_TARGET_TYPE_ROUNDTRIP_REFUSED: %',v_proc;
      END IF;
      EXECUTE v_after;
    ELSIF NOT (v_old_hits=0 AND v_new_hits=1) THEN
      RAISE EXCEPTION
        'WELCOME_GRAPH_SATELLITE_TARGET_TYPE_PREIMAGE_REFUSED: % old % new %',
        v_proc,v_old_hits,v_new_hits;
    END IF;

    SELECT p.prosrc,
           jsonb_build_object(
             'owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
             'secdef',p.prosecdef,'volatile',p.provolatile,'parallel',p.proparallel,
             'leakproof',p.proleakproof,'language',p.prolang,'rettype',p.prorettype,
             'retset',p.proretset,'kind',p.prokind
           )
      INTO STRICT v_source_after,v_metadata_after
      FROM pg_proc p WHERE p.oid=v_proc;
    IF v_source_after NOT LIKE '%'||v_new||'%'
       OR v_source_after LIKE '%'||v_old||'%'
       OR v_metadata_after IS DISTINCT FROM v_metadata_before THEN
      RAISE EXCEPTION 'WELCOME_GRAPH_SATELLITE_TARGET_TYPE_POSTIMAGE_REFUSED: %',v_proc;
    END IF;
  END LOOP;
END
$repair_welcome_graph_satellite_target_type$;

DO $assert_welcome_graph_satellite_target_authority$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
     WHERE p.oid='public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure
       AND r.rolname='postgres' AND p.prosecdef
       AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
       AND p.prorettype='jsonb'::regtype AND NOT p.proretset
       AND p.provolatile='v' AND NOT p.proleakproof AND p.proparallel='u'
       AND p.prokind='f'
  ) THEN
    RAISE EXCEPTION 'WELCOME_UNWIND_SATELLITE_TARGET_TYPE_AUTHORITY_REFUSED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
     WHERE p.oid='public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure
       AND r.rolname='postgres' AND p.prosecdef
       AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
       AND p.prorettype='jsonb'::regtype AND NOT p.proretset
       AND p.provolatile='s' AND NOT p.proleakproof AND p.proparallel='u'
       AND p.prokind='f'
  ) THEN
    RAISE EXCEPTION 'WELCOME_RESET_IMPACT_SATELLITE_TARGET_TYPE_AUTHORITY_REFUSED';
  END IF;
END
$assert_welcome_graph_satellite_target_authority$;

COMMIT;
