-- Historical original receivable at the unchanged closed Oct12 boundary.
-- Today's restoration/bank custody cannot remove this pre-discharge holding.
CREATE OR REPLACE FUNCTION smarter_private.original_erased_cash_receivables(p_union_id uuid,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $body$
DECLARE c record;f jsonb;p jsonb;held jsonb:='[]';n integer:=0;total numeric:=0;receipt jsonb;h text;owed numeric;
BEGIN
 IF p_union_id IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001'::uuid
 OR p_at IS NULL OR NOT isfinite(p_at) OR p_at<'2026-10-12 07:00:00Z'::timestamptz THEN
 RETURN jsonb_build_object('status','blocked','reason','finite_receivable_boundary_refused');END IF;
 FOR c IN SELECT k.* FROM smarter_private.original_inventory_restoration_cases k
 JOIN smarter_private.original_inventory_restoration_certificates z USING(event_id)
 WHERE k.family='erased_cash_receivable' AND z.boundary='2026-10-12 07:00:00Z'::timestamptz
 AND z.witness_md5=k.witness_md5 AND z.original_witness=k.original_witness AND z.proof_md5=md5(z.proof::text) LOOP
 f:=smarter_private.original_inventory_finite_witness(c.event_id);
 IF f IS NULL THEN RETURN jsonb_build_object('status','blocked','reason','original_receivable_source_refused');END IF;
 p:=smarter_private.original_erased_cash_base_proof(f,'2026-10-12 07:00:00Z');
 IF p->>'status' IS DISTINCT FROM 'ready' OR p->'financial_admission' IS DISTINCT FROM 'false'::jsonb
 OR f#>>'{original_table_scope,union_id}' IS DISTINCT FROM p_union_id::text
 OR f#>>'{original_manifest_scope,game_union_id}' IS DISTINCT FROM p_union_id::text
 OR f#>>'{original_manifest_scope,asset}' IS DISTINCT FROM 'chips'
 OR f#>'{original_manifest_scope,unit_scale}' IS DISTINCT FROM '2'::jsonb THEN
 RETURN jsonb_build_object('status','blocked','reason','original_receivable_proof_refused');END IF;
 n:=n+1;total:=total+(p->>'original_base')::numeric;
 owed:=(p->>'original_base')::numeric;
 IF p_at>'2026-10-12 07:00:00Z'::timestamptz THEN
  h:=md5((f-'original_table_scope'-'original_manifest_scope')::text);
  receipt:=smarter_private.original_erased_cash_base_discharge_receipt(c.event_id,h);
  IF receipt->>'status'='discharged' THEN
   IF receipt->>'discharged_at' IS NULL OR NOT isfinite((receipt->>'discharged_at')::timestamptz)
   OR receipt->>'custody' IS DISTINCT FROM 'canonical_deleted_account_bank'
   OR (receipt->>'amount')::numeric IS DISTINCT FROM owed
   OR receipt->>'occupancy_id' IS DISTINCT FROM f#>>'{event,before_row,occupancy_id}'
   OR (receipt->>'discharged_at')::timestamptz<='2026-10-12 07:00:00Z'::timestamptz THEN
    RETURN jsonb_build_object('status','blocked','reason','original_receivable_discharge_refused');END IF;
   IF (receipt->>'discharged_at')::timestamptz<p_at THEN owed:=0;END IF;
  ELSIF receipt->>'status' IS DISTINCT FROM 'pending' THEN
   RETURN jsonb_build_object('status','blocked','reason','original_receivable_discharge_unproven');
  END IF;
 END IF;
 IF owed>0 THEN held:=held||jsonb_build_array(jsonb_build_object('club_id',p#>'{holding,club_id}','user_id',p#>'{holding,user_id}',
 'amount',owed,'kind','original_erased_cash_receivable','source_id',f#>'{event,before_row,occupancy_id}',
 'original_event_id',c.event_id,'preserved_played_delta',p->'preserved_played_delta'));END IF;
 END LOOP;
 IF n IS DISTINCT FROM 7 OR total IS DISTINCT FROM 1845.87::numeric THEN
 RETURN jsonb_build_object('status','blocked','reason','finite_receivable_coverage_refused');END IF;
 RETURN jsonb_build_object('status','ready','holdings',held,'original_total',total,'held_total',(SELECT COALESCE(sum((x->>'amount')::numeric),0) FROM jsonb_array_elements(held)x),'financial_payment',false);
END $body$;
ALTER FUNCTION smarter_private.original_erased_cash_receivables(uuid,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_erased_cash_receivables(uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
