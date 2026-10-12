CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- WEEKLY CLOSE SCALE (20260928): a union's weekly close proves the same earned
-- plan up to nine times in one transaction (preparation twice, round 1 twice,
-- round 3, the ECO gate and the invoice evidence), about a minute each at
-- Midway's scale. Inside a close (app.accounting_close_memo='on', set only by
-- fn_process_weekly_accounting_scope for the attempt it is running) the first
-- proof of a (union, week) is kept for the rest of that transaction; a
-- rolled-back attempt forgets it with its subtransaction. Everywhere else the
-- plan is proved on every call, exactly as before, by
-- fn_accounting_union_earned_plan_v3.
DECLARE memo jsonb; memo_key text; plan jsonb;
BEGIN
 IF current_setting('app.accounting_close_memo',true)='on' THEN
  memo_key:=p_union_id::text||'|'||p_start::text||'|'||p_end::text;
  memo:=NULLIF(current_setting('app.accounting_earned_plan_memo',true),'')::jsonb;
  IF memo ? memo_key THEN RETURN memo->memo_key; END IF;
 END IF;
 plan:=public.fn_accounting_union_earned_plan_v3(p_union_id,p_start,p_end);
 IF memo_key IS NOT NULL THEN
  PERFORM set_config('app.accounting_earned_plan_memo',(COALESCE(memo,'{}'::jsonb)||jsonb_build_object(memo_key,plan))::text,true);
 END IF;
 RETURN plan;
END $function$
