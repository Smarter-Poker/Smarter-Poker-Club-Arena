-- Local fault injection only. Retain the real payer and journal triggers; add
-- a fixture trigger to exercise rejection of wrong provenance and extra legs.
CREATE FUNCTION held_fee_fixture.journal_fault() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE leg public.chip_ledger;prev text;
BEGIN
 IF NEW.settlement_id='owner-basis:'||held_fee_fixture.operation() THEN
  IF current_setting('held_fee_fixture.journal_fault',true)='correlation' THEN
   NEW.correlation_id:='e1d0f00d-0000-4000-8000-00000000dead';
  ELSIF current_setting('held_fee_fixture.journal_fault',true)='suspense' THEN
   -- Inject a balanced suspense pair after enriching the genuine bank leg.
   -- Replica mode applies only to these two deliberately malformed fixture
   -- rows, never to the real operation or its own bank/conservation checks.
   prev:=current_setting('session_replication_role');
   PERFORM set_config('session_replication_role','replica',true);
   leg:=NEW;leg.id:=gen_random_uuid();leg.from_type:='chip_retirement';leg.to_type:='settlement_suspense';
   leg.chain_seq:=nextval('public.chip_ledger_chain_seq');
   INSERT INTO public.chip_ledger SELECT leg.*;
   leg.id:=gen_random_uuid();leg.from_type:='settlement_suspense';leg.to_type:='chip_retirement';
   leg.chain_seq:=nextval('public.chip_ledger_chain_seq');
   INSERT INTO public.chip_ledger SELECT leg.*;
   PERFORM set_config('session_replication_role',prev,true);
  END IF;
 END IF;
 RETURN NEW;
END $$;
-- The z prefix follows the production enrichment trigger alphabetically.
CREATE TRIGGER z_held_fee_fixture_journal_fault BEFORE INSERT ON public.chip_ledger
 FOR EACH ROW EXECUTE FUNCTION held_fee_fixture.journal_fault();
BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$ DECLARE state jsonb;message text;mode text;BEGIN
 FOREACH mode IN ARRAY ARRAY['correlation','suspense'] LOOP
  PERFORM set_config('held_fee_fixture.journal_fault',mode,true);
  state:=held_fee_fixture.snapshot();message:=NULL;
  BEGIN PERFORM public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),held_fee_fixture.lane_events());
  EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
  PERFORM held_fee_fixture.assert(message LIKE 'owner_fee_operation_journal_not_exact:%' AND state=held_fee_fixture.snapshot(),
   'Wrong journal '||mode||' rolls back all member fees, banks, recognitions and bases');
 END LOOP;
END $$;
ROLLBACK;
DROP TRIGGER z_held_fee_fixture_journal_fault ON public.chip_ledger;
DROP FUNCTION held_fee_fixture.journal_fault();
-- A leg bearing this operation identity before an operation receipt cannot be
-- silently adopted as the operation's own write.
BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL session_replication_role=replica;
UPDATE public.chip_ledger SET settlement_id='owner-basis:'||held_fee_fixture.operation()
 WHERE id=(SELECT id FROM public.chip_ledger ORDER BY id LIMIT 1);
SET LOCAL session_replication_role=origin;
DO $$ DECLARE state jsonb;message text;BEGIN
 state:=held_fee_fixture.snapshot();
 BEGIN PERFORM public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),held_fee_fixture.lane_events());
 EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
 PERFORM held_fee_fixture.assert(message='owner_fee_operation_journal_already_exists' AND state=held_fee_fixture.snapshot(),
  'Orphan operation-tagged journal refuses before any recognition');
END $$;
ROLLBACK;
