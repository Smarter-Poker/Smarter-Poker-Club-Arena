CREATE OR REPLACE FUNCTION public.fn_cash_atomic_original_matches(p_original jsonb, p_live jsonb, p_request jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$
;
