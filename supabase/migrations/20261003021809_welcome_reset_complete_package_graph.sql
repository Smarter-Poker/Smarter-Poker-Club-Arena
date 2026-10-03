-- 20261003021809_welcome_reset_complete_package_graph.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The production reset installed by 20261002152207 narrowed tournament
-- discovery to direct schedule_id rows and SPIN/SNG rows. That accidentally
-- dropped schedule-spawn backlinks that the preceding implementation covered,
-- and it omitted the controller's SATELLITE board rows. Their tables were
-- therefore also absent from preview and reset receipts. A reset could report
-- success while leaving an unused part of the opening package behind.
--
-- Rewrite the preview and mutation authorities to derive the same complete,
-- owner-scoped package graph: tournaments linked directly or through
-- tournament_schedule_spawns, plus the pristine SPIN/SNG/SATELLITE board.
-- Existing cash, schedule, and derived-table selection remains unchanged. The rewrite is
-- replay-safe, exact-fragment guarded, reversible, and changes no club, game,
-- player, wallet, chip, receipt, or consent row.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- @live-proof: (SELECT bool_and(p.prosrc LIKE '%tournament_schedule_spawns sp%') AND bool_and(p.prosrc LIKE '%IN(''SPIN'',''SNG'',''SATELLITE'')%') AND bool_and(p.prosrc LIKE '%t.club_id=p_club_id%') FROM pg_proc p WHERE p.oid=ANY(ARRAY['public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure,'public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure]))

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $rewrite_complete_package_graph$
DECLARE
  v_proc regprocedure;
  v_before text;
  v_after text;
  v_source text;
  v_old text;
  v_new text := $new$SELECT COALESCE(array_agg(q.id ORDER BY q.id),'{}') INTO v_tournaments FROM (
    SELECT t.id FROM public.tournaments t
     WHERE t.club_id=p_club_id AND t.schedule_id=ANY(v_schedules)
    UNION
    SELECT t.id FROM public.tournament_schedule_spawns sp
    JOIN public.tournaments t ON t.id=sp.tournament_id
     WHERE sp.schedule_id=ANY(v_schedules) AND t.club_id=p_club_id
    UNION
    SELECT t.id FROM public.tournaments t
     WHERE t.club_id=p_club_id
       AND upper(COALESCE(t.tournament_type::text,'')) IN('SPIN','SNG','SATELLITE')
  ) q;$new$;
  v_preimage_md5 text;
  v_postimage_md5 text;
  v_old_hits integer;
  v_new_hits integer;
  v_metadata_before jsonb;
  v_metadata_after jsonb;
