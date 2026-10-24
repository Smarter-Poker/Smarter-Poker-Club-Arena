CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 RETURN public.fn_process_weekly_accounting(NULL);
END $function$
