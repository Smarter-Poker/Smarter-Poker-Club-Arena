-- Version reserved by scripts/reserve-migration-version.sh against protected main and worktrees.
-- The owned 04:00 weekly payout paid every scope or none: one scope still
-- preparing (Midway's 85 commission/player windows need far more than the
-- original 30 seconds a tick) kept every union and club unpaid, and after
-- 04:00 no route could pay a missed scope or retry a refused one.
-- Now each owned boundary pays the scopes that are prepared: preparation gets
-- 150 seconds of each original 240-second tick with a fair share (deadline and
-- window budget) per scope,
-- standalone clubs first; the last ticks before a slot own it with the ready
-- scopes; a scope whose last-moment revalidation changed is deferred without
-- refusing the others; and a scope an earlier slot did not pay is prepared for
-- the next owned slot, one per hour (at most eight, 04:00 to 11:00). Every slot
-- keeps the original two-minute notice, physical fleet ACK, four-minute money
-- deadline, R1/R2/R3 order, receipts and owned-phase money refusal.
-- No rate, ledger, receipt, report, generation, schedule or engine change.
-- @live-proof: EXISTS(SELECT FROM pg_attribute WHERE attrelid='public.weekly_accounting_payout_pauses'::regclass AND attname='attempt_no' AND NOT attisdropped) AND md5(pg_get_functiondef('smarter_private.weekly_payout_due()'::regprocedure))='b77443e07a558eae875c7f526ca9c16d' AND md5(pg_get_functiondef('smarter_private.weekly_payout_prepare_due()'::regprocedure))='24f2a5141c6ff0612ecaa65de4dbf486' AND md5(pg_get_functiondef('smarter_private.weekly_payout_execute(uuid)'::regprocedure))='bbdd0f71eac3f2c9d36b8fa02e32ca09'
BEGIN;
SET LOCAL transaction_timeout='15s';
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
SET LOCAL search_path=pg_catalog,public;
SET LOCAL timezone='UTC';
DO $weekly_payout_catch_up_authority$
BEGIN
 IF session_user<>'postgres' OR current_user<>'postgres'
  OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL
  OR public.fn_platform_frozen() IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'weekly_payout_catch_up_operator_or_freeze_refused';
 END IF;
 IF md5(pg_get_functiondef('smarter_private.weekly_payout_due()'::regprocedure))IS DISTINCT FROM 'd6cfdca075b78f50a43c68c3df3dd392'
  OR md5(pg_get_functiondef('smarter_private.weekly_payout_prepare_due()'::regprocedure))IS DISTINCT FROM '71e651b7e956674a7d288e0fe49ff3af'
  OR md5(pg_get_functiondef('smarter_private.weekly_payout_execute(uuid)'::regprocedure))IS DISTINCT FROM 'fc3005c0275c0ab6fb4941660c3aaf63'
  OR md5(pg_get_functiondef('public.fn_weekly_accounting_payout_pause_state(uuid,uuid)'::regprocedure))IS DISTINCT FROM 'c104d1b8c7ad71a07c24319c332def0a'
  OR md5(pg_get_functiondef('public.fn_weekly_accounting_payout_pause_ack(uuid,uuid,text,jsonb)'::regprocedure))IS DISTINCT FROM '657102273a8cd099748abb4ab27828ec'
 THEN RAISE EXCEPTION 'weekly_payout_catch_up_original_owner_changed';END IF;
 -- No boundary may be in flight while its shape changes.
 IF EXISTS(SELECT FROM public.weekly_accounting_payout_pauses WHERE phase<>'released')THEN
  RAISE EXCEPTION 'weekly_payout_catch_up_boundary_in_flight';END IF;
END $weekly_payout_catch_up_authority$;
-- native:begin
ALTER TABLE public.weekly_accounting_payout_pauses ADD COLUMN attempt_no integer NOT NULL DEFAULT 1;
ALTER TABLE public.weekly_accounting_payout_pauses ADD CONSTRAINT weekly_accounting_payout_pauses_attempt_no_check CHECK(attempt_no BETWEEN 1 AND 8);
ALTER TABLE public.weekly_accounting_payout_pauses DROP CONSTRAINT weekly_accounting_payout_pauses_period_start_period_end_key;
ALTER TABLE public.weekly_accounting_payout_pauses ADD CONSTRAINT weekly_accounting_payout_pauses_period_attempt_key UNIQUE(period_start,period_end,attempt_no);
ALTER TABLE public.weekly_accounting_payout_pauses DROP CONSTRAINT weekly_accounting_payout_pauses_check2;
ALTER TABLE public.weekly_accounting_payout_pauses ADD CONSTRAINT weekly_accounting_payout_pauses_slot_check
 CHECK(money_starts_at=public.fn_union_accounting_run_at(period_end)+make_interval(hours=>attempt_no-1));
