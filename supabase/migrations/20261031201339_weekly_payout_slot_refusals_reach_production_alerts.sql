-- Version reserved by scripts/reserve-migration-version.sh against protected main and worktrees.
-- A refused weekly payout slot, a scope deferred to the next owned slot, and a
-- week still owing scopes after its last slot are recorded once for Production
-- Alerts (source weekly-payout; no owner page kind matches it). Recording is
-- best effort and never changes the payout outcome, the slot, the receipts or
-- the owned pause. No rate, ledger, receipt, report, generation or schedule change.
-- @live-proof: md5(pg_get_functiondef('smarter_private.weekly_payout_due()'::regprocedure))='0dbbd9d129658483c1699faf0bf0ef7b' AND md5(pg_get_functiondef('smarter_private.weekly_payout_prepare_due()'::regprocedure))='8b87258de81fd2429ab72dc614ac4982'
BEGIN;
SET LOCAL transaction_timeout='15s';
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
SET LOCAL search_path=pg_catalog,public;
SET LOCAL timezone='UTC';
DO $weekly_payout_alerts_authority$
BEGIN
 IF session_user<>'postgres' OR current_user<>'postgres'
  OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL
  OR public.fn_platform_frozen() IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'weekly_payout_alerts_operator_or_freeze_refused';
 END IF;
 IF md5(pg_get_functiondef('smarter_private.weekly_payout_due()'::regprocedure))IS DISTINCT FROM 'b77443e07a558eae875c7f526ca9c16d'
  OR md5(pg_get_functiondef('smarter_private.weekly_payout_prepare_due()'::regprocedure))IS DISTINCT FROM '24f2a5141c6ff0612ecaa65de4dbf486'
  OR to_regprocedure('public.fn_record_operational_alert(text,text,text,text,text,jsonb)') IS NULL
  OR public.fn_ca_owner_page_kind('weekly-payout','WeeklyPayoutSlotRefused','warning') IS NOT NULL
  OR public.fn_ca_owner_page_kind('weekly-payout','WeeklyPayoutUnpaidAfterLastSlot','critical') IS NOT NULL
 THEN RAISE EXCEPTION 'weekly_payout_alerts_original_owner_changed';END IF;
END $weekly_payout_alerts_authority$;
-- native:begin
CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE n timestamptz:=smarter_private.weekly_payout_clock();e timestamptz:=public.fn_union_week_start(n);
 c timestamptz;r public.weekly_accounting_payout_pauses%ROWTYPE;answer jsonb;
