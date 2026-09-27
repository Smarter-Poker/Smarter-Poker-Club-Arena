-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721160237 "settlement_period_security_definer_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 568ca76f073b4d3e70a23b8da22a09ae of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- get_current_settlement_period was SECURITY INVOKER, so its create-branch
-- INSERT was RLS-blocked from the browser (settlement_periods is service-role
-- write-only). At period rollover (no open period) it returned nothing and the
-- SPA fabricated a random-UUID period that no row backs -> orphaned settlements.
-- SECURITY DEFINER lets the get-or-create actually persist a real period.
CREATE OR REPLACE FUNCTION public.get_current_settlement_period()
 RETURNS TABLE(id uuid, period_start timestamptz, period_end timestamptz, status text, total_rake numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_now timestamptz := now(); v_start timestamptz; v_end timestamptz; v_id uuid;
BEGIN
  RETURN QUERY SELECT sp.id, sp.start_at, sp.end_at, sp.status::text, COALESCE(sp.total_rake_collected, 0)
  FROM settlement_periods sp WHERE sp.status = 'open' ORDER BY sp.start_at DESC LIMIT 1;
  IF NOT FOUND THEN
    v_start := date_trunc('week', v_now) - interval '1 day';
    v_end := v_start + interval '7 days';
    v_id := gen_random_uuid();
    INSERT INTO settlement_periods (id, start_at, end_at, status, total_rake_collected)
    VALUES (v_id, v_start, v_end, 'open', 0) ON CONFLICT DO NOTHING;
    RETURN QUERY SELECT sp.id, sp.start_at, sp.end_at, sp.status::text, COALESCE(sp.total_rake_collected, 0)
    FROM settlement_periods sp WHERE sp.id = v_id;
  END IF;
END;
$function$;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM get_current_settlement_period() LIMIT 1;
  IF r.id IS NULL THEN RAISE EXCEPTION 'get_current_settlement_period returned null id'; END IF;
END $$;
