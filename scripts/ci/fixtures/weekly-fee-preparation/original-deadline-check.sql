CREATE FUNCTION public.fn_weekly_accounting_deadline_check() RETURNS void
 LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE deadline text:=current_setting('app.weekly_accounting_scope_deadline',true);
BEGIN
 IF deadline IS NOT NULL AND deadline<>'' AND clock_timestamp()>deadline::timestamptz THEN
  RAISE EXCEPTION 'weekly_scope_time_budget_exhausted' USING DETAIL=jsonb_build_object('deadline',deadline,
   'budget',COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes'),'at',clock_timestamp())::text;
 END IF;
END $function$;
