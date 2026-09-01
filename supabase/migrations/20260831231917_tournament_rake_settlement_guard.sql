-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831231917; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_tournament_rake_settlement_check(
  p_grace_minutes integer DEFAULT 30,
  p_since_days integer DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_grace    integer := GREATEST(COALESCE(p_grace_minutes, 30), 1);
  v_days     integer := GREATEST(COALESCE(p_since_days, 7), 1);
  v_missing  integer := 0;
  v_owed     numeric := 0;
  v_oldest   timestamptz;
  v_ids      uuid[];
  v_verdict  text := 'pass';
  v_severity text;
  v_message  text;
  v_context  jsonb;
  v_alerts   integer := 0;
BEGIN
  WITH unsettled AS (
    SELECT t.id,
           t.ended_at,
           (SELECT COALESCE(sum(r.rake_amount), 0) FROM public.rake_records r
             WHERE r.tournament_id = t.id AND r.is_tournament) AS banked
      FROM public.tournaments t
     WHERE upper(COALESCE(t.status, '')) IN ('COMPLETED', 'CANCELLED', 'CANCELED')
       AND t.ended_at IS NOT NULL
       AND t.ended_at > now() - make_interval(days => v_days)
       AND t.ended_at < now() - make_interval(mins => v_grace)
       AND EXISTS (SELECT 1 FROM public.rake_records r
                    WHERE r.tournament_id = t.id AND r.is_tournament)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_rake_settlements s
                        WHERE s.tournament_id = t.id)
  )
  SELECT count(*),
         COALESCE(sum(banked), 0),
         min(ended_at),
         COALESCE((array_agg(id ORDER BY ended_at))[1:20], ARRAY[]::uuid[])
    INTO v_missing, v_owed, v_oldest, v_ids
    FROM unsettled;

  IF v_missing > 0 THEN
    v_verdict  := 'rake_never_settled';
    v_severity := CASE WHEN v_missing >= 5 OR v_owed >= 50 THEN 'critical' ELSE 'warning' END;
    v_message  := format(
      '%s terminal tournament(s) have banked rake and no settlement row after '
      '%s minutes, holding %s in rake the union has not been paid. Oldest '
      'finished %s. The attribution view cannot see these: it starts from the '
      'settlements table, and these have no row to start from.',
      v_missing, v_grace, round(v_owed, 2), v_oldest);
  END IF;

  v_context := jsonb_build_object(
    'grace_minutes',  v_grace,
    'window_days',    v_days,
    'missing_count',  v_missing,
    'rake_unpaid',    round(v_owed, 2),
    'oldest_ended_at', v_oldest,
    'sample_games',   to_jsonb(v_ids),
    'verdict',        v_verdict,
    'detail',         'the sweep settles these; this check only reports them, '
                      'so a broken sweep cannot be masked by its own watcher');

  IF v_severity IS NOT NULL THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT v_severity, 'fn_tournament_rake_settlement_check', v_message, v_context
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_tournament_rake_settlement_check'
          AND fa.resolved IS NOT TRUE
          AND fa.context->>'verdict' = v_verdict);
    IF FOUND THEN v_alerts := 1; END IF;
  END IF;

  RETURN v_context || jsonb_build_object('ok', true, 'alerts_raised', v_alerts);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_rake_settlement_check(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_tournament_rake_settlement_check(integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_tournament_rake_settlement_check(integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_rake_settlement_check(integer, integer) TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.fn_tournament_rake_settlement_check(integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the rake settlement check';
  END IF;
  IF has_function_privilege('authenticated',
       'public.fn_tournament_rake_settlement_check(integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute the rake settlement check';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_tournament_rake_settlement_check(integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute the rake settlement check';
  END IF;
END $$;
