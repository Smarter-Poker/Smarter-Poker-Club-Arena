CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_eligible_scopes(p_end timestamp with time zone, p_now timestamp with time zone)
 RETURNS TABLE(kind text, id uuid, first_week timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_to timestamptz:=p_end;v_now timestamptz:=p_now;v_chunked boolean:=true;
BEGIN
 IF md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))<>'e4f6b4adc2f43ccd2b7ecd90f2434538'
 THEN RAISE EXCEPTION 'weekly_payout_original_scope_authority_changed' USING ERRCODE='55000';END IF;
 RETURN QUERY
WITH cash_clubs AS MATERIALIZED (
          SELECT DISTINCT s.club_id FROM public.accounting_cash_rake_sources s
          WHERE s.coordinator_union_id IS NULL AND s.earned_at<v_to
        ), cash_cutoffs AS MATERIALIZED (
          SELECT c.club_id,public.fn_ca_launch_accounting_cutoff('club',c.club_id) AS cutoff FROM cash_clubs c
        ), standalone_earned AS (
          SELECT s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s
          LEFT JOIN cash_cutoffs c ON c.club_id=s.club_id
          WHERE s.coordinator_union_id IS NULL AND s.earned_at<v_to
            AND CASE WHEN c.cutoff IS NULL THEN true
              ELSE s.earned_at IS NOT NULL AND isfinite(s.earned_at) AND s.earned_at>=c.cutoff END
          UNION ALL
          -- STANDALONE TOURNAMENT EARNINGS ARE READ PER CLUB (20261022150614): this branch
          -- used to read the tournament_fee_accrual half of
          -- accounting_payable_earning_sources for every source row on every tick
          -- (1.7M recognition probes, 10 s warm and over 100 s cold), which spent
          -- the close attempt's own 3-minute budget before the attempt began.
          -- The predicate below is that view branch verbatim, read per club from
          -- the club's own standalone fee rows. Only eligible below reads these
          -- rows, as GREATEST(first week, the club's settlement floor) for clubs
          -- that are not unions, so a club with any such earning before its floor
          -- contributes the floor itself and is not read further; any other club
          -- contributes its earliest earning (and earliest finite one).
          SELECT tc.id AS club_id,te.earned_at FROM public.clubs tc
          CROSS JOIN LATERAL (SELECT public.fn_club_settlement_floor_week(tc.id) AS floor) tf
          CROSS JOIN LATERAL (SELECT CASE WHEN tf.floor IS NOT NULL AND EXISTS(SELECT 1
              FROM (SELECT s.id,s.tournament_id,s.club_id,s.union_id,s.charged_at,s.rake_credit FROM public.accounting_tournament_fee_sources s
                     WHERE s.club_id=tc.id AND s.coordinator_union_id IS NULL OFFSET 0) s
              JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
              JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
              LEFT JOIN public.fn_ca_launch_accounting_club_cutoffs() bd(club_id,cutoff_at) ON bd.club_id=s.club_id
              WHERE (bd.cutoff_at IS NULL OR s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=bd.cutoff_at)
                AND (bd.cutoff_at IS NULL OR rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at>=bd.cutoff_at)
                AND rs.disposition='earned' AND r.status='recognized' AND rs.rake_credit=s.rake_credit AND rs.recognized_at=r.recognized_at
                AND NOT s.union_id IS DISTINCT FROM r.union_id AND rs.recognized_at<v_to AND rs.recognized_at<tf.floor)
            THEN tf.floor END AS clamp) tk
          CROSS JOIN LATERAL (
            SELECT tk.clamp AS earned_at WHERE tk.clamp IS NOT NULL
            UNION ALL
            SELECT tm.earned_at FROM (SELECT min(rs.recognized_at) AS m,min(rs.recognized_at) FILTER(WHERE isfinite(rs.recognized_at)) AS mf
              FROM (SELECT s.id,s.tournament_id,s.club_id,s.union_id,s.charged_at,s.rake_credit FROM public.accounting_tournament_fee_sources s
                     WHERE s.club_id=tc.id AND s.coordinator_union_id IS NULL OFFSET 0) s
              JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
              JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
              LEFT JOIN public.fn_ca_launch_accounting_club_cutoffs() bd(club_id,cutoff_at) ON bd.club_id=s.club_id
              WHERE tk.clamp IS NULL AND (bd.cutoff_at IS NULL OR s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=bd.cutoff_at)
                AND (bd.cutoff_at IS NULL OR rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at>=bd.cutoff_at)
                AND rs.disposition='earned' AND r.status='recognized' AND rs.rake_credit=s.rake_credit AND rs.recognized_at=r.recognized_at
                AND NOT s.union_id IS DISTINCT FROM r.union_id AND rs.recognized_at<v_to) ta
            CROSS JOIN LATERAL (VALUES(ta.m),(ta.mf)) tm(earned_at) WHERE tm.earned_at IS NOT NULL) te
          WHERE tc.is_union IS NOT TRUE
        ), standalone_work AS (
          SELECT s.club_id,LEAST(public.fn_union_week_start(min(s.earned_at) FILTER(WHERE isfinite(s.earned_at))),min(s.earned_at)) AS first_week
           FROM standalone_earned s GROUP BY s.club_id
          UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
           WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
          UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
           WHERE q.standalone_club_id IS NOT NULL AND q.status='complete' AND q.period_end<v_to
            AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs later
              WHERE later.standalone_club_id=q.standalone_club_id AND later.period_end>q.period_end)
          UNION ALL SELECT rp.club_id,min(public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles'))
           FROM public.rakeback_periods rp WHERE rp.status='pending' AND rp.period_end<(v_to AT TIME ZONE 'America/Los_Angeles')::date
            AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=rp.club_id) GROUP BY rp.club_id
          UNION ALL SELECT a.club_id,public.fn_union_prev_week_start(v_now) FROM public.agents a
           WHERE NOT COALESCE(a.is_prepaid,false) AND a.credit_limit>0 AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=a.club_id)
        ), union_floors AS (
          SELECT u.id,f.earliest_period_start,CASE WHEN f.earliest_period_start IS NULL THEN public.fn_union_prev_week_start(v_now)
             WHEN public.fn_union_week_start(f.earliest_period_start)<f.earliest_period_start
              THEN public.fn_union_week_start(public.fn_union_week_start(f.earliest_period_start)+interval '8 days')
             ELSE public.fn_union_week_start(f.earliest_period_start) END AS first_week
           FROM public.unions u LEFT JOIN public.union_settlement_floor f ON f.union_id=u.id
        ), union_work AS (
          SELECT u.id,LEAST(u.first_week,(SELECT min(q.period_start) FROM public.union_accounting_runs q
            WHERE q.union_id=u.id
              AND (q.status<>'complete' OR (u.earliest_period_start IS NULL
                AND q.status='complete' AND q.result->>'success'='true' AND q.result->>'accounting_version'='3'))
              AND (u.earliest_period_start IS NULL OR q.period_start>=u.first_week))) AS first_week
           FROM union_floors u
        ), eligible AS (
          -- Match the exact-scope floor rounding and per-week due check. An
          -- older union backlog remains due before this Monday's new close.
          SELECT 'union'::text AS kind,w.id FROM union_work w WHERE w.first_week<v_to
           AND v_now>=CASE WHEN v_chunked THEN public.fn_union_week_start(w.first_week+interval '8 days') ELSE public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days')) END
          UNION ALL SELECT 'club',w.club_id FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id
           WHERE c.is_union IS NOT TRUE AND GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))<v_to
            AND v_now>=CASE WHEN v_chunked THEN public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days') ELSE public.fn_union_accounting_run_at(public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days')) END GROUP BY w.club_id
        )
 SELECT e.kind,e.id,CASE WHEN e.kind='union' THEN (SELECT min(w.first_week) FROM union_work w WHERE w.id=e.id)
  ELSE (SELECT min(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))) FROM standalone_work w WHERE w.club_id=e.id) END
 FROM eligible e ORDER BY (e.kind='union') DESC,e.id;
END $function$
