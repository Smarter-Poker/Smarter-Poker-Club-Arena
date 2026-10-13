CREATE SCHEMA extensions;
CREATE TABLE ca_launch_accounting_boundaries(scope_kind text,scope_id uuid,cutoff_at timestamptz,undone_at timestamptz,PRIMARY KEY(scope_kind,scope_id));
CREATE TABLE accounting_cash_rake_sources(id uuid,rake_record_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,earned_at timestamptz,rake_credit numeric,contract jsonb);
CREATE INDEX cash_standalone ON accounting_cash_rake_sources(coordinator_union_id,earned_at,club_id);
CREATE TABLE accounting_tournament_fee_sources(id uuid,rake_record_id uuid,tournament_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,charged_at timestamptz,rake_credit numeric,contract jsonb);
CREATE TABLE accounting_tournament_recognized_sources(source_id uuid,tournament_id uuid,recognized_at timestamptz,disposition text,rake_credit numeric);
CREATE TABLE accounting_tournament_fee_recognitions(tournament_id uuid,recognized_at timestamptz,status text,union_id uuid);
CREATE TABLE unions(id uuid PRIMARY KEY);
CREATE TABLE clubs(id uuid PRIMARY KEY,is_union boolean);
CREATE TABLE union_settlement_floor(union_id uuid PRIMARY KEY,earliest_period_start timestamptz);
CREATE TABLE club_settlement_floor(club_id uuid PRIMARY KEY,earliest_period_start timestamptz);
CREATE TABLE union_clubs(club_id uuid,union_id uuid);
CREATE TABLE agents(club_id uuid,is_prepaid boolean,credit_used numeric);
CREATE TABLE rakeback_periods(club_id uuid,period_start date,period_end date,status text);
CREATE TABLE union_accounting_runs(union_id uuid,standalone_club_id uuid,period_start timestamptz,period_end timestamptz,status text,result jsonb,scope_kind text,scope_id uuid,last_scheduler_visit_at timestamptz,started_at timestamptz);
CREATE TABLE weekly_accounting_scheduler_visits(scope_kind text,scope_id uuid,last_visit_at timestamptz,last_outcome text);

 CREATE TABLE accounting_agreement_history(id bigint,entity_key text,entity_type text,observed_at timestamptz,after_terms jsonb);
 CREATE TABLE accounting_rakeback_period_calculations(club_id uuid,coordinator_union_id uuid,period_start date,period_end date);
 CREATE TABLE settlement_periods(club_id uuid,union_id uuid,start_at timestamptz,end_at timestamptz);
 CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('native.engine',true) IS DISTINCT FROM 'false'$$;
 CREATE OR REPLACE FUNCTION public.fn_ca_launch_accounting_cutoff(p_kind text, p_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT cutoff_at FROM public.ca_launch_accounting_boundaries WHERE scope_kind=p_kind AND scope_id=p_id AND undone_at IS NULL
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_launch_accounting_accepts(p_club_id uuid, p_earned_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT CASE WHEN b.cutoff IS NULL THEN true ELSE p_earned_at IS NOT NULL AND isfinite(p_earned_at) AND p_earned_at>=b.cutoff END
 FROM (SELECT public.fn_ca_launch_accounting_cutoff('club',p_club_id) cutoff)b
$function$;CREATE VIEW accounting_payable_earning_sources WITH(security_invoker=true) AS  SELECT 'cash_rake_accrual'::text AS source_type,
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
   FROM accounting_cash_rake_sources s
  WHERE fn_ca_launch_accounting_accepts(s.club_id, s.earned_at)
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
  WHERE fn_ca_launch_accounting_accepts(s.club_id, s.charged_at) AND fn_ca_launch_accounting_accepts(s.club_id, rs.recognized_at) AND rs.disposition = 'earned'::text AND r.status = 'recognized'::text AND rs.rake_credit = s.rake_credit AND rs.recognized_at = r.recognized_at AND NOT s.union_id IS DISTINCT FROM r.union_id;;CREATE OR REPLACE FUNCTION public.fn_accounting_week_clubs(p_union_id uuid, p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(club_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_to<=p_from
 THEN RAISE EXCEPTION 'invalid_accounting_scope' USING ERRCODE='22023'; END IF;
 IF p_club_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.is_union IS NOT TRUE) THEN
   RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT p_club_id;
 ELSE
  RETURN QUERY WITH initial AS (
   SELECT DISTINCT ON(h.entity_key) h.after_terms FROM public.accounting_agreement_history h
    WHERE h.entity_type='union_clubs' AND h.observed_at<=p_from ORDER BY h.entity_key,h.observed_at DESC,h.id DESC
  ), members_during_week AS (
   SELECT after_terms FROM initial UNION ALL SELECT h.after_terms FROM public.accounting_agreement_history h
    WHERE h.entity_type='union_clubs' AND h.observed_at>p_from AND h.observed_at<p_to
  ) SELECT x.id FROM (
   SELECT (m.after_terms->>'club_id')::uuid AS id FROM members_during_week m WHERE m.after_terms->>'union_id'=p_union_id::text
   UNION SELECT s.club_id FROM public.accounting_payable_earning_sources s
    WHERE s.coordinator_union_id=p_union_id AND s.earned_at>=p_from AND s.earned_at<p_to
   UNION SELECT c.club_id FROM public.accounting_rakeback_period_calculations c
    WHERE c.coordinator_union_id=p_union_id AND c.period_start=(p_from AT TIME ZONE 'America/Los_Angeles')::date
     AND c.period_end=(p_to AT TIME ZONE 'America/Los_Angeles')::date-1
   UNION SELECT sp.club_id FROM public.settlement_periods sp WHERE sp.union_id=p_union_id AND sp.start_at=p_from AND sp.end_at=p_to
  )x WHERE x.id IS NOT NULL AND x.id<>p_union_id ORDER BY x.id;
 END IF;
END $function$
;
 INSERT INTO clubs SELECT md5('club'||g)::uuid,CASE WHEN g=8 THEN true WHEN g=7 THEN NULL ELSE false END FROM generate_series(1,8)g;
 INSERT INTO accounting_cash_rake_sources(id,club_id,union_id,coordinator_union_id,earned_at,rake_credit)
 SELECT md5('cash'||g)::uuid,CASE WHEN g%11=0 THEN NULL WHEN g%17=0 THEN md5('union1')::uuid ELSE md5('club'||(1+g%5))::uuid END,md5('union1')::uuid,CASE WHEN g%13=0 THEN md5('union2')::uuid ELSE md5('union1')::uuid END,
 CASE g%9 WHEN 0 THEN NULL WHEN 1 THEN '-infinity'::timestamptz WHEN 2 THEN 'infinity'::timestamptz WHEN 3 THEN '2026-10-05 06:59:59Z' WHEN 4 THEN '2026-10-05 07:00Z' WHEN 5 THEN '2026-10-06 06:59:59Z' WHEN 6 THEN '2026-10-06 07:00Z' WHEN 7 THEN '2026-10-06 07:00:01Z' ELSE '2026-10-12 07:00Z' END,1 FROM generate_series(1,900)g;
 INSERT INTO accounting_tournament_fee_sources(id,tournament_id,club_id,union_id,coordinator_union_id,charged_at,rake_credit)
 SELECT md5('fee'||g)::uuid,md5('t'||g)::uuid,CASE WHEN g%11=0 THEN NULL WHEN g%17=0 THEN md5('union1')::uuid ELSE md5('club'||(1+g%5))::uuid END,CASE WHEN g%19=0 THEN NULL ELSE md5('union1')::uuid END,CASE WHEN g%13=0 THEN md5('union2')::uuid ELSE md5('union1')::uuid END,
 CASE g%7 WHEN 0 THEN NULL WHEN 1 THEN '-infinity'::timestamptz WHEN 2 THEN 'infinity'::timestamptz WHEN 3 THEN '2026-10-06 06:59:59Z' WHEN 4 THEN '2026-10-06 07:00Z' ELSE '2026-10-06 07:00:01Z' END,2 FROM generate_series(1,700)g;
 INSERT INTO accounting_tournament_recognized_sources
 SELECT id,tournament_id,CASE (row_number()OVER(ORDER BY id))%7 WHEN 0 THEN NULL WHEN 1 THEN '2026-10-05 06:59:59Z' WHEN 2 THEN '2026-10-05 07:00Z' WHEN 3 THEN '2026-10-06 06:59:59Z' WHEN 4 THEN '2026-10-06 07:00Z' WHEN 5 THEN '2026-10-06 07:00:01Z' ELSE '2026-10-12 07:00Z' END::timestamptz,CASE (row_number()OVER(ORDER BY id))%5 WHEN 0 THEN 'cancelled' ELSE 'earned' END,CASE (row_number()OVER(ORDER BY id))%6 WHEN 0 THEN 3 ELSE 2 END FROM accounting_tournament_fee_sources;
 INSERT INTO accounting_tournament_fee_recognitions SELECT s.tournament_id,CASE (row_number()OVER(ORDER BY s.id))%8 WHEN 0 THEN rs.recognized_at+interval '1 second' ELSE rs.recognized_at END,CASE (row_number()OVER(ORDER BY s.id))%9 WHEN 0 THEN 'pending' ELSE 'recognized' END,CASE (row_number()OVER(ORDER BY s.id))%10 WHEN 0 THEN md5('union2')::uuid ELSE s.union_id END FROM accounting_tournament_fee_sources s JOIN accounting_tournament_recognized_sources rs ON rs.source_id=s.id;
 INSERT INTO accounting_tournament_recognized_sources SELECT * FROM accounting_tournament_recognized_sources WHERE source_id=md5('fee1')::uuid;
 INSERT INTO accounting_tournament_fee_recognitions SELECT * FROM accounting_tournament_fee_recognitions WHERE tournament_id=md5('t1')::uuid;
 INSERT INTO accounting_agreement_history VALUES(1,'a','union_clubs','2026-10-04 07:00Z',jsonb_build_object('club_id',md5('club6')::uuid,'union_id',md5('union2')::uuid)),(2,'a','union_clubs','2026-10-05 07:00Z',jsonb_build_object('club_id',md5('club6')::uuid,'union_id',md5('union1')::uuid)),(3,'a','union_clubs','2026-10-05 07:00Z',jsonb_build_object('club_id',md5('club6')::uuid,'union_id',md5('union2')::uuid)),(4,'a','union_clubs','2026-10-06 07:00Z',jsonb_build_object('club_id',md5('club7')::uuid,'union_id',md5('union1')::uuid));
 INSERT INTO accounting_rakeback_period_calculations VALUES(md5('club6')::uuid,md5('union1')::uuid,'2026-10-05','2026-10-11');
 INSERT INTO settlement_periods VALUES(md5('club8')::uuid,md5('union1')::uuid,'2026-10-05 07:00Z','2026-10-12 07:00Z');
 