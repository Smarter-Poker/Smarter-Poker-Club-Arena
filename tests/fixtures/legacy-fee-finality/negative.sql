-- Completed custody is immutable even for direct privileged writes; untrusted
-- application roles cannot invoke its private proof or author proof rows.
BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$ DECLARE table_name text;statement text;refused boolean;state jsonb;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['accounting_tournament_fee_custody_obligations',
  'accounting_tournament_fee_custody_resolutions','accounting_tournament_fee_custody_capture_admissions'] LOOP
  PERFORM legacy_fee_fixture.assert(NOT has_table_privilege('service_role','public.'||table_name,'INSERT,UPDATE,DELETE,TRUNCATE')
   AND NOT has_table_privilege('authenticated','public.'||table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
   AND NOT has_table_privilege('anon','public.'||table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
   'Private proof table is inaccessible to application roles '||table_name);
  refused:=false;
  BEGIN EXECUTE format('TRUNCATE public.%I',table_name);
  EXCEPTION WHEN SQLSTATE '55000' THEN refused:=SQLERRM='original fee custody obligations are append-only'; END;
  PERFORM legacy_fee_fixture.assert(refused,'Append-only proof also refuses TRUNCATE '||table_name);
 END LOOP;
 FOREACH statement IN ARRAY ARRAY[
  'UPDATE public.accounting_tournament_fee_custody_obligations SET amount=amount+1',
  'DELETE FROM public.accounting_tournament_fee_custody_obligations',
  'UPDATE public.tournament_escrow SET fee_balance=0 WHERE tournament_id=''2d2319d4-09e4-4921-85f3-09832ca7f9da''',
  'UPDATE public.tournament_terminal_settlements SET accounting_state=''recognized'' WHERE tournament_id=''2d2319d4-09e4-4921-85f3-09832ca7f9da''',
  'UPDATE public.rake_records SET rake_amount=rake_amount+1 WHERE tournament_id=''2d2319d4-09e4-4921-85f3-09832ca7f9da'''] LOOP
  refused:=false;
  BEGIN EXECUTE statement;
  EXCEPTION WHEN SQLSTATE '55000' OR restrict_violation THEN refused:=true; END;
  PERFORM legacy_fee_fixture.assert(refused,'Original finality rejects direct mutation: '||statement);
 END LOOP;
 PERFORM legacy_fee_fixture.assert(NOT has_function_privilege('service_role','public.fn_ca_hold_legacy_tournament_fee(uuid,text)','EXECUTE')
  AND NOT has_function_privilege('service_role','public.fn_ca_begin_legacy_fee_resolution(uuid)','EXECUTE')
  AND NOT has_function_privilege('service_role','public.fn_ca_legacy_fee_capture_admitted(uuid)','EXECUTE'),
  'Only the original settlement owner can create custody and resolution authority');
 -- A private same-transaction admission cannot commit on its own, even with
 -- exact obligation values copied by a privileged caller.
 state:=legacy_fee_fixture.snapshot('2d2319d4-09e4-4921-85f3-09832ca7f9da');refused:=false;
 BEGIN
  INSERT INTO public.accounting_tournament_fee_custody_capture_admissions(tournament_id,obligation_id,source_fingerprint,amount)
   SELECT tournament_id,id,source_fingerprint,amount FROM public.accounting_tournament_fee_custody_obligations
   WHERE tournament_id='2d2319d4-09e4-4921-85f3-09832ca7f9da';
  SET CONSTRAINTS ALL IMMEDIATE;
 EXCEPTION WHEN SQLSTATE 'P0404' THEN refused:=SQLERRM='original fee capture cannot commit without its same-transaction resolution'; END;
 PERFORM legacy_fee_fixture.assert(refused AND state=legacy_fee_fixture.snapshot('2d2319d4-09e4-4921-85f3-09832ca7f9da'),
  'Private capture admission without canonical resolution rolls back in full');
END $$;
ROLLBACK;
BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL app.legacy_fee_resolution='approved';
DO $$ DECLARE raw_id uuid;refused boolean:=false;state jsonb;
BEGIN
 SELECT id INTO raw_id FROM public.rake_records WHERE tournament_id='2d2319d4-09e4-4921-85f3-09832ca7f9da' ORDER BY id LIMIT 1;
 state:=legacy_fee_fixture.snapshot('2d2319d4-09e4-4921-85f3-09832ca7f9da');
 BEGIN PERFORM public.fn_ca_capture_tournament_fee_from_recorded_evidence(raw_id);
 EXCEPTION WHEN SQLSTATE '55000' THEN refused:=SQLERRM='tournament_fee_event_is_not_live'; END;
 PERFORM legacy_fee_fixture.assert(refused AND state=legacy_fee_fixture.snapshot('2d2319d4-09e4-4921-85f3-09832ca7f9da'),
  'Direct capture and caller settings cannot authorize a completed-event rewrite');
END $$;
ROLLBACK;
