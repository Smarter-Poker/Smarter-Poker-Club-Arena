-- The rake guard that could not see a missing row.
--
-- v_tournament_rake_attribution_gaps is the estate's watcher for tournament
-- rake, and it opens with
--
--     FROM tournament_rake_settlements r
--     LEFT JOIN tournaments t ON t.id = r.tournament_id
--
-- so it can tell you that a settlement credited nobody, or threw, or was never
-- measured. What it cannot tell you is that a settlement DOES NOT EXIST. A
-- tournament that finished and was never settled at all has no row to start
-- from, so it is not a gap the view can report -- it is simply absent from the
-- query.
--
-- On 2026-08-31 that blind spot cost 215.98 in union rake across 29 terminal
-- events over two and a half hours. fn_sweep_unsettled_tournament_rake, the
-- safety net, was deadlocking against the live engine on every pass and
-- settling nothing; the attribution view stayed at zero rows the whole time,
-- because every settlement it could see was fine. The ones that were wrong
-- were the ones that were not there.
--
-- This check starts from the tournaments instead: terminal, has banked rake in
-- rake_records, and no settlement row. That is the same candidate predicate
-- the sweep itself uses, which is the point -- if the sweep has work it is not
-- doing, this says so.
--
-- The grace window matters. Settlement normally lands at or before the moment
-- ended_at is stamped (2,485 spins in the 24h before this shipped, max lag
-- under half a second), and the sweep runs every 10 minutes, so anything still
-- unsettled after 30 minutes is not latency.
--
-- CLAUDE.md 10.5, horses are players: no is_horse filter, no p_include_horses.
--
-- The function reads and alerts. It settles nothing and moves no money -- that
-- is the sweep's job, and quietly doing it here would hide the very failure
-- this exists to report.

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
    -- One event past the grace window is a hiccup; a pile of them is the sweep
    -- failing, which is what actually happens.
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
