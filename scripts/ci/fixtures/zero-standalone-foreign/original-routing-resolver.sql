CREATE OR REPLACE FUNCTION public.fn_resolve_accounting_routing_scope(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS TABLE(union_id uuid, standalone_club_id uuid, club_ids uuid[], scope_key text, lock_key text, routing_context text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 IF p_scope_kind IS NULL OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL
  OR (p_scope_kind='union' AND NOT EXISTS(SELECT 1 FROM public.unions u WHERE u.id=p_scope_id))
  OR (p_scope_kind='club' AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_scope_id))
 THEN RAISE EXCEPTION 'invalid_accounting_routing_scope' USING ERRCODE='22023';END IF;
 union_id:=CASE WHEN p_scope_kind='union' THEN p_scope_id END;
 standalone_club_id:=CASE WHEN p_scope_kind='club' THEN p_scope_id END;
 -- Preserve union keys and the established coordinator lock exactly. Club keys
 -- have an explicit prefix so even identical UUID values can never collide.
 scope_key:=CASE WHEN p_scope_kind='union' THEN p_scope_id::text ELSE 'club:'||p_scope_id::text END;
 lock_key:=CASE WHEN p_scope_kind='union' THEN 'union-accounting:' ELSE 'club-accounting:' END||p_scope_id::text||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 routing_context:=scope_key||':'||p_period_start::text||':'||p_period_end::text;
 -- Acquire before reading source-club membership: a waiting close must see all
 -- earning sources committed by the previous lock holder. Accrual shares this key.
 PERFORM pg_advisory_xact_lock(hashtextextended(lock_key,0));
 IF p_scope_kind='union' THEN
  club_ids:=ARRAY(WITH RECURSIVE
cash_clubs(club_id) AS (
 (SELECT s.club_id FROM public.accounting_cash_rake_sources s WHERE s.club_id IS NOT NULL ORDER BY s.club_id LIMIT 1)
 UNION ALL
 SELECT n.club_id FROM cash_clubs c CROSS JOIN LATERAL
 (SELECT s.club_id FROM public.accounting_cash_rake_sources s WHERE s.club_id>c.club_id ORDER BY s.club_id LIMIT 1)n
),
fee_clubs(club_id) AS (
 (SELECT s.club_id FROM public.accounting_tournament_fee_sources s WHERE s.club_id IS NOT NULL ORDER BY s.club_id LIMIT 1)
 UNION ALL
 SELECT n.club_id FROM fee_clubs c CROSS JOIN LATERAL
 (SELECT s.club_id FROM public.accounting_tournament_fee_sources s WHERE s.club_id>c.club_id ORDER BY s.club_id LIMIT 1)n
),
accepted_cash AS MATERIALIZED (
 SELECT k.club_id FROM cash_clubs k CROSS JOIN LATERAL
 (SELECT true FROM public.accounting_payable_earning_sources rs WHERE rs.source_type='cash_rake_accrual'
 AND rs.club_id=k.club_id AND rs.coordinator_union_id=p_scope_id
 AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end LIMIT 1 OFFSET 0)w
 UNION ALL SELECT NULL::uuid WHERE EXISTS(SELECT FROM public.accounting_payable_earning_sources rs
 WHERE rs.source_type='cash_rake_accrual' AND rs.club_id IS NULL AND rs.coordinator_union_id=p_scope_id
 AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end)
),
fee_candidates AS MATERIALIZED (SELECT k.club_id FROM fee_clubs k WHERE NOT EXISTS
 (SELECT FROM accepted_cash c WHERE c.club_id IS NOT DISTINCT FROM k.club_id)),
accepted_fee AS (
 SELECT k.club_id FROM fee_candidates k CROSS JOIN LATERAL (
 SELECT true FROM public.accounting_tournament_fee_sources fee CROSS JOIN LATERAL (
 SELECT true FROM public.accounting_payable_earning_sources rs WHERE rs.source_type='tournament_fee_accrual'
 AND rs.source_id=fee.id AND rs.club_id=k.club_id AND rs.coordinator_union_id=p_scope_id
 AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end LIMIT 1 OFFSET 0)witness
 WHERE fee.club_id=k.club_id AND fee.coordinator_union_id=p_scope_id
 LIMIT 1 OFFSET 0)w
 UNION ALL SELECT NULL::uuid WHERE NOT EXISTS(SELECT FROM accepted_cash c WHERE c.club_id IS NULL)
 AND EXISTS(SELECT FROM public.accounting_payable_earning_sources rs
 WHERE rs.source_type='tournament_fee_accrual' AND rs.club_id IS NULL AND rs.coordinator_union_id=p_scope_id
 AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end)
)
SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id=p_scope_id
 AND((isfinite(p_period_start) AND isfinite(p_period_end) AND p_period_end>p_period_start) IS NOT TRUE OR uc.joined_at IS NULL OR uc.joined_at<p_period_end)
 UNION SELECT ac.club_id FROM accepted_cash ac UNION SELECT af.club_id FROM accepted_fee af ORDER BY club_id);
 ELSE club_ids:=ARRAY[p_scope_id];END IF;
 RETURN NEXT;
END $function$
