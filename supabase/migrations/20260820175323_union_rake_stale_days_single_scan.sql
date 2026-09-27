-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820175323 "union_rake_stale_days_single_scan"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 428c2d2db2e8bac53df036d0eb0303aa of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_union_rake_stale_days(
  p_union_id uuid, p_from date, p_to_exclusive date)
RETURNS SETOF date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH live AS (
    SELECT (r.created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id AND t.union_id = p_union_id
     WHERE r.created_at >= (p_from::timestamp AT TIME ZONE 'UTC')
       AND r.created_at <  (p_to_exclusive::timestamp AT TIME ZONE 'UTC')
       AND r.player_contributions IS NOT NULL AND r.rake_amount > 0
     GROUP BY 1
  ),
  days AS (
    SELECT gs::date AS day
      FROM generate_series(p_from, p_to_exclusive - 1, interval '1 day') gs
  )
  SELECT d.day
    FROM days d
    LEFT JOIN live l ON l.day = d.day
    LEFT JOIN union_rake_rollup_days u
      ON u.union_id = p_union_id AND u.day = d.day
   WHERE u.day IS NULL
      OR u.records_seen IS DISTINCT FROM COALESCE(l.n, 0)
   ORDER BY d.day;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_rake_rollup_catchup(
  p_union_id uuid, p_max_days integer DEFAULT 3, p_lookback_days integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  d date;
  v_stale date[];
  v_done text[] := '{}';
  v_failed text[] := '{}';
  v_rolled int := 0;
BEGIN
  -- ONE scan for the whole window. This used to call
  -- fn_union_rake_day_is_fresh once per day to pick the stale days and then
  -- AGAIN once per day to count what was left -- about 20 separate full-day
  -- counts over rake_records for the default 10-day lookback, each joining
  -- ~100k rows to tables. That reliably exceeded the 8s statement timeout, so
  -- the catch-up aborted on every settler cycle and the rollup was only ever
  -- kept current by its lazy readers. Measured: 20+ scans -> timeout,
  -- one set-based scan -> 2.3s.
  v_stale := ARRAY(
    SELECT s FROM fn_union_rake_stale_days(p_union_id, v_today - p_lookback_days, v_today) s
  );

  FOREACH d IN ARRAY v_stale LOOP
    EXIT WHEN v_rolled >= GREATEST(p_max_days, 0);
    BEGIN
      PERFORM fn_union_rake_rollup_refresh_day(p_union_id, d);
      v_done := v_done || d::text;
      v_rolled := v_rolled + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed || (d::text || ':' || SQLERRM);
      v_rolled := v_rolled + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'union_id', p_union_id,
    'rolled', to_jsonb(v_done),
    'failed', to_jsonb(v_failed),
    -- Everything we did not get to this cycle. Derived from the single scan
    -- above rather than re-counting, so reporting cannot itself time out.
    'stale_remaining', GREATEST(COALESCE(array_length(v_stale, 1), 0) - v_rolled, 0));
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_rake_stale_days(uuid, date, date)
  FROM PUBLIC, anon, authenticated;
