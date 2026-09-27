-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820193738 "rollup_gap_alerting"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1037e2c19427245eee6d21f3389c8f21 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- A missing rollup day is now correct-but-slow rather than silently wrong
-- (measured: 145ms warm vs 7,098ms with one gap day in a 7-day window). That
-- makes staleness a performance problem instead of a money problem, which is
-- the right trade — but it still needs to be visible, or the Rake tab quietly
-- degrades and nobody knows why.

CREATE OR REPLACE FUNCTION public.fn_club_rake_rollup_catchup(p_days integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '600s'
AS $$
DECLARE
  c record; d date;
  v_days int := 0; v_rows int := 0; v_fail int := 0; v_gaps int := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR c IN
    SELECT DISTINCT club_id FROM union_clubs
    UNION
    SELECT DISTINCT r.club_id FROM rake_records r
     WHERE r.club_id IS NOT NULL
       AND r.created_at >= current_date - GREATEST(p_days,1) - 1
  LOOP
    FOR d IN
      SELECT gs::date FROM generate_series(
               current_date - GREATEST(p_days,1), current_date - 1, interval '1 day') gs
    LOOP
      IF EXISTS (SELECT 1 FROM club_rake_rollup_complete
                  WHERE club_id = c.club_id AND day = d) THEN
        CONTINUE;
      END IF;
      BEGIN
        v_rows := v_rows + public.fn_club_rake_rollup_day(c.club_id, d);
        v_days := v_days + 1;
      EXCEPTION WHEN OTHERS THEN
        v_fail := v_fail + 1;
      END;
    END LOOP;
  END LOOP;

  -- Anything still uncovered after a full pass is a real gap: the live view is
  -- now paying a scan for it on every refresh.
  SELECT count(*) INTO v_gaps
    FROM (SELECT DISTINCT club_id FROM rake_records
           WHERE created_at >= current_date - GREATEST(p_days,1) - 1
             AND club_id IS NOT NULL) c
    CROSS JOIN generate_series(current_date - GREATEST(p_days,1),
                               current_date - 1, interval '1 day') g
   WHERE NOT EXISTS (SELECT 1 FROM club_rake_rollup_complete rc
                      WHERE rc.club_id = c.club_id AND rc.day = g::date);

  IF v_gaps > 0 THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_club_rake_rollup_catchup',
            'Club rake rollup has uncovered days — the live downline view is falling back to full scans',
            jsonb_build_object('gap_club_days', v_gaps, 'lookback_days', p_days,
                               'failures', v_fail, 'ran_at', now()));
  END IF;

  RETURN jsonb_build_object('days_built', v_days, 'rows', v_rows,
                            'failures', v_fail, 'remaining_gaps', v_gaps,
                            'ran_at', now());
END $$;

REVOKE ALL ON FUNCTION public.fn_club_rake_rollup_catchup(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_rake_rollup_catchup(integer) TO service_role;
