CREATE OR REPLACE FUNCTION public.fn_weekly_accounting_attempt_begin(p_memo boolean) RETURNS void
 LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
 -- One close attempt of one book: its deadline, and (for a union) the
 -- earned-plan memo, both transaction-local and cleared by attempt_end.
 PERFORM set_config('app.weekly_accounting_scope_deadline',
  (clock_timestamp()+COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval)::text,true);
 PERFORM set_config('app.accounting_close_memo',CASE WHEN p_memo THEN 'on' ELSE '' END,true);
 PERFORM set_config('app.accounting_earned_plan_memo','',true);
 PERFORM set_config('app.union_pnl_evidence_memo','',true);
END $function$
