BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$ DECLARE c record;before jsonb;header jsonb;players jsonb;payouts jsonb;result jsonb;receipt jsonb;BEGIN
 FOR c IN SELECT * FROM sep8_spin_fixture.cases WHERE tournament_id=current_setting('sep8_fixture.event_id')::uuid ORDER BY tournament_id LOOP
  SELECT to_jsonb(h) INTO header FROM public.tournament_terminal_settlements h WHERE tournament_id=c.tournament_id;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY id) INTO players FROM public.tournament_players p WHERE tournament_id=c.tournament_id;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY id) INTO payouts FROM public.tournament_payouts p WHERE tournament_id=c.tournament_id;
  result:=public.fn_settle_tournament_rake(c.tournament_id,'sep8-local-original-term-continuation');
  receipt:=public.fn_ca_tournament_terminal_receipt(c.tournament_id,c.winner_id);
  PERFORM sep8_spin_fixture.assert(result->>'ok'='true' AND receipt->>'fully_settled'='true'
   AND receipt->>'accounting_complete'='true' AND receipt->>'accounting_state'='recognized'
   AND (SELECT fee_balance=0 FROM public.tournament_escrow WHERE tournament_id=c.tournament_id)
   AND (SELECT count(*)=1 FROM public.accounting_tournament_fee_batches WHERE tournament_id=c.tournament_id)
   AND (SELECT count(*)=3 AND sum(rake_credit)=c.fee FROM public.accounting_tournament_fee_sources WHERE tournament_id=c.tournament_id),
   'Actual original Spin capture recognizes three contributors after terminal '||c.tournament_id);
  PERFORM sep8_spin_fixture.assert(header=(SELECT to_jsonb(h) FROM public.tournament_terminal_settlements h WHERE tournament_id=c.tournament_id)
   AND players=(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.tournament_players p WHERE tournament_id=c.tournament_id)
   AND payouts=(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.tournament_payouts p WHERE tournament_id=c.tournament_id)
   AND public.fn_ca_sep8_spin_original_fee_proof(c.tournament_id)=(SELECT proof FROM sep8_spin_fixture.original_proofs WHERE tournament_id=c.tournament_id),
   'Recognition leaves original player result, payout, funding and source immutable '||c.tournament_id);
  before:=sep8_spin_fixture.snapshot();
  result:=public.fn_settle_tournament_rake(c.tournament_id,'sep8-local-resolution-replay');
  PERFORM sep8_spin_fixture.assert(result->>'already_settled'='true' AND receipt=public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places')
   AND before=sep8_spin_fixture.snapshot(),'Resolved original capture and payer replay without duplicate effects '||c.tournament_id);
 END LOOP;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
