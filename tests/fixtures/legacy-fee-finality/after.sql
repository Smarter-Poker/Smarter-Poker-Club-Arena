BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
CREATE FUNCTION pg_temp.fail_custody_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'native custody insertion fault' USING ERRCODE='P0041'; END $$;
CREATE TRIGGER native_custody_insertion_fault BEFORE INSERT ON public.accounting_tournament_fee_custody_obligations
 FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_custody_receipt();
DO $$ DECLARE c record;state jsonb;message text;result jsonb;
BEGIN
 FOR c IN SELECT * FROM legacy_fee_fixture.cases ORDER BY tournament_id LOOP
  result:=public.fn_claim_tournament_finish(c.tournament_id,c.winner_id,'legacy-fee-native');
  PERFORM legacy_fee_fixture.assert(result->>'ok'='true','Original winner claim with custody contract '||c.tournament_id);
  state:=legacy_fee_fixture.snapshot(c.tournament_id);message:=NULL;
  BEGIN PERFORM public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places');
  EXCEPTION WHEN SQLSTATE 'P0041' THEN message:=SQLERRM; END;
  PERFORM legacy_fee_fixture.assert(message='native custody insertion fault' AND state=legacy_fee_fixture.snapshot(c.tournament_id),
   'Fault after actual player payer rolls all effects back '||c.tournament_id);
 END LOOP;
END $$;
DROP TRIGGER native_custody_insertion_fault ON public.accounting_tournament_fee_custody_obligations;
DO $$ DECLARE c record;state jsonb;receipt jsonb;replay jsonb;quality jsonb;message text;
BEGIN
 FOR c IN SELECT * FROM legacy_fee_fixture.cases ORDER BY tournament_id LOOP
  receipt:=public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places');
  PERFORM legacy_fee_fixture.assert(receipt->>'ok'='true' AND receipt->>'player_result'='final'
   AND receipt->>'fully_settled'='false' AND receipt->>'accounting_complete'='false'
   AND receipt->>'accounting_state'='fee_custody_unresolved' AND (receipt->>'receipt_version')::integer=3
   AND (receipt->>'cash_payout_total')::numeric=c.prize_amount
   AND (receipt->>'bounty_payout_total')::numeric=c.bounty_amount,
   'Original terminal pays player once and reports unresolved accounting '||c.tournament_id);
  PERFORM legacy_fee_fixture.assert((SELECT COALESCE(sum(amount) FILTER(WHERE source NOT IN('bounty','bounty_cash','pko_bounty','bounty_residual','mystery_bounty','mystery_bounty_residual')),0)=c.prize_amount FROM public.tournament_payouts WHERE tournament_id=c.tournament_id)
   AND (SELECT chip_balance=c.prize_amount+c.bounty_amount FROM public.club_members WHERE user_id=c.winner_id AND club_id=c.club_id)
   AND (SELECT prize_balance=0 AND bounty_balance=0 AND fee_balance=c.fee_amount AND closed_at IS NULL FROM public.tournament_escrow WHERE tournament_id=c.tournament_id)
   AND NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=c.tournament_id)
   AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=c.tournament_id)
   AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources WHERE tournament_id=c.tournament_id),
   'Exact conserved prize transfer and retained fee with no banking '||c.tournament_id);
  state:=legacy_fee_fixture.snapshot(c.tournament_id);
  replay:=public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places');
  PERFORM legacy_fee_fixture.assert(receipt=replay AND state=legacy_fee_fixture.snapshot(c.tournament_id),
   'Duplicate terminal returns original receipt without effects '||c.tournament_id);
  message:=NULL;
  BEGIN PERFORM public.fn_settle_tournament_rake(c.tournament_id,'legacy-custody-unproved-continuation');
  EXCEPTION WHEN SQLSTATE '55000' OR SQLSTATE '23514' THEN message:=SQLERRM; END;
  PERFORM legacy_fee_fixture.assert((message IN ('tournament_fee_exact_charge_ambiguous','accounting_terms_not_observed','accounting_terms_not_active') OR (c.tournament_id IN(SELECT tournament_id FROM legacy_fee_fixture.pko_expected_sources) AND message='cash_commission_earning_club_not_observed'))
   AND state=legacy_fee_fixture.snapshot(c.tournament_id),
   'Continuation refuses missing original agreements without changing final players '||c.tournament_id||' refusal='||COALESCE(message,'NULL')||' unchanged='||(state=legacy_fee_fixture.snapshot(c.tournament_id))::text);
  PERFORM legacy_fee_fixture.assert(public.fn_tournament_finish_readiness(c.tournament_id,c.winner_id)->>'accounting_complete'='false',
   'Readiness exposes incomplete original fee accounting '||c.tournament_id);
 END LOOP;
 quality:=public.fn_accounting_tournament_week_quality('fade0000-0000-0000-0000-000000000001',now()-interval '1 day',now()+interval '1 day');
 PERFORM legacy_fee_fixture.assert(quality->>'status'='blocked', 'Existing weekly quality refuses full financial certification with held original fees');
 PERFORM legacy_fee_fixture.assert((SELECT sum(amount)=689 AND count(*)=8 FROM public.accounting_tournament_fee_custody_obligations)
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions)
  AND (SELECT sum(fee_balance)=689 FROM public.tournament_escrow e JOIN legacy_fee_fixture.cases c USING(tournament_id)),
  'All689 original fee chips exist once in the original escrow and nowhere as new spendable revenue');
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'LEGACY_FEE_NATIVE_RECEIPTS='||jsonb_agg(public.fn_ca_tournament_terminal_receipt(c.tournament_id,c.winner_id) ORDER BY c.tournament_id)::text FROM legacy_fee_fixture.cases c;
COMMIT;
