CREATE OR REPLACE FUNCTION public.fn_assert_cash_commission_period(p_union_id uuid, p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE missing_cash boolean;
BEGIN
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR p_union_id IS NULL OR NOT public.fn_is_union_overseer(p_union_id,auth.uid())) THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from
 THEN RAISE EXCEPTION 'invalid_cash_commission_scope' USING ERRCODE='22023'; END IF;
 -- THE UNACCRUED CANDIDATES FIRST (20261016131712): the cheap anti-join runs
 -- before any per-row function predicate; the conditions are unchanged.
 EXECUTE $scope_fence$SELECT EXISTS(
  WITH unaccrued AS MATERIALIZED (
   SELECT r.id
     FROM public.rake_records r LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=r.id
    WHERE r.created_at>=$3 AND r.created_at<$4 AND r.rake_amount>0 AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
      AND (b.status IS DISTINCT FROM 'accrued')), scoped_unaccrued AS MATERIALIZED (
  SELECT r.* FROM unaccrued u JOIN public.rake_records r ON r.id=u.id
  WHERE (($2 IS NOT NULL AND (r.club_id=$2 OR EXISTS(SELECT 1 FROM public.rake_attributions a WHERE a.rake_record_id=r.id AND a.club_id=$2)))
       OR ($1 IS NOT NULL AND (r.club_id=$1 OR EXISTS(SELECT 1 FROM public.union_clubs c WHERE c.union_id=$1 AND c.club_id=r.club_id)
        OR EXISTS(SELECT 1 FROM public.rake_attributions a JOIN public.union_clubs c ON c.club_id=a.club_id WHERE a.rake_record_id=r.id AND c.union_id=$1))))
 )
 SELECT 1 FROM scoped_unaccrued r
 WHERE (r.hand_id IS NOT NULL OR NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata))
 AND public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at)
)$scope_fence$ INTO missing_cash USING p_union_id,p_club_id,p_from,p_to;
 IF missing_cash THEN RAISE EXCEPTION 'cash_commission_earning_evidence_requires_reconciliation' USING ERRCODE='55000'; END IF;
END $function$
