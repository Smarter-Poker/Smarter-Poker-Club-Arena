CREATE OR REPLACE FUNCTION public.fn_ca_incident_resolution_reaches_the_alerts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_note text; v_state text; v_msg text;
BEGIN
  IF NEW.status <> 'resolved' OR COALESCE(OLD.status,'') = 'resolved' THEN
    RETURN NEW;
  END IF;

  /* AN AGE-OUT IS NOT A RESOLUTION AND MUST NOT PROPAGATE AS ONE (2026-09-20).
     This trigger marks the financial_alerts rows behind an incident resolved.
     An incident retired only because its stream went quiet has established
     nothing about those alerts, so closing them would carry "I could not tell"
     into a second table dressed as an answer. The incident closes; the alert
     stays open for whoever reads financial_alerts directly. */
  IF COALESCE(NEW.closure_basis = 'aged_out_unverified', false) THEN
    RETURN NEW;
  END IF;

  v_note := 'Closed with drift incident ' || NEW.id::text || ': '
            || COALESCE(NULLIF(NEW.resolution,''), 'no note given on the incident');

  UPDATE public.financial_alerts f
     SET resolved = true, resolved_at = now(),
         resolution = COALESCE(NULLIF(f.resolution,'') || ' | ','') || v_note
   WHERE NOT COALESCE(f.resolved,false)
     AND f.context->>'incident_id' ~ '^[0-9a-fA-F-]{36}$'
     AND (f.context->>'incident_id')::uuid = NEW.id;

  IF NEW.metadata->>'alert_id' ~ '^[0-9a-fA-F-]{36}$' THEN
    UPDATE public.financial_alerts f
       SET resolved = true, resolved_at = now(),
           resolution = COALESCE(NULLIF(f.resolution,'') || ' | ','') || v_note
     WHERE NOT COALESCE(f.resolved,false)
       AND f.id = (NEW.metadata->>'alert_id')::uuid;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  BEGIN
    INSERT INTO public.ca_incident_file_failures
      (source, dedupe_key, classification, severity, discrepancy, sqlstate, message)
    VALUES ('fn_ca_incident_resolution_reaches_the_alerts',
            'propagate:incident->alert:' || NEW.id::text,
            'unknown', 'warning', 0, v_state,
            'a resolved incident did not close the alerts echoing it: ' || v_msg);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RAISE WARNING 'fn_ca_incident_resolution_reaches_the_alerts failed: %', v_msg;
  RETURN NEW;
END $function$
;
