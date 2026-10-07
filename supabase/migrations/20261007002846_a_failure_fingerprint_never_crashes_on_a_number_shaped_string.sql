-- 20261007003000_a_failure_fingerprint_never_crashes_on_a_number_shaped_string.sql
--
-- WHAT HAPPENED (2026-10-06 from ~18:16 UTC): every weekly-close visit of
-- Midway Union and Deep Stack Society ended in the scheduler's catch with
-- 22003 "value overflows numeric format", rolling the whole visit back, so
-- neither book could record a result or move on (20+ visits each).
--
-- fn_accounting_failure_identity fingerprints a failed attempt's result so
-- the scheduler alerts only on a NEW failure. For each string it tries
-- (p_result#>>'{}')::jsonb to decode embedded JSON reports, and catches only
-- invalid_text_representation. A string that is a valid JSON number with an
-- exponent beyond numeric's range (e.g. '12e3456789', which an id or hash
-- fragment can be) raises 22003 instead, uncaught - turning a recorded
-- failure into a crash of the visit. Reproduced:
--   select fn_accounting_failure_identity('{"x":"12e3456789"}') -> 22003.
--
-- THE FIX: any data exception (class 22, which includes both) while trying
-- to decode keeps the string as ordinary text, exactly as a non-JSON string
-- already is. The fingerprint only decides whether to file an alert; no
-- money path reads it. Nothing else changes.

DO $mig$
DECLARE
 d text;
 o1 text := $o$EXCEPTION WHEN invalid_text_representation THEN RETURN p_result;END;$o$;
 n1 text := $n$EXCEPTION WHEN data_exception THEN RETURN p_result;END;$n$;
BEGIN
 d := pg_get_functiondef('public.fn_accounting_failure_identity(jsonb)'::regprocedure);
 IF (length(d)-length(replace(d,o1,'')))/length(o1) <> 1 THEN
  RAISE EXCEPTION 'failure identity edit does not match exactly once';
 END IF;
 EXECUTE replace(d,o1,n1);
END
$mig$;