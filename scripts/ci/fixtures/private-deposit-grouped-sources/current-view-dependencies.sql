CREATE TABLE public.accounting_cash_atomic_contract_admissions(source_id uuid PRIMARY KEY,admitted_contract jsonb,admitted_at timestamptz);
CREATE TABLE public.accounting_cash_funding_contract_admissions(source_id uuid PRIMARY KEY,funding_club_id uuid,admitted_contract jsonb,admitted_at timestamptz);
CREATE TABLE public.ca_launch_accounting_boundaries(scope_id uuid PRIMARY KEY,cutoff_at timestamptz,scope_kind text DEFAULT'club',undone_at timestamptz);
CREATE OR REPLACE FUNCTION public.fn_ca_launch_accounting_club_cutoffs()
 RETURNS TABLE(club_id uuid, cutoff_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER ROWS 10
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT b.scope_id, b.cutoff_at FROM public.ca_launch_accounting_boundaries b
  WHERE b.scope_kind='club' AND b.undone_at IS NULL
$function$;
CREATE OR REPLACE VIEW public.accounting_effective_cash_rake_sources WITH(security_invoker=true)AS SELECT s.id,
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
CREATE OR REPLACE VIEW public.accounting_payable_earning_sources WITH(security_invoker=true)AS SELECT 'cash_rake_accrual'::text AS source_type,
    s.id AS source_id,
    s.rake_record_id,
    NULL::uuid AS tournament_id,
    s.player_id,
    s.club_id,
    s.union_id,
    s.coordinator_union_id,
    s.earned_at,
    s.rake_credit,
    s.contract
   FROM accounting_effective_cash_rake_sources s
     LEFT JOIN fn_ca_launch_accounting_club_cutoffs() bd(club_id, cutoff_at) ON bd.club_id = s.club_id
  WHERE bd.cutoff_at IS NULL OR s.earned_at IS NOT NULL AND isfinite(s.earned_at) AND s.earned_at >= bd.cutoff_at
UNION ALL
 SELECT 'tournament_fee_accrual'::text AS source_type,
    s.id AS source_id,
    s.rake_record_id,
    s.tournament_id,
    s.player_id,
    s.club_id,
    s.union_id,
    s.coordinator_union_id,
    rs.recognized_at AS earned_at,
    s.rake_credit,
    s.contract
   FROM accounting_tournament_fee_sources s
     JOIN accounting_tournament_recognized_sources rs ON rs.source_id = s.id AND rs.tournament_id = s.tournament_id
     JOIN accounting_tournament_fee_recognitions r ON r.tournament_id = s.tournament_id
     LEFT JOIN fn_ca_launch_accounting_club_cutoffs() bd(club_id, cutoff_at) ON bd.club_id = s.club_id
  WHERE (bd.cutoff_at IS NULL OR s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at >= bd.cutoff_at) AND (bd.cutoff_at IS NULL OR rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at >= bd.cutoff_at) AND rs.disposition = 'earned'::text AND r.status = 'recognized'::text AND rs.rake_credit = s.rake_credit AND rs.recognized_at = r.recognized_at AND NOT s.union_id IS DISTINCT FROM r.union_id;
