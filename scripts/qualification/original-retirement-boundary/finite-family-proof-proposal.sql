-- Explicit original evidence families; unknown families and malformed proofs refuse.
CREATE OR REPLACE FUNCTION smarter_private.original_inventory_finite_family_proof(family text,witness jsonb,lo timestamptz,hi timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $body$
DECLARE p jsonb;
BEGIN
 IF witness IS NULL OR jsonb_typeof(witness) IS DISTINCT FROM 'object'
 OR lo IS DISTINCT FROM '2026-10-05 07:00:00Z'::timestamptz
 OR hi IS DISTINCT FROM '2026-10-12 07:00:00Z'::timestamptz THEN
 RETURN jsonb_build_object('status','blocked','reason','finite_original_interval_refused');END IF;
 CASE family
 WHEN 'paired_player' THEN
 p:=smarter_private.original_retirement_boundary_proof(witness,lo,hi);
 IF p->'ready' IS DISTINCT FROM 'true'::jsonb THEN RETURN p;END IF;
 p:=p||jsonb_build_object('status','ready');
 WHEN 'paired_chair' THEN p:=smarter_private.original_paired_seat_restoration_proof(witness->'chair',witness->'player',lo,hi);
 WHEN 'closed_player' THEN p:=smarter_private.original_closed_player_proof(witness,lo,hi);
 WHEN 'continued_chair' THEN p:=smarter_private.original_continued_chair_proof(witness,lo,hi);
 WHEN 'returned_cash' THEN p:=smarter_private.original_returned_cash_base_proof(witness,lo,hi);
 WHEN 'erased_cash_receivable' THEN p:=smarter_private.original_erased_cash_base_proof(witness,hi);
 ELSE RETURN jsonb_build_object('status','blocked','reason','unknown_original_proof_family');
 END CASE;
 IF p->>'status' IS DISTINCT FROM 'ready' OR p->'financial_admission' IS DISTINCT FROM 'false'::jsonb THEN
 RETURN jsonb_build_object('status','blocked','reason','original_proof_refused','proof',p);END IF;
 RETURN p;
END $body$;
ALTER FUNCTION smarter_private.original_inventory_finite_family_proof(text,jsonb,timestamptz,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_inventory_finite_family_proof(text,jsonb,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- Captured witness is usable only after every exact original source ref proves
-- COUNT1 and its independently captured digest; no missing-source default.
CREATE OR REPLACE FUNCTION smarter_private.original_inventory_finite_witness(p_event_id bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE c record;r jsonb;n integer;distinct_n integer;
BEGIN
 SELECT * INTO c FROM smarter_private.original_inventory_restoration_cases WHERE event_id=p_event_id;
 IF NOT FOUND OR c.original_witness IS NULL OR c.witness_md5 IS DISTINCT FROM md5(c.original_witness::text)
 OR jsonb_typeof(c.source_refs) IS DISTINCT FROM 'array' OR jsonb_array_length(c.source_refs)=0 THEN RETURN NULL;END IF;
 SELECT count(*),count(DISTINCT jsonb_build_array(x->>'kind',x->>'id',x->>'other_id')) INTO n,distinct_n FROM jsonb_array_elements(c.source_refs) x;
 IF n IS DISTINCT FROM distinct_n THEN RETURN NULL;END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(c.source_refs) LOOP
 IF r->>'md5' IS NULL OR r->>'md5' !~ '^[0-9a-f]{32}$'
 OR smarter_private.original_inventory_source_ref_md5(r) IS DISTINCT FROM r->>'md5' THEN RETURN NULL;END IF;
 END LOOP;
 RETURN c.original_witness;
END $body$;
ALTER FUNCTION smarter_private.original_inventory_finite_witness(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_inventory_finite_witness(bigint) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.original_erased_cash_base_request(p_event_id bigint,p_expected_hash text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $body$
DECLARE f jsonb;p jsonb;c record;
BEGIN
 SELECT * INTO c FROM smarter_private.original_inventory_restoration_cases WHERE event_id=p_event_id;
 IF NOT FOUND OR c.family IS DISTINCT FROM 'erased_cash_receivable'
 OR p_expected_hash IS NULL THEN
 RETURN jsonb_build_object('status','blocked','reason','unknown_or_changed_original_cash_request');END IF;
 f:=smarter_private.original_inventory_finite_witness(p_event_id);
 IF f IS NULL THEN
 RETURN jsonb_build_object('status','blocked','reason','original_cash_source_refused');END IF;
 f:=f-'original_table_scope'-'original_manifest_scope';
 IF md5(f::text) IS DISTINCT FROM p_expected_hash THEN
 RETURN jsonb_build_object('status','blocked','reason','original_cash_source_refused');END IF;
 p:=smarter_private.original_erased_cash_base_proof(f,'2026-10-12 07:00:00Z');
 IF p->>'status' IS DISTINCT FROM 'ready' OR p->'financial_admission' IS DISTINCT FROM 'false'::jsonb THEN RETURN p;END IF;
 RETURN jsonb_build_object('status','ready','financial_admission',false,'event_id',p_event_id,
 'case_witness_md5',c.witness_md5,'witness_md5',p_expected_hash,'witness',f,'proof',p,'proof_md5',md5(p::text));
END $body$;
ALTER FUNCTION smarter_private.original_erased_cash_base_request(bigint,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_erased_cash_base_request(bigint,text) FROM PUBLIC,anon,authenticated,service_role;
