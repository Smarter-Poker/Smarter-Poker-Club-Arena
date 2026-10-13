-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure))='47df4a9dfae6291b7b3f3d3c16470cfc')
-- Union cohort earning admission read launch cutoff per source row.
-- Cache the authentic cutoff once per distinct union/window earning club.
-- Preserve CASH and both charged/recognized tournament admissions, all history and other branches.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
SET LOCAL search_path=public;
DO $guard$BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.sub',true),'') IS NOT NULL THEN RAISE EXCEPTION 'weekly_cohort_operator_refused' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT FROM(VALUES
('smarter_private.original_inventory_proof_sources_match()','2f0091a1c85eb9f4ffadce1142ba31a4',false,'s','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']),
('public.fn_active_maintenance_release_boundary()','05b537b57c9f51a5164e20a1cd0e67e0',true,'v','{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}',ARRAY['search_path=public, auth, pg_temp']),
('public.fn_platform_frozen()','ec683805e052fceeae74789e82dce4cc',false,'v','{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}',ARRAY['search_path=public, pg_temp'])
 )v(signature,hash,secdef,volatility,acl,config)LEFT JOIN pg_proc p ON p.oid=to_regprocedure(v.signature) WHERE p.oid IS NULL OR md5(pg_get_functiondef(p.oid))IS DISTINCT FROM v.hash OR p.proowner<>'postgres'::regrole OR p.prosecdef IS DISTINCT FROM v.secdef OR p.provolatile::text IS DISTINCT FROM v.volatility OR p.proacl::text IS DISTINCT FROM v.acl OR p.proconfig IS DISTINCT FROM v.config)THEN RAISE EXCEPTION 'weekly_cohort_gate_authority_refused';END IF;
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN RAISE EXCEPTION 'weekly_cohort_settlement_lane_owned';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'weekly_cohort_override_refused';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'weekly_cohort_freeze_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'weekly_cohort_reader_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261013195428') THEN RAISE EXCEPTION 'weekly_cohort_history_replay';END IF;
 IF EXISTS(SELECT FROM(VALUES
('20261012181905',523621,'4f4827dba34fc22f2fc7b7c81b97f292'),
('20261013084856',23314,'c59c7bc7cce1650d9aa6903bdb76e056'),
('20261013133012',6255,'cfdc83501b87622c88d4a3e6a5d544dc'),
('20261013163310',56447,'e5e59a4139319168dd1fee09411989f6'),
('20261013182759',56531,'b3b2ab25d944efb292f8e918e93d7b8f')
 )v(version,bytes,hash)WHERE(SELECT count(*)FROM supabase_migrations.schema_migrations m WHERE m.version=v.version)<>1 OR NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations m WHERE m.version=v.version AND cardinality(m.statements)=1 AND octet_length(m.statements[1])=v.bytes AND md5(m.statements[1])=v.hash))THEN RAISE EXCEPTION 'weekly_cohort_parent_history_refused';END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'weekly_cohort_source40_refused';END IF;
 IF md5(pg_get_viewdef('public.accounting_payable_earning_sources'::regclass,true)) IS DISTINCT FROM 'aac794d4987660a54955116efb2c77d6' OR (SELECT reloptions FROM pg_class WHERE oid='public.accounting_payable_earning_sources'::regclass) IS DISTINCT FROM ARRAY['security_invoker=true'] THEN RAISE EXCEPTION 'weekly_cohort_view_refused';END IF;
 IF EXISTS(SELECT FROM(VALUES
('public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)','d7873c8b3dd2a0ef8df48be321dd9a2f',true,'s','{postgres=X/postgres}',ARRAY['search_path=public']),
('public.fn_caller_is_engine()','d9a70f1d932538025e656bfe2b4d091d',false,'s','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',ARRAY['search_path=pg_catalog, public, auth']),
('public.fn_process_weekly_accounting_scope(uuid,uuid)','91caaaf89b89f0978069461010c3eeb9',true,'v','{postgres=X/postgres}',ARRAY['search_path=public']),
('public.fn_ca_launch_accounting_accepts(uuid,timestamptz)','0f902b31908c9b6634635c1fab7363c4',true,'s','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',ARRAY['search_path=pg_catalog, public']),
('public.fn_ca_launch_accounting_cutoff(text,uuid)','cc3063873cf25be4b70e7cc893617c37',true,'s','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',ARRAY['search_path=pg_catalog, public']),
('public.fn_club_settlement_floor_week(uuid)','9e7e293af19b244b2176c27e62f678e4',false,'s','{postgres=X/postgres}',ARRAY['search_path=public']),
('public.fn_union_week_start(timestamptz)','103f192a228084dad0e4268c36c82c4b',false,'i','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',ARRAY['search_path=public, extensions']),
('public.fn_union_prev_week_start(timestamptz)','538130fb95504d2854a9c6e8b75214cc',false,'i','{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}',ARRAY['search_path=public, extensions']),
('public.fn_union_accounting_run_at(timestamptz)','85e9f0ab83b1655a90af953c0d547117',false,'i','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',ARRAY['search_path=public'])
 )v(signature,hash,secdef,volatility,acl,config)LEFT JOIN pg_proc p ON p.oid=to_regprocedure(v.signature) WHERE p.oid IS NULL OR md5(pg_get_functiondef(p.oid))IS DISTINCT FROM v.hash OR p.proowner<>'postgres'::regrole OR p.prosecdef IS DISTINCT FROM v.secdef OR p.provolatile::text IS DISTINCT FROM v.volatility OR p.proacl::text IS DISTINCT FROM v.acl OR p.proconfig IS DISTINCT FROM v.config)THEN RAISE EXCEPTION 'weekly_cohort_preimage_refused';END IF;
