-- SOURCE CANDIDATE ONLY. Not registered with any activation loader.
-- Apply only in the same admitted transaction as the successor definition,
-- after exact predecessor and complete catalog/ACL guards have passed.
-- No IF NOT EXISTS: never adopt an unrelated preexisting relation.
CREATE TABLE public.ca_correction_request_intents_v1 (
  linkage_key text PRIMARY KEY,
  ledger_id uuid NOT NULL UNIQUE,
  request_intent jsonb NOT NULL CHECK (
    jsonb_typeof(request_intent) = 'object'
    AND request_intent->>'version' = '1'
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.ca_correction_request_intents_v1 OWNER TO postgres;
ALTER TABLE public.ca_correction_request_intents_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_correction_request_intents_v1 FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.ca_correction_intent_immutable_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION 'correction_intent_is_immutable';
END;
$function$;
ALTER FUNCTION public.ca_correction_intent_immutable_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ca_correction_intent_immutable_v1() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER ca_correction_intent_immutable_v1
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.ca_correction_request_intents_v1
  FOR EACH STATEMENT EXECUTE FUNCTION public.ca_correction_intent_immutable_v1();

-- No FK to a potentially partitioned ledger's UUID alone. The qualified
-- writer binds both IDs atomically; replay verifies the retained ledger ID.
-- No backfill, app policy, public reader, or service INSERT grant.
