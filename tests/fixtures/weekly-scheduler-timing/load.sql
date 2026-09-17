\set ON_ERROR_STOP on
-- UNRUN. Fresh protected postgres-owned unit database. Supply the exact
-- admitted fcdb checkout as accounting_source_root. No production settings.
\ir ../weekly-union-continuation/load.sql
DO $$DECLARE d text;BEGIN
 SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) INTO d;
 IF position('public.test_clock()' IN d)=0 THEN RAISE EXCEPTION 'timing fixture clock predecessor missing';END IF;
 EXECUTE replace(d,'public.test_clock()','clock_timestamp()');
END$$;
\ir ../../../supabase/accounting/weekly-v3/components/20260914162500_standalone_deadlines_follow_their_own_week.sql
DO $$DECLARE d text;BEGIN
 SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) INTO d;
 EXECUTE replace(d,'clock_timestamp()','public.test_clock()');
END$$;
INSERT INTO clubs(id,chip_treasury,name,owner_id,is_union)
 SELECT u(n),100,'Synthetic Timing Club '||n,u(901),false FROM generate_series(12,14)n;
SET app.weekly_accounting_attempt_budget='3';

-- Read-only fixture evidence for every synthetic union and standalone scope.
-- Replay may change only scheduler visitation; refusal snapshots retain even
-- that field. Call after the coordinator in a separate SQL statement so this
-- STABLE reader cannot observe a pre-call statement snapshot.
CREATE FUNCTION public.test_scheduler_timing_snapshot(p_include_visits boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT jsonb_build_object(
  'inherited_financial_artifacts',public.test_scheduler_money_snapshot(),
  'union_wallets',(SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY w.id),'[]'::jsonb)
    FROM public.union_wallets w),
  'final_closes',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb)
    FROM public.ca_settlements c),
  'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb)
    FROM public.settlement_periods p),
  'rounds',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.union_id,r.period_start,r.period_end,r.round_no),'[]'::jsonb)
    FROM public.union_settlement_rounds r),
  'runs',(SELECT coalesce(jsonb_agg(
    CASE WHEN p_include_visits THEN to_jsonb(q) ELSE to_jsonb(q)-'last_scheduler_visit_at' END
    ORDER BY q.scope_kind,q.scope_id,q.period_start,q.period_end),'[]'::jsonb)
    FROM public.union_accounting_runs q));
$$;

-- This unit fixture uses the prior explicit PNL/calculation and zero-R1
-- dependency seams. The actual private coordinator/cascade/routed/statement
-- bodies remain. Real pg_cron is qualified separately; no cron stand-in here.
