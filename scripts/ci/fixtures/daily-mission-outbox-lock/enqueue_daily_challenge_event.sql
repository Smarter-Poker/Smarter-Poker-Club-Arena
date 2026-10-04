CREATE OR REPLACE FUNCTION public.enqueue_daily_challenge_event(p_user_id uuid, p_event_key text, p_amounts jsonb, p_magnitudes jsonb, p_values jsonb, p_occurred_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event public.daily_challenge_event_outbox%ROWTYPE;
  v_receipt public.daily_challenge_progress_events%ROWTYPE;
  v_receipt_found boolean;
BEGIN
  PERFORM public.fn_lock_daily_mission_user(p_user_id);

  INSERT INTO public.daily_challenge_event_outbox (
    user_id,
    event_key,
    amounts,
    magnitudes,
    threshold_values,
    occurred_at
  ) VALUES (
    p_user_id,
    p_event_key,
    p_amounts,
    p_magnitudes,
    p_values,
    p_occurred_at
  )
  ON CONFLICT (user_id, event_key) DO NOTHING;

  SELECT * INTO STRICT v_event
  FROM public.daily_challenge_event_outbox
  WHERE user_id = p_user_id
    AND event_key = p_event_key
  FOR UPDATE;

  IF v_event.amounts IS DISTINCT FROM p_amounts
     OR v_event.magnitudes IS DISTINCT FROM p_magnitudes
     OR v_event.threshold_values IS DISTINCT FROM p_values
     OR v_event.occurred_at IS DISTINCT FROM p_occurred_at
  THEN
    RAISE EXCEPTION 'Daily Missions event key is already bound to another payload';
  END IF;

  SELECT * INTO v_receipt
  FROM public.daily_challenge_progress_events
  WHERE user_id = p_user_id
    AND event_key = p_event_key
  FOR UPDATE;
  v_receipt_found := FOUND;

  IF v_receipt_found
     AND (
       v_receipt.amounts IS DISTINCT FROM v_event.amounts
       OR v_receipt.magnitudes IS DISTINCT FROM v_event.magnitudes
       OR v_receipt.threshold_values IS DISTINCT FROM v_event.threshold_values
       OR v_receipt.occurred_at IS DISTINCT FROM v_event.occurred_at
     )
  THEN
    RAISE EXCEPTION 'Daily Missions event key is already bound to another payload';
  END IF;

  BEGIN
    PERFORM public.record_daily_challenge_event(
      v_event.user_id,
      v_event.event_key,
      v_event.amounts,
      v_event.magnitudes,
      v_event.threshold_values,
      v_event.occurred_at
    );
    DELETE FROM public.daily_challenge_event_outbox
    WHERE user_id = v_event.user_id
      AND event_key = v_event.event_key;
    RETURN true;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.daily_challenge_event_outbox
    SET attempts = attempts + 1,
        last_error = left(SQLERRM, 1000),
        next_attempt_at = now() + interval '1 minute'
    WHERE user_id = v_event.user_id
      AND event_key = v_event.event_key;
    RETURN false;
  END;
END;
$function$
