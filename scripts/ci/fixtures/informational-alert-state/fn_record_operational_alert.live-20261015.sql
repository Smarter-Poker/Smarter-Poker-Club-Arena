CREATE OR REPLACE FUNCTION public.fn_record_operational_alert(p_source text, p_event_key text, p_alertname text, p_status text, p_severity text, p_payload jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_id bigint;
BEGIN
  -- A repeat delivery bumps the receipt. It never rewrites evidence, and it
  -- never changes a destination the row already names. The one thing it adds
  -- is the destination a row recorded before its writer addressed alerts:
  -- without it, a long-running alert first recorded unaddressed stays out of
  -- the owning lane for as long as it keeps firing.
  INSERT INTO public.operational_alert_events(source,event_key,alertname,status,severity,payload)
  VALUES(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload)
  ON CONFLICT (source,event_key) DO UPDATE
  SET last_received_at=clock_timestamp(), delivery_count=operational_alert_events.delivery_count+1,
      payload=CASE
        WHEN jsonb_typeof(operational_alert_events.payload)='object'
         AND NOT (operational_alert_events.payload ? 'target_task_id')
         AND jsonb_typeof(EXCLUDED.payload->'target_task_id')='string'
        THEN operational_alert_events.payload
             || jsonb_build_object('target_task_id',EXCLUDED.payload->'target_task_id')
        ELSE operational_alert_events.payload END
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$
