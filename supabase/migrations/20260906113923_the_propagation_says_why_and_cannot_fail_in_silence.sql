-- THE PROPAGATION SAYS WHY, AND CANNOT FAIL IN SILENCE.
--
-- Second defect found in the pre-Phase-2 deep dive, and it is in the fix I
-- shipped four hours ago.
--
-- 20260906095606 added two triggers so that resolving a financial_alert closes
-- the drift incident that mirrors it, and vice versa. I verified them by
-- checking the triggers existed. They existed. THEY HAD NEVER ONCE WORKED.
--
-- Proved by resolving a probe alert and reading the incident back: still open.
-- The reason is a guard I built in an earlier phase - fn_ca_resolution_needs_a_cause
-- - which refuses any resolve that does not carry a root_cause of at least 40
-- characters. My trigger sets status, resolved_at, correction_ref and
-- resolution, and never sets root_cause. So every propagation raised P0404.
--
-- AND THEN MY OWN HANDLER ATE IT:
--
--   EXCEPTION WHEN OTHERS THEN
--     RAISE WARNING 'fn_ca_alert_resolution_reaches_the_incident failed: %', SQLERRM;
--     RETURN NEW;
--
-- RAISE WARNING goes to the Postgres log, which is precisely the place
-- CLAUDE.md's own note on fn_ca_raise_drift_incident says 901 consecutive
-- failures once hid in. I wrote the same bug into the same file on the same
-- day, in a session whose Phase 1 was about a guard that reported the wrong
-- thing. The 83 mirrors that did close were closed by the backfill UPDATE in
-- that migration, which does set root_cause - not by the propagation, which is
-- what has to work tomorrow.
--
-- TWO FIXES, and the second matters more than the first:
--
--   1. Both directions now write a root_cause that says what was actually
--      wrong, so the guard is satisfied by meaning rather than by ceremony.
--
--   2. A propagation that fails RECORDS ITSELF in ca_incident_file_failures,
--      the table that already exists for exactly this. It still must not roll
--      back the resolve that triggered it - a person closing an alert cannot be
--      blocked because the mirror is unwell - but "did not work" is now a row
--      somebody can read instead of a warning nobody will.
--
-- Verified at the end of this migration by actually resolving a probe alert and
-- reading the incident back, then rolling it away. Checking that a trigger
-- exists is not checking that it works; that is the whole lesson of this file.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_alert_resolution_reaches_the_incident()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_state text; v_msg text;
BEGIN
  IF NOT COALESCE(NEW.resolved,false) OR COALESCE(OLD.resolved,false) THEN
    RETURN NEW;
  END IF;
  UPDATE public.ca_drift_incidents i
     SET status      = 'resolved',
         resolved_at = COALESCE(NEW.resolved_at, now()),
         correction_ref = COALESCE(NULLIF(i.correction_ref,''),
                                   'verified: closed with financial alert ' || NEW.id::text),
         root_cause  = COALESCE(NULLIF(i.root_cause,''),
                        'This incident is a mirror of financial alert ' || NEW.id::text
                        || ', raised by ' || COALESCE(NEW.source,'an unnamed source')
                        || '. The condition it describes was diagnosed and closed on that '
                        || 'alert; this row exists only because the alert was copied onto '
                        || 'the drift board when it was raised.'),
         resolution  = COALESCE(NULLIF(i.resolution,'') || ' | ', '')
                       || 'Closed with the financial alert it mirrors ('
                       || NEW.id::text || '): '
                       || COALESCE(NULLIF(NEW.resolution,''), 'no note given on the alert')
   WHERE i.status <> 'resolved'
     AND i.metadata->>'alert_id' ~ '^[0-9a-fA-F-]{36}$'
     AND (i.metadata->>'alert_id')::uuid = NEW.id;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  /* Never roll back the resolve that triggered us - but never disappear
     either. RAISE WARNING alone is how this defect hid from its own author. */
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  BEGIN
    INSERT INTO public.ca_incident_file_failures
      (source, dedupe_key, classification, severity, discrepancy, sqlstate, message)
    VALUES ('fn_ca_alert_resolution_reaches_the_incident',
            'propagate:alert->incident:' || NEW.id::text,
            'unknown', 'warning', 0, v_state,
            'a resolved alert did not close the incident mirroring it: ' || v_msg);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RAISE WARNING 'fn_ca_alert_resolution_reaches_the_incident failed: %', v_msg;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.fn_ca_incident_resolution_reaches_the_alerts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_note text; v_state text; v_msg text;
