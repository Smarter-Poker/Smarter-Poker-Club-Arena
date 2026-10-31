SELECT s.rake_record_id,sum(s.rake_credit) AS credited
FROM public.accounting_tournament_fee_sources s
WHERE s.rake_record_id=ANY((SELECT array_agg(rr.id) FROM rr)::uuid[])
GROUP BY s.rake_record_id
