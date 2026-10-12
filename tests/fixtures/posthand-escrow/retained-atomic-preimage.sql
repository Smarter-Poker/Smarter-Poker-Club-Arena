CREATE OR REPLACE FUNCTION smarter_private.horse_cash_retained_atomic_matches(p_table uuid, p_number bigint, p_original jsonb, p_live jsonb, p_request jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE c smarter_private.horse_cash_payload_certificates;
BEGIN
 IF EXISTS(SELECT 1 FROM smarter_private.horse_cash_postprune_certificates WHERE table_id=p_table AND hand_number=p_number) THEN RETURN false; END IF;
 SELECT * INTO c FROM smarter_private.horse_cash_payload_certificates WHERE table_id=p_table AND hand_number=p_number;
 IF NOT FOUND THEN RETURN public.fn_cash_atomic_original_matches(p_original,p_live,p_request); END IF;
 RETURN smarter_private.horse_cash_retained_request_matches(p_table,p_number,c.original_request_sha256,p_request)
 AND encode(extensions.digest(convert_to(p_original::text,'UTF8'),'sha256'),'hex')=c.compact_atomic_sha256
 AND encode(extensions.digest(convert_to(p_live::text,'UTF8'),'sha256'),'hex')=c.live_atomic_sha256;
END $function$
;