BEGIN
 SELECT cutover_period_end INTO STRICT c FROM smarter_private.weekly_payout_phase_configuration WHERE singleton;
 IF e<c THEN RETURN NULL;END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
  RETURN jsonb_build_object('success',false,'owns_tick',true,'advanced',false,'stage','weekly_payout_original_scheduler_owned');END IF;
 -- EVERY PREPARED SCOPE IS PAID; THE REST CATCH UP (20261031190020): the
 -- newest owned boundary of this closed week. Released (paid, refused or
 -- missed) means the next slot is prepared for whatever this week still owes;
 -- with nothing owed, or every slot spent, the original post-money scope owner
 -- continues P&L/docs and reads the original financial receipts, never paying
 -- them again.
 SELECT * INTO r FROM public.weekly_accounting_payout_pauses p WHERE p.period_end=e ORDER BY p.attempt_no DESC LIMIT 1;
 IF NOT FOUND OR r.phase='released' THEN RETURN smarter_private.weekly_payout_prepare_due();END IF;
 IF n<r.money_starts_at THEN
  RETURN jsonb_build_object('success',false,'owns_tick',true,'advanced',false,'stage','weekly_payout_prepared',
   'run_id',r.run_id,'attempt_no',r.attempt_no,'scheduled_for',r.money_starts_at);
 END IF;
 BEGIN
  answer:=smarter_private.weekly_payout_execute(r.run_id);
 EXCEPTION WHEN OTHERS THEN
  -- This subtransaction rolled back every financial pass, context capability
  -- and receipt together. A network-unknown outcome is read from this SAME
  -- durable run; this handler never starts another payer or extends the pause.
  -- The scopes it owned stay owed and are prepared for the next owned slot.
  answer:=jsonb_build_object('success',false,'owns_tick',true,'advanced',false,'stage','weekly_payout_financial_refused',
   'run_id',r.run_id,'attempt_no',r.attempt_no,'sqlstate',SQLSTATE,'reason',SQLERRM,'paid',false,'scheduled_for',r.money_starts_at,'observed_at',smarter_private.weekly_payout_clock());
  UPDATE public.weekly_accounting_payout_pauses SET phase='released',result=answer WHERE run_id=r.run_id;
 END;
 -- PRODUCTION ALERTS (20261031210000): a refused slot or a deferred scope is
 -- recorded once per boundary for Production Alerts; it never pages and never
 -- changes the payout outcome. The owed scopes are prepared for the next slot.
 IF answer->>'stage'='weekly_payout_financial_refused' OR jsonb_array_length(COALESCE(answer->'deferred_scopes','[]'::jsonb))>0 THEN
  BEGIN
   PERFORM public.fn_record_operational_alert('weekly-payout',
    CASE WHEN answer->>'stage'='weekly_payout_financial_refused' THEN 'refused:' ELSE 'deferred:' END||r.run_id::text,
    CASE WHEN answer->>'stage'='weekly_payout_financial_refused' THEN 'WeeklyPayoutSlotRefused' ELSE 'WeeklyPayoutScopeDeferred' END,
    'firing','warning',jsonb_build_object('target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca','period_start',r.period_start,'period_end',r.period_end,'attempt_no',r.attempt_no,
     'scheduled_for',r.money_starts_at,'reason',answer->>'reason','deferred_scopes',COALESCE(answer->'deferred_scopes','[]'::jsonb),
     'next','owed scopes are prepared for the next owned hourly slot'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
 END IF;
 RETURN answer;
END $function$;
CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_prepare_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE n timestamptz:=smarter_private.weekly_payout_clock();e timestamptz:=public.fn_union_week_start(n);
 due timestamptz:=public.fn_union_accounting_run_at(e);cutover timestamptz;plan jsonb;item jsonb;preparation jsonb;
 problems jsonb:='[]'::jsonb;ready jsonb:='[]'::jsonb;had_windows boolean;began timestamptz:=clock_timestamp();work_deadline timestamptz;saved_preparation_deadline text;r public.weekly_accounting_payout_pauses%ROWTYPE;
 latest public.weekly_accounting_payout_pauses%ROWTYPE;attempt integer:=1;slot timestamptz;final_call boolean;remaining integer;share interval;scope_deadline timestamptz;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 SELECT cutover_period_end INTO STRICT cutover FROM smarter_private.weekly_payout_phase_configuration WHERE singleton;
 IF e<cutover OR n<e THEN RETURN NULL;END IF;
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('statement_timeout')::interval IS DISTINCT FROM interval '240 seconds'
 THEN RAISE EXCEPTION 'weekly_payout_original_bounded_tick_required' USING ERRCODE='55000';END IF;
 -- EVERY PREPARED SCOPE IS PAID; THE REST CATCH UP (20261031190020). The newest
 -- owned boundary of this closed week decides the next slot: the original 04:00
 -- slot, then one owned slot per hour for scopes an earlier slot did not pay.
 -- A boundary that is not released waits for its own slot and is never
 -- re-prepared here; weekly_payout_due executes it at its own money start.
 SELECT * INTO latest FROM public.weekly_accounting_payout_pauses p WHERE p.period_end=e ORDER BY p.attempt_no DESC LIMIT 1;
 IF FOUND THEN
  IF latest.phase<>'released' THEN
   RETURN jsonb_build_object('success',false,'owns_tick',true,'advanced',false,'stage','weekly_payout_prepared',
    'run_id',latest.run_id,'attempt_no',latest.attempt_no,'scheduled_for',latest.money_starts_at);
  END IF;
  attempt:=latest.attempt_no+1;
 END IF;
 slot:=due+make_interval(hours=>attempt-1);
 -- A slot needs its two-minute last-hand notice plus one more tick ahead of it.
 WHILE n>slot-interval '3 minutes' LOOP attempt:=attempt+1;slot:=due+make_interval(hours=>attempt-1);END LOOP;
 IF attempt>8 THEN
  -- PRODUCTION ALERTS (20261031210000): every owned slot of this week is spent
  -- while the week still owes scopes. Recorded, never paged; no payer starts.
  IF jsonb_array_length(smarter_private.weekly_payout_scope_plan(e,n))>0 THEN
   BEGIN
    PERFORM public.fn_record_operational_alert('weekly-payout','unpaid-after-last-slot:'||e::text,'WeeklyPayoutUnpaidAfterLastSlot','firing','critical',
     jsonb_build_object('target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca','period_end',e,'owed',smarter_private.weekly_payout_scope_plan(e,n),'observed_at',n));
   EXCEPTION WHEN OTHERS THEN NULL;
   END;
  END IF;
  RETURN NULL;
 END IF;
 plan:=smarter_private.weekly_payout_scope_plan(e,n);
 IF jsonb_array_length(plan)=0 THEN RETURN NULL;END IF;
 -- The last preparation ticks before a slot own it with the scopes that are
 -- ready; a scope still preparing is deferred to the next slot, never allowed
 -- to keep every other scope unpaid.
 final_call:=n>=slot-interval '10 minutes';
 remaining:=jsonb_array_length(plan);
 -- Standalone club books before union books, each with a fair share of this
 -- tick, so one large union cannot spend the whole tick of every scope.
 FOR item IN SELECT j FROM jsonb_array_elements(plan) WITH ORDINALITY x(j,o) ORDER BY (j->>'kind'='union'),o LOOP
  IF clock_timestamp()-began>interval '150 seconds' THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('reason','preparation_budget','scope',item));
   remaining:=remaining-1;CONTINUE;
  END IF;
  PERFORM public.fn_weekly_accounting_attempt_begin(item->>'kind'='union');
  share:=GREATEST(interval '30 seconds',((began+interval '150 seconds')-clock_timestamp())/GREATEST(remaining,1));
  scope_deadline:=LEAST(NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz,clock_timestamp()+share);
  PERFORM set_config('app.weekly_accounting_scope_deadline',scope_deadline::text,true);
  -- The original window provers stop at deadline-budget+120s (and never past
  -- the statement's own start+timeout-60s): this scope's budget is its share.
  PERFORM set_config('app.weekly_accounting_scope_budget',share::text,true);
  BEGIN
   -- Continue only this original R0 transition while its immutable source
   -- reviews prove positive progress. No other failure/result is retried.
   work_deadline:=LEAST(scope_deadline,slot-interval '3 minutes');
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
   ELSE
    ready:=ready||jsonb_build_array(item);
   END IF;
  EXCEPTION WHEN OTHERS THEN
   PERFORM set_config('app.weekly_accounting_preparation_deadline',coalesce(saved_preparation_deadline,''),true);
   problems:=problems||jsonb_build_array(jsonb_build_object('scope',item,'error',SQLERRM,'sqlstate',SQLSTATE));
  END;
  PERFORM public.fn_weekly_accounting_attempt_end();
  remaining:=remaining-1;
 END LOOP;
 IF jsonb_array_length(problems)>0 AND NOT(final_call AND jsonb_array_length(ready)>0) THEN
  RETURN jsonb_build_object('success',false,'owns_tick',true,'advanced',true,'stage','weekly_payout_preparing',
   'attempt_no',attempt,'scheduled_for',slot,'ready_scopes',jsonb_array_length(ready),'problems',problems);
 END IF;
 -- The boundary keeps the original plan order of the scopes it pays.
 SELECT jsonb_agg(j ORDER BY o) INTO ready FROM jsonb_array_elements(plan) WITH ORDINALITY x(j,o) WHERE j IN (SELECT value FROM jsonb_array_elements(ready));
 INSERT INTO public.weekly_accounting_payout_pauses(period_start,period_end,attempt_no,announced_at,money_starts_at,money_deadline_at,expires_at,scope_plan)
 VALUES(public.fn_union_prev_week_start(e),e,attempt,slot-interval '2 minutes',slot,slot+interval '240 seconds',slot+interval '5 minutes',ready)
 ON CONFLICT(period_start,period_end,attempt_no)DO NOTHING;
 SELECT * INTO STRICT r FROM public.weekly_accounting_payout_pauses p WHERE p.period_end=e AND p.attempt_no=attempt;
 IF r.scope_plan IS DISTINCT FROM ready THEN RAISE EXCEPTION 'weekly_payout_prepared_scope_changed' USING ERRCODE='55000';END IF;
 IF jsonb_array_length(problems)>0 THEN
  BEGIN
   PERFORM public.fn_record_operational_alert('weekly-payout','deferred-at-preparation:'||r.run_id::text,'WeeklyPayoutScopeDeferred','firing','warning',
    jsonb_build_object('target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca','period_start',r.period_start,'period_end',r.period_end,'attempt_no',attempt,'scheduled_for',slot,'deferred_scopes',problems,
     'next','still-preparing scopes are prepared for the next owned hourly slot'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
 END IF;
 RETURN jsonb_build_object('success',false,'owns_tick',true,'advanced',true,'stage','weekly_payout_prepared','run_id',r.run_id,
  'attempt_no',attempt,'scheduled_for',slot,'deferred_scopes',problems);
END $function$;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_due() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_prepare_due() FROM PUBLIC,anon,authenticated,service_role;
-- native:end
DO $weekly_payout_alerts_installed$
BEGIN
 IF md5(pg_get_functiondef('smarter_private.weekly_payout_due()'::regprocedure))IS DISTINCT FROM '0dbbd9d129658483c1699faf0bf0ef7b'
  OR md5(pg_get_functiondef('smarter_private.weekly_payout_prepare_due()'::regprocedure))IS DISTINCT FROM '8b87258de81fd2429ab72dc614ac4982'
  OR EXISTS(SELECT FROM pg_proc WHERE oid IN('smarter_private.weekly_payout_due()'::regprocedure,'smarter_private.weekly_payout_prepare_due()'::regprocedure)
   AND proacl IS DISTINCT FROM '{postgres=X/postgres}'::aclitem[])
 THEN RAISE EXCEPTION 'weekly_payout_alerts_install_mismatch';END IF;
END $weekly_payout_alerts_installed$;
COMMIT;
