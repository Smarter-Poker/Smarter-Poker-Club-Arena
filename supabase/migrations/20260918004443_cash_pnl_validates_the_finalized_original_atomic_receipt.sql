-- Inner accepted-hand evidence precedes canonical outer post-commit sealing.
-- Compare its immutable monetary core and validate the later original seal;
-- never reinterpret missing manifests or rewrite an already captured outcome.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preconditions$
DECLARE e record; a record;
BEGIN
 FOR e IN SELECT * FROM (VALUES
  ('fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)','8c0acda3b19e958ecd5bbbc07c845afe','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_pnl_cash_hand_evidence(uuid,bigint)','e8687e1a7ef4941af1841a815ac2f253','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_ca_process_hand_post_commit_obligations(uuid)','8d18dde12765610895b25e297a1f403f','{postgres=X/postgres,service_role=X/postgres}','postgres')
 ) v(signature,definition_md5,acl,owner_name) LOOP
  SELECT md5(pg_get_functiondef(p.oid)) definition_md5,p.proacl::text acl,pg_get_userbyid(p.proowner) owner_name INTO a
  FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||e.signature);
  IF NOT FOUND OR a.definition_md5 IS DISTINCT FROM e.definition_md5 OR a.acl IS DISTINCT FROM e.acl OR a.owner_name IS DISTINCT FROM e.owner_name THEN
   RAISE EXCEPTION 'original_atomic_receipt_authority_drift:%',e.signature USING ERRCODE='55000'; END IF;
 END LOOP;
END $preconditions$;

CREATE FUNCTION public.fn_cash_atomic_original_matches(p_original jsonb,p_live jsonb,p_request jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE mutable_keys text[]:=ARRAY['post_commit_payload','post_commit_request_hash','post_commit_payload_hash','post_commit_completed_at','post_commit_result'];
 payload jsonb; submitted jsonb; result jsonb; k text;
BEGIN
 IF jsonb_typeof(p_original) IS DISTINCT FROM 'object' OR jsonb_typeof(p_live) IS DISTINCT FROM 'object'
  OR (p_original-mutable_keys) IS DISTINCT FROM (p_live-mutable_keys) THEN RETURN false; END IF;
 -- The private inner core may have no outer obligations. Its original exact
 -- row remains admissible; the rest of the reader still proves all funding.
 IF p_live IS NOT DISTINCT FROM p_original THEN RETURN true; END IF;
 payload:=p_live->'post_commit_payload';
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR payload->>'version' IS DISTINCT FROM '1'
  OR encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM p_live->>'post_commit_payload_hash'
  OR jsonb_typeof(payload->'accepted_hand_facts') IS DISTINCT FROM 'object'
  OR payload->'accepted_hand_facts' IS DISTINCT FROM p_request#>'{hand_row,_accepted_post_commit_facts}' THEN RETURN false; END IF;
 -- These are the only two fields the outer owner adds to the received
 -- obligation request. Reconstruct that exact request, then check its seal.
 submitted:=payload-'accepted_hand_facts';
 IF jsonb_typeof(submitted->'pending_addons')='object' THEN
  IF jsonb_typeof(submitted#>'{pending_addons,ids}') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  submitted:=submitted#-'{pending_addons,ids}';
 END IF;
 IF encode(extensions.digest(convert_to(submitted::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM p_live->>'post_commit_request_hash' THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['post_commit_payload','post_commit_request_hash','post_commit_payload_hash','post_commit_completed_at','post_commit_result'] LOOP
  IF NULLIF(p_original->k,'null'::jsonb) IS NOT NULL AND p_original->k IS DISTINCT FROM p_live->k THEN RETURN false; END IF;
 END LOOP;
 -- The original processor may subsequently record completion. It cannot
 -- replace monetary identity, the sealed request or the sealed payload.
 result:=NULLIF(p_live->'post_commit_result','null'::jsonb);
 IF (p_live->>'post_commit_completed_at' IS NULL) IS DISTINCT FROM (result IS NULL) THEN RETURN false; END IF;
 IF result IS NOT NULL AND (jsonb_typeof(result) IS DISTINCT FROM 'object' OR result->>'ok' IS DISTINCT FROM 'true'
   OR result->>'hand_id' IS DISTINCT FROM p_original->>'hand_id' OR result->>'hand_number' IS DISTINCT FROM p_original->>'hand_number'
   OR NOT isfinite((p_live->>'post_commit_completed_at')::timestamptz)
   OR (p_live->>'post_commit_completed_at')::timestamptz<(p_original->>'committed_at')::timestamptz) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_atomic_original_matches(jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $reader$
DECLARE source text; needle text;
BEGIN
 source:=pg_get_functiondef('public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure);
 needle:='IF FOUND AND v_live_atomic IS DISTINCT FROM p.atomic_receipt THEN';
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'original_atomic_reader_comparison_changed'; END IF;
 EXECUTE replace(source,needle,'IF FOUND AND NOT public.fn_cash_atomic_original_matches(p.atomic_receipt,v_live_atomic,p.accepted_request) THEN');
END $reader$;
REVOKE ALL ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) TO service_role;
COMMIT;
