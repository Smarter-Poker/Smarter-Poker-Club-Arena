CREATE INDEX IF NOT EXISTS operational_alert_events_mirror_alert_idx
  ON public.operational_alert_events (split_part(event_key, ':', 1), source, id)
  WHERE source IN ('financial-alerts-backfill', 'financial-alerts-updates', 'drift-incidents-backfill', 'drift-incidents-updates');
CREATE INDEX IF NOT EXISTS operational_alert_events_alertmanager_firing_idx
  ON public.operational_alert_events (alertname, ((payload -> 'alert') ->> 'fingerprint'), ((payload -> 'alert') ->> 'startsAt'))
  WHERE source = 'alertmanager' AND status = 'firing';
CREATE OR REPLACE FUNCTION public.fn_operational_alert_severity_rank(p_severity text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE p_severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 WHEN 'info' THEN 1 ELSE 0 END
$fn$;
CREATE OR REPLACE FUNCTION public.fn_operational_alert_mirror_classify()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_prefix text; v_aid text; v_rule text; v_prev_res boolean; v_prev_sr integer;
BEGIN
  IF NEW.investigation_status IS DISTINCT FROM 'new' THEN RETURN NEW; END IF;
  IF NEW.source IN ('financial-alerts-backfill', 'financial-alerts-updates', 'drift-incidents-backfill', 'drift-incidents-updates') THEN
    v_prefix := CASE WHEN NEW.source LIKE 'financial-alerts-%' THEN 'financial-alerts' ELSE 'drift-incidents' END;
    v_aid := split_part(NEW.event_key, ':', 1);
    IF NEW.source = v_prefix || '-updates' AND NEW.status = 'resolved' THEN
      v_rule := 'mirror_resolution_receipt';
    ELSIF NEW.source = v_prefix || '-updates' AND NEW.status = 'firing' THEN
      SELECT bool_or(o.status = 'resolved'), max(public.fn_operational_alert_severity_rank(o.severity))
        INTO v_prev_res, v_prev_sr
        FROM public.operational_alert_events o
       WHERE split_part(o.event_key, ':', 1) = v_aid AND o.source IN (v_prefix || '-backfill', v_prefix || '-updates');
      IF v_prev_sr IS NOT NULL AND NOT coalesce(v_prev_res, false)
         AND public.fn_operational_alert_severity_rank(NEW.severity) <= v_prev_sr THEN
        v_rule := 'mirror_duplicate_of_captured_original';
      END IF;
    ELSIF NEW.source = v_prefix || '-backfill' AND NEW.status = 'resolved' AND NEW.severity = 'info' THEN
      v_rule := 'info_captured_already_resolved';
    END IF;
  ELSIF NEW.source = 'alertmanager' AND NEW.status = 'resolved' THEN
    IF EXISTS (SELECT 1 FROM public.operational_alert_events f
                WHERE f.source = 'alertmanager' AND f.status = 'firing' AND f.alertname = NEW.alertname
                  AND (f.payload -> 'alert') ->> 'fingerprint' = (NEW.payload -> 'alert') ->> 'fingerprint'
                  AND (f.payload -> 'alert') ->> 'startsAt' = (NEW.payload -> 'alert') ->> 'startsAt') THEN
      v_rule := 'alertmanager_resolution_receipt_of_captured_firing';
    END IF;
  END IF;
  IF v_rule IS NOT NULL THEN
    NEW.investigation_status := 'informational';
    NEW.investigation := coalesce(NEW.investigation, '{}'::jsonb) || jsonb_build_object(
      'closed_by', 'alert-quality-rule-2026-10-31', 'rule', v_rule,
      'evidence', 'Classified on arrival: this receipt repeats or resolves an alert the inbox already holds.');
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END
$fn$;
CREATE OR REPLACE FUNCTION public.fn_operational_alert_resolved_twin_closes_firing()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_prefix text; v_aid text;
BEGIN
  BEGIN
    IF NEW.source IN ('financial-alerts-updates', 'drift-incidents-updates') THEN
      v_prefix := CASE WHEN NEW.source LIKE 'financial-alerts-%' THEN 'financial-alerts' ELSE 'drift-incidents' END;
      v_aid := split_part(NEW.event_key, ':', 1);
      UPDATE public.operational_alert_events o
         SET investigation_status = 'informational',
             investigation = coalesce(o.investigation, '{}'::jsonb) || jsonb_build_object(
               'closed_by', 'alert-quality-rule-2026-10-31', 'rule', 'resolved_twin_arrived', 'resolved_twin_id', NEW.id,
               'evidence', 'A later receipt of the same alert says it resolved.')
       WHERE o.id IN (SELECT f.id FROM public.operational_alert_events f
                       WHERE split_part(f.event_key, ':', 1) = v_aid
                         AND f.source IN (v_prefix || '-backfill', v_prefix || '-updates')
                         AND f.status = 'firing' AND f.investigation_status = 'new' AND f.id < NEW.id
                         AND f.severity IS DISTINCT FROM 'critical'
                       FOR UPDATE SKIP LOCKED);
    ELSIF NEW.source = 'alertmanager' THEN
      UPDATE public.operational_alert_events o
         SET investigation_status = 'informational',
             investigation = coalesce(o.investigation, '{}'::jsonb) || jsonb_build_object(
               'closed_by', 'alert-quality-rule-2026-10-31', 'rule', 'resolved_twin_arrived', 'resolved_twin_id', NEW.id,
               'evidence', 'Alertmanager sent the resolved notice for this firing (same alertname, fingerprint, startsAt).')
       WHERE o.id IN (SELECT f.id FROM public.operational_alert_events f
                       WHERE f.source = 'alertmanager' AND f.status = 'firing' AND f.alertname = NEW.alertname
                         AND (f.payload -> 'alert') ->> 'fingerprint' = (NEW.payload -> 'alert') ->> 'fingerprint'
                         AND (f.payload -> 'alert') ->> 'startsAt' = (NEW.payload -> 'alert') ->> 'startsAt'
                         AND f.investigation_status = 'new' AND f.id < NEW.id
                       FOR UPDATE SKIP LOCKED);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'resolved-twin classification skipped for inbox row %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END
$fn$;
CREATE OR REPLACE TRIGGER a0_operational_alert_mirror_classify
  BEFORE INSERT ON public.operational_alert_events FOR EACH ROW
  WHEN (NEW.investigation_status = 'new' AND NEW.source IN ('financial-alerts-backfill', 'financial-alerts-updates', 'drift-incidents-backfill', 'drift-incidents-updates', 'alertmanager'))
  EXECUTE FUNCTION public.fn_operational_alert_mirror_classify();
CREATE OR REPLACE TRIGGER b_operational_alert_resolved_twin_closes_firing
  AFTER INSERT ON public.operational_alert_events FOR EACH ROW
  WHEN (NEW.status = 'resolved' AND NEW.source IN ('financial-alerts-updates', 'drift-incidents-updates', 'alertmanager'))
  EXECUTE FUNCTION public.fn_operational_alert_resolved_twin_closes_firing();