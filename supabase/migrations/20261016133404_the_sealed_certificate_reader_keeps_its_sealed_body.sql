BEGIN;
SET LOCAL lock_timeout = '5s';

DO $restore$
DECLARE
  sig constant text := 'public.fn_accounting_close_certificate(text,uuid,timestamp with time zone,timestamp with time zone)';
  d text := pg_get_functiondef(sig::regprocedure);
  restored text;
BEGIN
  IF md5(d) = '7b4a5f4572a45db069b6058899614021' THEN
    RETURN;
  END IF;
  IF (length(d) - length(replace(d, 'clock_timestamp()-public.fn_accounting_close_proof_lifetime()', '')))
     / length('clock_timestamp()-public.fn_accounting_close_proof_lifetime()') <> 1 THEN
    RAISE EXCEPTION 'fn_accounting_close_certificate is not the 20261016123337 body';
  END IF;
  restored := replace(d, 'clock_timestamp()-public.fn_accounting_close_proof_lifetime()', 'clock_timestamp()-interval ''12 hours''');
  IF md5(restored) <> '7b4a5f4572a45db069b6058899614021' THEN
    RAISE EXCEPTION 'The restored body does not match the sealed md5';
  END IF;
  EXECUTE restored;
  IF md5(pg_get_functiondef(sig::regprocedure)) <> '7b4a5f4572a45db069b6058899614021' THEN
    RAISE EXCEPTION 'fn_accounting_close_certificate did not return to its sealed body';
  END IF;
  IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'The inventory proof sources still do not match their seal';
  END IF;
END
$restore$;

COMMIT;