BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$ DECLARE c record;state jsonb;message text;result jsonb;
BEGIN
 FOR c IN SELECT * FROM earlybird_fee_fixture.cases ORDER BY tournament_id LOOP
  result:=public.fn_claim_tournament_finish(c.tournament_id,c.winner_id,'legacy-fee-before');
  PERFORM earlybird_fee_fixture.assert(result->>'ok'='true','Original winner claim before repair '||c.tournament_id);
  state:=earlybird_fee_fixture.snapshot(c.tournament_id);message:=NULL;
  BEGIN
   PERFORM public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN message:=SQLERRM; END;
  PERFORM earlybird_fee_fixture.assert(message='legacy fee custody requires exact unpaid named source and completed player banks',
   'Original terminal reaches exact missing attribution refusal '||c.tournament_id);
  PERFORM earlybird_fee_fixture.assert(state=earlybird_fee_fixture.snapshot(c.tournament_id),
   'Original terminal rolls every partial player payment back '||c.tournament_id);
 END LOOP;
END $$;
ROLLBACK;
