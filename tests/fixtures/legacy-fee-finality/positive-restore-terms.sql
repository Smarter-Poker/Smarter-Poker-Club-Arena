-- Restore EXACT LOCAL SYNTHETIC observations saved before player completion.
-- This never backdates a production agreement and creates no canonical source.
BEGIN;
SELECT legacy_fee_fixture.assert(inet_server_addr() IS NULL
 AND (SELECT count(*)=5 FROM public.tournament_terminal_settlements h JOIN legacy_fee_fixture.cases c USING(tournament_id)
  WHERE h.receipt_version=3 AND h.accounting_state='fee_custody_unresolved' AND h.tournament_id NOT IN(SELECT tournament_id FROM legacy_fee_fixture.pko_expected_sources)),
 'Original local terms are restored only after all five actual player terminals');
SET LOCAL session_replication_role=replica;
INSERT INTO public.accounting_agreement_history
 SELECT (jsonb_populate_record(NULL::public.accounting_agreement_history,d.document)).*
 FROM legacy_fee_fixture.original_local_terms d;
SET LOCAL session_replication_role=origin;
COMMIT;
SELECT legacy_fee_fixture.assert(NOT EXISTS(SELECT 1 FROM legacy_fee_fixture.original_local_terms d
 LEFT JOIN public.accounting_agreement_history h ON h.id=d.id
 WHERE to_jsonb(h) IS DISTINCT FROM d.document)
 AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b JOIN legacy_fee_fixture.cases c USING(tournament_id) WHERE b.tournament_id NOT IN(SELECT tournament_id FROM legacy_fee_fixture.pko_expected_sources))
 AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s JOIN legacy_fee_fixture.cases c USING(tournament_id) WHERE s.tournament_id NOT IN(SELECT tournament_id FROM legacy_fee_fixture.pko_expected_sources))
 AND current_setting('session_replication_role')='origin',
 'Original local observations are restored byte-for-byte; actual capture remains the sole source producer');
