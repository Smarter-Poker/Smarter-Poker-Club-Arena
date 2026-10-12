
CREATE TABLE smarter_private.horse_settlement_key_certificates(table_id uuid,
stack_hand_id uuid,
hand_number bigint,
history_hand_id uuid,
manifest_id uuid,
original_result_sha256 text,
original_request_sha256 text,
compact_result jsonb,
accounting_evidence_sha256 text,
settled_at timestamp with time zone,
compacted_at timestamp with time zone);
CREATE OR REPLACE FUNCTION smarter_private.horse_settlement_original_result(p_table uuid, p_stack_hand uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE cert smarter_private.horse_settlement_key_certificates; original jsonb;
BEGIN
 SELECT * INTO cert FROM smarter_private.horse_settlement_key_certificates
 WHERE table_id=p_table AND stack_hand_id=p_stack_hand;
 IF NOT FOUND THEN RETURN p_result; END IF;
 SELECT p.atomic_receipt->'stack_result' INTO original FROM public.cash_hand_provenance_receipts p
 WHERE p.table_id=cert.table_id AND p.hand_number=cert.hand_number AND p.hand_id=cert.history_hand_id
 AND p.manifest_id=cert.manifest_id;
 IF p_result IS DISTINCT FROM cert.compact_result OR original IS NULL
 OR encode(extensions.digest(convert_to(original::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM cert.original_result_sha256
 OR encode(extensions.digest(convert_to((original->'request')::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM cert.original_request_sha256
 OR original-'request' IS DISTINCT FROM cert.compact_result THEN
  RAISE EXCEPTION 'HORSE_SETTLEMENT_COMPACT_ORIGINAL_CONFLICT' USING ERRCODE='55000'; END IF;
 RETURN original;
END $function$
;
REVOKE ALL ON FUNCTION smarter_private.horse_settlement_original_result(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;


ALTER TABLE smarter_private.horse_settlement_key_certificates ADD PRIMARY KEY(table_id,stack_hand_id),ADD UNIQUE(table_id,hand_number);
