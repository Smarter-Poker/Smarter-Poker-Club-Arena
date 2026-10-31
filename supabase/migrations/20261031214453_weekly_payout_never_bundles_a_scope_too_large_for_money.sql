-- Version reserved by scripts/reserve-migration-version.sh against protected main and worktrees.
-- An owned weekly payout slot pays every scope of its plan inside ONE bounded
-- 240-second money statement. Midway Union's week reads ~4.5 million sources
-- in round two alone (2026-10-19..26: 4,542,280), so bundled with Deep Stack
-- Society and Lightning Internal Pilot it cancels the statement and NOBODY is
-- paid, at every hourly slot (found by the rolled-back 2026-10-31 simulation:
-- statement timeout inside fn_settle_accounting_commission_stage's source
-- build). A scope too large for the money window is now never bundled: the
-- others are prepared and paid at 04:00, and the large scope is recorded for
-- Production Alerts. It remains owed for its protected route; nothing pays it
-- twice. No rate, ledger, receipt, report, generation or schedule change.
-- @live-proof: md5(pg_get_functiondef('smarter_private.weekly_payout_prepare_due()'::regprocedure))='0a2f2c4302c042a8971e88de455cc9ce' AND md5(pg_get_functiondef('smarter_private.weekly_payout_money_window_fits(text,uuid)'::regprocedure))='e22b6050f5af7b78b2e00f9f1736f885'
BEGIN;
SET LOCAL transaction_timeout='15s';
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
SET LOCAL search_path=pg_catalog,public;
SET LOCAL timezone='UTC';
DO $weekly_payout_money_window_authority$
BEGIN
 IF session_user<>'postgres' OR current_user<>'postgres'
  OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL
  OR public.fn_platform_frozen() IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'weekly_payout_money_window_operator_or_freeze_refused';
 END IF;
 IF md5(pg_get_functiondef('smarter_private.weekly_payout_due()'::regprocedure))IS DISTINCT FROM '0dbbd9d129658483c1699faf0bf0ef7b'
  OR md5(pg_get_functiondef('smarter_private.weekly_payout_prepare_due()'::regprocedure))IS DISTINCT FROM '8b87258de81fd2429ab72dc614ac4982'
  OR to_regclass('smarter_private.weekly_payout_money_window_exclusions') IS NOT NULL
  OR to_regprocedure('smarter_private.weekly_payout_money_window_fits(text,uuid)') IS NOT NULL
  OR public.fn_ca_owner_page_kind('weekly-payout','WeeklyPayoutScopeTooLargeForMoneyWindow','critical') IS NOT NULL
 THEN RAISE EXCEPTION 'weekly_payout_money_window_original_owner_changed';END IF;
END $weekly_payout_money_window_authority$;
-- native:begin
CREATE TABLE smarter_private.weekly_payout_money_window_exclusions(
 scope_kind text NOT NULL CHECK(scope_kind IN('club','union')),
 scope_id uuid NOT NULL,
 reason text NOT NULL,
 measured_sources bigint,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(scope_kind,scope_id));
REVOKE ALL ON TABLE smarter_private.weekly_payout_money_window_exclusions FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO smarter_private.weekly_payout_money_window_exclusions(scope_kind,scope_id,reason,measured_sources)
VALUES('union','fade0000-0000-0000-0000-000000000001',
 'Midway Union: round two of 2026-10-19..26 read 4542280 sources; its money rounds do not fit the 240-second owned money statement (rolled-back simulation 2026-10-31). Remove only when its money rounds are precomputed during the week.',4542280);
CREATE FUNCTION smarter_private.weekly_payout_money_window_fits(p_kind text,p_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT NOT EXISTS(SELECT FROM smarter_private.weekly_payout_money_window_exclusions x WHERE x.scope_kind=p_kind AND x.scope_id=p_id)
  AND COALESCE((SELECT max(w.sources) FROM (SELECT (r.result->>'sources')::bigint AS sources FROM public.accounting_routed_settlement_runs r
   WHERE r.scope_kind=p_kind AND r.scope_id=p_id AND r.round_no=2 AND r.result->>'sources' ~ '^[0-9]{1,18}$'
   ORDER BY r.period_start DESC LIMIT 4) w),0)<=1000000
$function$;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_money_window_fits(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
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
 too_large jsonb:='[]'::jsonb;
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
 -- MONEY WINDOW (20261031214453): an owned slot pays all of its scopes inside
 -- ONE bounded 240-second money statement, so a scope whose own money rounds
 -- cannot fit that window would cancel the statement and leave every other
 -- scope unpaid at every slot. Such a scope (a recorded exclusion, or one whose
 -- recent round two read more than a million sources) is never bundled: the
 -- others are prepared and paid, and the large scope is recorded once for
 -- Production Alerts (never paged). It stays owed; no payer starts for it here.
 SELECT COALESCE(jsonb_agg(x.value),'[]'::jsonb) INTO too_large FROM jsonb_array_elements(plan) x
  WHERE NOT smarter_private.weekly_payout_money_window_fits(x.value->>'kind',(x.value->>'id')::uuid);
 IF jsonb_array_length(too_large)>0 THEN
  BEGIN
   PERFORM public.fn_record_operational_alert('weekly-payout','too-large-for-money-window:'||e::text,'WeeklyPayoutScopeTooLargeForMoneyWindow','firing','critical',
    jsonb_build_object('target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca','period_end',e,'scopes',too_large,'observed_at',n));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  SELECT COALESCE(jsonb_agg(x.j ORDER BY x.o),'[]'::jsonb) INTO plan FROM jsonb_array_elements(plan) WITH ORDINALITY x(j,o)
   WHERE NOT x.j IN (SELECT t.value FROM jsonb_array_elements(too_large) t);
  IF jsonb_array_length(plan)=0 THEN RETURN NULL;END IF;
 END IF;
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
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_prepare_due() FROM PUBLIC,anon,authenticated,service_role;
-- native:end
DO $weekly_payout_money_window_installed$
BEGIN
 IF md5(pg_get_functiondef('smarter_private.weekly_payout_prepare_due()'::regprocedure))IS DISTINCT FROM '0a2f2c4302c042a8971e88de455cc9ce'
  OR md5(pg_get_functiondef('smarter_private.weekly_payout_money_window_fits(text,uuid)'::regprocedure))IS DISTINCT FROM 'e22b6050f5af7b78b2e00f9f1736f885'
  OR md5(pg_get_functiondef('smarter_private.weekly_payout_due()'::regprocedure))IS DISTINCT FROM '0dbbd9d129658483c1699faf0bf0ef7b'
  OR EXISTS(SELECT FROM pg_proc WHERE oid IN('smarter_private.weekly_payout_prepare_due()'::regprocedure,'smarter_private.weekly_payout_money_window_fits(text,uuid)'::regprocedure)
   AND proacl IS DISTINCT FROM '{postgres=X/postgres}'::aclitem[])
  OR (SELECT count(*) FROM smarter_private.weekly_payout_money_window_exclusions)<>1
  OR smarter_private.weekly_payout_money_window_fits('union','fade0000-0000-0000-0000-000000000001')
 THEN RAISE EXCEPTION 'weekly_payout_money_window_install_mismatch';END IF;
END $weekly_payout_money_window_installed$;
COMMIT;
