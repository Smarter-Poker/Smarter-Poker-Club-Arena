-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820193828 "rollup_gap_alerting_alias_fix"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a37ed2e170cb6b821d27b6d8ed758ca5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The gap query aliased a subquery `c`, which is also the name of the PL/pgSQL
-- loop record — "column reference c.club_id is ambiguous". Renamed. Caught here
-- rather than at :25 past the hour, where it would have aborted the whole
-- catch-up and left the rollup to rot.

CREATE OR REPLACE FUNCTION public.fn_club_rake_rollup_catchup(p_days integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '600s'
AS $$
DECLARE
  rec record; d date;
  v_days int := 0; v_rows int := 0; v_fail int := 0; v_gaps int := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR rec IN
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
                  WHERE club_id = rec.club_id AND day = d) THEN
        CONTINUE;
      END IF;
      BEGIN
        v_rows := v_rows + public.fn_club_rake_rollup_day(rec.club_id, d);
        v_days := v_days + 1;
      EXCEPTION WHEN OTHERS THEN
        v_fail := v_fail + 1;
      END;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_gaps
    FROM (SELECT DISTINCT club_id AS cid FROM rake_records
           WHERE created_at >= current_date - GREATEST(p_days,1) - 1
             AND club_id IS NOT NULL) src
    CROSS JOIN generate_series(current_date - GREATEST(p_days,1),
                               current_date - 1, interval '1 day') g
   WHERE NOT EXISTS (SELECT 1 FROM club_rake_rollup_complete rc
                      WHERE rc.club_id = src.cid AND rc.day = g::date);

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
