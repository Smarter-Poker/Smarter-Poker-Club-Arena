-- PROPOSAL: not yet installed, submitted, or qualified as financial admission.
-- Raw population/as_of/state readers and their sealed hashes remain unchanged.
CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_as_of_admitted(p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE raw jsonb; remaining jsonb; admitted jsonb;n integer;unique_n integer;h record;current_header record;
BEGIN
 IF p_at IS NULL OR NOT isfinite(p_at) OR p_at<>public.fn_union_week_start(p_at) OR p_at>clock_timestamp() THEN
 RETURN jsonb_build_object('status','blocked','reason','closed_original_week_boundary_required');END IF;
 raw:=public.fn_union_pnl_inventory_as_of(p_at);
 -- Missing coverage or an unknown original result is never an empty issue list.
 IF raw IS NULL OR jsonb_typeof(raw) IS DISTINCT FROM 'object'
 OR raw->>'status' NOT IN('observed','blocked') OR raw->>'status' IS NULL
 OR jsonb_typeof(raw->'issues') IS DISTINCT FROM 'array'
 OR jsonb_typeof(raw->'population') IS DISTINCT FROM 'object'
 OR (raw->>'status'='blocked' AND raw->'issues'='[]'::jsonb)
 OR (raw->>'status'='observed' AND raw->'issues'<>'[]'::jsonb)
 OR raw ? 'reason'
 OR raw->'inventory_version' IS DISTINCT FROM '1'::jsonb
 OR raw->'current_state_used' IS DISTINCT FROM 'false'::jsonb
 OR raw->'financial_basis_certified' IS DISTINCT FROM 'false'::jsonb
 OR (raw->>'boundary')::timestamptz IS DISTINCT FROM p_at
 OR nullif(raw->>'capture_started_at','') IS NULL
 OR raw->>'coverage' IS DISTINCT FROM 'Original active population and later captured transitions; monetary funding and obligation receipts must independently certify equity.' THEN
  RETURN (CASE WHEN jsonb_typeof(raw)='object' THEN raw ELSE '{}'::jsonb END)||jsonb_build_object('status','blocked',
   'admission_status','original_inventory_shape_unproven','financial_basis_certified',false);
 END IF;
 -- A duplicate issue tuple is never two independent original authorities.
 SELECT count(*),count(DISTINCT jsonb_build_array(x->>'source_name',x->>'row_id',x->>'source_event_id'))
 INTO n,unique_n FROM jsonb_array_elements(raw->'issues')x;
 IF n IS DISTINCT FROM unique_n THEN RETURN raw||jsonb_build_object('status','blocked','admission_status','duplicate_original_issue_refused');END IF;
 -- Verify the active raw projection against its immutable original sealed
 -- header. This also rejects a forged warm temp-cache population.
 IF p_at>='2026-10-12 07:00:00Z'::timestamptz THEN
 SELECT * INTO current_header FROM public.union_pnl_inventory_checkpoints WHERE boundary=p_at;
 IF NOT FOUND OR current_header.result_md5 IS NULL
 OR md5(jsonb_build_object('population',raw->'population','issues',raw->'issues')::text) IS DISTINCT FROM current_header.result_md5
 OR (p_at='2026-10-12 07:00:00Z'::timestamptz AND current_header.result_md5 IS DISTINCT FROM 'dd5e733acc7ed72e69b98d009ac124a6') THEN
 RETURN raw||jsonb_build_object('status','blocked','admission_status','raw_sealed_projection_or_cache_refused');END IF;END IF;
 -- Observed original results require no admission and are returned byte-identical.
 IF raw->>'status'='observed' THEN RETURN raw;END IF;
 SELECT * INTO h FROM public.union_pnl_inventory_checkpoints WHERE boundary='2026-10-12 07:00:00Z'::timestamptz;
 IF NOT FOUND OR p_at<'2026-10-12 07:00:00Z'::timestamptz
 OR h.base_boundary IS DISTINCT FROM '2026-10-05 07:00:00Z'::timestamptz
 OR h.max_event_id IS DISTINCT FROM 63116879::bigint OR h.row_count IS DISTINCT FROM 3352453::bigint
 OR h.issue_count IS DISTINCT FROM 245::bigint OR n>245
 OR (p_at='2026-10-12 07:00:00Z'::timestamptz AND n IS DISTINCT FROM 245)
 OR h.rows_md5 IS DISTINCT FROM '5ae24d37326afb43bf598385c2ce24c5'
 OR h.issues_md5 IS DISTINCT FROM '9492245970312d6ac027287a5126c114'
 OR h.result_md5 IS DISTINCT FROM 'dd5e733acc7ed72e69b98d009ac124a6'
 OR h.sealed_at IS DISTINCT FROM '2026-10-12 11:40:53.278694Z'::timestamptz
 OR (SELECT count(*) FROM smarter_private.original_inventory_restoration_cases) IS DISTINCT FROM 245::bigint
 OR (SELECT count(*) FROM smarter_private.original_inventory_restoration_certificates WHERE boundary='2026-10-12 07:00:00Z'::timestamptz) IS DISTINCT FROM 245::bigint
 THEN RETURN raw||jsonb_build_object('status','blocked','admission_status','exact_original_sealed_coverage_refused');END IF;
 SELECT COALESCE(jsonb_agg(i.issue ORDER BY i.ord) FILTER(WHERE NOT i.accepted),'[]'::jsonb),
        COALESCE(jsonb_agg(i.issue ORDER BY i.ord) FILTER(WHERE i.accepted),'[]'::jsonb)
 INTO remaining,admitted
 FROM(SELECT x.issue,x.ord,
   smarter_private.inventory_restoration_issue_accepted(x.issue,p_at) IS TRUE accepted
   FROM jsonb_array_elements(raw->'issues') WITH ORDINALITY x(issue,ord)) i;
 RETURN raw||jsonb_build_object(
  'status',CASE WHEN remaining='[]'::jsonb THEN 'observed' ELSE 'blocked' END,
  'issues',remaining,'retained_original_inventory_issues',raw->'issues',
  'admitted_original_inventory_issues',admitted,
  'raw_inventory_as_of_result_md5',md5(raw::text),'raw_inventory_status',raw->>'status',
  'admission_basis','Exact immutable original restoration boundary certificates; original population untouched',
  'financial_basis_certified',false);
END $body$;
ALTER FUNCTION public.fn_union_pnl_inventory_as_of_admitted(timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_as_of_admitted(timestamptz) FROM PUBLIC,anon,authenticated,service_role;
-- Original fn_union_pnl_boundary is SECURITY DEFINER owned by postgres.
-- Proposed exact single callsite replacement, after its original body MD5 guard:
-- OLD inv:=public.fn_union_pnl_inventory_as_of(p_at);
-- NEW inv:=public.fn_union_pnl_inventory_as_of_admitted(p_at);
-- All original funding/return/holdings equations and rejection branches stay.
