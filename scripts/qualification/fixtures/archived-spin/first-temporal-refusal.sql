\set ON_ERROR_STOP on
BEGIN READ ONLY;
DO $$ DECLARE message text; actual_scope jsonb; BEGIN
 IF session_user<>'fixture_bootstrap' OR current_database() !~ '^qual_spin_expiry_[0-9a-f]{32}$'
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 THEN RAISE EXCEPTION 'ARCHIVE_TEMPORAL_READ_BOUNDARY'; END IF;
 IF (SELECT starts_at FROM public.accounting_tournament_fee_cutover WHERE singleton)
 IS DISTINCT FROM '2026-09-17T18:24:02.831517+00:00'::timestamptz THEN
 RAISE EXCEPTION 'ARCHIVE_ORIGINAL_CUTOVER_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533') THEN RAISE EXCEPTION 'ARCHIVE_ORIGINAL_RECOGNIZED_SOURCE_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches WHERE rake_record_id IN(SELECT id FROM public.rake_records WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533')) THEN RAISE EXCEPTION 'ARCHIVE_ORIGINAL_CASH_ACCRUAL_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_mixed_cutover_spin_fee_proofs WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533' OR rake_record_id='6d13847d-cbe2-473c-94e5-34dad1ce3efb')
 OR public.fn_accounting_mixed_cutover_spin_proof_valid('6d13847d-cbe2-473c-94e5-34dad1ce3efb') IS DISTINCT FROM false THEN RAISE EXCEPTION 'ARCHIVE_ORIGINAL_MIXED_PROOF_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM public.tournament_bounty_chests WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533')
 OR EXISTS(SELECT 1 FROM public.tournament_bounty_awards WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533')
 OR EXISTS(SELECT 1 FROM public.tournament_guarantee_overlays WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533')
 OR EXISTS(SELECT 1 FROM public.tournament_bounty_award_recipients r JOIN public.tournament_bounty_awards a ON a.id=r.award_id WHERE a.tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533') THEN RAISE EXCEPTION 'ARCHIVE_ORIGINAL_TERMINAL_MARKER_WITNESS_CHANGED'; END IF;
 -- Actual recognition uses this transaction's week, not the September8 charge.
 -- These observed bounds expire and require a new authentic capture at rollover.
 IF transaction_timestamp()<'2026-09-28T07:00:00Z'::timestamptz
 OR transaction_timestamp()>='2026-10-05T07:00:00Z'::timestamptz
 OR public.fn_union_week_start(transaction_timestamp()) IS DISTINCT FROM '2026-09-28T07:00:00Z'::timestamptz
 THEN RAISE EXCEPTION 'ARCHIVE_RECOGNITION_PERIOD_CAPTURE_EXPIRED'; END IF;
 WITH scopes AS (
 SELECT coordinator_union_id,club_id FROM public.accounting_tournament_fee_sources WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533'
 UNION SELECT f.union_id,t.club_id FROM public.tournaments t JOIN public.accounting_tournament_fee_sources f ON f.tournament_id=t.id WHERE t.id='2aa4cba1-506f-426b-a1ba-d8e22e018533' AND t.club_id IS NOT NULL
 UNION SELECT CASE WHEN t.is_private THEN NULL ELSE t.union_id END,t.club_id FROM public.tournaments t WHERE t.id='2aa4cba1-506f-426b-a1ba-d8e22e018533' AND t.club_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f WHERE f.tournament_id=t.id)
 ) SELECT jsonb_agg(to_jsonb(s) ORDER BY coordinator_union_id,club_id) INTO actual_scope FROM scopes s;
 IF actual_scope IS DISTINCT FROM '[{"club_id":"fade0000-0000-0000-0000-000000000001","coordinator_union_id":"fade0000-0000-0000-0000-000000000001"}]'::jsonb
 OR EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.union_id='fade0000-0000-0000-0000-000000000001' AND r.period_start<'2026-10-05T07:00:00Z'::timestamptz AND r.period_end>'2026-09-28T07:00:00Z'::timestamptz)
 THEN RAISE EXCEPTION 'ARCHIVE_RECOGNITION_PERIOD_STATE_CHANGED'; END IF;
 BEGIN
 PERFORM public.fn_accounting_earning_contract('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
 '036f0b55-c601-4d09-982a-5294cf4ea15d',8,'fade0000-0000-0000-0000-000000000001',
 '2026-09-08T14:45:08.753219+00:00');
 RAISE EXCEPTION 'ARCHIVE_MISSING_ORIGINAL_TERMS_ACCEPTED';
 EXCEPTION WHEN check_violation THEN
 GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
 IF message<>'cash_commission_earning_club_not_observed' THEN RAISE; END IF;
 END;
END $$;
SELECT jsonb_build_object('stage','original_fee_terms_refusal','reason','cash_commission_earning_club_not_observed','financial_qualified',false);
ROLLBACK;
