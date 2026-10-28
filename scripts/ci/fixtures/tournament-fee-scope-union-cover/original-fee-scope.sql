SELECT s.tournament_id,count(*) AS fee_source_count,
    count(DISTINCT COALESCE(s.union_id::text,'private')) AS scope_count,
    min(s.union_id::text)::uuid AS one_union
    FROM public.accounting_tournament_fee_sources s
    WHERE s.tournament_id=ANY((SELECT array_agg(c.tournament_id) FROM candidates c)::uuid[]) GROUP BY s.tournament_id
