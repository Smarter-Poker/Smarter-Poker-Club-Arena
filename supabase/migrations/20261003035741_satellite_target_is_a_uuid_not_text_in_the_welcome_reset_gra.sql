-- 20261003035741_satellite_target_is_a_uuid_not_text_in_the_welcome_reset_gra.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20261003021809_welcome_reset_complete_package_graph installed the SATELLITE
-- leg of the welcome-package graph as
--
--     WHERE target.id=t.satellite_target_id OR target.id::text=t.satellite_target
--
-- public.tournaments.satellite_target is of type uuid, not text. Casting the
-- LEFT side to text therefore asks Postgres for `text = uuid`, an operator
-- that does not exist, and both authorities raise
--
--     42883  operator does not exist: text = uuid
--
-- the first time that branch is planned. fn_get_club_welcome_package_reset_impact
-- is called immediately before Club Create Certification's own probe, so every
-- run of that certification has died there since the fragment shipped
-- (run 37094163115 is the recorded failure).
--
-- The repair is the cast: compare uuid to uuid. The predicate's intent is
-- unchanged - a SATELLITE feeder belongs to the package graph when its target
-- is one of the package's tournaments, reached through either the current
-- satellite_target_id backlink or the legacy satellite_target column - and
-- both columns already hold the target's uuid.
--
-- WHY IT PASSED REVIEW AND REHEARSAL. scripts/ci/test-club-welcome-package.py
-- builds its rehearsal fixture with `satellite_target text`, so the local
-- Postgres run resolved `text = text` and went green while production could
-- only ever raise. That fixture column is corrected to uuid in this same
-- commit: a fixture that does not carry production's type cannot refuse a
-- type error, and this is the line that let one through.
--
-- This migration changes no club, game, player, wallet, chip, receipt or
-- consent row. It rewrites two function bodies by exact-fragment substitution,
-- refuses unless the fragment appears exactly once, proves the substitution is
-- reversible to the byte, re-reads both functions afterwards and requires
-- every catalogue attribute (owner, acl, config, secdef, volatility,
-- parallel safety, leakproofness, language, return type, kind) to be
-- identical to what it found. Replay is a no-op: a body already carrying the
-- repaired fragment is left alone.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- @live-proof: (SELECT bool_and(p.prosrc LIKE '%target.id=t.satellite_target_id OR target.id=t.satellite_target%') AND bool_and(p.prosrc NOT LIKE '%target.id::text=t.satellite_target%') FROM pg_proc p WHERE p.oid=ANY(ARRAY['public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure,'public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure]))

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $satellite_target_is_a_uuid$
DECLARE
  v_proc regprocedure;
  v_before text;
  v_after text;
  v_reversed text;
  v_source text;
  v_metadata_before jsonb;
  v_metadata_after jsonb;
  v_old_hits integer;
  v_new_hits integer;
  v_old text := $old$target.id=t.satellite_target_id OR target.id::text=t.satellite_target$old$;
  v_new text := $new$target.id=t.satellite_target_id OR target.id=t.satellite_target$new$;
