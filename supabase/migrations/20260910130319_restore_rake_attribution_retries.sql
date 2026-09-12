-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260910130319; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260910130319   (the stamp IS the apply time, UTC: 2026-09-10 13:03:19)
--   name        restore_rake_attribution_retries
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 8151 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260910130319 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
--
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- PREPARED ONLY: the serialized production release owner controls application.
-- Restore the committed bounded attribution retry without replacing current
-- settlement-lane exclusion, payer behavior, function identity or privileges.
-- Preimage: main c064df4a M5 body b945872c72d3414909d4b4b41cfb7849 composed
-- with d7f6f0fd migration20260910035435 => recorded live05a512317bb7bdcecfaec19ef8ee4e63.
-- Retry source: main c064df4a migration20260909202824 bodycc8ae636957b2582c7486353d57f7766.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $restore_rake_retry$
DECLARE
  v_oid oid := to_regprocedure('public.fn_settle_tournament_rake(uuid,text)');
  v_helper oid := to_regprocedure('public.fn_ca_lock_settlement_lane_global()');
  v_source text;
  v_definition text;
  v_before jsonb;
  v_after jsonb;
  v_old_1 constant text := $old_1$  v_att_err text; v_users integer; v_members integer; v_done boolean := false;$old_1$;
  v_new_1 constant text := $new_1$  v_att_err text; v_users integer; v_members integer; v_done boolean := false;
  v_attempt integer := 0; v_attempts integer := 0; v_state text;$new_1$;
  v_old_2 constant text := $old_2$  BEGIN
    v_att := public.fn_attribute_tournament_rake(p_tournament_id);
    v_att_ok := COALESCE((v_att->>'ok')::boolean, false);
    IF NOT v_att_ok THEN
      v_att_err := COALESCE(v_att->>'reason', 'attribution returned ok=false');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_att_err := SQLERRM;
    v_att := jsonb_build_object('ok', false, 'reason', v_att_err);
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_settle_tournament_rake',
            'Rake settled but attribution failed: ' || v_att_err,
            jsonb_build_object('tournament_id', p_tournament_id, 'net', v_net));
  END;$old_2$;
  v_new_2 constant text := $new_2$  /* ATTRIBUTION, RETRIED INSIDE THIS TRANSACTION (2026-09-09 - see header).
     Each attempt is its own subtransaction: a deadlock or a lock timeout
     inside it rolls back only the attempt, never the settle above. The two
     SQLSTATEs retried are the two that are transient by construction; any
     other error fails once and alerts exactly as before. */
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      v_att := public.fn_attribute_tournament_rake(p_tournament_id);
      v_att_ok := COALESCE((v_att->>'ok')::boolean, false);
      v_att_err := CASE WHEN v_att_ok THEN NULL
                        ELSE COALESCE(v_att->>'reason', 'attribution returned ok=false') END;
      EXIT;
    EXCEPTION
      WHEN deadlock_detected OR lock_not_available THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
        IF v_attempt >= 4 THEN
          v_att_err := SQLERRM || ' (after ' || v_attempt || ' attempts)';
          v_att := jsonb_build_object('ok', false, 'reason', v_att_err);
          INSERT INTO public.financial_alerts (severity, source, message, context)
          VALUES ('warning', 'fn_settle_tournament_rake',
                  'Rake settled but attribution failed: ' || v_att_err,
                  jsonb_build_object('tournament_id', p_tournament_id, 'net', v_net,
                                     'sqlstate', v_state, 'attempts', v_attempt));
          EXIT;
        END IF;
        PERFORM pg_sleep(CASE v_attempt WHEN 1 THEN 0.1 WHEN 2 THEN 0.3 ELSE 0.6 END);
      WHEN OTHERS THEN
        v_att_err := SQLERRM;
        v_att := jsonb_build_object('ok', false, 'reason', v_att_err);
        INSERT INTO public.financial_alerts (severity, source, message, context)
        VALUES ('warning', 'fn_settle_tournament_rake',
                'Rake settled but attribution failed: ' || v_att_err,
                jsonb_build_object('tournament_id', p_tournament_id, 'net', v_net,
                                   'attempts', v_attempt));
        EXIT;
    END;
  END LOOP;
  v_attempts := v_attempt;$new_2$;
  v_old_3 constant text := $old_3$                            'attributed_users', v_users, 'members', v_members);$old_3$;
  v_new_3 constant text := $new_3$                            'attributed_users', v_users, 'members', v_members,
                            'attribution_attempts', v_attempts);$new_3$;
