-- Reserved by scripts/new-migration.mjs. Installed cash cover removes heap cost;
-- original100 still exceeds8s in per-attribution fee cutoff. Retain it once.
-- Same NULL/finite acceptance, bounds, sharing, rounding, metadata and source65.
BEGIN;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
DO $guard$
DECLARE
 v_oid oid := 'public.ca_club_member_period_fee_totals(uuid,uuid[],date,timestamptz)'::regprocedure;
 v_old text; v_new text; v_metadata jsonb; v_generation text; v_seal text;
 v_semantics jsonb;
 v_accept CONSTANT text := $old$public.fn_ca_launch_accounting_accepts(ra.club_id,
    (SELECT rr.created_at FROM public.rake_records rr WHERE rr.id=ra.rake_record_id))$old$;
 v_cached CONSTANT text := $new$CASE WHEN b.cutoff IS NULL THEN true ELSE EXISTS(
    SELECT 1 FROM public.rake_records rr WHERE rr.id=ra.rake_record_id
     AND rr.created_at IS NOT NULL AND isfinite(rr.created_at) AND rr.created_at>=b.cutoff)END$new$;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
  OR nullif(current_setting('request.jwt.claims',true),'')IS NOT NULL
  OR nullif(current_setting('request.jwt.claim.role',true),'')IS NOT NULL
  OR nullif(current_setting('request.jwt.claim.sub',true),'')IS NOT NULL
 THEN RAISE EXCEPTION 'roster_fee_cutoff_operator_refused';END IF;
 IF public.fn_ca_break_window_refuses_migrations(now())IS NOT NULL
  OR public.fn_platform_frozen()IS DISTINCT FROM false
  OR public.fn_active_maintenance_release_boundary()IS NOT NULL
 THEN RAISE EXCEPTION 'roster_fee_cutoff_window_refused';END IF;
 v_generation:=smarter_private.original_inventory_basis_generation();
 v_seal:=pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure);
 IF v_generation IS NULL OR smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'roster_fee_cutoff_current_source_required';END IF;
 IF EXISTS(SELECT FROM(VALUES
  ('public.fn_ca_launch_accounting_cutoff(text,uuid)','cc3063873cf25be4b70e7cc893617c37','{postgres=X/postgres,service_role=X/postgres}'),
  ('public.fn_ca_launch_accounting_accepts(uuid,timestamptz)','0f902b31908c9b6634635c1fab7363c4','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')
 )x(signature,definition_md5,acl) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(x.signature)
 WHERE p.oid IS NULL OR p.proowner<>'postgres'::regrole OR md5(pg_get_functiondef(p.oid))IS DISTINCT FROM x.definition_md5 OR p.proacl::text IS DISTINCT FROM x.acl)
 THEN RAISE EXCEPTION 'roster_fee_cutoff_semantics_changed';END IF;
 SELECT jsonb_agg(to_jsonb(p)ORDER BY p.oid)INTO v_semantics FROM pg_proc p WHERE p.oid IN('public.fn_ca_launch_accounting_cutoff(text,uuid)'::regprocedure,'public.fn_ca_launch_accounting_accepts(uuid,timestamptz)'::regprocedure);
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO v_old,v_metadata FROM pg_proc p WHERE p.oid=v_oid;
 IF md5(v_old)<>'79889e997c09a52d8519b110bf0915b1'
  OR (v_metadata->>'proowner')::oid<>'postgres'::regrole
 THEN RAISE EXCEPTION 'roster_fee_cutoff_reader_changed';END IF;
 IF (length(v_old)-length(replace(v_old,v_accept,'')))/length(v_accept)<>2
 THEN RAISE EXCEPTION 'roster_fee_cutoff_exact_predicates_required';END IF;
 v_new:=replace(v_old,'), b AS ('||chr(10)||'  SELECT d,e,CASE',
  '), b AS MATERIALIZED ('||chr(10)||'  SELECT d,e,public.fn_ca_launch_accounting_cutoff(''club'',p_club_id) cutoff,CASE');
 IF v_new=v_old THEN RAISE EXCEPTION 'roster_fee_cutoff_exact_bounds_required';END IF;
 v_new:=replace(v_new,v_accept,v_cached);
 EXECUTE v_new;
 IF pg_get_functiondef(v_oid)IS DISTINCT FROM v_new
  OR (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=v_oid)IS DISTINCT FROM v_metadata
 THEN RAISE EXCEPTION 'roster_fee_cutoff_postimage_changed';END IF;
 IF(SELECT jsonb_agg(to_jsonb(p)ORDER BY p.oid)FROM pg_proc p WHERE p.oid IN('public.fn_ca_launch_accounting_cutoff(text,uuid)'::regprocedure,'public.fn_ca_launch_accounting_accepts(uuid,timestamptz)'::regprocedure))IS DISTINCT FROM v_semantics
 THEN RAISE EXCEPTION 'roster_fee_cutoff_semantics_changed';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true
  OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM v_generation
  OR pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure)IS DISTINCT FROM v_seal
 THEN RAISE EXCEPTION 'roster_fee_cutoff_original_source_changed';END IF;
END$guard$;
COMMIT;
