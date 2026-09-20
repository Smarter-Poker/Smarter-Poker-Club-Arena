BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$ DECLARE c record;result jsonb;replay jsonb;before jsonb;err text;witness jsonb;BEGIN
 FOR c IN SELECT f.*,s.operation_id,s.expected FROM sep8_spin_fixture.cases f JOIN sep8_spin_fixture.standings_cases s USING(tournament_id) WHERE f.tournament_id=current_setting('sep8_fixture.event_id')::uuid ORDER BY tournament_id LOOP
  result:=public.fn_complete_sep8_spin_original_standings(c.operation_id,c.expected);
  EXECUTE 'SELECT smarter_private.spin_original_standings_witness($1,$2)' INTO witness USING c.tournament_id,c.winner_id;
  PERFORM sep8_spin_fixture.assert(result->>'receipt_version'='3' AND result->>'player_result'='final'
   AND result->>'accounting_complete'='false' AND result->>'accounting_state'='fee_custody_unresolved'
   AND result->'cash'->'original_standings'=witness AND jsonb_typeof(witness)='object'
   AND (SELECT count(*)=1 AND sum(amount)=c.prize FROM public.tournament_payouts WHERE tournament_id=c.tournament_id)
   AND (SELECT fee_balance=c.fee AND prize_balance=0 AND bounty_balance=0 FROM public.tournament_escrow WHERE tournament_id=c.tournament_id)
   AND (SELECT chip_balance=c.prize FROM public.club_members WHERE club_id=c.winner_club_id AND user_id=c.winner_id),
   'Existing original payer finalizes exact prize with immutable standings and fee custody '||c.tournament_id);
  PERFORM sep8_spin_fixture.assert(NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources WHERE tournament_id=c.tournament_id)
   AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=c.tournament_id)
   AND NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=c.tournament_id)
   AND public.fn_ca_sep8_spin_original_fee_proof(c.tournament_id)=(SELECT proof FROM sep8_spin_fixture.original_proofs WHERE tournament_id=c.tournament_id),
   'Original fee stays unrecognized and funding proof unchanged after player closure '||c.tournament_id);
  before:=sep8_spin_fixture.snapshot();
  replay:=public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places');
  PERFORM sep8_spin_fixture.assert(result=replay AND before=sep8_spin_fixture.snapshot(),
   'Original terminal replay is identical with no duplicate effect '||c.tournament_id);
  replay:=public.fn_complete_sep8_spin_original_standings(c.operation_id,c.expected);
  PERFORM sep8_spin_fixture.assert(result=replay AND before=sep8_spin_fixture.snapshot(),
   'Same original standings operation replays without writes '||c.tournament_id);
  err:=NULL;
  BEGIN PERFORM public.fn_complete_sep8_spin_original_standings(gen_random_uuid(),c.expected);
  EXCEPTION WHEN SQLSTATE '40001' THEN err:=SQLERRM;END;
  PERFORM sep8_spin_fixture.assert(err='SPIN_ORIGINAL_REPLAY_MISMATCH' AND before=sep8_spin_fixture.snapshot(),
   'Different original standings operation refuses completed event '||c.tournament_id);
  err:=NULL;
  BEGIN PERFORM public.fn_complete_sep8_spin_original_standings(c.operation_id,c.expected||'{"extra":true}');
  EXCEPTION WHEN SQLSTATE '40001' THEN err:=SQLERRM;END;
  PERFORM sep8_spin_fixture.assert(err='SPIN_ORIGINAL_REPLAY_MISMATCH' AND before=sep8_spin_fixture.snapshot(),
   'Changed expected original standings refuses completed event '||c.tournament_id);
  err:=NULL;
  BEGIN PERFORM public.fn_settle_tournament_rake(c.tournament_id,'sep8-missing-original-terms');
  EXCEPTION WHEN SQLSTATE '55000' OR SQLSTATE '23514' THEN err:=SQLERRM;END;
  PERFORM sep8_spin_fixture.assert(err IN('accounting_terms_not_observed','cash_commission_earning_club_not_observed') AND before=sep8_spin_fixture.snapshot(),
   'Postclosure original capture refuses missing agreements with zero writes '||c.tournament_id);
 END LOOP;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
