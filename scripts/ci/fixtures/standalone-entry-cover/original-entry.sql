      WITH cash_candidates AS MATERIALIZED (
 SELECT s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s
 WHERE s.coordinator_union_id IS NULL AND s.earned_at<$2 AND ($1 IS NULL OR s.club_id=$1)
), tournament_candidates AS MATERIALIZED (
 SELECT s.club_id,s.charged_at,s.union_id,s.rake_credit,rs.recognized_at,rs.disposition,rs.rake_credit AS recognized_rake_credit,
 r.status AS recognition_status,r.recognized_at AS recognition_at,r.union_id AS recognition_union_id
 FROM public.accounting_tournament_fee_sources s
 JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
 JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
 WHERE s.coordinator_union_id IS NULL AND rs.recognized_at<$2 AND ($1 IS NULL OR s.club_id=$1)
), earning_clubs AS MATERIALIZED (
 SELECT e.club_id FROM (SELECT c.club_id FROM cash_candidates c UNION ALL SELECT t.club_id FROM tournament_candidates t)e GROUP BY e.club_id
), earning_cutoffs AS MATERIALIZED (
 SELECT c.club_id,public.fn_ca_launch_accounting_cutoff('club',c.club_id) AS cutoff FROM earning_clubs c
), accepted_earnings AS (
 SELECT s.club_id,s.earned_at FROM cash_candidates s
 LEFT JOIN earning_cutoffs b ON b.club_id=s.club_id
 WHERE CASE WHEN b.cutoff IS NULL THEN true ELSE s.earned_at IS NOT NULL AND isfinite(s.earned_at) AND s.earned_at>=b.cutoff END
 UNION ALL
 SELECT s.club_id,s.recognized_at AS earned_at FROM tournament_candidates s
 LEFT JOIN earning_cutoffs b ON b.club_id=s.club_id
 WHERE CASE WHEN b.cutoff IS NULL THEN true ELSE s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=b.cutoff END
 AND CASE WHEN b.cutoff IS NULL THEN true ELSE s.recognized_at IS NOT NULL AND isfinite(s.recognized_at) AND s.recognized_at>=b.cutoff END
 AND s.disposition='earned' AND s.recognition_status='recognized'
 AND s.recognized_rake_credit=s.rake_credit AND s.recognized_at=s.recognition_at
 AND NOT s.union_id IS DISTINCT FROM s.recognition_union_id
), pending_scope AS (
        SELECT s.club_id,LEAST(public.fn_union_week_start(min(s.earned_at) FILTER(WHERE isfinite(s.earned_at))),min(s.earned_at)) AS first_week
         FROM accepted_earnings s GROUP BY s.club_id
        UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
         WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
        UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
         WHERE q.standalone_club_id IS NOT NULL AND q.status='complete' AND q.period_end<$2
          AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs later
            WHERE later.standalone_club_id=q.standalone_club_id AND later.period_end>q.period_end)
        UNION ALL SELECT rp.club_id,min(public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles'))
         FROM public.rakeback_periods rp WHERE rp.status='pending' AND rp.period_end<($2 AT TIME ZONE 'America/Los_Angeles')::date
          AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=rp.club_id) GROUP BY rp.club_id
        UNION ALL SELECT a.club_id,public.fn_union_prev_week_start($3) FROM public.agents a
         WHERE NOT COALESCE(a.is_prepaid,false) AND a.credit_used>0 AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=a.club_id)
      ) SELECT x.club_id AS id,GREATEST(min(x.first_week),public.fn_club_settlement_floor_week(x.club_id)) AS first_week FROM pending_scope x JOIN public.clubs c ON c.id=x.club_id
       WHERE c.is_union IS NOT TRUE AND ($1 IS NULL OR x.club_id=$1) GROUP BY x.club_id ORDER BY x.club_id;
