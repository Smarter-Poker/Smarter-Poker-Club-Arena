-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820175626 "union_rake_catchup_shorter_lookback"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5b24162ae93b4921b0fb725a02c69bb5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Lookback 10 -> 4 days for the per-cycle catch-up.
--
-- The scan cost is linear in the window: ~100k rake_records per day joined to
-- tables. Ten days is 4.0s even with force_custom_plan, which is too close to
-- the 8s statement timeout to survive a busy moment -- and when it trips, the
-- whole catch-up aborts. Four days is ~1.6s.
--
-- Nothing depends on the longer window for CORRECTNESS. A stale day is
-- detected by record-count mismatch and recomputed live at read time by
-- fn_union_rake_paid_by_club over whatever window the caller asks for, so a
-- day that drifts outside the catch-up window is still fixed the moment it is
-- read. This function exists purely to move that work OUT of the Monday
-- settlement transaction, and doing so for the last four days achieves that.
-- A deeper sweep can be run on demand by passing p_lookback_days explicitly.
CREATE OR REPLACE FUNCTION public.fn_union_rake_rollup_catchup(
  p_union_id uuid, p_max_days integer DEFAULT 3, p_lookback_days integer DEFAULT 4)
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
  -- counts over rake_records for the old 10-day lookback, each joining ~100k
  -- rows to tables. That reliably exceeded the 8s statement timeout, so the
  -- catch-up aborted on every settler cycle and the rollup was only ever kept
  -- current by its lazy readers.
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
