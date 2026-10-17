-- 20261016131712_the_commission_evidence_check_reads_only_what_is_unaccrued.sql
--
-- Reserved as 20261016131712 by scripts/new-migration.mjs; renamed to the
-- version the Supabase MCP recorded when it was applied (20261016131916).
--
-- THE COMMISSION EVIDENCE CHECK READS ONLY WHAT IS UNACCRUED (2026-10-16)
--
-- What happened. With every proof of the union week 2026-10-05..12 fresh
-- (20261016123337), job 272's union visit still ran out of its 240 s
-- statement budget on every tick (financial_alerts "A weekly accounting scope
-- did not finish its scheduler visit", weekly_scope_statement_budget_exhausted,
-- 12:15, 12:25, 12:35 ... 2026-10-16). Timed inside a rolled-back probe,
-- fn_assert_cash_commission_period alone took 77.9 s, and one union attempt
-- calls it twice (fn_process_weekly_accounting_scope, then
-- fn_union_settlement_cascade): about 156 s of a 240 s tick spent proving
-- that nothing is missing.
--
-- Why. Its EXISTS asks for a cash rake record of the week that has no accrued
-- batch. The planner evaluated the per-row function predicates
-- (fn_rake_record_is_ghost_twin, fn_ca_launch_accounting_accepts and the
-- union membership subqueries) on all 606,825 cash rake records of the week
-- before it looked at the batch status, and the answer is "none unaccrued":
-- read directly, the week has 0 unaccrued records and the anti-join takes
-- 1.8 s.
--
-- The fix. The same predicate, in an order the planner cannot reverse: the
-- unaccrued candidates are found first in a MATERIALIZED CTE (the cheap,
-- indexed join), and only those candidates pay for the function predicates.
-- Every condition is unchanged and the helpers are STABLE, so the answer is
-- the same for every input; only the work is.
--
-- The 240 s replication bound is unchanged.
--
-- @live-proof: (SELECT strpos(pg_get_functiondef('public.fn_assert_cash_commission_period(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure), 'WITH unaccrued AS MATERIALIZED') > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_assert_cash_commission_period(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))
     <> '2187b83d511186ee44503c95ff7960c2' THEN
    RAISE EXCEPTION 'Unexpected preimage of fn_assert_cash_commission_period';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_assert_cash_commission_period(p_union_id uuid, p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR p_union_id IS NULL OR NOT public.fn_is_union_overseer(p_union_id,auth.uid())) THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from
 THEN RAISE EXCEPTION 'invalid_cash_commission_scope' USING ERRCODE='22023'; END IF;
 -- THE UNACCRUED CANDIDATES FIRST (20261016131712): the cheap anti-join runs
 -- before any per-row function predicate; the conditions are unchanged.
 IF EXISTS(
  WITH unaccrued AS MATERIALIZED (
   SELECT r.id, r.club_id, r.hand_id, r.table_id, r.metadata, r.created_at
     FROM public.rake_records r LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=r.id
    WHERE r.created_at>=p_from AND r.created_at<p_to AND r.rake_amount>0 AND NOT COALESCE(r.is_tournament,false) AND r.tournament_id IS NULL
      AND (b.status IS DISTINCT FROM 'accrued'))
  SELECT 1 FROM unaccrued r
   WHERE (r.hand_id IS NOT NULL OR NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata))
     AND ((p_club_id IS NOT NULL AND (r.club_id=p_club_id OR EXISTS(SELECT 1 FROM public.rake_attributions a WHERE a.rake_record_id=r.id AND a.club_id=p_club_id)))
       OR (p_union_id IS NOT NULL AND (r.club_id=p_union_id OR EXISTS(SELECT 1 FROM public.union_clubs c WHERE c.union_id=p_union_id AND c.club_id=r.club_id)
        OR EXISTS(SELECT 1 FROM public.rake_attributions a JOIN public.union_clubs c ON c.club_id=a.club_id WHERE a.rake_record_id=r.id AND c.union_id=p_union_id))))
     AND public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at))
 THEN RAISE EXCEPTION 'cash_commission_earning_evidence_requires_reconciliation' USING ERRCODE='55000'; END IF;
END $function$;

REVOKE ALL ON FUNCTION public.fn_assert_cash_commission_period(uuid,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assert_cash_commission_period(uuid,uuid,timestamp with time zone,timestamp with time zone) TO service_role;

COMMIT;
