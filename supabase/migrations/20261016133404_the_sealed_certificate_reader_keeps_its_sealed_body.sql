-- 20261016133338_the_sealed_certificate_reader_keeps_its_sealed_body.sql
--
-- Reserved as 20261016133338 by scripts/new-migration.mjs; renamed to the
-- version the Supabase MCP recorded when it was applied (20261016133404).
--
-- THE SEALED CERTIFICATE READER KEEPS ITS SEALED BODY (2026-10-16)
--
-- What happened. 20261016123337 rewrote ten weekly-close functions to read
-- fn_accounting_close_proof_lifetime() (72 hours) instead of a 12 hour
-- literal. One of them, fn_accounting_close_certificate, is one of the 40
-- proof sources sealed by md5 in
-- smarter_private.original_inventory_proof_sources_match() (pin
-- 7b4a5f4572a45db069b6058899614021). Its new body no longer matched the seal,
-- so smarter_private.original_inventory_basis_generation() returned NULL from
-- 12:33 UTC, every P&L certificate keyed to the generation stopped
-- qualifying, and fn_prepare_accounting_week fell back to re-proving the
-- whole week's original flow evidence live (measured: past 230 s, cancelled
-- inside fn_union_pnl_original_flow_evidence).
--
-- The fix. fn_accounting_close_certificate goes back to exactly its sealed
-- body (asserted by md5 before and after), and the generation comes back with
-- it. The other nine functions keep the 72 hour lifetime: the two-hour plan,
-- flow and settlement windows (accounting_close_partials) are the work that
-- took longer than 12 hours to prove, and no seal covers them. The six
-- combined certificates read through the sealed reader keep its 12 hours;
-- each is rebuilt from its 72 hour windows or in one bounded step. Changing
-- that reader belongs with a deliberate re-seal of the inventory proof
-- sources, not with this.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_close_certificate(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) = '7b4a5f4572a45db069b6058899614021')
-- @live-proof: (SELECT smarter_private.original_inventory_proof_sources_match())

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
