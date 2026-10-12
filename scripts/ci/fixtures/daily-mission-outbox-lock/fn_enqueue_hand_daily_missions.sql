CREATE OR REPLACE FUNCTION public.fn_enqueue_hand_daily_missions()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event jsonb;
  v_uid uuid;
BEGIN
  IF jsonb_typeof(NEW.daily_mission_events)<>'array' THEN RETURN NEW; END IF;
  FOR v_event IN
    SELECT value FROM jsonb_array_elements(NEW.daily_mission_events)
     ORDER BY value->>'user_id',value::text
  LOOP
    BEGIN
      v_uid := (v_event->>'user_id')::uuid;
      IF v_uid IS NULL THEN CONTINUE; END IF;
      INSERT INTO public.daily_challenge_event_outbox
        (user_id,event_key,amounts,magnitudes,threshold_values,occurred_at)
      VALUES (
        v_uid,
        'hand:'||NEW.id::text,
        v_event->'amounts',
        coalesce(v_event->'magnitudes','{}'::jsonb),
        coalesce(v_event->'values','{}'::jsonb),
        coalesce(NEW.ended_at,NEW.created_at,now())
      )
      ON CONFLICT (user_id,event_key) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Daily Missions hand event % could not be queued: %',NEW.id,SQLERRM;
    END;
  END LOOP;
  RETURN NEW;
END;
$function$
