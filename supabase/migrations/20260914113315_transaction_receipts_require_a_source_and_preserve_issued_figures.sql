-- Weekly statements require a period. Transaction invoices instead require an exact posted source.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('fn_accounting_document_immutable()'::regprocedure))<>'a847f39bbd1bbfbef4b3e3a28ed9b3b6'
 THEN RAISE EXCEPTION 'accounting document guard changed since review'; END IF;
END $guard$;
ALTER TABLE public.settlement_invoices ALTER COLUMN period_id DROP NOT NULL;
ALTER TABLE public.settlement_invoices ADD CONSTRAINT accounting_invoice_has_one_source
 CHECK(num_nonnulls(source_ledger_id,source_credit_invoice_id,source_credit_payment_id)<=1
  AND (period_id IS NOT NULL OR num_nonnulls(source_ledger_id,source_credit_invoice_id,source_credit_payment_id)=1));
CREATE OR REPLACE FUNCTION public.fn_accounting_document_immutable() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE issued boolean;
BEGIN
 IF TG_TABLE_NAME='settlement_invoices' THEN
   issued:=COALESCE(OLD.message_sent,false) OR EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE invoice_id=OLD.id);
   IF issued AND (TG_OP='DELETE' OR
     ROW(NEW.club_id,NEW.period_id,NEW.invoice_type,NEW.invoice_number,NEW.from_entity_type,NEW.from_entity_id,
         NEW.to_entity_type,NEW.to_entity_id,NEW.gross_amount,NEW.net_amount,NEW.deductions,NEW.breakdown,
         NEW.due_at,NEW.notes,NEW.source_ledger_id,NEW.source_credit_invoice_id,NEW.source_credit_payment_id,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.club_id,OLD.period_id,OLD.invoice_type,OLD.invoice_number,OLD.from_entity_type,OLD.from_entity_id,
         OLD.to_entity_type,OLD.to_entity_id,OLD.gross_amount,OLD.net_amount,OLD.deductions,OLD.breakdown,
         OLD.due_at,OLD.notes,OLD.source_ledger_id,OLD.source_credit_invoice_id,OLD.source_credit_payment_id,OLD.created_at)
     OR NEW.message_sent IS DISTINCT FROM true)
   THEN RAISE EXCEPTION 'issued_accounting_invoice_is_immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='social_messages' THEN
   issued:=EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE message_id=OLD.id);
   IF issued AND (TG_OP='DELETE' OR
      (to_jsonb(NEW)-ARRAY['read_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['read_at','updated_at']))
   THEN RAISE EXCEPTION 'issued_accounting_message_is_immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $function$;
COMMIT;
