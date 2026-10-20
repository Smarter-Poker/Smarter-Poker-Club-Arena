-- Mirror explicit Diamond source resolution into its rule episode in the
-- original transaction. Never infer recovery from age or stream silence.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

CREATE FUNCTION public.fn_ca_diamond_rule_transition_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
DECLARE v_rule text;
BEGIN
  -- Insert and resolve share the same rule lock before touching drift state.
  -- A concurrent critical cannot be omitted by the last-source-row decision.
  FOR v_rule IN SELECT DISTINCT r FROM (VALUES (NEW.rule),
      (CASE WHEN TG_OP='UPDATE' THEN OLD.rule ELSE NEW.rule END)) keys(r) ORDER BY r LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('ca-diamond-rule:' || v_rule,0));
  END LOOP;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_rule_transition_lock() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.fn_ca_diamond_resolution_reaches_drift() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $fn$
BEGIN
  IF NEW.resolved_at IS NULL
     OR NEW.severity <> 'critical' OR nullif(btrim(NEW.resolution),'') IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_diamond_incidents s
              WHERE s.rule=NEW.rule AND s.severity='critical' AND s.resolved_at IS NULL) THEN RETURN NEW; END IF;
  UPDATE public.ca_drift_incidents d
     SET status='resolved',resolved_at=greatest(clock_timestamp(),d.detected_at),
         resolved_by=coalesce(NEW.resolved_by,'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         closure_basis='verified_remeasured',
         root_cause='The Diamond source explicitly resolved its last open critical for rule '||NEW.rule||'. The source-to-drift resolution transition was missing.',
         correction_ref='verified: diamond-source:'||NEW.id::text,
         resolution='Diamond source '||NEW.id::text||' resolved at '||NEW.resolved_at::text||': '||NEW.resolution
   WHERE d.source='ca_diamond_incidents' AND d.metadata->>'rule'=NEW.rule
     AND d.resolved_at IS NULL;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_resolution_reaches_drift() FROM PUBLIC,anon,authenticated;

CREATE TRIGGER ca_diamond_rule_transition_lock
BEFORE INSERT OR UPDATE OF resolved_at,rule,severity ON public.ca_diamond_incidents
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_rule_transition_lock();
CREATE TRIGGER ca_diamond_resolution_reaches_drift
AFTER UPDATE OF resolved_at ON public.ca_diamond_incidents
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_resolution_reaches_drift();
-- Reopening a critical uses the existing episode and paging authority.
CREATE TRIGGER ca_diamond_reopened_critical_pages
AFTER UPDATE OF resolved_at ON public.ca_diamond_incidents
FOR EACH ROW WHEN (OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS NULL AND NEW.severity='critical')
EXECUTE FUNCTION public.fn_ca_diamond_incident_pages();

-- The observed source already resolved before this transition was installed.
-- Invoke the same trigger against that one source without changing its history.
UPDATE public.ca_diamond_incidents SET resolved_at=resolved_at WHERE id=912032;
COMMIT;
