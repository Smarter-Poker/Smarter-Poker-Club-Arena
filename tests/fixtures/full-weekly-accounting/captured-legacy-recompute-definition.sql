CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_all_clubs(p_period_start date DEFAULT NULL::date, p_period_end date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  v_from date := COALESCE(p_period_start, (date_trunc('week', now()) - interval '7 days')::date);
  v_to   date := COALESCE(p_period_end,   (date_trunc('week', now()) - interval '1 day')::date);
  c record;
  v_one jsonb;
  v_written int := 0;
  v_clubs int := 0;
  v_failed int := 0;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  -- Every club that belongs to a union. Private club games are excluded from
  -- union numbers elsewhere; rakeback is still owed per club, so the club is
  -- the unit here.
  FOR c IN
    SELECT DISTINCT uc.club_id FROM union_clubs uc
  LOOP
    BEGIN
      v_one := public.fn_rakeback_recompute_periods(c.club_id, v_from, v_to, NULL);
      v_written := v_written + COALESCE((v_one->>'written')::int, 0);
      v_clubs := v_clubs + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('warning', 'fn_rakeback_recompute_all_clubs',
              'Rakeback recompute failed for a club',
              jsonb_build_object('club_id', c.club_id, 'error', SQLERRM,
                                 'period_start', v_from, 'period_end', v_to));
    END;
  END LOOP;

  -- If the week produced rake but no rakeback rows at all, something upstream
  -- is broken and Round 3 is about to pay nobody. Say so before it happens.
  IF v_written = 0 AND EXISTS (
       SELECT 1 FROM rake_records r
        JOIN union_clubs uc ON uc.club_id = r.club_id
       WHERE r.created_at >= v_from::timestamptz
         AND r.created_at < (v_to + 1)::timestamptz
         AND r.rake_amount > 0
     ) THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('critical', 'fn_rakeback_recompute_all_clubs',
            'Rake was generated this period but no rakeback rows were written - Round 3 will pay nobody',
            jsonb_build_object('period_start', v_from, 'period_end', v_to,
                               'clubs_processed', v_clubs));
  END IF;

  RETURN jsonb_build_object('clubs_processed', v_clubs, 'clubs_failed', v_failed,
                            'rows_written', v_written,
                            'period_start', v_from, 'period_end', v_to, 'ran_at', now());
END $function$

