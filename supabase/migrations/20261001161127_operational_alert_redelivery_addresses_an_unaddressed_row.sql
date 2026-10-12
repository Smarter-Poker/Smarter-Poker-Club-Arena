-- Club Arena PR #5448, migration 20260927160533 (HELD; installed on owner instruction 2026-10-01).
SET LOCAL lock_timeout = '5s';

DO $preimage$
DECLARE
  v_recorder constant text := 'public.fn_record_operational_alert(text,text,text,text,text,jsonb)';
BEGIN
  IF md5(pg_get_functiondef(v_recorder::regprocedure)) IS DISTINCT FROM '36601e205494e8768f5a1dce09f4a186' THEN
    RAISE EXCEPTION 'operational alert recorder is not the expected preimage';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_cash_failed_run_intake()'::regprocedure))
       IS DISTINCT FROM 'b1b3aa4e571504d1fa68b1baab72e8ba' THEN
    RAISE EXCEPTION 'cash failed-run intake is not the expected preimage';
  END IF;
END
$preimage$;

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
$function$;

DO $repin$
DECLARE
  v_old constant text := '36601e205494e8768f5a1dce09f4a186';
  v_new constant text := '4bab2581b3dff1e09b22d0df46c68df8';
  v_intake constant regprocedure := 'public.fn_ca_cash_failed_run_intake()'::regprocedure;
  v_before text := pg_get_functiondef(v_intake);
  v_expected text;
  v_meta_before jsonb;
  v_meta_after jsonb;
BEGIN
  IF md5(pg_get_functiondef('public.fn_record_operational_alert(text,text,text,text,text,jsonb)'::regprocedure))
       IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION 'operational alert recorder postimage differs from the reviewed definition';
  END IF;
  IF (length(v_before) - length(replace(v_before, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'cash failed-run intake must pin the recorder exactly once';
  END IF;
  SELECT jsonb_build_object('owner', pg_get_userbyid(proowner), 'secdef', prosecdef,
           'config', proconfig, 'acl', proacl::text)
    INTO v_meta_before FROM pg_proc WHERE oid = v_intake;
  v_expected := replace(v_before, v_old, v_new);
  EXECUTE v_expected;
  IF pg_get_functiondef(v_intake) IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'cash failed-run intake postimage is not the one-literal replacement';
  END IF;
  SELECT jsonb_build_object('owner', pg_get_userbyid(proowner), 'secdef', prosecdef,
           'config', proconfig, 'acl', proacl::text)
    INTO v_meta_after FROM pg_proc WHERE oid = v_intake;
  IF v_meta_after IS DISTINCT FROM v_meta_before THEN
    RAISE EXCEPTION 'cash failed-run intake authority changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid = 'public.fn_record_operational_alert(text,text,text,text,text,jsonb)'::regprocedure
        AND pg_get_userbyid(p.proowner) = 'postgres' AND NOT p.prosecdef
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
        AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'operational alert recorder authority changed';
  END IF;
END
$repin$;