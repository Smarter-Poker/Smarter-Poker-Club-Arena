CREATE OR REPLACE FUNCTION public.fn_cash_provenance_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN RAISE EXCEPTION 'Original cash provenance is immutable' USING ERRCODE='55000'; END $function$