-- One owned boundary of a week is in flight at a time; the engine reads it.
CREATE UNIQUE INDEX weekly_accounting_payout_pauses_one_unreleased ON public.weekly_accounting_payout_pauses(period_end) WHERE phase<>'released';
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
 IF attempt>8 THEN RETURN NULL;END IF;
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
 RETURN jsonb_build_object('success',false,'owns_tick',true,'advanced',true,'stage','weekly_payout_prepared','run_id',r.run_id,
  'attempt_no',attempt,'scheduled_for',slot,'deferred_scopes',problems);
END $function$;
CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_execute(p_run uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET lock_timeout TO '1s'
AS $function$
DECLARE r public.weekly_accounting_payout_pauses%ROWTYPE;item jsonb;res jsonb;prep jsonb;
 round integer;k text;id uuid;ws timestamptz;we timestamptz;receipts jsonb:='[]'::jsonb;
 kept jsonb:='[]'::jsonb;deferred jsonb:='[]'::jsonb;
 began timestamptz:=smarter_private.weekly_payout_clock();
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 IF current_setting('statement_timeout')::interval IS DISTINCT FROM interval '240 seconds'
  OR COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
 THEN RAISE EXCEPTION 'weekly_payout_original_240s_tick_required' USING ERRCODE='55000';END IF;
 SELECT * INTO STRICT r FROM public.weekly_accounting_payout_pauses WHERE run_id=p_run;
 -- The original 04:00 invocation waits for its own physical fleet barrier.
 -- Do not lock the row before ACK: that would block the engine transaction
 -- needed to release this very wait. This bounded wait is part of the SAME
 -- original DUE statement, never a repair worker, new payer or renewed lease.
 WHILE r.phase='draining' AND smarter_private.weekly_payout_clock()>=r.money_starts_at
  AND smarter_private.weekly_payout_clock()+interval '180 seconds'<r.money_deadline_at LOOP
  PERFORM pg_sleep(0.05);
  SELECT * INTO STRICT r FROM public.weekly_accounting_payout_pauses WHERE run_id=p_run;
 END LOOP;
 SELECT * INTO STRICT r FROM public.weekly_accounting_payout_pauses WHERE run_id=p_run FOR UPDATE;
 began:=smarter_private.weekly_payout_clock();
 IF r.phase='released' THEN RETURN r.result||jsonb_build_object('duplicate',true);END IF;
 -- The original 180s scope must fit before the absolute money deadline and
 -- the original 240s statement must fit before the gameplay lease. Admission
 -- never renews either clock. Actual start time is retained rather than
 -- calling a late cron invocation an on-time four-o'clock payout.
 IF r.phase<>'ready' OR r.acknowledged_at>=r.money_deadline_at OR r.acknowledged_at IS NULL
  OR began<r.money_starts_at OR began+interval '180 seconds'>=r.money_deadline_at
  OR statement_timestamp()+interval '240 seconds'>=r.expires_at
  OR NOT smarter_private.weekly_payout_claims_match(r.instance_id,r.lease_claims)
 THEN RAISE EXCEPTION 'weekly_payout_not_prepared_and_parked_at_four' USING ERRCODE='55000';END IF;
 -- EVERY PREPARED SCOPE IS PAID (20261031190020): a boundary may own a subset
 -- of what this week still owes; every owned scope must still be owed, once.
 IF EXISTS(SELECT FROM jsonb_array_elements(r.scope_plan) j
   WHERE NOT j IN (SELECT value FROM jsonb_array_elements(smarter_private.weekly_payout_scope_plan(r.period_end,began))))
  OR (SELECT count(DISTINCT j) FROM jsonb_array_elements(r.scope_plan) j)<>jsonb_array_length(r.scope_plan)
 THEN RAISE EXCEPTION 'weekly_payout_prepared_scope_changed' USING ERRCODE='55000';END IF;
 PERFORM public.fn_weekly_accounting_attempt_begin(true);
 -- Revalidate original prepared earning/certificate owners immediately before
 -- any financial capability exists. Changed applicable source evidence must
 -- refuse or be admitted by its original producer, never by a current-rate
 -- rewrite here. No old paid JSON, timestamps or fingerprints are retagged.
 FOR item IN SELECT value FROM jsonb_array_elements(r.scope_plan) LOOP
  PERFORM public.fn_weekly_accounting_deadline_check();
  -- A scope whose preparation changed is deferred to the next owned slot with
  -- nothing paid; it never refuses the scopes that are still prepared.
  BEGIN
   prep:=public.fn_prepare_accounting_week(CASE WHEN item->>'kind'='union' THEN (item->>'id')::uuid END,
    CASE WHEN item->>'kind'='club' THEN (item->>'id')::uuid END,(item->>'period_start')::timestamptz,(item->>'period_end')::timestamptz);
  EXCEPTION WHEN OTHERS THEN
   IF SQLSTATE='57014' THEN RAISE;END IF;
   prep:=jsonb_build_object('success',false,'error',SQLERRM,'sqlstate',SQLSTATE);
  END;
  IF prep->>'success'='true' THEN kept:=kept||jsonb_build_array(item);
  ELSE deferred:=deferred||jsonb_build_array(jsonb_build_object('scope',item,'preparation',prep));END IF;
 END LOOP;
 IF jsonb_array_length(kept)=0 THEN
  RAISE EXCEPTION 'weekly_payout_precommit_preparation_changed' USING ERRCODE='55000',DETAIL=deferred::text;END IF;
 IF kept IS DISTINCT FROM r.scope_plan THEN
  UPDATE public.weekly_accounting_payout_pauses SET scope_plan=kept WHERE run_id=r.run_id RETURNING * INTO r;
 END IF;
 UPDATE public.weekly_accounting_payout_pauses SET phase='paying' WHERE run_id=r.run_id;
 -- This outer order is deliberate: ALL club funding, then ALL agent gross
 -- pass-downs, and only then ANY player/horse secondary payment.
 FOR round IN 1..3 LOOP
  FOR item IN SELECT value FROM jsonb_array_elements(r.scope_plan) LOOP
   k:=item->>'kind';id:=(item->>'id')::uuid;ws:=(item->>'period_start')::timestamptz;we:=(item->>'period_end')::timestamptz;
   PERFORM public.fn_weekly_accounting_deadline_check();
   IF smarter_private.weekly_payout_clock()>=r.money_deadline_at THEN
    RAISE EXCEPTION 'weekly_payout_absolute_money_deadline' USING ERRCODE='57014';END IF;
   INSERT INTO smarter_private.weekly_payout_owned_transactions(backend_pid,transaction_id,run_id,scope_kind,scope_id,period_start,period_end,round_no)
   VALUES(pg_backend_pid(),txid_current(),r.run_id,k,id,ws,we,round)
   ON CONFLICT(backend_pid,transaction_id)DO UPDATE SET scope_kind=EXCLUDED.scope_kind,scope_id=EXCLUDED.scope_id,
    period_start=EXCLUDED.period_start,period_end=EXCLUDED.period_end,round_no=EXCLUDED.round_no;
   IF round=1 THEN
    -- The original R1 closes and posts its own treasury debit; there is no
    -- transaction-local debit deferred until slow post-money documents.
    PERFORM set_config('app.union_close_defer_rake_debit','',true);
    IF k='union' THEN
     res:=public.fn_union_weekly_rakeback_close(id,ws,we);
     IF res->>'success' IS DISTINCT FROM 'true' AND res->>'error' IS DISTINCT FROM 'already_executed' THEN
      RAISE EXCEPTION 'weekly_payout_original_round1_refused' USING DETAIL=res::text;END IF;
    ELSE
     res:=public.fn_bank_standalone_week_rake(id,ws,we);
     IF res->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'weekly_payout_original_club_bank_refused' USING DETAIL=res::text;END IF;
    END IF;
   ELSIF round=2 THEN
    res:=public.fn_settle_accounting_commission_stage(k,id,ws,we);
   ELSE
    res:=public.fn_settle_accounting_rakeback_stage(k,id,ws,we);
   END IF;
   IF round IN(2,3) AND (res->>'success' IS DISTINCT FROM 'true' OR res->>'routing_version' IS DISTINCT FROM '3'
    OR res->>'source_version' IS DISTINCT FROM '2' OR COALESCE((res->>'shortfalls')::integer,0)<>0
    OR res->>'batch_committed'='true' OR NOT EXISTS(SELECT FROM public.accounting_routed_settlement_runs x
     WHERE x.scope_kind=k AND x.scope_id=id AND x.period_start=ws AND x.period_end=we AND x.round_no=round AND x.result=(res-'duplicate')))
   THEN RAISE EXCEPTION 'weekly_payout_original_financial_receipt_required' USING ERRCODE='23514',DETAIL=res::text;END IF;
   IF k='union' THEN
    INSERT INTO public.union_settlement_rounds(union_id,period_start,period_end,round_no,round_name,payers,payees,amount,shortfalls,detail)
    VALUES(id,ws,we,round,CASE round WHEN 1 THEN 'union_to_clubs' WHEN 2 THEN 'club_to_agents' ELSE 'agents_to_players' END,
     CASE WHEN round=1 THEN 1 ELSE 0 END,COALESCE((res->>'payees')::integer,(res->>'clubs_paid')::integer,0),
     COALESCE((res->>'amount')::numeric,(res->>'total_rakeback')::numeric,0),COALESCE((res->>'shortfalls')::integer,0),res)
    ON CONFLICT(union_id,period_start,period_end,round_no)DO NOTHING;
   END IF;
   receipts:=receipts||jsonb_build_array(jsonb_build_object('scope',item,'round',round,'receipt',res));
  END LOOP;
 END LOOP;
 PERFORM public.fn_weekly_accounting_deadline_check();
 IF smarter_private.weekly_payout_clock()>=r.money_deadline_at THEN
  RAISE EXCEPTION 'weekly_payout_absolute_money_deadline' USING ERRCODE='57014';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(r.scope_plan) LOOP
  INSERT INTO smarter_private.weekly_payout_financial_receipts(scope_kind,scope_id,period_start,period_end,run_id,original_round_receipts)
  VALUES(item->>'kind',(item->>'id')::uuid,(item->>'period_start')::timestamptz,(item->>'period_end')::timestamptz,r.run_id,
   (SELECT jsonb_agg(j ORDER BY (j->>'round')::int) FROM jsonb_array_elements(receipts)j WHERE j->'scope'=item));
 END LOOP;
 DELETE FROM smarter_private.weekly_payout_owned_transactions WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current();
 PERFORM public.fn_weekly_accounting_attempt_end();
 res:=jsonb_build_object('success',true,'owns_tick',true,'advanced',true,'stage','weekly_payout_financial_complete',
  'run_id',r.run_id,'scheduled_for',r.money_starts_at,'financial_started_at',began,
  'financial_finished_at',smarter_private.weekly_payout_clock(),'books_complete',false,'original_receipts',receipts,
  'attempt_no',r.attempt_no,'deferred_scopes',deferred);
 UPDATE public.weekly_accounting_payout_pauses SET phase='released',result=res WHERE run_id=r.run_id;
 RETURN res;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_due() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_prepare_due() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_execute(uuid) FROM PUBLIC,anon,authenticated,service_role;
-- native:end
DO $weekly_payout_catch_up_installed$
BEGIN
 IF md5(pg_get_functiondef('smarter_private.weekly_payout_due()'::regprocedure))IS DISTINCT FROM 'b77443e07a558eae875c7f526ca9c16d'
  OR md5(pg_get_functiondef('smarter_private.weekly_payout_prepare_due()'::regprocedure))IS DISTINCT FROM '24f2a5141c6ff0612ecaa65de4dbf486'
  OR md5(pg_get_functiondef('smarter_private.weekly_payout_execute(uuid)'::regprocedure))IS DISTINCT FROM 'bbdd0f71eac3f2c9d36b8fa02e32ca09'
  OR EXISTS(SELECT FROM pg_proc WHERE oid IN('smarter_private.weekly_payout_due()'::regprocedure,'smarter_private.weekly_payout_prepare_due()'::regprocedure,'smarter_private.weekly_payout_execute(uuid)'::regprocedure)
   AND proacl IS DISTINCT FROM '{postgres=X/postgres}'::aclitem[])
 THEN RAISE EXCEPTION 'weekly_payout_catch_up_install_mismatch';END IF;
END $weekly_payout_catch_up_installed$;
COMMIT;
