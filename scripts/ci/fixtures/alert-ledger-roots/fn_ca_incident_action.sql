CREATE OR REPLACE FUNCTION public.fn_ca_incident_action(p_incident_id uuid, p_action text, p_note text DEFAULT NULL::text, p_assignee uuid DEFAULT NULL::uuid, p_root_cause text DEFAULT NULL::text, p_correction_ref text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  inc public.ca_drift_incidents;
  v_allowed boolean;
BEGIN
  SELECT * INTO inc FROM public.ca_drift_incidents WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;

  v_allowed := v_uid IS NULL OR v_uid = ANY (public.fn_ca_incident_recipient_ids(inc, false));
  IF NOT v_allowed THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  IF p_action = 'acknowledge' THEN
    UPDATE public.ca_drift_incidents
       SET status = CASE WHEN status = 'open' THEN 'acknowledged' ELSE status END,
           acknowledged_by = COALESCE(acknowledged_by, v_uid),
           acknowledged_at = COALESCE(acknowledged_at, now())
     WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'acknowledged', v_uid, jsonb_build_object('note', p_note));

  ELSIF p_action = 'assign' THEN
    UPDATE public.ca_drift_incidents SET assigned_to = p_assignee WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'assigned', v_uid,
            jsonb_build_object('assignee', p_assignee, 'note', p_note));

  ELSIF p_action = 'comment' THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'comment', v_uid, jsonb_build_object('note', p_note));

  ELSIF p_action = 'reconciling' THEN
    UPDATE public.ca_drift_incidents SET status = 'reconciling' WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'status_change', v_uid,
            jsonb_build_object('to', 'reconciling', 'note', p_note));

  ELSIF p_action = 'resolve' THEN
    IF inc.classification = 'unknown'
       AND COALESCE(p_root_cause, inc.root_cause) IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'root_cause_required_for_unknown');
    END IF;
    UPDATE public.ca_drift_incidents
       SET status = 'resolved', resolved_by = v_uid, resolved_at = now(),
           resolution = COALESCE(p_note, resolution),
           root_cause = COALESCE(p_root_cause, root_cause),
           correction_ref = COALESCE(p_correction_ref, correction_ref)
     WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'resolved', v_uid,
            jsonb_build_object('note', p_note, 'root_cause', p_root_cause,
                               'correction_ref', p_correction_ref));
    -- SIGNAL-NOT-NOISE (2026-08-31): only a critical's resolution pushes.
    IF inc.severity = 'critical' THEN
      PERFORM public.fn_ca_incident_notify(p_incident_id, 'notified',
        '✅ Resolved: ' || inc.classification || ' drift', false);
    END IF;

  ELSIF p_action = 'reopen' THEN
    UPDATE public.ca_drift_incidents
       SET status = 'open', resolved_at = NULL, resolved_by = NULL,
           past_target = false, escalation_level = 0,
           detected_at = now(), deadline_at = now() + interval '20 minutes'
     WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'reopened', v_uid, jsonb_build_object('note', p_note));
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_action');
  END IF;

  RETURN jsonb_build_object('ok', true);
END $function$;
