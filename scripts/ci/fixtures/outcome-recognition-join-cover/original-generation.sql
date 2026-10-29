CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE r jsonb; receipt jsonb; c record; proofs text;source_hash text;source_count bigint;discharges jsonb:='[]';treasury text;tw record;tp jsonb;
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
 -- A newly admitted original treasury witness is a new proof input. Old
 -- derived blocked parts must be recomputed by their existing generation owner.
 FOR tw IN SELECT ledger_id,kind FROM smarter_private.original_treasury_historical_admissions ORDER BY ledger_id LOOP
  tp:=CASE tw.kind WHEN 'gift' THEN smarter_private.original_treasury_gift_evidence(tw.ledger_id)
   WHEN 'return' THEN smarter_private.original_treasury_return_evidence(tw.ledger_id) END;
  IF tp->>'status' IS DISTINCT FROM 'proven' THEN RETURN NULL;END IF;
 END LOOP;
 SELECT md5(COALESCE(string_agg(ledger_id::text||':'||kind||':'||source_fingerprint,'|' ORDER BY ledger_id),'no-original-treasury-witnesses')) INTO treasury
 FROM smarter_private.original_treasury_historical_admissions;
 RETURN 'original-inventory-245-v1:'||md5(source_hash||'|'||proofs||'|'||discharges::text||'|'||treasury);
END $function$
;
