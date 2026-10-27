CREATE VIEW public.accounting_effective_cash_rake_sources AS  SELECT s.id,
    s.rake_record_id,
    s.player_id,
    s.club_id,
    s.union_id,
    s.coordinator_union_id,
    s.earned_at,
    s.rake_credit,
    COALESCE(a.admitted_contract, s.contract) AS contract,
    GREATEST(s.recorded_at, a.admitted_at) AS recorded_at
   FROM accounting_cash_rake_sources s
     LEFT JOIN accounting_cash_atomic_contract_admissions a ON a.source_id = s.id
  WHERE NOT (EXISTS ( SELECT
           FROM accounting_cash_funding_contract_admissions f
          WHERE f.source_id = s.id))
UNION ALL
 SELECT s.id,
    s.rake_record_id,
    s.player_id,
    f.funding_club_id AS club_id,
    s.union_id,
    s.coordinator_union_id,
    s.earned_at,
    s.rake_credit,
    f.admitted_contract AS contract,
    GREATEST(s.recorded_at, a.admitted_at, f.admitted_at) AS recorded_at
   FROM accounting_cash_funding_contract_admissions f
     JOIN accounting_cash_rake_sources s ON s.id = f.source_id
     LEFT JOIN accounting_cash_atomic_contract_admissions a ON a.source_id = s.id;