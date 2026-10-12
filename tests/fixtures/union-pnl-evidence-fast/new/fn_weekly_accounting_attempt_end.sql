CREATE OR REPLACE FUNCTION public.fn_weekly_accounting_attempt_end() RETURNS void
 LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
 PERFORM set_config('app.weekly_accounting_scope_deadline','',true);
 PERFORM set_config('app.accounting_close_memo','',true);
 PERFORM set_config('app.accounting_earned_plan_memo','',true);
 PERFORM set_config('app.union_pnl_evidence_memo','',true);
END $function$