BEGIN
  IF NEW.status <> 'resolved' OR COALESCE(OLD.status,'') = 'resolved' THEN
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
END $fn$;

-- ---------------------------------------------------------------------------
-- PROVE BOTH DIRECTIONS, then put it back.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_alert uuid; v_inc uuid; v_status text; v_resolved boolean;
  v_alert2 uuid; v_inc2 uuid;
  v_done boolean := false;
BEGIN
  BEGIN
    -- direction 1: alert closes its mirror
    INSERT INTO public.financial_alerts (severity, source, message, context, resolved)
    VALUES ('critical','zz_verify.propagation','verify propagation','{}'::jsonb,false)
    RETURNING id INTO v_alert;

    v_inc := public.fn_ca_raise_drift_incident(
      'financial_alerts:zz_verify.propagation','unknown','critical',
      'fa:zz_verify:'||md5(v_alert::text), 0, NULL, NULL, 'ledger',
      NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'verify',NULL,
      jsonb_build_object('alert_id', v_alert));
    IF v_inc IS NULL THEN RAISE EXCEPTION 'VERIFY FAILED: raiser returned null'; END IF;

    UPDATE public.financial_alerts SET resolved=true, resolved_at=now(),
           resolution='verify close' WHERE id=v_alert;

    SELECT status INTO v_status FROM public.ca_drift_incidents WHERE id=v_inc;
    IF v_status <> 'resolved' THEN
      RAISE EXCEPTION 'VERIFY FAILED: alert->incident propagation did not close the mirror (status %)', v_status;
    END IF;

    -- direction 2: incident closes the alert it mirrors
    INSERT INTO public.financial_alerts (severity, source, message, context, resolved)
    VALUES ('critical','zz_verify.propagation2','verify propagation 2','{}'::jsonb,false)
    RETURNING id INTO v_alert2;

    v_inc2 := public.fn_ca_raise_drift_incident(
      'financial_alerts:zz_verify.propagation2','unknown','critical',
      'fa:zz_verify2:'||md5(v_alert2::text), 0, NULL, NULL, 'ledger',
      NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'verify',NULL,
      jsonb_build_object('alert_id', v_alert2));

    UPDATE public.ca_drift_incidents
       SET status='resolved', resolved_at=now(),
           correction_ref='verified: propagation self-test',
           root_cause='A probe incident raised by this migration to prove the incident-to-alert propagation actually closes the alert.',
           resolution='verify close from the incident side'
     WHERE id=v_inc2;

    SELECT resolved INTO v_resolved FROM public.financial_alerts WHERE id=v_alert2;
    IF NOT COALESCE(v_resolved,false) THEN
      RAISE EXCEPTION 'VERIFY FAILED: incident->alert propagation did not close the alert';
    END IF;

    v_done := true;
    RAISE EXCEPTION 'ca_verify_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ca_verify_rollback' THEN RAISE; END IF;
  END;

  IF NOT v_done THEN
    RAISE EXCEPTION 'VERIFY FAILED: the propagation probe did not run to completion';
  END IF;
  IF EXISTS (SELECT 1 FROM public.financial_alerts WHERE source LIKE 'zz_verify.%') THEN
    RAISE EXCEPTION 'VERIFY FAILED: probe alerts survived their rollback';
  END IF;

  RAISE NOTICE 'PROPAGATION_VERIFIED both directions close, probe rolled back';
END $verify$;

COMMIT;