BEGIN
  FOREACH v_proc IN ARRAY ARRAY[
    'public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure,
    'public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure
  ] LOOP
    v_before := pg_get_functiondef(v_proc);
    SELECT p.prosrc,
           jsonb_build_object('owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
             'secdef',p.prosecdef,'volatile',p.provolatile,'parallel',p.proparallel,
             'leakproof',p.proleakproof,'language',p.prolang,'rettype',p.prorettype,
             'retset',p.proretset,'kind',p.prokind)
      INTO STRICT v_source,v_metadata_before
      FROM pg_proc p WHERE p.oid=v_proc;

    IF v_proc='public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure THEN
      v_preimage_md5 := '9cf532743321cafc703634efb08c3911';
      v_postimage_md5 := 'ddb572f8fa2818a746338d222cd58bfe';
      v_old := $old$SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO v_tournaments
    FROM public.tournaments
   WHERE schedule_id=ANY(v_schedules)
      OR (club_id=p_club_id AND upper(COALESCE(tournament_type::text,'')) IN('SPIN','SNG'));$old$;
    ELSE
      v_preimage_md5 := '9dedf8944a2b8ea83653d6e9329362d7';
      v_postimage_md5 := '14e783ded2c21a64a3dd2741e5fe47d5';
      v_old := $old$SELECT COALESCE(array_agg(id),'{}') INTO v_tournaments FROM public.tournaments
   WHERE schedule_id=ANY(v_schedules) OR
    (club_id=p_club_id AND upper(COALESCE(tournament_type::text,'')) IN('SPIN','SNG'));$old$;
    END IF;

    v_old_hits := (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
    v_new_hits := (length(v_before)-length(replace(v_before,v_new,'')))/length(v_new);
    IF md5(v_source)=v_preimage_md5 AND v_old_hits=1 AND v_new_hits=0 THEN
      v_after := replace(v_before,v_old,v_new);
      IF replace(v_after,v_new,v_old) IS DISTINCT FROM v_before
         OR (length(v_after)-length(replace(v_after,v_new,'')))/length(v_new)<>1 THEN
        RAISE EXCEPTION 'WELCOME_RESET_COMPLETE_GRAPH_ROUNDTRIP_REFUSED: %',v_proc;
      END IF;
      EXECUTE v_after;
    ELSIF NOT (md5(v_source)=v_postimage_md5 AND v_old_hits=0 AND v_new_hits=1) THEN
      RAISE EXCEPTION 'WELCOME_RESET_COMPLETE_GRAPH_PREIMAGE_REFUSED: % md5 % old % new %',
        v_proc,md5(v_source),v_old_hits,v_new_hits;
    END IF;

    SELECT p.prosrc,
           jsonb_build_object('owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
             'secdef',p.prosecdef,'volatile',p.provolatile,'parallel',p.proparallel,
             'leakproof',p.proleakproof,'language',p.prolang,'rettype',p.prorettype,
             'retset',p.proretset,'kind',p.prokind)
      INTO STRICT v_source,v_metadata_after
      FROM pg_proc p WHERE p.oid=v_proc;
    IF md5(v_source)<>v_postimage_md5 OR v_metadata_after IS DISTINCT FROM v_metadata_before THEN
      RAISE EXCEPTION 'WELCOME_RESET_COMPLETE_GRAPH_POSTIMAGE_REFUSED: % md5 % metadata %',
        v_proc,md5(v_source),v_metadata_after IS NOT DISTINCT FROM v_metadata_before;
    END IF;
  END LOOP;
END
$rewrite_complete_package_graph$;

DO $assert_complete_package_graph$
DECLARE
  v_unwind regprocedure := 'public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure;
  v_impact regprocedure := 'public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure;
  v_proc regprocedure;
  v_source text;
BEGIN
  FOREACH v_proc IN ARRAY ARRAY[v_unwind,v_impact] LOOP
    SELECT p.prosrc INTO STRICT v_source FROM pg_proc p WHERE p.oid=v_proc;
    IF v_source NOT LIKE '%tournament_schedule_spawns sp%'
       OR v_source NOT LIKE '%IN(''SPIN'',''SNG'',''SATELLITE'')%'
       OR v_source NOT LIKE '%JOIN public.tournaments t ON t.id=sp.tournament_id%'
       OR v_source NOT LIKE '%sp.schedule_id=ANY(v_schedules) AND t.club_id=p_club_id%'
       OR v_source LIKE '%IN(''SPIN'',''SNG'')%' THEN
      RAISE EXCEPTION 'WELCOME_RESET_COMPLETE_GRAPH_POSTIMAGE_REFUSED: %',v_proc;
    END IF;
  END LOOP;

  IF NOT EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
       WHERE p.oid=v_unwind AND r.rolname='postgres' AND p.prosecdef
         AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
         AND p.prorettype='jsonb'::regtype AND NOT p.proretset
         AND p.provolatile='v' AND NOT p.proleakproof AND p.proparallel='u'
         AND p.prokind='f'
         AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[])
     OR has_function_privilege('anon',v_unwind,'EXECUTE')
     OR has_function_privilege('authenticated',v_unwind,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_unwind,'EXECUTE')
     OR EXISTS(
       SELECT 1 FROM aclexplode(COALESCE(
         (SELECT proacl FROM pg_proc WHERE oid=v_unwind),
        acldefault('f',(SELECT proowner FROM pg_proc WHERE oid=v_unwind)))) a
        WHERE a.privilege_type='EXECUTE'
          AND a.grantee NOT IN (
            (SELECT oid FROM pg_roles WHERE rolname='postgres'),
            (SELECT oid FROM pg_roles WHERE rolname='service_role'))
     ) THEN
    RAISE EXCEPTION 'WELCOME_UNWIND_COMPLETE_GRAPH_AUTHORITY_REFUSED';
  END IF;

  IF NOT EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
       WHERE p.oid=v_impact AND r.rolname='postgres' AND p.prosecdef
         AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
         AND p.prorettype='jsonb'::regtype AND NOT p.proretset
         AND p.provolatile='s' AND NOT p.proleakproof AND p.proparallel='u'
         AND p.prokind='f'
         AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[])
     OR has_function_privilege('anon',v_impact,'EXECUTE')
     OR NOT has_function_privilege('authenticated',v_impact,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_impact,'EXECUTE')
     OR EXISTS(
       SELECT 1 FROM aclexplode(COALESCE(
         (SELECT proacl FROM pg_proc WHERE oid=v_impact),
        acldefault('f',(SELECT proowner FROM pg_proc WHERE oid=v_impact)))) a
        WHERE a.privilege_type='EXECUTE'
          AND a.grantee NOT IN (
            (SELECT oid FROM pg_roles WHERE rolname='postgres'),
            (SELECT oid FROM pg_roles WHERE rolname='authenticated'),
            (SELECT oid FROM pg_roles WHERE rolname='service_role'))
     ) THEN
    RAISE EXCEPTION 'WELCOME_RESET_IMPACT_COMPLETE_GRAPH_AUTHORITY_REFUSED';
  END IF;
END
$assert_complete_package_graph$;

COMMIT;
