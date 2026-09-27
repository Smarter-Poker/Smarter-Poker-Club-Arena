-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820172240 "union_ops_add_missing_auth_guards"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 201004908623532cc964d0eed2d92830 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- FIVE UI-CALLABLE FUNCTIONS HAD NO SERVER-SIDE AUTHORISATION.
--
-- When these were SQL-only, cron was the only caller and that was fine. Making
-- them reachable from the product without a guard means any signed-in user —
-- an ordinary player in any club — could call them directly against PostgREST
-- and read union-wide finances, or in the case of the sweep, write rows into
-- financial_alerts. The UI only ever shows them to overseers, but UI gating is
-- not access control.
--
-- Guard shape matches the rest of the union surface: a NULL auth.uid() is cron
-- or service_role and passes; a real user must be an overseer of that union.
--
-- The guard is inserted immediately after the function's opening BEGIN, leaving
-- the existing body untouched, so this cannot alter behaviour for callers who
-- were already authorised.

DO $mig$
DECLARE
  t record;
  v_def text;
  v_pos int;
  v_guard text;
  v_marker text := 'AS $function$';
BEGIN
  FOR t IN
    SELECT p.oid, p.proname,
           CASE p.proname
             WHEN 'fn_union_law_selftest' THEN
               '  IF auth.uid() IS NOT NULL'
               || ' AND NOT public.fn_is_platform_admin()'
               || ' AND NOT EXISTS (SELECT 1 FROM unions u'
               || ' WHERE public.fn_is_union_overseer(u.id, auth.uid())) THEN'
               || ' RAISE EXCEPTION ''not_authorised''; END IF;'
             ELSE
               '  IF auth.uid() IS NOT NULL'
               || ' AND NOT public.fn_is_union_overseer(p_union_id, auth.uid()) THEN'
               || ' RAISE EXCEPTION ''not_authorised''; END IF;'
           END AS guard
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('fn_union_agent_coverage','fn_union_club_exit_blockers',
                         'fn_union_distribution_check','fn_union_integrity_sweep',
                         'fn_union_law_selftest')
  LOOP
    v_def := pg_get_functiondef(t.oid);

    -- Already guarded (re-run safety).
    IF v_def LIKE '%not_authorised%' THEN
      RAISE NOTICE 'skip % — already guarded', t.proname;
      CONTINUE;
    END IF;

    -- Find the first BEGIN after the body marker and insert the guard after it.
    v_pos := position(v_marker in v_def);
    IF v_pos = 0 THEN
      RAISE EXCEPTION 'could not locate body marker in %', t.proname;
    END IF;

    v_pos := v_pos + length(v_marker);
    v_pos := v_pos + position(E'\nBEGIN\n' in substring(v_def from v_pos)) - 1
             + length(E'\nBEGIN\n');
    IF v_pos <= length(v_marker) THEN
      RAISE EXCEPTION 'could not locate BEGIN in %', t.proname;
    END IF;

    v_def := substring(v_def from 1 for v_pos - 1)
             || t.guard || E'\n'
             || substring(v_def from v_pos);

    EXECUTE v_def;
    RAISE NOTICE 'guarded %', t.proname;
  END LOOP;
END $mig$;
