-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260723175912 "ca_sweep3c_fix_current_period_getorcreate_not_nulls"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 658189e9efbd882e96d61ec814d4e242 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Sweep #3c: get_current_settlement_period's INSERT omitted the NOT NULL
-- period_number/year columns, so creating a fresh period (once no period is
-- open) would raise. Fill them: year = ISO year, period_number = ISO week,
-- and keep the same return shape.
CREATE OR REPLACE FUNCTION public.get_current_settlement_period()
RETURNS TABLE(id uuid, period_start timestamp with time zone, period_end timestamp with time zone, status text, total_rake numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_now timestamptz := now(); v_start timestamptz; v_end timestamptz;
BEGIN
  -- Existing open period wins.
  RETURN QUERY SELECT sp.id, sp.start_at, sp.end_at, sp.status::text, COALESCE(sp.total_rake_collected, 0)
  FROM settlement_periods sp WHERE sp.status = 'open' ORDER BY sp.start_at DESC LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- None open: create one. The partial-unique index makes concurrent creates safe.
  v_start := date_trunc('week', v_now) - interval '1 day';
  v_end := v_start + interval '7 days';
  INSERT INTO settlement_periods (id, start_at, end_at, status, total_rake_collected, period_number, year)
  VALUES (gen_random_uuid(), v_start, v_end, 'open', 0,
          EXTRACT(week FROM v_start)::int, EXTRACT(isoyear FROM v_start)::int)
  ON CONFLICT DO NOTHING;

  -- Re-select the open period (works whether our insert won or a concurrent one did).
  RETURN QUERY SELECT sp.id, sp.start_at, sp.end_at, sp.status::text, COALESCE(sp.total_rake_collected, 0)
  FROM settlement_periods sp WHERE sp.status = 'open' ORDER BY sp.start_at DESC LIMIT 1;
END;
$function$;
