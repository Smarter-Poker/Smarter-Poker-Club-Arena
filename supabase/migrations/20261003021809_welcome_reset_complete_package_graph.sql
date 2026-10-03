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
-- while preserving broad type-only SPIN/SNG discovery. The missing backlink
-- left a scheduled opening tournament and its table outside preview/reset;
-- the broad type predicate could instead absorb an unrelated owner-created
-- tournament. Both are unsafe definitions of the welcome package graph.
--
-- Rewrite the preview and mutation authorities to derive the same complete,
-- owner-scoped package graph: tournaments linked directly or through
-- tournament_schedule_spawns, the exact pristine twelve-row SPIN/SNG opening
-- board, and only SATELLITE feeders whose target belongs to that opening
-- schedule. Unrelated owner-created tournaments remain outside the reset
-- graph even when they use SPIN, SNG, or SATELLITE formats.
-- Existing cash, schedule, and derived-table selection remains unchanged. The rewrite is
-- replay-safe, exact-fragment guarded, reversible, and changes no club, game,
-- player, wallet, chip, receipt, or consent row.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- @live-proof: (SELECT bool_and(p.prosrc LIKE '%tournament_schedule_spawns sp%') AND bool_and(p.prosrc LIKE '%1 Chip Deep Stack Spin PLO6%') AND bool_and(p.prosrc LIKE '%target.id=t.satellite_target_id OR target.id::text=t.satellite_target%') AND bool_and(p.prosrc LIKE '%t.club_id=p_club_id%') AND bool_and(p.prosrc LIKE '%WELCOME_PACKAGE_BOARD_LINEAGE_AMBIGUOUS%' OR p.provolatile='s') FROM pg_proc p WHERE p.oid=ANY(ARRAY['public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure,'public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure]))

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
  v_new text := $new$WITH package_schedule_tournaments AS (
    SELECT t.id FROM public.tournaments t
     WHERE t.club_id=p_club_id AND t.schedule_id=ANY(v_schedules)
    UNION
    SELECT t.id FROM public.tournament_schedule_spawns sp
    JOIN public.tournaments t ON t.id=sp.tournament_id
     WHERE sp.schedule_id=ANY(v_schedules) AND t.club_id=p_club_id
  ), expected(name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,seats,stack) AS (
    VALUES
      ('NLH Heads-Up 1','NLH','sng','SNG',0.95::numeric,0.05::numeric,2,1000),
      ('PLO4 Heads-Up 1','PLO4','sng','SNG',0.95::numeric,0.05::numeric,2,1000),
      ('NLH Heads-Up 1 Turbo','NLH','sng','SNG',0.95::numeric,0.05::numeric,2,300),
      ('PLO4 Heads-Up 1 Turbo','PLO4','sng','SNG',0.95::numeric,0.05::numeric,2,300),
      ('1 Chip Spin NLH','NLH','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO4','PLO4','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO5','PLO5','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO6','PLO6','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Deep Stack Spin NLH','NLH','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO4','PLO4','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO5','PLO5','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO6','PLO6','spin','SPIN',1::numeric,0::numeric,3,1000)
  )
  SELECT COALESCE(array_agg(q.id ORDER BY q.id),'{}') INTO v_tournaments FROM (
    SELECT p.id FROM package_schedule_tournaments p
    UNION
    SELECT t.id FROM public.tournaments t JOIN expected e
      ON t.name=e.name AND upper(COALESCE(t.game_type,''))=e.game_type
     AND lower(COALESCE(t.variant,''))=e.variant
     AND upper(COALESCE(t.tournament_type::text,''))=e.tournament_type
     AND t.buy_in_amount=e.buy_in_amount AND t.buy_in_fee=e.buy_in_fee
     AND t.max_players=e.seats AND t.min_players=e.seats
     AND t.table_size=e.seats AND t.starting_chips=e.stack
     WHERE t.club_id=p_club_id AND t.union_id IS NULL AND t.schedule_id IS NULL
       AND t.restart_source_id IS NULL AND t.satellite_target_id IS NULL
       AND t.satellite_target IS NULL
    UNION
    SELECT t.id FROM public.tournaments t
     WHERE t.club_id=p_club_id AND t.union_id IS NULL
       AND upper(COALESCE(t.tournament_type::text,''))='SATELLITE'
       AND EXISTS(
         SELECT 1 FROM package_schedule_tournaments target
          WHERE target.id=t.satellite_target_id OR target.id::text=t.satellite_target
       )
  ) q;$new$;
  v_preimage_md5 text;
  v_postimage_md5 text;
  v_old_hits integer;
  v_new_hits integer;
  v_metadata_before jsonb;
  v_metadata_after jsonb;
  v_lock_old text := $lock_old$SELECT COALESCE(array_agg(entity_id ORDER BY entity_id),'{}') INTO v_schedules
    FROM public.club_welcome_package_items
   WHERE club_id=p_club_id AND entity_kind='tournament_schedule' AND retired_at IS NULL;$lock_old$;
  v_lock_new text := $lock_new$SELECT COALESCE(array_agg(entity_id ORDER BY entity_id),'{}') INTO v_schedules
    FROM public.club_welcome_package_items
   WHERE club_id=p_club_id AND entity_kind='tournament_schedule' AND retired_at IS NULL;
  PERFORM 1 FROM public.tournament_schedules WHERE id=ANY(v_schedules) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.tournament_schedule_spawns
   WHERE schedule_id=ANY(v_schedules) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.tournaments t
   WHERE t.club_id=p_club_id AND (
     upper(COALESCE(t.tournament_type::text,'')) IN('SPIN','SNG','SATELLITE')
     OR t.schedule_id=ANY(v_schedules) OR EXISTS(
       SELECT 1 FROM public.tournament_schedule_spawns sp
        WHERE sp.tournament_id=t.id AND sp.schedule_id=ANY(v_schedules)
     )
   ) ORDER BY t.id FOR UPDATE;
  IF NOT (WITH expected(name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,seats,stack) AS (
    VALUES
      ('NLH Heads-Up 1','NLH','sng','SNG',0.95::numeric,0.05::numeric,2,1000),
      ('PLO4 Heads-Up 1','PLO4','sng','SNG',0.95::numeric,0.05::numeric,2,1000),
      ('NLH Heads-Up 1 Turbo','NLH','sng','SNG',0.95::numeric,0.05::numeric,2,300),
      ('PLO4 Heads-Up 1 Turbo','PLO4','sng','SNG',0.95::numeric,0.05::numeric,2,300),
      ('1 Chip Spin NLH','NLH','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO4','PLO4','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO5','PLO5','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO6','PLO6','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Deep Stack Spin NLH','NLH','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO4','PLO4','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO5','PLO5','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO6','PLO6','spin','SPIN',1::numeric,0::numeric,3,1000)
  ), candidates AS (
    SELECT e.name FROM public.tournaments t JOIN expected e
      ON t.name=e.name AND upper(COALESCE(t.game_type,''))=e.game_type
     AND lower(COALESCE(t.variant,''))=e.variant
     AND upper(COALESCE(t.tournament_type::text,''))=e.tournament_type
     AND t.buy_in_amount=e.buy_in_amount AND t.buy_in_fee=e.buy_in_fee
     AND t.max_players=e.seats AND t.min_players=e.seats
     AND t.table_size=e.seats AND t.starting_chips=e.stack
     WHERE t.club_id=p_club_id AND t.union_id IS NULL AND t.schedule_id IS NULL
       AND t.restart_source_id IS NULL AND t.satellite_target_id IS NULL
       AND t.satellite_target IS NULL
  ) SELECT count(*)=0 OR (count(*)=12 AND count(DISTINCT name)=12) FROM candidates) THEN
    RAISE EXCEPTION 'WELCOME_PACKAGE_BOARD_LINEAGE_AMBIGUOUS' USING ERRCODE='55000';
  END IF;$lock_new$;
  v_econ_old text := $econ_old$) INTO v_economics;
  RETURN jsonb_build_object$econ_old$;
  v_econ_new text := $econ_new$) INTO v_economics;
  IF NOT (WITH expected(name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,seats,stack) AS (
    VALUES
      ('NLH Heads-Up 1','NLH','sng','SNG',0.95::numeric,0.05::numeric,2,1000),
      ('PLO4 Heads-Up 1','PLO4','sng','SNG',0.95::numeric,0.05::numeric,2,1000),
      ('NLH Heads-Up 1 Turbo','NLH','sng','SNG',0.95::numeric,0.05::numeric,2,300),
      ('PLO4 Heads-Up 1 Turbo','PLO4','sng','SNG',0.95::numeric,0.05::numeric,2,300),
      ('1 Chip Spin NLH','NLH','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO4','PLO4','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO5','PLO5','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO6','PLO6','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Deep Stack Spin NLH','NLH','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO4','PLO4','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO5','PLO5','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO6','PLO6','spin','SPIN',1::numeric,0::numeric,3,1000)
  ), candidates AS (
    SELECT e.name FROM public.tournaments t JOIN expected e
      ON t.name=e.name AND upper(COALESCE(t.game_type,''))=e.game_type
     AND lower(COALESCE(t.variant,''))=e.variant
     AND upper(COALESCE(t.tournament_type::text,''))=e.tournament_type
     AND t.buy_in_amount=e.buy_in_amount AND t.buy_in_fee=e.buy_in_fee
     AND t.max_players=e.seats AND t.min_players=e.seats
     AND t.table_size=e.seats AND t.starting_chips=e.stack
     WHERE t.club_id=p_club_id AND t.union_id IS NULL AND t.schedule_id IS NULL
       AND t.restart_source_id IS NULL AND t.satellite_target_id IS NULL
       AND t.satellite_target IS NULL
  ) SELECT count(*)=0 OR (count(*)=12 AND count(DISTINCT name)=12) FROM candidates) THEN
    v_economics:=false;
  END IF;
  RETURN jsonb_build_object$econ_new$;
  v_lock_old_hits integer;
  v_lock_new_hits integer;
  v_econ_old_hits integer;
  v_econ_new_hits integer;
  v_reversed text;
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
      v_postimage_md5 := 'baf9d702c714d90a697f0a1850c44389';
      v_old := $old$SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO v_tournaments
    FROM public.tournaments
   WHERE schedule_id=ANY(v_schedules)
      OR (club_id=p_club_id AND upper(COALESCE(tournament_type::text,'')) IN('SPIN','SNG'));$old$;
    ELSE
      v_preimage_md5 := '9dedf8944a2b8ea83653d6e9329362d7';
      v_postimage_md5 := '74d99b51f3757c9f43d797eb6b7f95da';
      v_old := $old$SELECT COALESCE(array_agg(id),'{}') INTO v_tournaments FROM public.tournaments
   WHERE schedule_id=ANY(v_schedules) OR
    (club_id=p_club_id AND upper(COALESCE(tournament_type::text,'')) IN('SPIN','SNG'));$old$;
    END IF;

    v_old_hits := (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
    v_new_hits := (length(v_before)-length(replace(v_before,v_new,'')))/length(v_new);
    v_lock_old_hits := (length(v_before)-length(replace(v_before,v_lock_old,'')))/length(v_lock_old);
    v_lock_new_hits := (length(v_before)-length(replace(v_before,v_lock_new,'')))/length(v_lock_new);
    v_econ_old_hits := (length(v_before)-length(replace(v_before,v_econ_old,'')))/length(v_econ_old);
    v_econ_new_hits := (length(v_before)-length(replace(v_before,v_econ_new,'')))/length(v_econ_new);
    IF md5(v_source)=v_preimage_md5 AND v_old_hits=1 AND v_new_hits=0 THEN
      v_after := replace(v_before,v_old,v_new);
      IF v_proc='public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure THEN
        IF v_lock_old_hits<>1 OR v_lock_new_hits<>0 THEN
          RAISE EXCEPTION 'WELCOME_RESET_COMPLETE_GRAPH_LOCK_PREIMAGE_REFUSED: old % new %',
            v_lock_old_hits,v_lock_new_hits;
        END IF;
        v_after := replace(v_after,v_lock_old,v_lock_new);
      ELSE
        IF v_econ_old_hits<>1 OR v_econ_new_hits<>0 THEN
          RAISE EXCEPTION 'WELCOME_RESET_COMPLETE_GRAPH_ECONOMICS_PREIMAGE_REFUSED: old % new %',
            v_econ_old_hits,v_econ_new_hits;
        END IF;
        v_after := replace(v_after,v_econ_old,v_econ_new);
      END IF;
      v_reversed := replace(v_after,v_new,v_old);
      IF v_proc='public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure THEN
        v_reversed := replace(v_reversed,v_lock_new,v_lock_old);
      ELSE
        v_reversed := replace(v_reversed,v_econ_new,v_econ_old);
      END IF;
      IF v_reversed IS DISTINCT FROM v_before
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
       OR v_source NOT LIKE '%1 Chip Deep Stack Spin PLO6%'
       OR v_source NOT LIKE '%JOIN public.tournaments t ON t.id=sp.tournament_id%'
       OR v_source NOT LIKE '%sp.schedule_id=ANY(v_schedules) AND t.club_id=p_club_id%'
       OR v_source NOT LIKE '%target.id=t.satellite_target_id OR target.id::text=t.satellite_target%' THEN
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
