-- Unactivated ABI v2 read. All money comes from one statement snapshot.
CREATE OR REPLACE FUNCTION public.fn_get_captured_rakeback(p_club_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE v_user uuid:=auth.uid();v_cutoff date:=date_trunc('week',statement_timestamp() AT TIME ZONE 'UTC')::date;
 v_result jsonb;v_integrity boolean;
BEGIN
 IF v_user IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE='42501';END IF;
 IF NOT public.fn_captured_rakeback_v2_active() THEN
  RETURN jsonb_build_object('schema_version',2,'source_active',false,'beneficiary_user_id',v_user,
   'earning_closed_through',v_cutoff::text,'pending_amount','0.00','paid_amount','0.00',
   'closed_entitlement_exact','0','consumed_exact','0','unpaid_exact','0',
   'balances','[]'::jsonb,'cash_payments','[]'::jsonb,'unresolved_earnings','[]'::jsonb,'source_final',false);
 END IF;
 WITH raw AS MATERIALIZED(
  SELECT f.*,s.funding_route,s.funding_union_id source_union_id,s.requested_club_id,a.contract_version,
   coalesce(f.booked_club_id,s.requested_club_id) display_club_id,
   date_trunc('week',s.settled_at AT TIME ZONE 'UTC')::date earning_week,
   (SELECT max((j->>'contract_rate')::numeric) FROM jsonb_array_elements(f.hierarchy) j) top_rate
  FROM public.ca_cash_commission_facts f JOIN public.ca_cash_commission_sources s USING(hand_id)
  JOIN public.hand_atomic_commits h ON h.hand_id=s.hand_id
   AND h.commission_capture_version=1 AND h.post_commit_payload_hash=s.accepted_payload_hash
  JOIN public.ca_cash_commission_authority a ON a.singleton AND a.contract_version=1
  WHERE f.player_id=v_user AND (p_club_id IS NULL OR coalesce(f.booked_club_id,s.requested_club_id)=p_club_id)
 ), classified AS MATERIALIZED(
  SELECT r.*,coalesce(
   assignment_state='assigned' AND payer_user_id IS NOT NULL AND payer_user_id<>player_id AND direct_agent_id IS NOT NULL
   AND errors='[]'::jsonb AND coalesce(player_terms->'errors','[]'::jsonb)='[]'::jsonb
   AND player_rebate_entitlement>=0 AND player_rebate_entitlement::text NOT IN ('NaN','Infinity','-Infinity')
   AND player_rebate_rate BETWEEN 0 AND 1 AND player_rebate_rate::text NOT IN ('NaN','Infinity','-Infinity')
   AND direct_commission_rate BETWEEN 0 AND .70
   AND player_rebate_rate<=greatest(direct_commission_rate-.10,0)
   AND player_rebate_entitlement=rake_credit*player_rebate_rate
   AND booked_club_id IS NOT NULL AND funding_union_id IS NOT DISTINCT FROM source_union_id
   AND funding_club_rate BETWEEN 0 AND 1 AND funding_club_rate::text NOT IN ('NaN','Infinity','-Infinity')
   AND top_rate IS NOT NULL AND top_rate<=.70 AND top_rate<=funding_club_rate
   AND ((funding_route='union_rake_wallet' AND source_union_id IS NOT NULL AND funding_state='union_member')
    OR (funding_route='club_chip_treasury' AND source_union_id IS NULL AND funding_state='club_treasury_owner')),false) eligible,
   coalesce(assignment_state='self_agent' AND errors='[]'::jsonb
    AND player_rebate_entitlement=0 AND player_rebate_rate=0,false) resolved_self_zero
  FROM raw r
 ), sources AS MATERIALIZED(
  SELECT c.*,p.id pool_id,
   coalesce((SELECT sum(x.amount) FROM public.ca_source_player_payment_slices x
    JOIN public.ca_source_player_cash_payments pay ON pay.id=x.payment_id
    WHERE x.hand_id=c.hand_id AND x.player_id=c.player_id AND pay.player_id=c.player_id
     AND pay.payer_user_id=c.payer_user_id AND pay.pool_id=p.id),0) consumed,
   EXISTS(SELECT 1 FROM public.ca_source_player_funding_admissions z
    WHERE z.hand_id=c.hand_id AND z.player_id=c.player_id AND z.pool_id=p.id
     AND z.payer_user_id=c.payer_user_id AND z.agent_id=c.direct_agent_id) funding_admitted
  FROM classified c LEFT JOIN public.ca_source_funding_pools p ON p.club_id=c.booked_club_id
   AND p.funding_union_id IS NOT DISTINCT FROM c.source_union_id AND p.funding_route=c.funding_route
   AND p.contract_version=c.contract_version
  WHERE c.eligible
 ), weeks AS MATERIALIZED(
  SELECT booked_club_id club_id,source_union_id funding_union_id,funding_route,contract_version,payer_user_id,pool_id,
   earning_week,earning_week+7<=v_cutoff closed,sum(player_rebate_entitlement) entitlement,
   sum(consumed) consumed,count(*) source_count,count(*) FILTER(WHERE funding_admitted) funding_admitted_source_count
  FROM sources GROUP BY booked_club_id,source_union_id,funding_route,contract_version,payer_user_id,pool_id,earning_week
 ), payments AS MATERIALIZED(
  SELECT pay.*,p.club_id,p.funding_union_id,p.funding_route,p.contract_version
  FROM public.ca_source_player_cash_payments pay JOIN public.ca_source_funding_pools p ON p.id=pay.pool_id
  WHERE pay.player_id=v_user AND (p_club_id IS NULL OR p.club_id=p_club_id)
 ), balances AS MATERIALIZED(
  SELECT w.club_id,w.funding_union_id,w.funding_route,w.contract_version,w.payer_user_id,w.pool_id,
   coalesce(sum(w.entitlement) FILTER(WHERE w.closed),0) closed_exact,sum(w.consumed) consumed,
   coalesce((SELECT sum(pay.amount) FROM payments pay WHERE pay.pool_id=w.pool_id AND pay.payer_user_id=w.payer_user_id),0) paid,
   bool_and(w.consumed<=w.entitlement AND (w.closed OR w.consumed=0)) valid_weeks,
   jsonb_agg(jsonb_build_object('week_start',w.earning_week::text,'week_end',(w.earning_week+6)::text,
    'closed',w.closed,'entitlement_exact',trim_scale(w.entitlement)::text,
    'consumed_exact',trim_scale(w.consumed)::text,'remaining_exact',trim_scale(w.entitlement-w.consumed)::text,
    'source_count',w.source_count,'funding_admitted_source_count',w.funding_admitted_source_count) ORDER BY w.earning_week) earning_weeks
  FROM weeks w GROUP BY w.club_id,w.funding_union_id,w.funding_route,w.contract_version,w.payer_user_id,w.pool_id
 ), unresolved_sources AS MATERIALIZED(
  SELECT c.hand_id,c.display_club_id club_id,c.earning_week,
   c.errors||coalesce(c.player_terms->'errors','[]'::jsonb)||coalesce(c.funding_terms->'errors','[]'::jsonb)
   ||CASE WHEN c.assignment_state<>'assigned' THEN jsonb_build_array('assignment_'||c.assignment_state) ELSE '[]'::jsonb END
   ||CASE WHEN c.booked_club_id IS NULL THEN '["booked_club_unavailable_requested_club_context"]'::jsonb ELSE '[]'::jsonb END
   ||CASE WHEN c.top_rate>c.funding_club_rate THEN '["hierarchy_exceeds_captured_club_funding"]'::jsonb ELSE '[]'::jsonb END
   ||CASE WHEN c.funding_state='union_self_retained' THEN '["union_self_retained_no_club_release"]'::jsonb ELSE '[]'::jsonb END
   ||'["captured_player_contract_unresolved"]'::jsonb reasons
  FROM classified c WHERE NOT c.eligible AND NOT c.resolved_self_zero
 ), unresolved AS(
  SELECT u.club_id,u.earning_week,count(DISTINCT u.hand_id) source_count,
   jsonb_agg(DISTINCT r.reason ORDER BY r.reason) reasons
  FROM unresolved_sources u CROSS JOIN LATERAL jsonb_array_elements_text(u.reasons) r(reason)
  GROUP BY u.club_id,u.earning_week
 )
 SELECT jsonb_build_object('schema_version',2,'source_active',true,'beneficiary_user_id',v_user,
  'earning_closed_through',v_cutoff::text,
  'pending_amount',round(coalesce(sum(floor(b.closed_exact*100)/100-b.paid),0),2)::text,
  'paid_amount',round(coalesce(sum(b.paid),0),2)::text,
  'closed_entitlement_exact',trim_scale(coalesce(sum(b.closed_exact),0))::text,
  'consumed_exact',trim_scale(coalesce(sum(b.consumed),0))::text,
  'unpaid_exact',trim_scale(coalesce(sum(b.closed_exact-b.consumed),0))::text,
  'balances',coalesce(jsonb_agg(jsonb_build_object('scope',jsonb_build_object(
   'club_id',b.club_id,'funding_union_id',b.funding_union_id,'funding_route',b.funding_route,
   'contract_version',b.contract_version,'payer_user_id',b.payer_user_id),'pool_id',b.pool_id,
   'closed_entitlement_exact',trim_scale(b.closed_exact)::text,'consumed_exact',trim_scale(b.consumed)::text,
   'unpaid_exact',trim_scale(b.closed_exact-b.consumed)::text,
   'pending_amount',round(floor(b.closed_exact*100)/100-b.paid,2)::text,'paid_amount',round(b.paid,2)::text,
   'earning_weeks',b.earning_weeks) ORDER BY b.club_id,b.funding_union_id NULLS FIRST,b.funding_route,b.payer_user_id)
   FILTER(WHERE b.club_id IS NOT NULL),'[]'::jsonb),
  'cash_payments',coalesce((SELECT jsonb_agg(public.fn_ca_captured_player_payment_dto(pay.id) ORDER BY pay.paid_at,pay.id) FROM payments pay),'[]'::jsonb),
  'unresolved_earnings',coalesce((SELECT jsonb_agg(jsonb_build_object('club_id',u.club_id,
   'week_start',u.earning_week::text,'week_end',(u.earning_week+6)::text,
   'source_count',u.source_count,'reasons',u.reasons) ORDER BY u.club_id,u.earning_week) FROM unresolved u),'[]'::jsonb),
  'source_final',false),
  coalesce(bool_and(b.valid_weeks AND b.consumed=b.paid AND b.closed_exact>=b.consumed
   AND floor(b.closed_exact*100)/100>=b.paid),true)
   AND coalesce(sum(b.paid),0)=(SELECT coalesce(sum(pay.amount),0) FROM payments pay)
 INTO v_result,v_integrity FROM balances b;
 IF NOT v_integrity THEN RAISE EXCEPTION 'captured_rakeback_read_evidence_does_not_reconcile' USING ERRCODE='23514';END IF;
 RETURN v_result;
END $f$;
REVOKE ALL ON FUNCTION public.fn_get_captured_rakeback(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_get_captured_rakeback(uuid) TO authenticated,service_role;
