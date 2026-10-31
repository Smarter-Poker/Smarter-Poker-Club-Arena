-- @live-proof: (md5(pg_get_functiondef('public.fn_standalone_foreign_certificate_periods(text,uuid,date,date,timestamptz,timestamptz)'::regprocedure))='9f8457664adb8bc0b171ca75d831126b')
-- The former standalone's strict foreign-certificate query timed out90s even
-- with its original source cover. Its plan rescanned the entire original
-- materialized source bag for every certificate (416 actual,1 estimated).
-- Flatten only the original cand allocations ONCE before the exact same bad
-- LEFT JOIN source identity/party/rate checks. All original src/cnt/own/cand,
-- latest-history/fingerprint and final aggregate predicates remain unchanged.
-- Pure actual READ ONLY candidate:416 exact original IDs in62675.592ms.
-- No earning, wallet, receipt, cache/generation, source65 pin or budget changes.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $foreign_allocations_once$
DECLARE definition text;before_metadata jsonb;after_metadata jsonb;p record;
BEGIN
 IF public.fn_platform_frozen()THEN RAISE EXCEPTION 'foreign_certificate_allocations_install_frozen';END IF;
 SELECT pg_get_functiondef(x.oid),to_jsonb(x)-'prosrc'-'prosqlbody'INTO definition,before_metadata FROM pg_catalog.pg_proc x
 WHERE x.oid='public.fn_standalone_foreign_certificate_periods(text,uuid,date,date,timestamptz,timestamptz)'::regprocedure;
 IF md5(definition)IS DISTINCT FROM'154b8afb11b7a9c7617d16fd047c9918' THEN RAISE EXCEPTION 'foreign_certificate_allocations_original_owner_changed';END IF;
 SELECT x.*,pg_get_userbyid(x.proowner)owner_name,l.lanname INTO p FROM pg_catalog.pg_proc x JOIN pg_catalog.pg_language l ON l.oid=x.prolang
 WHERE x.oid='public.fn_standalone_foreign_certificate_periods(text,uuid,date,date,timestamptz,timestamptz)'::regprocedure;
 IF p.owner_name IS DISTINCT FROM'postgres'OR p.lanname IS DISTINCT FROM'sql'OR p.provolatile IS DISTINCT FROM's'OR p.prosecdef OR p.proisstrict OR p.proleakproof OR p.proparallel IS DISTINCT FROM'u'
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public']OR p.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[]
 THEN RAISE EXCEPTION 'foreign_certificate_allocations_original_metadata_changed';END IF;
 IF (length(definition)-length(replace(definition,$old_bad$bad AS MATERIALIZED (
  SELECT DISTINCT foreign_cert.period_id FROM cand foreign_cert
  CROSS JOIN LATERAL jsonb_array_elements(foreign_cert.source_allocations) a
  LEFT JOIN src fs ON fs.source_type=a->>'source_type' AND fs.source_id=(a->>'source_id')::uuid
  WHERE fs.source_id IS NULL OR fs.club_id IS DISTINCT FROM foreign_cert.club_id
   OR fs.player_id IS DISTINCT FROM foreign_cert.player_id
   OR fs.coordinator_union_id IS DISTINCT FROM foreign_cert.coordinator_union_id
   OR fs.earned_at<p_period_start OR fs.earned_at>=p_period_end
   OR fs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
   OR fs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
   OR a->>'source_type' NOT IN('cash_rake_accrual','tournament_fee_accrual')
   OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric NOT BETWEEN 0 AND 1
   OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
   OR a->>'payer_kind' IS NULL OR a->>'payer_kind' NOT IN('agent','club')
   OR NULLIF(a->>'payer_user_id','')::uuid=foreign_cert.player_id
   OR (a->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF(a->>'payer_user_id','') IS NOT NULL)
   OR (foreign_cert.payer_kind<>'split' AND(a->>'payer_kind' IS DISTINCT FROM foreign_cert.payer_kind
     OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM foreign_cert.payer_user_id)))$old_bad$,'')))/length($old_bad$bad AS MATERIALIZED (
  SELECT DISTINCT foreign_cert.period_id FROM cand foreign_cert
  CROSS JOIN LATERAL jsonb_array_elements(foreign_cert.source_allocations) a
  LEFT JOIN src fs ON fs.source_type=a->>'source_type' AND fs.source_id=(a->>'source_id')::uuid
  WHERE fs.source_id IS NULL OR fs.club_id IS DISTINCT FROM foreign_cert.club_id
   OR fs.player_id IS DISTINCT FROM foreign_cert.player_id
   OR fs.coordinator_union_id IS DISTINCT FROM foreign_cert.coordinator_union_id
   OR fs.earned_at<p_period_start OR fs.earned_at>=p_period_end
   OR fs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
   OR fs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
   OR a->>'source_type' NOT IN('cash_rake_accrual','tournament_fee_accrual')
   OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric NOT BETWEEN 0 AND 1
   OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
   OR a->>'payer_kind' IS NULL OR a->>'payer_kind' NOT IN('agent','club')
   OR NULLIF(a->>'payer_user_id','')::uuid=foreign_cert.player_id
   OR (a->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF(a->>'payer_user_id','') IS NOT NULL)
   OR (foreign_cert.payer_kind<>'split' AND(a->>'payer_kind' IS DISTINCT FROM foreign_cert.payer_kind
     OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM foreign_cert.payer_user_id)))$old_bad$)<>1 THEN RAISE EXCEPTION 'foreign_certificate_allocations_original_bad_shape_changed';END IF;
 definition:=replace(definition,$old_bad$bad AS MATERIALIZED (
  SELECT DISTINCT foreign_cert.period_id FROM cand foreign_cert
  CROSS JOIN LATERAL jsonb_array_elements(foreign_cert.source_allocations) a
  LEFT JOIN src fs ON fs.source_type=a->>'source_type' AND fs.source_id=(a->>'source_id')::uuid
  WHERE fs.source_id IS NULL OR fs.club_id IS DISTINCT FROM foreign_cert.club_id
   OR fs.player_id IS DISTINCT FROM foreign_cert.player_id
   OR fs.coordinator_union_id IS DISTINCT FROM foreign_cert.coordinator_union_id
   OR fs.earned_at<p_period_start OR fs.earned_at>=p_period_end
   OR fs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
   OR fs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
   OR a->>'source_type' NOT IN('cash_rake_accrual','tournament_fee_accrual')
   OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric NOT BETWEEN 0 AND 1
   OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
   OR a->>'payer_kind' IS NULL OR a->>'payer_kind' NOT IN('agent','club')
   OR NULLIF(a->>'payer_user_id','')::uuid=foreign_cert.player_id
   OR (a->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF(a->>'payer_user_id','') IS NOT NULL)
   OR (foreign_cert.payer_kind<>'split' AND(a->>'payer_kind' IS DISTINCT FROM foreign_cert.payer_kind
     OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM foreign_cert.payer_user_id)))$old_bad$,$new_bad$allocation_rows AS MATERIALIZED (
  SELECT foreign_cert.period_id,foreign_cert.club_id,foreign_cert.player_id,
    foreign_cert.coordinator_union_id,foreign_cert.payer_kind,foreign_cert.payer_user_id,
    a.value AS allocation
  FROM cand foreign_cert
  CROSS JOIN LATERAL jsonb_array_elements(foreign_cert.source_allocations) a(value)),
bad AS MATERIALIZED (
  SELECT DISTINCT foreign_cert.period_id FROM allocation_rows foreign_cert
  LEFT JOIN src fs ON fs.source_type=(foreign_cert.allocation)->>'source_type' AND fs.source_id=((foreign_cert.allocation)->>'source_id')::uuid
  WHERE fs.source_id IS NULL OR fs.club_id IS DISTINCT FROM foreign_cert.club_id
   OR fs.player_id IS DISTINCT FROM foreign_cert.player_id
   OR fs.coordinator_union_id IS DISTINCT FROM foreign_cert.coordinator_union_id
   OR fs.earned_at<p_period_start OR fs.earned_at>=p_period_end
   OR fs.rake_credit IS DISTINCT FROM((foreign_cert.allocation)->>'rake_credit')::numeric
   OR fs.rake_record_id IS DISTINCT FROM((foreign_cert.allocation)->>'rake_record_id')::uuid
   OR (foreign_cert.allocation)->>'source_type' NOT IN('cash_rake_accrual','tournament_fee_accrual')
   OR ((foreign_cert.allocation)->>'rate')::numeric IS NULL OR ((foreign_cert.allocation)->>'rate')::numeric NOT BETWEEN 0 AND 1
   OR ((foreign_cert.allocation)->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
   OR (foreign_cert.allocation)->>'payer_kind' IS NULL OR (foreign_cert.allocation)->>'payer_kind' NOT IN('agent','club')
   OR NULLIF((foreign_cert.allocation)->>'payer_user_id','')::uuid=foreign_cert.player_id
   OR ((foreign_cert.allocation)->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF((foreign_cert.allocation)->>'payer_user_id','') IS NOT NULL)
   OR (foreign_cert.payer_kind<>'split' AND((foreign_cert.allocation)->>'payer_kind' IS DISTINCT FROM foreign_cert.payer_kind
     OR NULLIF((foreign_cert.allocation)->>'payer_user_id','')::uuid IS DISTINCT FROM foreign_cert.payer_user_id)))$new_bad$);
 EXECUTE definition;
 SELECT to_jsonb(x)-'prosrc'-'prosqlbody'INTO after_metadata FROM pg_catalog.pg_proc x
 WHERE x.oid='public.fn_standalone_foreign_certificate_periods(text,uuid,date,date,timestamptz,timestamptz)'::regprocedure;
 IF before_metadata IS DISTINCT FROM after_metadata OR md5(pg_get_functiondef('public.fn_standalone_foreign_certificate_periods(text,uuid,date,date,timestamptz,timestamptz)'::regprocedure))IS DISTINCT FROM'9f8457664adb8bc0b171ca75d831126b'
 THEN RAISE EXCEPTION 'foreign_certificate_allocations_postimage_or_metadata_changed';END IF;
END $foreign_allocations_once$;
COMMIT;
