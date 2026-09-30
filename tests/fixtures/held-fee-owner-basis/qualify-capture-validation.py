"""Reuse exact transaction-owned capture admission without repeated full receipts.

Only private native fixtures instrument the retained receipt or inject drift;
all such changes roll back. The real final deferred validator remains active.
"""
import json,re,subprocess

def qualify(root,fix,out,cmd,run,schema):
 binding=json.loads((fix/'source-binding.json').read_text())
 candidate=(root/binding['capture_validation_migration']).read_text()
 identity='public.fn_ca_tournament_terminal_receipt(uuid,uuid)'
 definition=subprocess.check_output(cmd+['-At','-c',"SELECT pg_get_functiondef('"+identity+"'::regprocedure)"],text=True).rstrip()+'\n'
 instrumented,n=re.subn(r'\nBEGIN\n',"\nBEGIN\n PERFORM nextval('held_fee_fixture.capture_receipt_calls');\n",definition,count=1)
 if n!=1:raise AssertionError('Receipt instrumentation boundary changed')
 seed="INSERT INTO public.accounting_tournament_fee_custody_capture_admissions(tournament_id,obligation_id,source_fingerprint,amount) SELECT tournament_id,id,source_fingerprint,amount FROM public.accounting_tournament_fee_custody_obligations WHERE tournament_id=held_fee_fixture.event();"
 def rescan_phase(label,expected):
  run("BEGIN;CREATE SEQUENCE held_fee_fixture.capture_receipt_calls;\n"+instrumented+';\n'+seed+"\nDO $$ DECLARE i int;calls bigint;BEGIN FOR i IN 1..27 LOOP IF public.fn_ca_legacy_fee_capture_admitted(held_fee_fixture.event()) IS DISTINCT FROM true THEN RAISE EXCEPTION 'exact capture admission refused';END IF;END LOOP;SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO calls FROM held_fee_fixture.capture_receipt_calls;PERFORM held_fee_fixture.assert(calls="+str(expected)+",'"+label+"');END $$;ROLLBACK;",'capture-'+label)
 rescan_phase('original-27-records-rescan-full-receipt',27)
 run("ALTER FUNCTION public.fn_ca_legacy_fee_capture_admitted(uuid) SET statement_timeout='31s';",'capture-predecessor-drift')
 before=schema();p=out/'capture-install-refused.sql';p.write_text(candidate)
 r=subprocess.run(cmd+['-f',str(p)],capture_output=True,text=True)
 (out/'capture-install-refused.log').write_text(r.stdout+r.stderr)
 if r.returncode==0 or 'legacy fee capture admission prerequisite changed' not in r.stderr or schema()!=before:
  raise AssertionError('Capture admission drift must refuse without schema/ACL changes')
 run("ALTER FUNCTION public.fn_ca_legacy_fee_capture_admitted(uuid) RESET statement_timeout;",'capture-predecessor-restored')
 run(candidate,'capture-install')
 rescan_phase('patched-27-records-reuse-exact-admission',0)
 got=subprocess.check_output(cmd+['-At','-c',"SELECT pg_get_functiondef('"+identity+"'::regprocedure)"],text=True).rstrip()+'\n'
 if got!=definition:raise AssertionError('Receipt instrumentation escaped rollback')
 run("""BEGIN;
DO $$ BEGIN
 PERFORM held_fee_fixture.assert(NOT public.fn_ca_legacy_fee_capture_admitted(held_fee_fixture.event()),'Missing admission refuses');
 PERFORM held_fee_fixture.assert(NOT has_table_privilege('service_role','public.accounting_tournament_fee_custody_capture_admissions','INSERT') AND NOT has_function_privilege('service_role','public.fn_ca_legacy_fee_capture_admitted(uuid)','EXECUTE'),'Service role cannot forge or directly exercise internal admission');
END $$;ROLLBACK;
""",'capture-missing-and-access')
 for mode in ['transaction','obligation','fingerprint','amount']:
  obligation='gen_random_uuid()' if mode=='obligation' else 'id'
  fingerprint="source_fingerprint||'-wrong'" if mode=='fingerprint' else 'source_fingerprint'
  amount='amount+0.01' if mode=='amount' else 'amount'
  transaction='txid_current()-1' if mode=='transaction' else 'txid_current()'
  run("BEGIN;INSERT INTO public.accounting_tournament_fee_custody_capture_admissions(tournament_id,obligation_id,source_fingerprint,amount,transaction_id) SELECT tournament_id,"+obligation+','+fingerprint+','+amount+','+transaction+" FROM public.accounting_tournament_fee_custody_obligations WHERE tournament_id=held_fee_fixture.event();SELECT held_fee_fixture.assert(NOT public.fn_ca_legacy_fee_capture_admitted(held_fee_fixture.event()),'Capture rejects wrong "+mode+"');ROLLBACK;",'capture-invalid-'+mode)
 run('BEGIN;'+seed+"""
DO $$ DECLARE code text;BEGIN
 BEGIN UPDATE public.accounting_tournament_fee_custody_capture_admissions SET amount=amount+0.01 WHERE tournament_id=held_fee_fixture.event();
 EXCEPTION WHEN OTHERS THEN code:=SQLSTATE;END;
 PERFORM held_fee_fixture.assert(code='55000' AND public.fn_ca_legacy_fee_capture_admitted(held_fee_fixture.event()),'Exact admission is immutable');
END $$;
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_terminal_settlements SET rake_amount=rake_amount+0.01 WHERE tournament_id=held_fee_fixture.event();
SET LOCAL session_replication_role=origin;
SELECT held_fee_fixture.assert(NOT public.fn_ca_legacy_fee_capture_admitted(held_fee_fixture.event()),'Header amount mismatch refuses capture');
ROLLBACK;
""",'capture-immutable-and-header')
 run("""SET statement_timeout='5s';
BEGIN;SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$ DECLARE before_state jsonb;code text;context text;refused_after_resolution boolean;BEGIN
 before_state:=held_fee_fixture.snapshot();
 BEGIN
  PERFORM public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),jsonb_build_array(jsonb_build_object('tournament_id',held_fee_fixture.event(),'amount',2.70)));
  refused_after_resolution:=NOT public.fn_ca_legacy_fee_capture_admitted(held_fee_fixture.event());
  -- Private native fault injection, after the real operation's own checks.
  PERFORM set_config('session_replication_role','replica',true);
  UPDATE public.tournaments SET prize_pool=prize_pool+0.01 WHERE id=held_fee_fixture.event();
  PERFORM set_config('session_replication_role','origin',true);
  SET CONSTRAINTS legacy_fee_resolution_requires_recognition IMMEDIATE;
 EXCEPTION WHEN OTHERS THEN code:=SQLSTATE;GET STACKED DIAGNOSTICS context=PG_EXCEPTION_CONTEXT;
 END;
 PERFORM held_fee_fixture.assert(refused_after_resolution IS TRUE,'Resolved same-transaction fee refuses further capture');
 PERFORM held_fee_fixture.assert(code='P0404' AND position('fn_ca_tournament_terminal_receipt' IN context)>0 AND before_state=held_fee_fixture.snapshot(),'Full deferred receipt rejects evidence drift and rolls back all money');
END $$;ROLLBACK;
""",'capture-deferred-full-receipt')
 count=sum(len(re.findall(r'NOTICE:\s+PASS ',p.read_text())) for p in out.glob('capture-*.log'))
 if count!=12:raise AssertionError('Expected 12 capture validation assertions, observed '+str(count))
 evidence={'assertions':count,'original_full_receipt_calls':27,'patched_full_receipt_calls':0,'full_definition_drift_refusal':True,'deferred_full_receipt_and_money_rollback':True}
 (out/'capture-validation-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n')
 return evidence
