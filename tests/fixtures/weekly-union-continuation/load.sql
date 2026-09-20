\set ON_ERROR_STOP on
-- UNRUN. Protected fixture only. Supply accounting_source_root as the exact
-- admitted fcdb checkout. Run in a fresh disposable database as postgres.
DO $$BEGIN IF current_user<>'postgres' THEN RAISE EXCEPTION 'continuation fixture requires postgres owner';END IF;END$$;
\set base_load :accounting_source_root '/tests/fixtures/weekly-scheduler-fairness/load.sql'
\i :base_load

-- The existing unit loader controls the clock after applying fairness. Restore
-- only that declared seam before the successor's exact final preimage guard.
-- The guard below still proves the entire restored definition; it does not
-- accept a fixture-specific function hash or a missing financial predicate.
DO $$DECLARE d text;BEGIN
 SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) INTO d;
 IF position('public.test_clock()' IN d)=0 THEN RAISE EXCEPTION 'continuation fixture clock predecessor missing';END IF;
 EXECUTE replace(d,'public.test_clock()','clock_timestamp()');
END$$;
\ir ../../../supabase/accounting/weekly-v3/components/20260914162000_no_floor_union_completion_preserves_contiguous_work.sql
DO $$DECLARE d text;BEGIN
 SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) INTO d;
 EXECUTE replace(d,'clock_timestamp()','public.test_clock()');
END$$;

-- Keep every actual coordinator, R2/R3, period, conservation and statement
-- body. Refine the existing R1 dependency seam to permit only empty books
-- with exact synthetic zero-close receipts. This is not a source/payment
-- qualification, and there are no club recipients in these union books.
CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('test.zero_r1_blocked',true)='true' THEN
  RAISE EXCEPTION 'fixture_zero_round1_blocked';END IF;
 IF EXISTS(SELECT 1 FROM public.fn_accounting_week_clubs($1,NULL,$2,$3))
  OR EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources s WHERE s.coordinator_union_id=$1 AND s.earned_at>=$2 AND s.earned_at<$3)
  OR NOT EXISTS(SELECT 1 FROM public.ca_settlements c WHERE c.union_id=$1 AND c.state='final'
   AND c.settlement_type='union_rakeback_close'
   AND c.external_ref=$1::text||':'||to_char($2 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ||'..'||to_char($3 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
   AND c.totals='{"accounting_version":3,"period_rake":0,"payout_total":0,"retained":0,"basis_by_club":{},"payout_by_club":{}}'::jsonb)
 THEN RAISE EXCEPTION 'fixture_exact_zero_round1_receipt_missing';END IF;
 RETURN jsonb_build_object('success',true,'already_executed',true,'total_rakeback',0,'clubs_paid',0,'period_rake',0,'union_retained',0);
END$$;

SET timezone='UTC';
SET test.clock='2026-09-14T09:20:00Z';
SET app.weekly_accounting_attempt_budget='1';
UPDATE accounting_cash_accrual_cutover SET starts_at='2026-08-24 07:00Z';
-- The backdated cutover exists only in this empty synthetic permission/schedule
-- fixture. No source, agreement, invoice or real historical obligation is moved.
UPDATE union_settlement_floor SET earliest_period_start='2026-09-14 07:00Z';
DELETE FROM union_settlement_floor WHERE union_id=u(1001);
UPDATE clubs SET is_union=true WHERE id=u(11);
INSERT INTO union_wallets(id,union_id,chip_balance,rake_wallet) VALUES(u(2000),u(1001),1000,0);
INSERT INTO ca_settlements(id,settlement_type,union_id,state,external_ref,totals)
 SELECT u(n),'union_rakeback_close',u(1001),'final',u(1001)::text||':'
  ||to_char(f AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')||'..'
  ||to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  '{"accounting_version":3,"period_rake":0,"payout_total":0,"retained":0,"basis_by_club":{},"payout_by_club":{}}'::jsonb
 FROM (VALUES(2001,'2026-08-24 07:00Z'::timestamptz,'2026-08-31 07:00Z'::timestamptz),
  (2002,'2026-08-31 07:00Z'::timestamptz,'2026-09-07 07:00Z'::timestamptz),
  (2003,'2026-09-07 07:00Z'::timestamptz,'2026-09-14 07:00Z'::timestamptz))v(n,f,t);
SELECT assert_true(NOT EXISTS(SELECT 1 FROM union_accounting_runs)
 AND NOT EXISTS(SELECT 1 FROM fn_accounting_week_clubs(u(1001),NULL,'2026-08-24 07:00Z','2026-09-14 07:00Z')),
 'continuation fixture begins with an empty union book and no fabricated run result');

-- Exact replay snapshot includes canonical financial/run facts omitted by the
-- inherited broad helper. Only the explicitly mutable scheduler visitation
-- timestamp is removed; attempts, results, start/finish and all other fields stay.
CREATE FUNCTION public.test_union_continuation_snapshot(p_union uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT jsonb_build_object(
  'inherited_financial_artifacts',public.test_scheduler_money_snapshot(),
  'union_wallets',(SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY w.id),'[]'::jsonb)
    FROM public.union_wallets w WHERE w.union_id=p_union),
  'final_closes',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb)
    FROM public.ca_settlements c WHERE c.union_id=p_union),
  'periods',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb)
    FROM public.settlement_periods p WHERE p.union_id=p_union),
  'rounds',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.period_start,r.period_end,r.round_no),'[]'::jsonb)
    FROM public.union_settlement_rounds r WHERE r.union_id=p_union),
  'runs',(SELECT coalesce(jsonb_agg(to_jsonb(q)-'last_scheduler_visit_at' ORDER BY q.period_start,q.period_end),'[]'::jsonb)
    FROM public.union_accounting_runs q WHERE q.union_id=p_union));
$$;
