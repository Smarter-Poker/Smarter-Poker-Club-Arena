-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823050839 "trigger_fn_not_directly_callable_by_clients"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4b8df725494ffe46892c55a449d4a396 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- fn_sync_tournament_current_players() RETURNS trigger, is SECURITY DEFINER,
-- writes, and was EXECUTE-able by PUBLIC/anon/authenticated. A trigger
-- function needs no EXECUTE grant for its trigger to fire - the trigger runs
-- in the context of the statement that fired it - so those grants only ever
-- offered a browser role a way to invoke it directly.
--
-- It has one attached trigger, which is unaffected. Last of the four
-- functions failing the required invariant
-- `anon_mutating_definer_functions_check_auth_uid`, which reads the live
-- catalog and therefore reddens CHECK 10 on every open pull request in the
-- estate.
REVOKE EXECUTE ON FUNCTION public.fn_sync_tournament_current_players() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE v_bad int; v_trig int; v_fail int;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_sync_tournament_current_players'
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'trigger function is still directly callable by a browser role';
  END IF;

  SELECT count(*) INTO v_trig
  FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
  WHERE p.proname = 'fn_sync_tournament_current_players' AND NOT tg.tgisinternal;
  IF v_trig < 1 THEN
    RAISE EXCEPTION 'the trigger that uses this function has gone';
  END IF;

  -- The whole point: the invariant that gates every PR must now be green.
  SELECT count(*) INTO v_fail FROM public.economy_invariants() WHERE NOT ok;
  IF v_fail > 0 THEN
    RAISE EXCEPTION 'economy invariants still failing: %', v_fail;
  END IF;
END $$;
