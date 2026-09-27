-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820183806 "harden_contribution_cast_against_non_numeric"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 40c230975f1ced7c55d496ab13c5018d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- A NON-NUMERIC CONTRIBUTION WOULD KILL A WHOLE CLUB'S WEEKLY RAKEBACK.
--
-- Both the recompute and the live downline view do `(value)::numeric` over
-- rake_records.player_contributions. jsonb casts a *string* to numeric with
-- "cannot cast jsonb string to type numeric" — an ERROR, not a NULL. One such
-- value anywhere in a club's week aborts that club's entire recompute. The new
-- fn_rakeback_recompute_all_clubs catches per club and files a warning, so the
-- visible symptom would be one club silently receiving no rakeback at all.
--
-- All 5,080,079 contribution values in the last 30 days are numbers, so this is
-- prophylactic: it costs nothing and converts a total failure into skipping the
-- one malformed contributor.

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

    IF v_def LIKE '%jsonb_typeof%' THEN
      RAISE NOTICE 'skip % — already hardened', t.proname;
      CONTINUE;
    END IF;

    -- Guard every numeric comparison over a contribution value.
    v_def := replace(v_def,
      '(e2.value)::numeric > 0',
      'jsonb_typeof(e2.value) = ''number'' AND (e2.value)::numeric > 0');
    v_def := replace(v_def,
      '(e.value)::numeric > 0',
      'jsonb_typeof(e.value) = ''number'' AND (e.value)::numeric > 0');
    v_def := replace(v_def,
      '(k.value)::numeric > 0',
      'jsonb_typeof(k.value) = ''number'' AND (k.value)::numeric > 0');

    EXECUTE v_def;
    RAISE NOTICE 'hardened %', t.proname;
  END LOOP;
END $mig$;
