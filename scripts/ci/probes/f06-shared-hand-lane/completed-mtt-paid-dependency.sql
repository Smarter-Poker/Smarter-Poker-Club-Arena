-- Exact installed original paid receipt schema and immutable guards, source 20260918093004.
CREATE TABLE public.tournament_paid_stack_custody_receipts (
  id uuid PRIMARY KEY,
  transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  tournament_id uuid NOT NULL,
  user_id uuid NOT NULL,
  candidate_id uuid NOT NULL UNIQUE,
  entitlement_id uuid NOT NULL UNIQUE,
  source_ledger_id uuid NOT NULL UNIQUE,
  source_wallet_id uuid NOT NULL UNIQUE,
  destination_table_id uuid NOT NULL,
  destination_seat_number integer NOT NULL CHECK(destination_seat_number BETWEEN 1 AND 10),
  grant_chips numeric NOT NULL CHECK(grant_chips>0 AND grant_chips=trunc(grant_chips) AND grant_chips<2147483648),
  live_chips_before numeric NOT NULL CHECK(live_chips_before>=0 AND live_chips_before<'Infinity'),
  funded_supply numeric NOT NULL CHECK(funded_supply>0 AND funded_supply<'Infinity'),
  scoring_excess numeric NOT NULL,
  expected jsonb NOT NULL CHECK(jsonb_typeof(expected)='object'),
  state text NOT NULL CHECK(state IN ('reserved','seated')),
  assignment jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK(scoring_excess=live_chips_before+grant_chips-funded_supply),
  CHECK((state='reserved' AND assignment IS NULL AND completed_at IS NULL)
     OR (state='seated' AND assignment IS NOT NULL AND completed_at IS NOT NULL))
);
ALTER TABLE public.tournament_paid_stack_custody_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_paid_stack_custody_receipts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_guard_original_paid_stack_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
BEGIN
 IF TG_OP='DELETE' OR TG_OP='TRUNCATE' THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_CUSTODY_IMMUTABLE' USING ERRCODE='55000';
 ELSIF TG_OP='INSERT' THEN
  IF NEW.state IS DISTINCT FROM 'reserved' OR NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() THEN
   RAISE EXCEPTION 'ORIGINAL_PAID_CUSTODY_RESERVATION_REQUIRED' USING ERRCODE='55000';
  END IF;
 ELSIF OLD.state IS DISTINCT FROM 'reserved' OR NEW.state IS DISTINCT FROM 'seated'
 OR OLD.transaction_id IS DISTINCT FROM pg_current_xact_id()
 OR (to_jsonb(NEW)-ARRAY['state','assignment','completed_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','assignment','completed_at']) THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_CUSTODY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_guard_original_paid_stack_receipt() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER original_paid_custody_immutable BEFORE INSERT OR UPDATE OR DELETE
 ON public.tournament_paid_stack_custody_receipts FOR EACH ROW
 EXECUTE FUNCTION public.fn_ca_guard_original_paid_stack_receipt();
CREATE TRIGGER original_paid_custody_no_truncate BEFORE TRUNCATE
 ON public.tournament_paid_stack_custody_receipts FOR EACH STATEMENT
 EXECUTE FUNCTION public.fn_ca_guard_original_paid_stack_receipt();

CREATE FUNCTION public.fn_ca_original_paid_stack_must_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tournament_paid_stack_custody_receipts r
 WHERE r.id=NEW.id AND r.state='seated' AND r.assignment->>'ok'='true'
 AND r.assignment->>'tournament_id'=r.tournament_id::text
 AND r.assignment->>'user_id'=r.user_id::text
 AND r.assignment->>'table_id'=r.destination_table_id::text
 AND (r.assignment->>'seat_number')::integer=r.destination_seat_number
 AND (r.assignment->>'stack')::numeric=r.grant_chips) THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_CUSTODY_INCOMPLETE' USING ERRCODE='55000';
 END IF;
 RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_original_paid_stack_must_complete() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER original_paid_custody_completed AFTER INSERT OR UPDATE
 ON public.tournament_paid_stack_custody_receipts DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_original_paid_stack_must_complete();