BEGIN
  IF v_oid IS NULL OR v_helper IS NULL THEN
    RAISE EXCEPTION 'rake retry restoration refused: current rake authority or lane helper is missing';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_helper)
       IS DISTINCT FROM '343015440ea5c84ee4ca7ae583c73d30' THEN
    RAISE EXCEPTION 'rake retry restoration refused: current settlement-lane helper differs';
  END IF;
  -- Body equality does not authenticate an altered owner or search path.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid=v_oid AND proowner='postgres'::regrole AND prosecdef
       AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
       AND proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[]
       AND NOT proisstrict AND NOT proleakproof AND provolatile='v'
       AND proparallel='u'
  ) THEN
    RAISE EXCEPTION 'rake retry restoration refused: current rake metadata differs';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid=v_helper AND proowner='postgres'::regrole AND NOT prosecdef
       AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
       AND proconfig=ARRAY['search_path=public, pg_temp']::text[]
       AND NOT proisstrict AND NOT proleakproof AND provolatile='v'
       AND proparallel='u'
  ) OR has_function_privilege('anon',v_helper,'EXECUTE')
    OR has_function_privilege('authenticated',v_helper,'EXECUTE')
    OR NOT has_function_privilege('service_role',v_helper,'EXECUTE') THEN
    RAISE EXCEPTION 'rake retry restoration refused: current settlement-lane metadata or privileges differ';
  END IF;
  SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'security_definer',prosecdef,'volatile',provolatile,'parallel',proparallel,'strict',proisstrict,'leakproof',proleakproof,'language',prolang,'returns',prorettype,'arguments',proargtypes::text) INTO v_source,v_before FROM pg_proc WHERE oid=v_oid;
  IF has_function_privilege('anon',v_oid,'EXECUTE')
     OR has_function_privilege('authenticated',v_oid,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN
    RAISE EXCEPTION 'rake retry restoration refused: current service-only privileges differ';
  END IF;
  IF md5(v_source)='be08a61e1a867519048c4692b41ab1fd' THEN
    RAISE NOTICE 'RAKE_RETRY_RESTORATION_ALREADY_APPLIED';
    RETURN;
  END IF;
  IF md5(v_source)<>'05a512317bb7bdcecfaec19ef8ee4e63' THEN
    RAISE EXCEPTION 'rake retry restoration refused: current rake body differs';
  END IF;
  v_definition := pg_get_functiondef(v_oid);
  IF (length(v_definition)-length(replace(v_definition,v_old_1,'')))/length(v_old_1) <> 1 THEN
    RAISE EXCEPTION 'rake retry restoration refused: source fragment 1 is not unique';
  END IF;
  v_definition := replace(v_definition,v_old_1,v_new_1);
  IF (length(v_definition)-length(replace(v_definition,v_old_2,'')))/length(v_old_2) <> 1 THEN
    RAISE EXCEPTION 'rake retry restoration refused: source fragment 2 is not unique';
  END IF;
  v_definition := replace(v_definition,v_old_2,v_new_2);
  IF (length(v_definition)-length(replace(v_definition,v_old_3,'')))/length(v_old_3) <> 1 THEN
    RAISE EXCEPTION 'rake retry restoration refused: source fragment 3 is not unique';
  END IF;
  v_definition := replace(v_definition,v_old_3,v_new_3);
  EXECUTE v_definition;
  SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'security_definer',prosecdef,'volatile',provolatile,'parallel',proparallel,'strict',proisstrict,'leakproof',proleakproof,'language',prolang,'returns',prorettype,'arguments',proargtypes::text) INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)<>'be08a61e1a867519048c4692b41ab1fd' OR v_before IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'rake retry restoration refused: source or function metadata postcondition failed';
  END IF;
  RAISE NOTICE 'RAKE_RETRY_RESTORATION_APPLIED';
END;
$restore_rake_retry$;
COMMIT;
