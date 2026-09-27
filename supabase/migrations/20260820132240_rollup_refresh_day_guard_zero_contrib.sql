-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820132240 "rollup_refresh_day_guard_zero_contrib"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4eed0d0379d9db2a4548683474cde18d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- 2026-08-20 re-audit: fn_union_rake_rollup_refresh_day divided by the
-- per-record contribution total with no guard. The legacy/live computation
-- filters `total_contrib > 0`; the finalizer did not. A single rake_records
-- row whose player_contributions sum to 0 would raise division_by_zero, the
-- day would never finalize, and — because a non-finalized day is recomputed
-- live at read time — it would silently fall back to the slow path forever
-- with no error surfaced anywhere.
--
-- None exist today (0 such rows in the last 7 days on union tables), so this
-- is pre-emptive. NULLIF makes the share NULL instead of raising, and the
-- existing `WHERE expanded.share IS NOT NULL` filter already drops it —
-- matching the live function's behaviour exactly. No change when the total
-- is positive.
CREATE OR REPLACE FUNCTION public.fn_union_rake_rollup_refresh_day(
  p_union_id uuid, p_day date)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz := (p_day::timestamp AT TIME ZONE 'UTC');
  v_end   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_records integer;
BEGIN
  IF v_end > now() THEN
    RAISE EXCEPTION 'union rake rollup: day % is not complete (UTC); refusing to finalize', p_day;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('union_rake_rollup:' || p_union_id::text || ':' || p_day::text, 42));

  DELETE FROM union_rake_rollup_days
   WHERE union_id = p_union_id AND day = p_day;  -- cascades to detail

  SELECT count(*) INTO v_records
    FROM rake_records r
    JOIN tables t ON t.id = r.table_id AND t.union_id = p_union_id
   WHERE r.created_at >= v_start AND r.created_at < v_end
     AND r.player_contributions IS NOT NULL AND r.rake_amount > 0;

  INSERT INTO union_rake_rollup_days (union_id, day, records_seen)
  VALUES (p_union_id, p_day, v_records);

  INSERT INTO union_rake_paid_daily_user (union_id, day, user_id, rake_amount)
  WITH expanded AS (
    SELECT (e.key)::uuid AS user_id,
           r.rake_amount * (e.value)::numeric
             / NULLIF(SUM((e.value)::numeric) OVER (PARTITION BY r.id), 0) AS share
      FROM rake_records r
      JOIN tables t ON t.id = r.table_id AND t.union_id = p_union_id
      CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) e(key, value)
     WHERE r.created_at >= v_start AND r.created_at < v_end
       AND r.player_contributions IS NOT NULL AND r.rake_amount > 0
  )
  SELECT p_union_id, p_day, expanded.user_id, SUM(expanded.share)
    FROM expanded
   WHERE expanded.share IS NOT NULL
   GROUP BY expanded.user_id;
END;
$function$;
