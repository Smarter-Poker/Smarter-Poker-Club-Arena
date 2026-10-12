-- The defect, reproduced on the installed predecessor: agreements exist at the
-- event's completion, none at its charges, and the held fee still cannot move.
BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$ DECLARE state jsonb;message text;code text;BEGIN
 PERFORM held_fee_fixture.assert(to_regprocedure('public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb)') IS NULL
  AND to_regclass('public.accounting_tournament_fee_owner_bases') IS NULL,'Predecessor has no owner-authorized basis');
 state:=held_fee_fixture.snapshot();
 BEGIN PERFORM public.fn_settle_tournament_rake(held_fee_fixture.event(),'held-fee-before');
 EXCEPTION WHEN OTHERS THEN message:=SQLERRM;code:=SQLSTATE; END;
 PERFORM held_fee_fixture.assert(message IN('cash_commission_earning_club_not_observed','accounting_terms_not_observed')
  AND code IN('23514','55000') AND state=held_fee_fixture.snapshot(),
  'Predecessor refuses the held fee at its charge-time contract and changes nothing: '||COALESCE(message,'<none>'));
END $$;
ROLLBACK;
