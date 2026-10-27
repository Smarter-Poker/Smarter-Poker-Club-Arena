 SELECT 'cash_rake_accrual'::text AS source_type,
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
