SELECT count(*) AS n,sum(s.rake_credit) AS total,
    count(*) FILTER(WHERE s.club_id IS DISTINCT FROM period.club_id OR s.union_id IS NOT NULL
     OR s.coordinator_union_id IS DISTINCT FROM period.union_id OR s.earned_at IS DISTINCT FROM b.banked_at) AS bad,
    bool_or(s.club_id=period.club_id AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id) AS mine
   FROM public.accounting_cash_rake_sources s WHERE b.source_type='cash_rake_accrual' AND s.rake_record_id=b.source_group OFFSET 0
