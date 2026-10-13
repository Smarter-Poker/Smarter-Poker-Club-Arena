CREATE SCHEMA smarter_private;
CREATE TABLE smarter_private.horse_cash_payload_certificates(table_id uuid,
hand_number bigint,
hand_id uuid,
manifest_id uuid,
original_request_sha256 text,
original_atomic_sha256 text,
compact_request_sha256 text,
compact_atomic_sha256 text,
immutable_financial_sha256 text,
live_atomic_sha256 text,
accounting_evidence_sha256 text,
accepted_at timestamp with time zone,
settled_at timestamp with time zone,
compacted_at timestamp with time zone);
CREATE TABLE smarter_private.horse_cash_postprune_certificates(table_id uuid,
hand_number bigint,
hand_id uuid,
manifest_id uuid,
original_request_sha256 text,
original_atomic_sha256 text,
compact_request_sha256 text,
compact_atomic_sha256 text,
immutable_financial_sha256 text,
accounting_evidence_sha256 text,
original_boundary_sha256 text,
accepted_at timestamp with time zone,
settled_at timestamp with time zone,
compacted_at timestamp with time zone);
CREATE OR REPLACE FUNCTION smarter_private.horse_cash_retained_request_matches(p_table uuid, p_number bigint, p_hash text, p_request jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE c smarter_private.horse_cash_payload_certificates; p public.cash_hand_provenance_receipts; retained smarter_private.horse_cash_postprune_certificates;
BEGIN
 SELECT * INTO c FROM smarter_private.horse_cash_payload_certificates WHERE table_id=p_table AND hand_number=p_number;
 IF NOT FOUND THEN
  SELECT * INTO retained FROM smarter_private.horse_cash_postprune_certificates WHERE table_id=p_table AND hand_number=p_number;
  IF NOT FOUND THEN RETURN encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex') IS NOT DISTINCT FROM p_hash; END IF;
  SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table AND hand_number=p_number;
  RETURN FOUND AND (p.hand_id,p.manifest_id,p.accepted_at,p.payload_hash) IS NOT DISTINCT FROM
   (retained.hand_id,retained.manifest_id,retained.accepted_at,retained.original_request_sha256)
   AND p_hash=retained.original_request_sha256 AND p.accepted_request IS NOT DISTINCT FROM p_request
   AND encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex')=retained.compact_request_sha256
   AND encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex')=retained.compact_atomic_sha256
   AND encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex')=retained.immutable_financial_sha256;
 END IF;
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table AND hand_number=p_number;
 RETURN FOUND AND p.hand_id=c.hand_id AND p.manifest_id=c.manifest_id AND p.accepted_at=c.accepted_at
 AND p_hash=c.original_request_sha256 AND p.payload_hash=p_hash
 AND p.accepted_request IS NOT DISTINCT FROM p_request
 AND encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex')=c.compact_request_sha256
 AND encode(extensions.digest(convert_to(p.atomic_receipt::text,'UTF8'),'sha256'),'hex')=c.compact_atomic_sha256
 AND encode(extensions.digest(convert_to((to_jsonb(p)-ARRAY['accepted_request','atomic_receipt','accepted_at'])::text,'UTF8'),'sha256'),'hex')=c.immutable_financial_sha256;
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_signed_retained_request_matches(p_table uuid, p_number bigint, p_hash text, p_request jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
 SELECT p_table IS NOT NULL AND p_number IS NOT NULL AND p_hash IS NOT NULL AND p_request IS NOT NULL
 AND EXISTS(SELECT 1 FROM public.cash_hand_provenance_receipts p WHERE p.table_id=p_table AND p.hand_number=p_number
  AND p.payload_hash IS NOT DISTINCT FROM p_hash AND p.accepted_request IS NOT DISTINCT FROM p_request
  AND smarter_private.horse_cash_retained_request_matches(p_table,p_number,p_hash,p_request))
$function$
;
REVOKE ALL ON FUNCTION public.fn_cash_signed_retained_request_matches(uuid,bigint,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cash_signed_retained_request_matches(uuid,bigint,text,jsonb) TO service_role;
REVOKE ALL ON FUNCTION smarter_private.horse_cash_retained_request_matches(uuid,bigint,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;


ALTER TABLE smarter_private.horse_cash_payload_certificates ADD PRIMARY KEY(table_id,hand_number);
ALTER TABLE smarter_private.horse_cash_postprune_certificates ADD PRIMARY KEY(table_id,hand_number);
