CREATE OR REPLACE FUNCTION public.fn_accounting_close_windows_advance_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE q record; done jsonb:='[]'::jsonb; advanced boolean:=false; stmt_stop timestamptz;
 n_windows bigint; n_before bigint; n_after bigint; v_msg text;
 budget interval:=COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 saved_deadline text:=COALESCE(current_setting('app.weekly_accounting_scope_deadline',true),'');
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('statement_timeout') IN ('0','0ms')
  OR public.fn_platform_frozen() IS DISTINCT FROM false
  OR extract(minute FROM clock_timestamp())>=45
  OR NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
  RETURN NULL;
 END IF;
 -- No window starts less than a minute before the statement is cancelled.
 stmt_stop:=statement_timestamp()+current_setting('statement_timeout')::interval-interval '60 seconds';
 FOR q IN SELECT r.scope_kind,r.scope_id,r.period_start,r.period_end FROM public.union_accounting_runs r
   WHERE r.status='running' AND r.result->>'chunk_committed'='true' AND r.result->>'stage'='prepared'
    AND r.scope_kind IN ('union','club') AND r.scope_id IS NOT NULL AND r.period_end<=clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs s WHERE s.scope_kind=r.scope_kind
     AND s.scope_id=r.scope_id AND s.period_start=r.period_start AND s.period_end=r.period_end AND s.round_no=2)
   ORDER BY r.period_start,r.scope_kind,r.scope_id LOOP
  EXIT WHEN clock_timestamp()>stmt_stop;
  SELECT count(*),count(p.window_start) INTO n_windows,n_before
   FROM public.fn_accounting_close_windows(q.period_start,q.period_end) w
   LEFT JOIN public.accounting_close_partials p ON p.kind='round2_'||q.scope_kind||'_window' AND p.union_id=q.scope_id
    AND p.period_start=q.period_start AND p.period_end=q.period_end AND p.window_start=w.window_start AND p.window_end=w.window_end
    AND p.computed_at>=q.period_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime();
  CONTINUE WHEN n_windows=0 OR n_before=n_windows;
  -- The advance stops 120 s after its attempt began and a minute before the
  -- statement ends: begin it so both points are the statement's minute.
  PERFORM set_config('app.weekly_accounting_scope_deadline',(stmt_stop-interval '120 seconds'+budget)::text,true);
  BEGIN
   PERFORM public.fn_settle_accounting_commission_advance(q.scope_kind,q.scope_id,q.period_start,q.period_end);
  EXCEPTION WHEN OTHERS THEN
   -- A window this read cannot prove is left to the book's own attempt,
   -- which refuses it as it always has.
   GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT;
  END;
  SELECT count(p.window_start) INTO n_after
   FROM public.fn_accounting_close_windows(q.period_start,q.period_end) w
   JOIN public.accounting_close_partials p ON p.kind='round2_'||q.scope_kind||'_window' AND p.union_id=q.scope_id
    AND p.period_start=q.period_start AND p.period_end=q.period_end AND p.window_start=w.window_start AND p.window_end=w.window_end
    AND p.computed_at>=q.period_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime();
  advanced:=advanced OR n_after>n_before;
  done:=done||jsonb_build_array(jsonb_build_object('scope_kind',q.scope_kind,'scope_id',q.scope_id,
   'period_start',q.period_start,'period_end',q.period_end,'windows',n_windows,'fresh_before',n_before,
   'fresh_after',n_after,'error',v_msg));
  v_msg:=NULL;
 END LOOP;
 PERFORM set_config('app.weekly_accounting_scope_deadline',saved_deadline,true);
 IF NOT advanced THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('success',true,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
  'observed_at',clock_timestamp(),'detail','[]'::jsonb,'window_advance',done);
END
$function$
