-- Root reserved version 20261030014346. Protected installation/readback required; source alone is not installed.
-- The original cascade leaves R2/R3 payers at its NOT NULL DEFAULT0.
-- The owned global phase supplied explicitNULL, aborting Union money atomically.
-- Restore the same receipt metadata convention. No money owner, scope, rate,
-- receipt identity, deadline, pause/lease authority, schema or schedule changes.
-- @live-proof: md5(pg_get_functiondef('smarter_private.weekly_payout_execute(uuid)'::regprocedure))='fc3005c0275c0ab6fb4941660c3aaf63'
BEGIN;
SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s';SET LOCAL transaction_timeout='15s';
DO $guard$DECLARE p pg_proc%ROWTYPE;BEGIN
 SELECT*INTO STRICT p FROM pg_proc WHERE oid='smarter_private.weekly_payout_execute(uuid)'::regprocedure;
 IF md5(pg_get_functiondef(p.oid))<>'f34d653a6d05b9245c81336d69e2c453'OR to_jsonb(p)-'prosrc'IS DISTINCT FROM $metadata${"oid":"277353657","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"weekly_payout_execute","prorows":0,"pronargs":1,"proowner":"16384","proconfig":["search_path=pg_catalog, public","lock_timeout=1s"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_run"],"proargtypes":["2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"24465641","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$metadata$::jsonb THEN RAISE EXCEPTION 'weekly_union_round_receipt_owner_preimage_changed';END IF;
 IF NOT EXISTS(SELECT FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.union_settlement_rounds'::regclass AND a.attname='payers'AND a.atttypid='integer'::regtype AND a.attnotnull AND NOT a.attisdropped AND pg_get_expr(d.adbin,d.adrelid)='0')THEN RAISE EXCEPTION 'weekly_union_round_receipt_payers_contract_changed';END IF;
END$guard$;
CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_execute(p_run uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET lock_timeout TO '1s'
AS $function$
DECLARE r public.weekly_accounting_payout_pauses%ROWTYPE;item jsonb;res jsonb;prep jsonb;
 round integer;k text;id uuid;ws timestamptz;we timestamptz;receipts jsonb:='[]'::jsonb;
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
 IF r.scope_plan IS DISTINCT FROM smarter_private.weekly_payout_scope_plan(r.period_end,began)
 THEN RAISE EXCEPTION 'weekly_payout_prepared_scope_changed' USING ERRCODE='55000';END IF;
 PERFORM public.fn_weekly_accounting_attempt_begin(true);
 -- Revalidate original prepared earning/certificate owners immediately before
 -- any financial capability exists. Changed applicable source evidence must
 -- refuse or be admitted by its original producer, never by a current-rate
 -- rewrite here. No old paid JSON, timestamps or fingerprints are retagged.
 FOR item IN SELECT value FROM jsonb_array_elements(r.scope_plan) LOOP
  PERFORM public.fn_weekly_accounting_deadline_check();
  prep:=public.fn_prepare_accounting_week(CASE WHEN item->>'kind'='union' THEN (item->>'id')::uuid END,
   CASE WHEN item->>'kind'='club' THEN (item->>'id')::uuid END,(item->>'period_start')::timestamptz,(item->>'period_end')::timestamptz);
  IF prep->>'success' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'weekly_payout_precommit_preparation_changed' USING ERRCODE='55000',DETAIL=prep::text;END IF;
 END LOOP;
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
  'financial_finished_at',smarter_private.weekly_payout_clock(),'books_complete',false,'original_receipts',receipts);
 UPDATE public.weekly_accounting_payout_pauses SET phase='released',result=res WHERE run_id=r.run_id;
 RETURN res;
END $function$

;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_execute(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $post$DECLARE p pg_proc%ROWTYPE;BEGIN
 SELECT*INTO STRICT p FROM pg_proc WHERE oid='smarter_private.weekly_payout_execute(uuid)'::regprocedure;
 IF md5(pg_get_functiondef(p.oid))<>'fc3005c0275c0ab6fb4941660c3aaf63'OR to_jsonb(p)-'prosrc'IS DISTINCT FROM $metadata${"oid":"277353657","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"weekly_payout_execute","prorows":0,"pronargs":1,"proowner":"16384","proconfig":["search_path=pg_catalog, public","lock_timeout=1s"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_run"],"proargtypes":["2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"24465641","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$metadata$::jsonb THEN RAISE EXCEPTION 'weekly_union_round_receipt_owner_postimage_changed';END IF;
END$post$;
COMMIT;
