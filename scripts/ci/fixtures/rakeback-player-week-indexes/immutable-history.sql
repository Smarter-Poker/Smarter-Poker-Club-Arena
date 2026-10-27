CREATE OR REPLACE FUNCTION public.fn_accounting_agreement_history_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION 'accounting_agreement_history_is_immutable' USING ERRCODE='55000'; END $function$

