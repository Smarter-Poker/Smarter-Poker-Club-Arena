-- PROPOSAL ONLY. The new contributor identity survives every later settle.
CREATE FUNCTION public.fn_ca_commission_contributor_identity_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
BEGIN
 IF OLD.contributing_user_id IS DISTINCT FROM NEW.contributing_user_id THEN
   RAISE EXCEPTION 'Commission contributing identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_commission_contributor_identity_immutable()
 FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER commission_contributor_identity_immutable BEFORE UPDATE
 ON public.agent_commissions FOR EACH ROW
 EXECUTE FUNCTION public.fn_ca_commission_contributor_identity_immutable();
CREATE FUNCTION public.fn_ca_commission_receipt_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
BEGIN
 IF TG_OP='UPDATE' AND OLD.state='pending'
   AND NEW.state IN ('applied','legacy_preserved')
   AND NEW.source_type=OLD.source_type AND NEW.source_id=OLD.source_id
   AND NEW.contributing_user_id=OLD.contributing_user_id
   AND NEW.requested_club_id=OLD.requested_club_id
   AND NEW.rake_credit=OLD.rake_credit AND NEW.created_at=OLD.created_at THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Final commission source receipts are immutable' USING ERRCODE='23514';
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_commission_receipt_immutable()
 FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER commission_receipt_immutable BEFORE UPDATE OR DELETE
 ON public.ca_commission_contributor_receipts FOR EACH ROW
 EXECUTE FUNCTION public.fn_ca_commission_receipt_immutable();
CREATE TRIGGER commission_receipt_no_truncate BEFORE TRUNCATE
 ON public.ca_commission_contributor_receipts FOR EACH STATEMENT
 EXECUTE FUNCTION public.fn_ca_commission_receipt_immutable();