END$guard$;
CREATE OR REPLACE FUNCTION public.fn_accounting_week_clubs(p_union_id uuid, p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
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
  RETURN QUERY WITH cash_candidates AS MATERIALIZED (
 SELECT s.id,s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s
 WHERE s.coordinator_union_id=p_union_id AND s.earned_at>=p_from AND s.earned_at<p_to
), tournament_candidates AS MATERIALIZED (
 SELECT s.id,s.club_id,s.charged_at,s.union_id,s.rake_credit,rs.recognized_at,rs.disposition,rs.rake_credit AS recognized_rake_credit,
 r.status AS recognition_status,r.recognized_at AS recognition_at,r.union_id AS recognition_union_id
 FROM public.accounting_tournament_fee_sources s
 JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
 JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
 WHERE s.coordinator_union_id=p_union_id AND rs.recognized_at>=p_from AND rs.recognized_at<p_to
), earning_clubs AS MATERIALIZED (
 SELECT e.club_id FROM (SELECT c.club_id FROM cash_candidates c UNION ALL SELECT t.club_id FROM tournament_candidates t)e GROUP BY e.club_id
), earning_cutoffs AS MATERIALIZED (
 SELECT c.club_id,public.fn_ca_launch_accounting_cutoff('club',c.club_id) AS cutoff FROM earning_clubs c
), accepted_earnings AS (
 SELECT 'cash_rake_accrual'::text AS source_type,s.id AS source_id,s.club_id FROM cash_candidates s
 LEFT JOIN earning_cutoffs b ON b.club_id=s.club_id
 WHERE CASE WHEN b.cutoff IS NULL THEN true ELSE s.earned_at IS NOT NULL AND isfinite(s.earned_at) AND s.earned_at>=b.cutoff END
 UNION ALL
 SELECT 'tournament_fee_accrual'::text AS source_type,s.id AS source_id,s.club_id FROM tournament_candidates s
 LEFT JOIN earning_cutoffs b ON b.club_id=s.club_id
 WHERE CASE WHEN b.cutoff IS NULL THEN true ELSE s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=b.cutoff END
 AND CASE WHEN b.cutoff IS NULL THEN true ELSE s.recognized_at IS NOT NULL AND isfinite(s.recognized_at) AND s.recognized_at>=b.cutoff END
 AND s.disposition='earned' AND s.recognition_status='recognized'
 AND s.recognized_rake_credit=s.rake_credit AND s.recognized_at=s.recognition_at
 AND NOT s.union_id IS DISTINCT FROM s.recognition_union_id
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
  )x WHERE x.id IS NOT NULL AND x.id<>p_union_id ORDER BY x.id;
 END IF;
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
DO $post$BEGIN
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)') AND md5(pg_get_functiondef(p.oid))='47df4a9dfae6291b7b3f3d3c16470cfc' AND md5(p.prosrc)='8ca51c56842586a2b94b7a7c341c7c78' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='s' AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'weekly_cohort_postimage_refused';END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'weekly_cohort_post_source40_refused';END IF;
END$post$;
COMMIT;
