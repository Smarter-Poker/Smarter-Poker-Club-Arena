BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
CREATE FUNCTION pg_temp.fail_canonical_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.settled_at IS NOT NULL THEN RAISE EXCEPTION 'native final recognition fault' USING ERRCODE='P0042'; END IF;RETURN NEW;END $$;
CREATE TRIGGER native_final_recognition_fault AFTER UPDATE ON public.tournament_rake_settlements
 FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_canonical_resolution();
DO $$ DECLARE c record;state jsonb;message text;
BEGIN
 SELECT * INTO c FROM legacy_fee_fixture.cases WHERE tournament_id NOT IN(SELECT tournament_id FROM legacy_fee_fixture.pko_expected_sources) ORDER BY tournament_id LIMIT 1;
 state:=legacy_fee_fixture.snapshot(c.tournament_id);
 BEGIN PERFORM public.fn_settle_tournament_rake(c.tournament_id,'legacy-native-resolution-fault');
 EXCEPTION WHEN SQLSTATE 'P0042' THEN message:=SQLERRM; END;
 PERFORM legacy_fee_fixture.assert(message='native final recognition fault' AND state=legacy_fee_fixture.snapshot(c.tournament_id),
  'Late recognition fault rolls capture, bank, commissions and resolution back while original players stay final');
END $$;
DROP TRIGGER native_final_recognition_fault ON public.tournament_rake_settlements;
DO $$ DECLARE c record;state jsonb;original_header jsonb;original_payouts jsonb;original_players jsonb;result jsonb;receipt jsonb;
BEGIN
 FOR c IN SELECT * FROM legacy_fee_fixture.cases ORDER BY tournament_id LOOP
  SELECT to_jsonb(h) INTO original_header FROM public.tournament_terminal_settlements h WHERE tournament_id=c.tournament_id;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY id) INTO original_payouts FROM public.tournament_payouts p WHERE tournament_id=c.tournament_id;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY id) INTO original_players FROM public.tournament_players p WHERE tournament_id=c.tournament_id;
  result:=public.fn_settle_tournament_rake(c.tournament_id,'legacy-native-original-attribution');
  receipt:=public.fn_ca_tournament_terminal_receipt(c.tournament_id,c.winner_id);
  PERFORM legacy_fee_fixture.assert(result->>'ok'='true' AND receipt->>'receipt_version'='3'
   AND receipt->>'fully_settled'='true' AND receipt->>'accounting_complete'='true'
   AND receipt->>'accounting_state'='recognized' AND receipt->>'player_result'='final'
   AND receipt->'rake'->'accounting'->'resolution'->>'status'='recognized'
   AND (receipt->'rake'->'accounting'->'resolution'->>'bank_amount')::numeric=c.fee_amount
   AND (SELECT fee_balance=0 AND closed_at IS NULL FROM public.tournament_escrow WHERE tournament_id=c.tournament_id),
   'Existing capture and settlement resolve the exact held original fee '||c.tournament_id);
  PERFORM legacy_fee_fixture.assert(original_header=(SELECT to_jsonb(h) FROM public.tournament_terminal_settlements h WHERE tournament_id=c.tournament_id)
   AND original_payouts=(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.tournament_payouts p WHERE tournament_id=c.tournament_id)
   AND original_players=(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.tournament_players p WHERE tournament_id=c.tournament_id)
   AND (SELECT sum(amount)=c.fee_amount AND count(*)=1 FROM public.chip_ledger WHERE tournament_id=c.tournament_id AND category='burn')
   AND (SELECT sum(rake_credit)=c.fee_amount FROM public.accounting_tournament_recognized_sources WHERE tournament_id=c.tournament_id),
   'Resolution preserves immutable player results and counts one original fee disposition '||c.tournament_id);
  state:=legacy_fee_fixture.snapshot(c.tournament_id);
  result:=public.fn_settle_tournament_rake(c.tournament_id,'legacy-native-resolution-replay');
  PERFORM legacy_fee_fixture.assert(result->>'ok'='true' AND result->>'already_settled'='true'
   AND receipt=public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places')
   AND state=legacy_fee_fixture.snapshot(c.tournament_id),
   'Resolved fee and player terminal replay without any duplicate effect '||c.tournament_id);
 END LOOP;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'LEGACY_FEE_NATIVE_RESOLVED='||jsonb_agg(public.fn_ca_tournament_terminal_receipt(c.tournament_id,c.winner_id) ORDER BY c.tournament_id)::text FROM legacy_fee_fixture.cases c WHERE tournament_id NOT IN(SELECT tournament_id FROM legacy_fee_fixture.pko_expected_sources);
COMMIT;
