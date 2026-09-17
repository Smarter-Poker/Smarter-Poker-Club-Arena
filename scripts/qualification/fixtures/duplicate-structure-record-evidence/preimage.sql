-- Captured installed pg_get_functiondef, MD5 c2ceec953ff4cb6b31741fe20b75b635.
-- Fixture bootstrap only. Never replay the historical migration's probes/status writes.
CREATE OR REPLACE FUNCTION public.fn_ca_duplicate_structure_payout_check(p_hours integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_players int := 0;
  v_events  int := 0;
  v_excess  numeric := 0;
  v_sample  jsonb;
  v_since   timestamptz := now() - make_interval(hours => GREATEST(p_hours, 1));
BEGIN
  WITH dup AS (
    SELECT tpo.tournament_id,
           tpo.user_id,
           count(*)            AS rows_,
           sum(tpo.amount)     AS paid,
           max(tpo.amount)     AS largest,
           max(tpo.created_at) AS last_at
      FROM public.tournament_payouts tpo
     WHERE tpo.source = 'structure'
       AND tpo.amount > 0
       AND tpo.created_at > v_since
     GROUP BY 1, 2
    HAVING count(*) > 1
  )
  SELECT count(*),
         count(DISTINCT tournament_id),
         COALESCE(sum(paid - largest), 0),
         COALESCE(jsonb_agg(jsonb_build_object(
           'tournament_id', tournament_id, 'user_id', user_id,
           'rows', rows_, 'paid', round(paid, 2),
           'excess', round(paid - largest, 2), 'last_at', last_at)
           ORDER BY paid - largest DESC), '[]'::jsonb)
    INTO v_players, v_events, v_excess, v_sample
    FROM dup;

  IF v_players > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical',
           'fn_ca_duplicate_structure_payout_check',
           format('%s finisher(s) across %s tournament(s) hold more than one '
                  'structure payout row for the same place; %s paid beyond the '
                  'ladder in the last %s hour(s). A place pays once.',
                  v_players, v_events, round(v_excess, 2), GREATEST(p_hours, 1)),
           jsonb_build_object('players', v_players, 'tournaments', v_events,
                              'excess', round(v_excess, 2),
                              'hours', GREATEST(p_hours, 1),
                              'sample', v_sample)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_ca_duplicate_structure_payout_check'
          AND fa.resolved IS NOT TRUE);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'hours', GREATEST(p_hours, 1),
    'players_double_paid', v_players,
    'tournaments', v_events,
    'excess', round(v_excess, 2),
    'sample', v_sample);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_duplicate_structure_payout_check(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_duplicate_structure_payout_check(integer) TO service_role;
