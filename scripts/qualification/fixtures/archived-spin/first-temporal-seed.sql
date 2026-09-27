\set ON_ERROR_STOP on
-- Authentic cutoff singleton and original-time empty agreement projection.
-- Seed before any trigger exists; no history is fabricated or backdated.
BEGIN;
DO $$ BEGIN
 IF session_user<>'fixture_bootstrap' OR current_user<>'fixture_bootstrap'
 OR current_database() !~ '^qual_spin_expiry_[0-9a-f]{32}$'
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal)
 OR EXISTS(SELECT 1 FROM public.accounting_agreement_history)
 OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_cutover)
 THEN RAISE EXCEPTION 'ARCHIVE_TEMPORAL_PRE_TRIGGER_BOUNDARY'; END IF;
END $$;
INSERT INTO public.accounting_tournament_fee_cutover(singleton,starts_at)
 VALUES(true,'2026-09-17T18:24:02.831517+00:00');
COMMIT;
