-- An explicit investigated resolution replaces the current age-out disposition,
-- without rewriting its immutable historical event. Previously the RPC retained
-- aged_out_unverified while changing cause/ref; both triggers skipped resolved
-- preimages, so the evidence and linked alerts disagreed.
-- No ledger, balances, seats, hands, detector or scheduling changes.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_incident_action', 'migration explicit investigated operator resolution');
DO $preimage$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_incident_action(uuid,text,text,uuid,text,text)'::regprocedure)) <> '3507dce688509aabeaff69a89e787ca0'
     OR md5(pg_get_functiondef('public.fn_ca_resolution_needs_a_cause()'::regprocedure)) <> '48547879bc49d84f5898e8cb44fe1951'
     OR md5(pg_get_functiondef('public.fn_ca_incident_resolution_reaches_the_alerts()'::regprocedure)) <> '63b671cfa20b9f85c22e50dbe12281e1' THEN
    RAISE EXCEPTION 'incident resolution preimage changed; inspect before installation';
  END IF;
END $preimage$;
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
    -- A repeated explicit resolution is a readback, not another event or push.
    IF inc.status = 'resolved' AND inc.closure_basis = 'operator'
       AND inc.resolution IS NOT DISTINCT FROM COALESCE(p_note, inc.resolution)
       AND inc.root_cause IS NOT DISTINCT FROM COALESCE(p_root_cause, inc.root_cause)
       AND inc.correction_ref IS NOT DISTINCT FROM COALESCE(p_correction_ref, inc.correction_ref) THEN
      RETURN jsonb_build_object('ok', true, 'already_resolved', true);
    END IF;
    -- Silence is not evidence. Replacing an age-out requires a new explanation.
    IF inc.closure_basis = 'aged_out_unverified'
       AND (NULLIF(btrim(p_root_cause), '') IS NULL
            OR NULLIF(btrim(p_correction_ref), '') IS NULL
            OR NULLIF(btrim(p_note), '') IS NULL) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'explicit_resolution_evidence_required');
    END IF;
    IF inc.classification = 'unknown'
       AND COALESCE(p_root_cause, inc.root_cause) IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'root_cause_required_for_unknown');
    END IF;
    UPDATE public.ca_drift_incidents
       SET status = 'resolved', closure_basis = 'operator', resolved_by = v_uid, resolved_at = now(),
           resolution = COALESCE(p_note, resolution),
           root_cause = COALESCE(p_root_cause, root_cause),
           correction_ref = COALESCE(p_correction_ref, correction_ref)
     WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'resolved', v_uid,
            jsonb_build_object('note', p_note, 'root_cause', p_root_cause,
                               'correction_ref', p_correction_ref,
                               'closure_basis', 'operator',
                               'previous_closure_basis', inc.closure_basis,
                               'previous_resolved_at', inc.resolved_at,
                               'previous_root_cause', inc.root_cause,
                               'previous_correction_ref', inc.correction_ref,
                               'previous_resolution', inc.resolution));
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

  -- A successful explicit incident action is an investigation of its routed
  -- inbox record. Bell reads, failed actions and automated incident writes are not.
  -- Keep terminal investigations terminal; acknowledgement never proves a fix.
  UPDATE public.operational_alert_events e
     SET investigation = e.investigation || jsonb_build_object(
           'incident_action', p_action, 'incident_id', p_incident_id,
           'actor', v_uid, 'note', p_note, 'recorded_at', clock_timestamp()),
         investigation_status = CASE WHEN p_action = 'resolve'
                                           AND e.investigation_status IN ('new', 'investigating')
                                     THEN 'verified_fixed'
                                     WHEN e.investigation_status = 'new'
                                     THEN 'investigating' ELSE e.investigation_status END
    FROM public.operational_notification_destinations d
   WHERE e.id = d.inbox_event_id
     AND e.source = 'owner-operational-notifications'
     AND d.original_notification->'data'->>'incident_id' = p_incident_id::text;

  RETURN jsonb_build_object('ok', true);
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_resolution_needs_a_cause()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cause text := btrim(coalesce(NEW.root_cause, ''));
  v_ref   text := btrim(coalesce(NEW.correction_ref, ''));
  -- COALESCE, not a bare comparison: a NULL closure_basis must read as "not
  -- aged out" (false), never as NULL, or both fences below silently pass.
  v_aged  boolean := COALESCE(NEW.closure_basis = 'aged_out_unverified', false);
  v_ok    boolean;
