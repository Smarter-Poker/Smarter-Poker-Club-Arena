-- One fresh finite-source revalidation per report. Existing cache TTLs and
-- authoritative cache writers remain unchanged; old-generation values refuse.
CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation()
RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $body$
DECLARE r jsonb; receipt jsonb; c record; proofs text;source_hash text;source_count bigint;discharges jsonb:='[]';
BEGIN
 IF (SELECT count(*) FROM smarter_private.original_inventory_restoration_cases) IS DISTINCT FROM 245::bigint
 OR (SELECT count(*) FROM smarter_private.original_inventory_restoration_certificates WHERE boundary='2026-10-12 07:00:00Z') IS DISTINCT FROM 245::bigint
 OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RETURN NULL;END IF;
 -- Deduplicate shared original authorities; no 4x family source scan.
 FOR r IN SELECT DISTINCT x FROM smarter_private.original_inventory_restoration_cases k CROSS JOIN LATERAL jsonb_array_elements(k.source_refs)x LOOP
 IF r->>'md5' IS NULL OR smarter_private.original_inventory_source_ref_md5(r) IS DISTINCT FROM r->>'md5' THEN RETURN NULL;END IF;
 END LOOP;
 FOR c IN SELECT * FROM smarter_private.original_inventory_restoration_cases WHERE family='erased_cash_receivable' ORDER BY event_id LOOP
 receipt:=smarter_private.original_erased_cash_base_discharge_receipt(c.event_id,md5((c.original_witness-'original_table_scope'-'original_manifest_scope')::text));
 IF receipt->>'status' NOT IN('pending','discharged') OR receipt->>'status' IS NULL THEN RETURN NULL;END IF;
 discharges:=discharges||jsonb_build_array(jsonb_build_object('event_id',c.event_id,'receipt',receipt));
 END LOOP;
 SELECT md5(string_agg(event_id::text||':'||witness_md5||':'||proof_md5,'|' ORDER BY event_id)) INTO proofs
 FROM smarter_private.original_inventory_restoration_certificates WHERE boundary='2026-10-12 07:00:00Z';
 SELECT count(to_regprocedure(signature)),md5(string_agg(signature||':'||md5(pg_get_functiondef(to_regprocedure(signature))),'|' ORDER BY signature)) INTO source_count,source_hash FROM(VALUES ('public.fn_union_pnl_boundary(uuid,timestamptz)'),('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'),('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'),('smarter_private.original_inventory_basis_generation()'),('smarter_private.original_inventory_proof_sources_match()'))s(signature);
 IF source_count IS DISTINCT FROM 5::bigint OR source_hash IS NULL OR proofs IS NULL THEN RETURN NULL;END IF;
 RETURN 'original-inventory-245-v1:'||md5(source_hash||'|'||proofs||'|'||discharges::text);
END $body$;
ALTER FUNCTION smarter_private.original_inventory_basis_generation() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_inventory_basis_generation() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.inventory_basis_cache_read(p_generation text,p_problem boolean,p_kind text,p_union uuid,p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE v jsonb;
BEGIN
 IF p_generation='original-inventory-245:unqualified' THEN RETURN NULL;END IF;
 IF p_problem IS NULL OR p_kind NOT IN('pnl_boundary','pnl_flows','pnl_touched','pnl_clubs') OR p_kind IS NULL THEN RETURN NULL;END IF;
 IF p_problem THEN v:=public.fn_accounting_close_problem(p_kind,p_union,p_start,p_end);
 ELSE v:=public.fn_accounting_close_certificate(p_kind,p_union,p_start,p_end);END IF;
 IF p_generation IS NULL THEN RETURN v;END IF;
 IF v IS NULL OR v->>'_original_inventory_generation' IS DISTINCT FROM p_generation THEN RETURN NULL;END IF;
 RETURN v-'_original_inventory_generation';
END $body$;
ALTER FUNCTION smarter_private.inventory_basis_cache_read(text,boolean,text,uuid,timestamptz,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.inventory_basis_cache_read(text,boolean,text,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.inventory_basis_cache_write(p_generation text,p_kind text,p_union uuid,p_start timestamptz,p_end timestamptz,p_value jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,smarter_private AS $body$
BEGIN
 IF p_generation='original-inventory-245:unqualified' THEN RETURN;END IF;
 IF p_value IS NULL OR p_kind IS NULL
 OR p_kind NOT IN('pnl_boundary','pnl_flows','pnl_touched','pnl_clubs','pnl_boundary_problem','pnl_flows_problem','pnl_touched_problem','pnl_clubs_problem') THEN RETURN;END IF;
 PERFORM public.fn_accounting_close_certify(p_kind,p_union,p_start,p_end,CASE WHEN p_generation IS NULL THEN p_value ELSE p_value||jsonb_build_object('_original_inventory_generation',p_generation) END);
END $body$;
ALTER FUNCTION smarter_private.inventory_basis_cache_write(text,text,uuid,timestamptz,timestamptz,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.inventory_basis_cache_write(text,text,uuid,timestamptz,timestamptz,jsonb) FROM PUBLIC,anon,authenticated,service_role;
