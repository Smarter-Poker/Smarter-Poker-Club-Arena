-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827153334; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- A minutes column stops holding a level count (2026-08-27).
-- See repo migration 20260827_late_reg_mins_stops_holding_a_level_count.sql
-- for the full header. Surgical: rewrites ONLY the late_reg_mins argument of
-- fn_create_tournament's INSERT, leaving the rest of the body untouched.

DO $$
DECLARE
  v_src  text;
  v_new  text;
  v_old  text := E'    COALESCE((p_config->>''lateRegistrationLevels'')::int, 0),\n'
              || E'    COALESCE((p_config->>''lateRegistrationLevels'')::int, 0),\n'
              || E'    COALESCE((p_config->>''lateRegistrationLevels'')::int, 0),';
  v_fix  text := E'    COALESCE((p_config->>''lateRegistrationLevels'')::int, 0),\n'
              || E'    COALESCE((p_config->>''lateRegistrationMinutes'')::int, 0),\n'
              || E'    COALESCE((p_config->>''lateRegistrationLevels'')::int, 0),';
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
    FROM pg_proc WHERE proname = 'fn_create_tournament';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'late_reg_mins: fn_create_tournament not found';
  END IF;

  IF position(v_old in v_src) = 0 THEN
    IF position('lateRegistrationMinutes' in v_src) > 0 THEN
      RAISE NOTICE 'late_reg_mins: already fixed, nothing to do';
      RETURN;
    END IF;
    RAISE EXCEPTION 'late_reg_mins: could not locate the three-line late-reg block; fix by hand';
  END IF;

  v_new := replace(v_src, v_old, v_fix);
  EXECUTE v_new;
END $$;

UPDATE public.tournaments
   SET late_reg_mins = 0
 WHERE status IN ('REGISTERING', 'ANNOUNCED')
   AND COALESCE(late_reg_mins, 0) > 0
   AND COALESCE(late_reg_mins, 0) = COALESCE(late_reg_levels, 0);

DO $$
DECLARE
  v_bad int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'fn_create_tournament'
       AND prosrc LIKE '%lateRegistrationMinutes%'
  ) THEN
    RAISE EXCEPTION 'late_reg_mins: RPC still writes the level count';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'fn_create_tournament'
       AND prosrc LIKE '%trunc(v_total%'
  ) THEN
    RAISE EXCEPTION 'late_reg_mins: the fee formula was damaged by the rewrite';
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.tournaments
   WHERE status IN ('REGISTERING', 'ANNOUNCED')
     AND COALESCE(late_reg_mins, 0) > 0
     AND COALESCE(late_reg_mins, 0) = COALESCE(late_reg_levels, 0);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'late_reg_mins: % open tournaments still carry a level count', v_bad;
  END IF;
END $$;
