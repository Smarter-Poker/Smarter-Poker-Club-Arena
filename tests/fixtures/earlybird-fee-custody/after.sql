BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$ DECLARE c record;state jsonb;message text;BEGIN
 SELECT * INTO c FROM earlybird_fee_fixture.cases;
 PERFORM earlybird_fee_fixture.assert((SELECT amount=2.70 AND source_count=27 AND source_fingerprint='aab06c68bd63b23b2b7340bd55f43e44' FROM public.fn_ca_legacy_fee_custody_cohort(c.tournament_id)), 'Exact new original fee tuple admitted');
 state:=earlybird_fee_fixture.snapshot(c.tournament_id);
 BEGIN PERFORM public.fn_ca_hold_legacy_tournament_fee(c.tournament_id,'tournament_fee_sources_require_reconciliation');
 EXCEPTION WHEN SQLSTATE 'P0404' THEN message:=SQLERRM; END;
 PERFORM earlybird_fee_fixture.assert(message='legacy fee custody requires exact unpaid named source and completed player banks' AND state=earlybird_fee_fixture.snapshot(c.tournament_id),'Direct custody cannot bypass canonical player-bank completion');
 PERFORM earlybird_fee_fixture.assert(NOT EXISTS(SELECT 1 FROM public.fn_ca_legacy_fee_custody_cohort('00000000-0000-0000-0000-000000000099')),'Unrelated event remains outside bounded cohort');
END $$;
-- These corruptions exist only in rolled-back, isolated fixture subtransactions.
SAVEPOINT raw_source;
UPDATE public.rake_records SET metadata=metadata||'{"native_original_mismatch":true}'::jsonb
 WHERE id=(SELECT min(id::text)::uuid FROM public.rake_records WHERE tournament_id='a5aa6984-6c1c-4b59-aeb7-9e7878853bdd');
DO $$ DECLARE c record;state jsonb;message text;BEGIN
 SELECT * INTO c FROM earlybird_fee_fixture.cases;
 PERFORM public.fn_claim_tournament_finish(c.tournament_id,c.winner_id,'earlybird-native-negative');
 state:=earlybird_fee_fixture.snapshot(c.tournament_id);
 BEGIN PERFORM public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places');
 EXCEPTION WHEN SQLSTATE 'P0404' THEN message:=SQLERRM; END;
 PERFORM earlybird_fee_fixture.assert(message='legacy fee custody original source identity changed' AND state=earlybird_fee_fixture.snapshot(c.tournament_id),'Changed original row refuses with every partial payout rolled back');
END $$;
ROLLBACK TO raw_source;
CREATE FUNCTION pg_temp.earlybird_late_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'earlybird native late custody fault' USING ERRCODE='P0041';END $$;
CREATE TRIGGER earlybird_native_late_fault BEFORE INSERT ON public.accounting_tournament_fee_custody_obligations
 FOR EACH ROW EXECUTE FUNCTION pg_temp.earlybird_late_fault();
DO $$ DECLARE c record;state jsonb;message text;BEGIN
 SELECT * INTO c FROM earlybird_fee_fixture.cases;
 PERFORM public.fn_claim_tournament_finish(c.tournament_id,c.winner_id,'earlybird-native');
 state:=earlybird_fee_fixture.snapshot(c.tournament_id);
 BEGIN PERFORM public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places');
 EXCEPTION WHEN SQLSTATE 'P0041' THEN message:=SQLERRM; END;
 PERFORM earlybird_fee_fixture.assert(message='earlybird native late custody fault' AND state=earlybird_fee_fixture.snapshot(c.tournament_id),'Late custody failure rolls back complete player payment and lifecycle');
