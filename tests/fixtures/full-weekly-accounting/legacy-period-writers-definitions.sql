-- Portable original definitions captured at 2026-09-15 00:39:03.686932+00.
-- Fixture preimages only. These functions are not called by this file.
-- No table, cron object or replacement grant is fabricated here.
CREATE OR REPLACE FUNCTION public.fn_create_settlement_period(p_club_id uuid, p_user_id uuid, p_period_start date DEFAULT CURRENT_DATE, p_period_end date DEFAULT (CURRENT_DATE + '7 days'::interval))
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period_id uuid;
  v_rate numeric;
BEGIN
  SELECT COALESCE(a.player_rakeback_rate, 0.10) INTO v_rate
    FROM public.player_agent_assignments paa
    LEFT JOIN public.agents a ON a.id = paa.agent_id
   WHERE paa.player_id = p_user_id AND paa.club_id = p_club_id
   LIMIT 1;
  v_rate := COALESCE(v_rate, 0.10);

  INSERT INTO public.rakeback_periods
    (user_id, club_id, period_start, period_end, rakeback_rate, status)
  VALUES
    (p_user_id, p_club_id, p_period_start, p_period_end, v_rate, 'pending')
  RETURNING id INTO v_period_id;

  RETURN v_period_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_rakeback_periods_bulk_upsert(p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  it jsonb;
  v_written   integer := 0;
  v_conflict  integer := 0;
  v_failed    integer := 0;
  v_first_err text := NULL;
  v_rows      integer;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN jsonb_build_object('written', 0, 'conflicts', 0, 'failed', 0,
                              'error', 'p_items must be a jsonb array');
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    BEGIN
      INSERT INTO rakeback_periods (
        user_id, club_id, period_start, period_end,
        rake_generated, rakeback_rate, rakeback_earned, rakeback_amount,
        total_rake_paid, status
      ) VALUES (
        (it->>'user_id')::uuid,
        (it->>'club_id')::uuid,
        (it->>'period_start')::date,
        (it->>'period_end')::date,
        COALESCE((it->>'rake_generated')::numeric, 0),
        COALESCE((it->>'rakeback_rate')::numeric, 0),
        COALESCE((it->>'rakeback_earned')::numeric, 0),
        COALESCE((it->>'rakeback_amount')::numeric, 0),
        COALESCE((it->>'total_rake_paid')::numeric, 0),
        'pending'
      )
      ON CONFLICT (user_id, club_id, period_start, period_end) DO UPDATE
        SET rake_generated  = EXCLUDED.rake_generated,
            rakeback_rate   = EXCLUDED.rakeback_rate,
            rakeback_earned = EXCLUDED.rakeback_earned,
            rakeback_amount = EXCLUDED.rakeback_amount,
            total_rake_paid = EXCLUDED.total_rake_paid
        WHERE rakeback_periods.status = 'pending';

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows > 0 THEN v_written := v_written + 1; END IF;

    EXCEPTION
      WHEN unique_violation THEN
        -- (user_id, period_start) collision: same player, same week, different
        -- club. Pre-existing behaviour was a 409 counted as a failure.
        v_conflict := v_conflict + 1;
      WHEN OTHERS THEN
        v_failed := v_failed + 1;
        IF v_first_err IS NULL THEN v_first_err := SQLERRM; END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object('written', v_written, 'conflicts', v_conflict,
                            'failed', v_failed, 'first_error', v_first_err);
END $function$;
