CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_prepare_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE n timestamptz:=smarter_private.weekly_payout_clock();e timestamptz:=public.fn_union_week_start(n);
 due timestamptz:=public.fn_union_accounting_run_at(e);cutover timestamptz;plan jsonb;item jsonb;preparation jsonb;
 problems jsonb:='[]'::jsonb;had_windows boolean;began timestamptz:=clock_timestamp();work_deadline timestamptz;saved_preparation_deadline text;r public.weekly_accounting_payout_pauses%ROWTYPE;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 SELECT cutover_period_end INTO STRICT cutover FROM smarter_private.weekly_payout_phase_configuration WHERE singleton;
 IF e<cutover OR n<e OR n>=due THEN RETURN NULL;END IF;
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('statement_timeout')::interval IS DISTINCT FROM interval '240 seconds'
 THEN RAISE EXCEPTION 'weekly_payout_original_bounded_tick_required' USING ERRCODE='55000';END IF;
 plan:=smarter_private.weekly_payout_scope_plan(e,n);
 IF jsonb_array_length(plan)=0 THEN RETURN NULL;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(plan) LOOP
  IF clock_timestamp()-began>interval '30 seconds' THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('reason','preparation_budget','scope',item));EXIT;
  END IF;
  PERFORM public.fn_weekly_accounting_attempt_begin(item->>'kind'='union');
  BEGIN
   -- Continue only this original R0 transition while its immutable source
   -- reviews prove positive progress. No other failure/result is retried.
   work_deadline:=LEAST(began+interval '30 seconds',NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz,due);
   saved_preparation_deadline:=current_setting('app.weekly_accounting_preparation_deadline',true);
   PERFORM set_config('app.weekly_accounting_preparation_deadline',work_deadline::text,true);
   LOOP
   preparation:=public.fn_prepare_accounting_week(CASE WHEN item->>'kind'='union' THEN (item->>'id')::uuid END,
    CASE WHEN item->>'kind'='club' THEN (item->>'id')::uuid END,(item->>'period_start')::timestamptz,(item->>'period_end')::timestamptz);
    EXIT WHEN NOT(coalesce(jsonb_array_length(preparation->'problems'),0)=1
      AND preparation#>>'{problems,0,reason}'='own_agent_source_interpretation_in_progress'
      AND coalesce((preparation#>>'{problems,0,source_check,reviewed}')::int,0)>0);
    EXIT WHEN preparation#>>'{problems,0,source_check,budget_exhausted}'='true'OR clock_timestamp()>=work_deadline;
   END LOOP;
   PERFORM set_config('app.weekly_accounting_preparation_deadline',coalesce(saved_preparation_deadline,''),true);
   had_windows:=false;
   IF preparation->>'success'='true' THEN
    had_windows:=public.fn_accounting_close_windows_pending(CASE WHEN item->>'kind'='union' THEN (item->>'id')::uuid END,
     CASE WHEN item->>'kind'='club' THEN (item->>'id')::uuid END,(item->>'period_start')::timestamptz,(item->>'period_end')::timestamptz);
   END IF;
   IF preparation->>'success' IS DISTINCT FROM 'true' OR had_windows THEN
    problems:=problems||jsonb_build_array(jsonb_build_object('scope',item,'preparation',preparation,'windows_pending',had_windows));
   END IF;
  EXCEPTION WHEN OTHERS THEN
   PERFORM set_config('app.weekly_accounting_preparation_deadline',coalesce(saved_preparation_deadline,''),true);
   problems:=problems||jsonb_build_array(jsonb_build_object('scope',item,'error',SQLERRM,'sqlstate',SQLSTATE));
  END;
  PERFORM public.fn_weekly_accounting_attempt_end();
 END LOOP;
 IF jsonb_array_length(problems)>0 THEN
  RETURN jsonb_build_object('success',false,'owns_tick',true,'advanced',true,'stage','weekly_payout_preparing','problems',problems);
 END IF;
 INSERT INTO public.weekly_accounting_payout_pauses(period_start,period_end,announced_at,money_starts_at,money_deadline_at,expires_at,scope_plan)
 VALUES(public.fn_union_prev_week_start(e),e,due-interval '2 minutes',due,due+interval '240 seconds',due+interval '5 minutes',plan)
 ON CONFLICT(period_start,period_end)DO NOTHING;
 SELECT * INTO STRICT r FROM public.weekly_accounting_payout_pauses p WHERE p.period_end=e;
 IF r.scope_plan IS DISTINCT FROM plan THEN RAISE EXCEPTION 'weekly_payout_prepared_scope_changed' USING ERRCODE='55000';END IF;
 RETURN jsonb_build_object('success',false,'owns_tick',true,'advanced',true,'stage','weekly_payout_prepared','run_id',r.run_id);
END $function$;