END $$;
DROP TRIGGER earlybird_native_late_fault ON public.accounting_tournament_fee_custody_obligations;
DO $$ DECLARE c record;state jsonb;receipt jsonb;replay jsonb;message text;BEGIN
 SELECT * INTO c FROM earlybird_fee_fixture.cases;
 receipt:=public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places');
 PERFORM earlybird_fee_fixture.assert(receipt->>'ok'='true' AND receipt->>'player_result'='final'
  AND receipt->>'fully_settled'='false' AND receipt->>'accounting_complete'='false'
  AND receipt->>'accounting_state'='fee_custody_unresolved' AND receipt->>'receipt_version'='3'
  AND (receipt->>'cash_payout_total')::numeric=99.30 AND (receipt->>'bounty_payout_total')::numeric=0,
  'Real terminal pays99.30 and honestly reports unresolved original fee2.70');
 PERFORM earlybird_fee_fixture.assert((SELECT chip_balance=27.85 FROM public.club_members WHERE user_id=c.winner_id AND club_id='a0000000-0000-0000-0000-000000000001')
  AND (SELECT sum(m.chip_balance)=99.30 FROM public.club_members m JOIN public.tournament_players p ON p.user_id=m.user_id AND p.club_id=m.club_id WHERE p.tournament_id=c.tournament_id)
  AND (SELECT sum(amount)=99.30 FROM public.tournament_payouts WHERE tournament_id=c.tournament_id)
  AND (SELECT prize_balance=0 AND bounty_balance=0 AND fee_balance=2.70 AND fee_out=0 AND closed_at IS NULL FROM public.tournament_escrow WHERE tournament_id=c.tournament_id)
  AND (SELECT count(*)=1 AND sum(amount)=2.70 FROM public.accounting_tournament_fee_custody_obligations WHERE tournament_id=c.tournament_id)
  AND NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=c.tournament_id)
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=c.tournament_id)
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources WHERE tournament_id=c.tournament_id),
  'Exact player credit with no fee banking, earning capture or attribution');
 PERFORM earlybird_fee_fixture.assert((SELECT status='COMPLETED' FROM public.tournaments WHERE id=c.tournament_id)
  AND (SELECT status='closed' AND lifecycle='closed' FROM public.tables WHERE id=c.table_id)
  AND (SELECT bool_and(left_at IS NOT NULL) FROM public.table_seats WHERE table_id=c.table_id),
  'Terminal declares original winner, closes event and support table, releases the final seat');
 PERFORM earlybird_fee_fixture.assert((SELECT jsonb_agg(to_jsonb(r)-'terminal_closed_at' ORDER BY id) FROM public.rake_records r WHERE tournament_id=c.tournament_id)
  = (SELECT jsonb_agg(r-'terminal_closed_at' ORDER BY r->>'id') FROM earlybird_fee_fixture.original_fee_document d,jsonb_array_elements(d.document->'original_fees')r)
  AND (SELECT jsonb_agg(to_jsonb(r)-'terminal_closed_at' ORDER BY id) FROM public.tournament_refund_entitlements r WHERE tournament_id=c.tournament_id)
  = (SELECT jsonb_agg(r-'terminal_closed_at' ORDER BY r->>'id') FROM earlybird_fee_fixture.original_fee_document d,jsonb_array_elements(d.document->'original_funding')r),
  'All27 original fees and funding entitlements preserved exactly');
 PERFORM earlybird_fee_fixture.assert((SELECT count(*)=100 FROM public.tournament_players WHERE tournament_id=c.tournament_id)
  AND NOT EXISTS(SELECT 1 FROM earlybird_fee_fixture.paid d,jsonb_array_elements(d.document->'players')p
   JOIN public.tournament_players t ON t.id=(p->>'id')::uuid
   WHERE p->>'status'='eliminated' AND (t.position IS DISTINCT FROM (p->>'position')::integer OR t.prize IS DISTINCT FROM (p->>'prize')::numeric))
  AND (SELECT jsonb_agg(to_jsonb(k) ORDER BY key) FROM public.wallet_credit_idempotency k WHERE key LIKE 'tourney:'||c.tournament_id||':rebuy:%')
   =(SELECT document->'credit_keys' FROM earlybird_fee_fixture.credits),
  'All100 original players, prior nine cached awards and27 rebuy identities preserved');
 state:=earlybird_fee_fixture.snapshot(c.tournament_id);
 replay:=public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places');
 PERFORM earlybird_fee_fixture.assert(receipt=replay AND state=earlybird_fee_fixture.snapshot(c.tournament_id),'Duplicate completion has identical receipt and zero additional effects');
 BEGIN PERFORM public.fn_complete_tournament_terminal(c.tournament_id,md5('wrong-earlybird-winner')::uuid,'places');
 EXCEPTION WHEN SQLSTATE '40001' THEN message:=SQLERRM;END;
 PERFORM earlybird_fee_fixture.assert(message LIKE 'terminal replay parameters disagree%' AND state=earlybird_fee_fixture.snapshot(c.tournament_id),'Changed winner cannot reuse completed operation');
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'EARLYBIRD_NATIVE_RECEIPT='||public.fn_ca_tournament_terminal_receipt(tournament_id,winner_id)::text FROM earlybird_fee_fixture.cases;
COMMIT;
