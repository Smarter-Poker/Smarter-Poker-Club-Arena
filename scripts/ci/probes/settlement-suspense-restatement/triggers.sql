-- Production triggers the restatement runs through.
CREATE TRIGGER trg_ca_resolution_needs_a_cause BEFORE UPDATE ON public.ca_drift_incidents
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_resolution_needs_a_cause();
CREATE TRIGGER ca_correction_intent_immutable_v1 BEFORE DELETE OR UPDATE OR TRUNCATE
  ON public.ca_correction_request_intents_v1
  FOR EACH STATEMENT EXECUTE FUNCTION public.ca_correction_intent_immutable_v1();
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'$$;
