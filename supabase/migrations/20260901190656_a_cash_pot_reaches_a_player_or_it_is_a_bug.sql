-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901190656; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_cash_pot_conservation_check(
  p_since_hours integer DEFAULT 24
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_hours   integer := LEAST(GREATEST(COALESCE(p_since_hours, 24), 1), 720);
  v_since   timestamptz;
  v_hands   bigint := 0;
  v_bad     bigint := 0;
  v_chips   numeric := 0;
  v_nowin   bigint := 0;
  v_nowin_chips numeric := 0;
  v_alerts  integer := 0;
BEGIN
  v_since := now() - make_interval(hours => v_hours);

  WITH h AS (
    SELECT hh.id, hh.table_id, hh.created_at,
           COALESCE(hh.pot_size, 0)    AS pot,
           COALESCE(hh.rake_amount, 0) AS rake,
           COALESCE(hh.bbj_amount, 0)  AS bbj,
           COALESCE((SELECT sum((e->>'amount')::numeric)
                       FROM jsonb_array_elements(
                         CASE WHEN jsonb_typeof(hh.winners) = 'array'
                              THEN hh.winners ELSE '[]'::jsonb END) e
                      WHERE e ? 'amount'), 0) AS awarded,
           COALESCE(jsonb_array_length(
             CASE WHEN jsonb_typeof(hh.winners) = 'array'
                  THEN hh.winners ELSE '[]'::jsonb END), 0) AS winner_count
      FROM public.hand_history hh
     WHERE hh.tournament_id IS NULL
       AND hh.created_at >= v_since
       AND COALESCE(hh.pot_size, 0) > 0
  )
  SELECT count(*),
         count(*) FILTER (WHERE winner_count > 0 AND abs(pot - rake - bbj - awarded) > 0.01),
         COALESCE(round(sum(abs(pot - rake - bbj - awarded))
                        FILTER (WHERE winner_count > 0
                                  AND abs(pot - rake - bbj - awarded) > 0.01), 2), 0),
         count(*) FILTER (WHERE winner_count = 0),
         COALESCE(round(sum(pot - rake - bbj) FILTER (WHERE winner_count = 0), 2), 0)
    INTO v_hands, v_bad, v_chips, v_nowin, v_nowin_chips
    FROM h;

  /* One OPEN alert per condition, refreshed by resolving it. A per-hand alert
     would file thousands of rows on a bad day and bury itself, which is the
     failure 20260901170000 exists to stop. */
  IF v_bad > 0 THEN
    PERFORM public.fn_raise_server_financial_alert(
      'critical', 'fn_cash_pot_conservation_check',
      format('%s cash hand(s) in the last %sh did not distribute their pot: %s chips entered pots and did not come out to a player or the rake',
             v_bad, v_hours, v_chips),
      jsonb_build_object('kind','pot_not_distributed','hands',v_bad,
        'chips',v_chips,'since_hours',v_hours,'hands_checked',v_hands,
        'detail','no money was moved by this check'),
      'pot_not_distributed');
    v_alerts := v_alerts + 1;
  END IF;

  IF v_nowin > 0 THEN
    PERFORM public.fn_raise_server_financial_alert(
      'warning', 'fn_cash_pot_conservation_check',
      format('%s cash hand(s) in the last %sh recorded no winner at all while holding %s chips after rake',
             v_nowin, v_hours, v_nowin_chips),
      jsonb_build_object('kind','no_winner_recorded','hands',v_nowin,
        'chips',v_nowin_chips,'since_hours',v_hours,
        'detail','usually a hand interrupted at a boundary; two occurred on 2026-08-30 and none since'),
      'no_winner_recorded');
    v_alerts := v_alerts + 1;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'since_hours', v_hours,
    'hands_checked', v_hands,
    'pot_not_distributed', v_bad,
    'pot_not_distributed_chips', v_chips,
    'no_winner_recorded', v_nowin,
    'no_winner_recorded_chips', v_nowin_chips,
    'alerts_raised', v_alerts);
END;
$function$;

COMMENT ON FUNCTION public.fn_cash_pot_conservation_check(integer) IS
  'Asks of every completed cash hand whether pot_size equals rake + bbj + what the winners were awarded. The one money surface on the platform that nothing was watching. Reports through the deduped alert path and moves no money.';

REVOKE ALL ON FUNCTION public.fn_cash_pot_conservation_check(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_pot_conservation_check(integer) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_cash_pot_conservation_check') THEN
    RAISE EXCEPTION 'fn_cash_pot_conservation_check was not created';
  END IF;
END $$;
