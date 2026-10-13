WITH cash_clubs AS MATERIALIZED (
          SELECT DISTINCT s.club_id FROM public.accounting_cash_rake_sources s
          WHERE s.coordinator_union_id IS NULL AND s.earned_at<TIMESTAMPTZ '2026-10-12 07:00:00+00'
        ), cash_cutoffs AS MATERIALIZED (
          SELECT c.club_id,public.fn_ca_launch_accounting_cutoff('club',c.club_id) AS cutoff FROM cash_clubs c
        ), standalone_earned AS (
          SELECT s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s
          LEFT JOIN cash_cutoffs c ON c.club_id=s.club_id
          WHERE s.coordinator_union_id IS NULL AND s.earned_at<TIMESTAMPTZ '2026-10-12 07:00:00+00'
            AND CASE WHEN c.cutoff IS NULL THEN true
              ELSE s.earned_at IS NOT NULL AND isfinite(s.earned_at) AND s.earned_at>=c.cutoff END
          UNION ALL
          SELECT s.club_id,s.earned_at FROM public.accounting_payable_earning_sources s
          WHERE s.source_type='tournament_fee_accrual' AND s.coordinator_union_id IS NULL AND s.earned_at<TIMESTAMPTZ '2026-10-12 07:00:00+00'
        ) SELECT s.club_id,LEAST(public.fn_union_week_start(min(s.earned_at) FILTER(WHERE isfinite(s.earned_at))),min(s.earned_at)) first_week,count(*)row_count FROM standalone_earned s GROUP BY s.club_id ORDER BY s.club_id NULLS LAST;