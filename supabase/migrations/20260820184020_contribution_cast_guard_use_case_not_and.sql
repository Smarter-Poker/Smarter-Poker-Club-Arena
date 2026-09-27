-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820184020 "contribution_cast_guard_use_case_not_and"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 13d94aa58beed366dd334034178df162 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The previous guard used `jsonb_typeof(v)='number' AND (v)::numeric > 0`.
-- SQL does not guarantee left-to-right evaluation of AND — the planner is free
-- to test the cast first, and it did, so the guard never fired. CASE is the
-- only construct with a defined evaluation order here.

DO $mig$
DECLARE
  t record;
  v_def text;
BEGIN
  FOR t IN
    SELECT oid, proname FROM pg_proc
     WHERE pronamespace='public'::regnamespace
       AND proname IN ('fn_rakeback_recompute_periods','fn_agent_downline_rake')
  LOOP
    v_def := pg_get_functiondef(t.oid);

    v_def := replace(v_def,
      'jsonb_typeof(e2.value) = ''number'' AND (e2.value)::numeric > 0',
      '(CASE WHEN jsonb_typeof(e2.value) = ''number'' THEN (e2.value)::numeric ELSE 0 END) > 0');
    v_def := replace(v_def,
      'jsonb_typeof(e.value) = ''number'' AND (e.value)::numeric > 0',
      '(CASE WHEN jsonb_typeof(e.value) = ''number'' THEN (e.value)::numeric ELSE 0 END) > 0');
    v_def := replace(v_def,
      'jsonb_typeof(k.value) = ''number'' AND (k.value)::numeric > 0',
      '(CASE WHEN jsonb_typeof(k.value) = ''number'' THEN (k.value)::numeric ELSE 0 END) > 0');

    EXECUTE v_def;
    RAISE NOTICE 'guard fixed on %', t.proname;
  END LOOP;
END $mig$;