BEGIN
  IF NEW.status <> 'resolved' OR
     (OLD.status = 'resolved'
      AND NEW.closure_basis IS NOT DISTINCT FROM OLD.closure_basis
      AND NEW.root_cause IS NOT DISTINCT FROM OLD.root_cause
      AND NEW.correction_ref IS NOT DISTINCT FROM OLD.correction_ref) THEN
    RETURN NEW;
  END IF;

  IF length(v_cause) < 40 THEN
    RAISE EXCEPTION
      'An incident is not resolved until the cause is written down. Supply root_cause: what was actually wrong, in a sentence (at least 40 characters). Got %.',
      CASE WHEN v_cause = '' THEN 'nothing' ELSE '"' || v_cause || '"' END
      USING ERRCODE = 'P0404';
  END IF;

  -- 2026-09-01: the auto_repair_status='repaired' bypass is GONE. Any writer
  -- could set that flag in the same UPDATE that resolved, which made the law
  -- optional for exactly the actor it was written to govern (the same shape
  -- as the [allow-revert] token incident of 2026-08-31). The automated
  -- reconciler now writes 'verified: <evidence>' like every other resolver.
  --
  -- 2026-09-20: 'aged-out:' joins the list, FENCED OFF from 'verified:' in
  -- BOTH directions. Until today the escalation tick closed a silence-retired
  -- incident with correction_ref 'verified: not seen again for N hours', so an
  -- unread event stream and a re-measured all-clear were recorded with the
  -- same word in the same field - 43 rows carry that wording. Silence is
  -- "I could not tell" (law 10.86 rule 1). It gets its own prefix, and the two
  -- can no longer be mistaken for one another.
  v_ok := v_ref ~* '^(migration[[:space:]]+[^[:space:]]|PR[[:space:]]*#[0-9]|chip_ledger[[:space:]]+[^[:space:]]|correction:[^[:space:]])'
       OR v_ref ~* '^(ruling:|verified:|no-change-needed:|aged-out:)[[:space:]]*[^[:space:]]';

  IF NOT v_ok THEN
    RAISE EXCEPTION
      'An incident is not resolved until something stops it happening again. Supply correction_ref as one of: "migration <name>", "PR #<n>", "chip_ledger <id>", "correction:<key>", "ruling: <decision>", "verified: <evidence>", "aged-out: <what went quiet>", or "no-change-needed: <why>". Got %.',
      CASE WHEN v_ref = '' THEN 'nothing' ELSE '"' || v_ref || '"' END
      USING ERRCODE = 'P0404';
  END IF;

  IF v_aged AND v_ref !~* '^aged-out:[[:space:]]*[^[:space:]]' THEN
    RAISE EXCEPTION
      'closure_basis is ''aged_out_unverified'', so correction_ref must begin "aged-out: ". An incident retired because its event stream went quiet was not verified, and must not be filed under any evidence prefix. Got %.',
      CASE WHEN v_ref = '' THEN 'nothing' ELSE '"' || v_ref || '"' END
      USING ERRCODE = 'P0404';
  END IF;

  IF NOT v_aged AND v_ref ~* '^aged-out:' THEN
    RAISE EXCEPTION
      'correction_ref begins "aged-out: " but closure_basis is %. Set closure_basis to ''aged_out_unverified'', or supply real evidence under one of the other prefixes.',
      COALESCE('''' || NEW.closure_basis || '''', 'not set')
      USING ERRCODE = 'P0404';
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_incident_resolution_reaches_the_alerts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_note text; v_state text; v_msg text;
BEGIN
  IF NEW.status <> 'resolved' OR
     (COALESCE(OLD.status,'') = 'resolved'
      AND NEW.closure_basis IS NOT DISTINCT FROM OLD.closure_basis) THEN
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
  -- Explicit operator resolution must commit its linked outcome atomically.
  IF NEW.closure_basis = 'operator' THEN RAISE; END IF;
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

-- CREATE OR REPLACE preserves the existing grants and signature.
REVOKE ALL ON FUNCTION public.fn_ca_incident_action(uuid,text,text,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_incident_action(uuid,text,text,uuid,text,text) TO authenticated, service_role;
COMMIT;
