WITH RECURSIVE
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
 UNION SELECT ac.club_id FROM accepted_cash ac UNION SELECT af.club_id FROM accepted_fee af ORDER BY club_id;
