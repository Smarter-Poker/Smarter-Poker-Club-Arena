CREATE OR REPLACE FUNCTION public.fn_accounting_week_clubs(p_union_id uuid, p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(club_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_key text; v_lock bigint; v_held boolean; v_clubs uuid[];
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_to<=p_from
 THEN RAISE EXCEPTION 'invalid_accounting_scope' USING ERRCODE='22023'; END IF;
 IF p_club_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.is_union IS NOT TRUE) THEN
   RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT p_club_id;
 ELSE
  -- A WEEK'S CLUBS ARE READ ONCE PER CLOSE ATTEMPT (20261016000241). Inside
  -- one union close attempt (job 272's chunked tick, the attempt's memo and
  -- deadline set by fn_weekly_accounting_attempt_begin) and only while this
  -- transaction holds the week's exclusive close lock, which every writer of
  -- this week's cash and tournament sources must share, the answer is kept
  -- for the rest of that attempt: no source of the week can be written while
  -- the lock is held. Everywhere else the week is read on every call.
  v_key:=p_union_id::text||'|'||p_from::text||'|'||p_to::text||'|'||COALESCE(current_setting('app.weekly_accounting_scope_deadline',true),'');
  v_lock:=hashtextextended('union-accounting:'||p_union_id::text||':'||extract(epoch FROM p_from)::text||':'||extract(epoch FROM p_to)::text,0);
  v_held:=COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
   AND current_setting('app.accounting_close_memo',true)='on'
   AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype='advisory' AND l.pid=pg_backend_pid() AND l.granted
    AND l.mode='ExclusiveLock' AND l.objsubid=1 AND l.database=(SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname=current_database())
    AND l.classid=((v_lock>>32)&4294967295)::oid AND l.objid=(v_lock&4294967295)::oid);
  IF v_held AND split_part(COALESCE(current_setting('app.accounting_week_clubs_memo',true),''),'=',1)=v_key THEN
   RETURN QUERY SELECT m.id::uuid FROM unnest(string_to_array(NULLIF(split_part(current_setting('app.accounting_week_clubs_memo',true),'=',2),''),',')) WITH ORDINALITY m(id,n) ORDER BY m.n;
   RETURN;
  END IF;
  -- PER CLUB (20261016000241): the week's cash sources are grouped per club,
  -- and a tournament club is accepted by one indexed existence test of its
  -- own rows, instead of materialising every accepted earning (2.5 million
  -- rows for the 2026-10-05 Midway week) to UNION them down to their clubs.
  -- The tests are the per-row tests, unchanged: with no launch cutoff, any
  -- cash row or any earned tournament row; with a cutoff, a cash row earned
  -- at or after it, or an earned tournament row both charged and recognized
  -- at or after it (finite instants only).
  SELECT COALESCE(array_agg(w.id ORDER BY w.id),ARRAY[]::uuid[]) INTO v_clubs FROM (WITH cash_clubs AS MATERIALIZED (
 SELECT w.club_id,latest.earned_at AS latest FROM (WITH RECURSIVE cash_walk(club_id) AS ((SELECT s.club_id FROM public.accounting_cash_rake_sources s WHERE s.club_id IS NOT NULL ORDER BY s.club_id LIMIT 1) UNION ALL SELECT n.club_id FROM cash_walk w CROSS JOIN LATERAL (SELECT s.club_id FROM public.accounting_cash_rake_sources s WHERE s.club_id>w.club_id ORDER BY s.club_id LIMIT 1) n) SELECT cash_walk.club_id FROM cash_walk) w CROSS JOIN LATERAL (SELECT s.earned_at FROM public.accounting_cash_rake_sources s WHERE s.club_id=w.club_id AND s.coordinator_union_id=p_union_id AND s.earned_at>=p_from AND s.earned_at<p_to ORDER BY s.earned_at DESC LIMIT 1 OFFSET 0) latest
), tournament_clubs AS MATERIALIZED (
 SELECT w.club_id FROM (WITH RECURSIVE walk(club_id) AS ((SELECT s.club_id FROM public.accounting_tournament_fee_sources s WHERE s.coordinator_union_id=p_union_id AND s.club_id IS NOT NULL ORDER BY s.club_id LIMIT 1) UNION ALL SELECT n.club_id FROM walk w CROSS JOIN LATERAL (SELECT s.club_id FROM public.accounting_tournament_fee_sources s WHERE s.coordinator_union_id=p_union_id AND s.club_id>w.club_id ORDER BY s.club_id LIMIT 1) n) SELECT walk.club_id FROM walk) w
), earning_clubs AS MATERIALIZED (
 SELECT e.club_id FROM (SELECT c.club_id FROM cash_clubs c UNION ALL SELECT t.club_id FROM tournament_clubs t)e GROUP BY e.club_id
), earning_cutoffs AS MATERIALIZED (
 SELECT c.club_id,public.fn_ca_launch_accounting_cutoff('club',c.club_id) AS cutoff FROM earning_clubs c
), accepted_cash AS MATERIALIZED (
 SELECT c.club_id FROM cash_clubs c LEFT JOIN earning_cutoffs b ON b.club_id=c.club_id
 WHERE CASE WHEN b.cutoff IS NULL THEN true ELSE c.latest>=b.cutoff END
), tournament_candidates AS MATERIALIZED (
 SELECT t.club_id FROM tournament_clubs t WHERE NOT EXISTS(SELECT FROM accepted_cash ac WHERE ac.club_id=t.club_id)
), accepted_earnings AS (
 SELECT c.club_id FROM accepted_cash c
 UNION ALL
 SELECT t.club_id FROM tournament_candidates t LEFT JOIN earning_cutoffs b ON b.club_id=t.club_id
 WHERE EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions r JOIN LATERAL (SELECT 1 FROM (SELECT s.* FROM public.accounting_tournament_fee_sources s WHERE s.coordinator_union_id=p_union_id AND s.club_id=t.club_id AND s.tournament_id=r.tournament_id OFFSET 0) s JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
  WHERE s.tournament_id=r.tournament_id AND s.coordinator_union_id=p_union_id AND s.club_id=t.club_id AND rs.recognized_at>=p_from AND rs.recognized_at<p_to
   AND CASE WHEN b.cutoff IS NULL THEN true ELSE s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=b.cutoff END
   AND CASE WHEN b.cutoff IS NULL THEN true ELSE rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at>=b.cutoff END
   AND rs.disposition='earned' AND r.status='recognized'
   AND rs.rake_credit=s.rake_credit AND rs.recognized_at=r.recognized_at
   AND NOT s.union_id IS DISTINCT FROM r.union_id LIMIT 1 OFFSET 0) witness ON true WHERE r.status='recognized' AND r.recognized_at>=p_from AND r.recognized_at<p_to LIMIT 1 OFFSET 0)
), initial AS (
   SELECT DISTINCT ON(h.entity_key) h.after_terms FROM public.accounting_agreement_history h
    WHERE h.entity_type='union_clubs' AND h.observed_at<=p_from ORDER BY h.entity_key,h.observed_at DESC,h.id DESC
  ), members_during_week AS (
   SELECT after_terms FROM initial UNION ALL SELECT h.after_terms FROM public.accounting_agreement_history h
    WHERE h.entity_type='union_clubs' AND h.observed_at>p_from AND h.observed_at<p_to
  ) SELECT x.id FROM (
   SELECT (m.after_terms->>'club_id')::uuid AS id FROM members_during_week m WHERE m.after_terms->>'union_id'=p_union_id::text
   UNION SELECT s.club_id FROM accepted_earnings s
   UNION SELECT c.club_id FROM public.accounting_rakeback_period_calculations c
    WHERE c.coordinator_union_id=p_union_id AND c.period_start=(p_from AT TIME ZONE 'America/Los_Angeles')::date
     AND c.period_end=(p_to AT TIME ZONE 'America/Los_Angeles')::date-1
   UNION SELECT sp.club_id FROM public.settlement_periods sp WHERE sp.union_id=p_union_id AND sp.start_at=p_from AND sp.end_at=p_to
  )x WHERE x.id IS NOT NULL AND x.id<>p_union_id ORDER BY x.id) w;
  IF v_held THEN
   PERFORM set_config('app.accounting_week_clubs_memo',v_key||'='||array_to_string(v_clubs,','),true);
  END IF;
  RETURN QUERY SELECT m.id FROM unnest(v_clubs) WITH ORDINALITY m(id,n) ORDER BY m.n;
 END IF;
END $function$