BEGIN
  -- The repair is only correct if the column really is uuid. Read the type
  -- from the catalogue and refuse rather than install the other mistake.
  IF (SELECT a.atttypid FROM pg_attribute a
       WHERE a.attrelid='public.tournaments'::regclass
         AND a.attname='satellite_target' AND NOT a.attisdropped) <> 'uuid'::regtype THEN
    RAISE EXCEPTION 'SATELLITE_TARGET_IS_NOT_UUID_REFUSED: %',
      (SELECT format_type(a.atttypid,a.atttypmod) FROM pg_attribute a
        WHERE a.attrelid='public.tournaments'::regclass
          AND a.attname='satellite_target' AND NOT a.attisdropped);
  END IF;
  IF (SELECT a.atttypid FROM pg_attribute a
       WHERE a.attrelid='public.tournaments'::regclass
         AND a.attname='satellite_target_id' AND NOT a.attisdropped) <> 'uuid'::regtype THEN
    RAISE EXCEPTION 'SATELLITE_TARGET_ID_IS_NOT_UUID_REFUSED';
  END IF;

  FOREACH v_proc IN ARRAY ARRAY[
    'public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure,
    'public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure
  ] LOOP
    v_before := pg_get_functiondef(v_proc);
    SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
             'secdef',p.prosecdef,'volatile',p.provolatile,'parallel',p.proparallel,
             'leakproof',p.proleakproof,'language',p.prolang,'rettype',p.prorettype,
             'retset',p.proretset,'kind',p.prokind)
      INTO STRICT v_metadata_before
      FROM pg_proc p WHERE p.oid=v_proc;

    v_old_hits := (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
    v_new_hits := (length(v_before)-length(replace(v_before,v_new,'')))/length(v_new);

    IF v_old_hits=1 AND v_new_hits=0 THEN
      v_after := replace(v_before,v_old,v_new);
      v_reversed := replace(v_after,v_new,v_old);
      IF v_reversed IS DISTINCT FROM v_before
         OR (length(v_after)-length(replace(v_after,v_new,'')))/length(v_new)<>1 THEN
        RAISE EXCEPTION 'SATELLITE_TARGET_UUID_ROUNDTRIP_REFUSED: %',v_proc;
      END IF;
      EXECUTE v_after;
    ELSIF NOT (v_old_hits=0 AND v_new_hits=1) THEN
      RAISE EXCEPTION 'SATELLITE_TARGET_UUID_PREIMAGE_REFUSED: % old % new %',
        v_proc,v_old_hits,v_new_hits;
    END IF;

    SELECT p.prosrc,
           jsonb_build_object('owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
             'secdef',p.prosecdef,'volatile',p.provolatile,'parallel',p.proparallel,
             'leakproof',p.proleakproof,'language',p.prolang,'rettype',p.prorettype,
             'retset',p.proretset,'kind',p.prokind)
      INTO STRICT v_source,v_metadata_after
      FROM pg_proc p WHERE p.oid=v_proc;
    IF v_source NOT LIKE '%target.id=t.satellite_target_id OR target.id=t.satellite_target%'
       OR position('target.id::text=t.satellite_target' in v_source)>0
       OR v_metadata_after IS DISTINCT FROM v_metadata_before THEN
      RAISE EXCEPTION 'SATELLITE_TARGET_UUID_POSTIMAGE_REFUSED: % metadata %',
        v_proc,v_metadata_after IS NOT DISTINCT FROM v_metadata_before;
    END IF;

    -- The body is plpgsql, so creating it does not plan its SQL. Plan the
    -- repaired comparison here, over no rows, so this migration fails rather
    -- than production if the operator still cannot be resolved.
    PERFORM 1 FROM public.tournaments t
      JOIN public.tournaments target
        ON target.id=t.satellite_target_id OR target.id=t.satellite_target
     WHERE false;
  END LOOP;
END
$satellite_target_is_a_uuid$;

DO $assert_satellite_target_is_a_uuid$
DECLARE
  v_proc regprocedure;
  v_source text;
BEGIN
  FOREACH v_proc IN ARRAY ARRAY[
    'public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure,
    'public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure
  ] LOOP
    SELECT p.prosrc INTO STRICT v_source FROM pg_proc p WHERE p.oid=v_proc;
    -- The cast is gone and nothing else in the complete-graph rewrite moved.
    IF v_source NOT LIKE '%target.id=t.satellite_target_id OR target.id=t.satellite_target%'
       OR v_source LIKE '%target.id::text=t.satellite_target%'
       OR v_source NOT LIKE '%tournament_schedule_spawns sp%'
       OR v_source NOT LIKE '%JOIN public.tournaments t ON t.id=sp.tournament_id%'
       OR v_source NOT LIKE '%sp.schedule_id=ANY(v_schedules) AND t.club_id=p_club_id%'
       OR v_source NOT LIKE '%1 Chip Deep Stack Spin PLO6%'
       OR v_source NOT LIKE '%t.club_id=p_club_id%' THEN
      RAISE EXCEPTION 'SATELLITE_TARGET_UUID_GRAPH_REFUSED: %',v_proc;
    END IF;
  END LOOP;
END
$assert_satellite_target_is_a_uuid$;

COMMIT;
