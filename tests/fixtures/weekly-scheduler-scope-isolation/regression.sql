-- Three unions due for last week. U1's close runs past the tick's statement
-- budget, U2 is healthy, U3 raises out of its scope. U1 sorts first (lowest
-- id, no visit yet). Every tick runs under a 3s budget, as a short-budget
-- caller does; the scheduler must not let U1 starve U2 and U3.
\set ON_ERROR_STOP 1
INSERT INTO public.unions VALUES ('00000000-0000-0000-0000-0000000000a1'),('00000000-0000-0000-0000-0000000000a2'),('00000000-0000-0000-0000-0000000000a3');
INSERT INTO public.union_settlement_floor SELECT id,public.fn_union_prev_week_start(clock_timestamp()) FROM public.unions;
INSERT INTO public.fixture_mode VALUES ('00000000-0000-0000-0000-0000000000a1','slow'),('00000000-0000-0000-0000-0000000000a2','ok'),('00000000-0000-0000-0000-0000000000a3','raise');
\set tick 'SET statement_timeout=''3s''; SELECT public.fn_process_weekly_accounting_scope(NULL,NULL)->>''checked'' AS checked; RESET statement_timeout;'
\set QUIET on
\set ON_ERROR_STOP 0
:tick
:tick
:tick
\set ON_ERROR_STOP 1
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.union_accounting_runs WHERE union_id='00000000-0000-0000-0000-0000000000a2' AND status='complete') THEN
  RAISE EXCEPTION 'FAIL U2 was starved: three ticks and its close never ran, behind U1''s timeout'; END IF;
 RAISE NOTICE 'PASS U2 closed although U1 exhausts every tick''s budget';
END $$;
DO $$ DECLARE v record; BEGIN
 SELECT * INTO v FROM public.weekly_accounting_scheduler_visits WHERE scope_id='00000000-0000-0000-0000-0000000000a1';
 IF v.last_outcome IS DISTINCT FROM 'statement_timeout' OR v.unfinished_visits<2 THEN RAISE EXCEPTION 'FAIL U1 visit not recorded: %',row_to_json(v); END IF;
 IF EXISTS(SELECT 1 FROM public.union_accounting_runs WHERE union_id='00000000-0000-0000-0000-0000000000a1') THEN
  RAISE EXCEPTION 'FAIL U1''s rolled-back attempt left a run row'; END IF;
 SELECT * INTO v FROM public.weekly_accounting_scheduler_visits WHERE scope_id='00000000-0000-0000-0000-0000000000a3';
 IF v.last_outcome IS DISTINCT FROM 'error' OR v.last_error->>'error' IS DISTINCT FROM 'fixture_run_row_refused' THEN
  RAISE EXCEPTION 'FAIL U3 error not recorded: %',row_to_json(v); END IF;
 IF EXISTS(SELECT 1 FROM public.union_accounting_runs WHERE union_id='00000000-0000-0000-0000-0000000000a3') THEN
  RAISE EXCEPTION 'FAIL U3''s rolled-back scope left a run row'; END IF;
 RAISE NOTICE 'PASS each unfinished visit is recorded and its own writes are rolled back';
END $$;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.financial_alerts WHERE context->>'scope_id'='00000000-0000-0000-0000-0000000000a3')<>1 THEN
  RAISE EXCEPTION 'FAIL U3 must raise exactly one alert across repeated identical errors'; END IF;
 IF EXISTS(SELECT 1 FROM public.financial_alerts WHERE context->>'scope_id'='00000000-0000-0000-0000-0000000000a1') THEN
  RAISE EXCEPTION 'FAIL a short-budget timeout is not an incident'; END IF;
 RAISE NOTICE 'PASS alerts: one for the changed error, none for a short-budget timeout';
END $$;

-- An operator's cancel still stops and rolls back the whole tick.
UPDATE public.fixture_mode SET mode='cancel' WHERE union_id='00000000-0000-0000-0000-0000000000a2';
UPDATE public.weekly_accounting_scheduler_visits SET last_visit_at='2000-01-01' WHERE scope_id='00000000-0000-0000-0000-0000000000a2';
CREATE TABLE fixture_before AS SELECT * FROM public.weekly_accounting_scheduler_visits;
DO $$ BEGIN
 BEGIN
  PERFORM public.fn_process_weekly_accounting_scope(NULL,NULL);
 EXCEPTION WHEN query_canceled THEN
  IF EXISTS(SELECT * FROM public.weekly_accounting_scheduler_visits EXCEPT SELECT * FROM fixture_before) THEN
   RAISE EXCEPTION 'FAIL the cancelled tick left a visit behind'; END IF;
  RAISE NOTICE 'PASS an operator cancel still aborts the whole tick'; RETURN;
 END;
 RAISE EXCEPTION 'FAIL an operator cancel was swallowed';
END $$;

-- A long-budget tick seals the inventory before its scopes; a short one does not.
CREATE FUNCTION public.fn_union_pnl_inventory_checkpoint_due() RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.fixture_calls(what) VALUES('seal'); RETURN '{"status":"ready","sealed":[]}'; END $$;
UPDATE public.fixture_mode SET mode='ok';
DELETE FROM public.fixture_calls;
SET statement_timeout='3s'; SELECT (public.fn_process_weekly_accounting_scope(NULL,NULL)->>'success') AS short_tick; RESET statement_timeout;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.fixture_calls WHERE what='seal') THEN RAISE EXCEPTION 'FAIL a short-budget tick started the seal'; END IF;
END $$;
DELETE FROM public.fixture_calls;
SET statement_timeout='40min'; SELECT (public.fn_process_weekly_accounting_scope(NULL,NULL)->>'success') AS long_tick; RESET statement_timeout;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.fixture_calls WHERE what='seal')<>1 THEN RAISE EXCEPTION 'FAIL the long tick must seal once'; END IF;
 IF EXISTS(SELECT 1 FROM public.fixture_calls c WHERE c.what LIKE 'cascade%' AND c.at<(SELECT at FROM public.fixture_calls WHERE what='seal')) THEN
  RAISE EXCEPTION 'FAIL the seal ran after a scope'; END IF;
 IF EXISTS(SELECT 1 FROM public.weekly_accounting_scheduler_visits WHERE last_outcome<>'visited') THEN
  RAISE EXCEPTION 'FAIL healthy scopes must clear their unfinished outcome'; END IF;
 IF (SELECT count(*) FROM public.union_accounting_runs WHERE status='complete')<>3 THEN RAISE EXCEPTION 'FAIL every union closes once healthy'; END IF;
 RAISE NOTICE 'PASS the long tick seals before its scopes; a short tick never does; every recovered scope closes';
END $$;
