CREATE OR REPLACE FUNCTION public.fn_record_operational_alerts(p_events jsonb)
 RETURNS bigint[]
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_event jsonb; v_ids bigint[] := '{}';
BEGIN
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'expected 1 to 200 alert events';
  END IF;
  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    v_ids := array_append(v_ids, public.fn_record_operational_alert(
      v_event->>'source',v_event->>'event_key',v_event->>'alertname',
      v_event->>'status',v_event->>'severity',v_event->'payload'));
  END LOOP;
  RETURN v_ids;
END;
$function$
