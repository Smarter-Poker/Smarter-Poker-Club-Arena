-- A retained 18-event fee operation has 182 original rake records. Capture
-- revalidated the complete tournament for every record, although its immutable
-- admission was created after full validation in this same locked transaction.
-- Reuse that exact admission during capture. Full validation before admission
-- and the deferred same-transaction resolution/bank/final-receipt checks remain.
-- No fee, prize, destination, transaction boundary or timeout changes.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$
DECLARE expected record;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('public.fn_ca_legacy_fee_capture_admitted(uuid)','81f9c4d298c05b5a226dcd179d2e46f7'),
  ('public.fn_ca_begin_legacy_fee_resolution(uuid)','bdcedd8acbf81c2f925d390d825d422c'),
  ('public.fn_ca_legacy_fee_capture_requires_resolution()','f734e98537abaae01809f7d12f68e61c'),
  ('public.fn_ca_legacy_fee_resolution_requires_recognition()','5cacfa2b62b7ecbea69725a8486ae635')
 ) e(identity,definition_md5) LOOP
  IF md5(pg_get_functiondef(expected.identity::regprocedure)) IS DISTINCT FROM expected.definition_md5
   OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=expected.identity::regprocedure) IS DISTINCT FROM 'postgres'
   OR (SELECT proacl::text FROM pg_proc WHERE oid=expected.identity::regprocedure) IS DISTINCT FROM '{postgres=X/postgres}' THEN
   RAISE EXCEPTION 'legacy fee capture admission prerequisite changed: %',expected.identity USING ERRCODE='55000';
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.accounting_tournament_fee_custody_capture_admissions'::regclass
   AND tgname='legacy_fee_capture_requires_resolution' AND tgenabled='O' AND tgdeferrable AND tginitdeferred
   AND tgfoid='public.fn_ca_legacy_fee_capture_requires_resolution()'::regprocedure)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.accounting_tournament_fee_custody_resolutions'::regclass
   AND tgname='legacy_fee_resolution_requires_recognition' AND tgenabled='O' AND tgdeferrable AND tginitdeferred
   AND tgfoid='public.fn_ca_legacy_fee_resolution_requires_recognition()'::regprocedure)
  OR EXISTS(SELECT 1 FROM (VALUES('anon'),('authenticated'),('service_role')) roles(name)
   WHERE has_table_privilege(roles.name,'public.accounting_tournament_fee_custody_capture_admissions','INSERT,UPDATE,DELETE')) THEN
  RAISE EXCEPTION 'legacy fee capture admission transaction safeguards changed' USING ERRCODE='55000';
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_ca_legacy_fee_capture_admitted(p_tournament_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $fn$
BEGIN
 -- The sole admission writer fully validates the terminal receipt while
 -- owning the event/escrow and settlement lanes. Only that same transaction
 -- can reuse it. Deferred constraints require its exact resolution and the
 -- full final terminal receipt before anything can commit.
 RETURN EXISTS(
  SELECT 1 FROM public.accounting_tournament_fee_custody_capture_admissions a
  JOIN public.accounting_tournament_fee_custody_obligations o
   ON o.tournament_id=a.tournament_id AND o.id=a.obligation_id
  JOIN public.tournament_terminal_settlements h ON h.tournament_id=a.tournament_id
  WHERE a.tournament_id=p_tournament_id AND a.transaction_id=txid_current()
   AND a.source_fingerprint=o.source_fingerprint AND a.amount=o.amount
   AND h.receipt_version=3 AND h.accounting_state='fee_custody_unresolved'
   AND h.rake_amount=o.amount
   AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions r WHERE r.tournament_id=a.tournament_id)
   AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions r WHERE r.tournament_id=a.tournament_id)
 );
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_capture_admitted(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
