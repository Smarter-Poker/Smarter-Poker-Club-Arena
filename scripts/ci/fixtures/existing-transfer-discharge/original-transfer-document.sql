CREATE OR REPLACE FUNCTION public.fn_accounting_transfer_document_on_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 IF NEW.category='correction' THEN PERFORM public.fn_accounting_correction_prepare(NEW.id);END IF;
 PERFORM public.fn_invoice_accounting_ledger_transfer(NEW.id);
 RETURN NEW;
END $function$
