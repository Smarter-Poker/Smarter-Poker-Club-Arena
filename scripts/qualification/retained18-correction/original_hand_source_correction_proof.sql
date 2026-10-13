CREATE OR REPLACE FUNCTION smarter_private.original_hand_source_correction_proof(e uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE proof jsonb;
BEGIN
 proof:=smarter_private.original_tournament30_source_correction_proof(e);
 IF proof IS NOT NULL THEN RETURN proof;END IF;
 RETURN smarter_private.cash_original17_source_correction_proof(e);
END $function$;
