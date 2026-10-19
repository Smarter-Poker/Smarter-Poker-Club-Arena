CREATE OR REPLACE FUNCTION public.fn_ca_legacy_period_maturity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF NEW.status='paid' AND OLD.status IS DISTINCT FROM 'paid'
  AND (NEW.period_end+1)::timestamp AT TIME ZONE 'UTC' > statement_timestamp() THEN
  RAISE EXCEPTION 'Legacy period payment requires a closed earning period' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $function$
