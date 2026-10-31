#!/usr/bin/env python3
"""Bounded PG17 qualification: actual unchanged canonical payer, always rolled back.

All data/auth context are in a disposable private socket-only fixture. No service
credential, production DB, or production auth impersonation is used. This does not
claim that production configured service execution has occurred.
"""
import argparse,hashlib,json,sys
from decimal import Decimal
from pathlib import Path
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import module
from tournament_abort_fixture import install_financial_foundation
from tournament_abort_native import install_f06_extension,sql_file,prepare_quiesced,SERVICE
ROOT=Path(__file__).resolve().parents[2]
MIGRATION=ROOT/'supabase/migrations/20261031175559_original69_service_probe_always_rolls_back_canonical_settlem.sql'
DATA=ROOT/'scripts/ci/fixtures/original69-nonpaying-probe'

def install_money_guard(e,db):
 # Reuse the captured authoritative registry/guard, with no duplicate historical
 # refusal suite and no substitute predicate or new authority registration.
 path=ROOT/'scripts/ci/fixtures/tournament-abort/current-money-registry-guard.json'
 captured=json.loads(path.read_text());columns=[]
 for c in captured['registry_columns']:
  columns.append('"'+c['name']+'" '+c['type']+(' DEFAULT '+c['default'] if c['default'] else '')+(' NOT NULL' if c['notnull'] else ''))
 sql='CREATE TABLE IF NOT EXISTS public.ca_money_rpc_registry('+','.join(columns+[c['definition'] for c in captured['registry_constraints']])+');'
 sql+='ALTER TABLE public.ca_money_rpc_registry ENABLE ROW LEVEL SECURITY;REVOKE ALL ON public.ca_money_rpc_registry FROM PUBLIC,anon,authenticated;GRANT ALL ON public.ca_money_rpc_registry TO service_role;'
 for f in captured['functions']:
  assert hashlib.md5(f['definition'].encode()).hexdigest()==f['definition_md5']
  sql+=f['definition']+';REVOKE ALL ON FUNCTION public.'+f['signature']+' FROM PUBLIC,anon,authenticated;'
 sql+="CREATE EVENT TRIGGER ab_ca_money_rpc_registered ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();"
 sql_file(e,db,'actual-money-registry-install',sql)
 e.report['source_sha256'][str(path.relative_to(ROOT))]=hashlib.sha256(path.read_bytes()).hexdigest()

def main():
 p=argparse.ArgumentParser(description=__doc__)
 for name in ['evidence','work-root','socket-root','pg-bin']:p.add_argument('--'+name,type=Path,required=True)
 a=p.parse_args();a.evidence.mkdir(parents=True,exist_ok=False);a.work_root.mkdir(parents=True,exist_ok=True);a.socket_root.mkdir(parents=True,exist_ok=True)
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','original69_private_execution')
 e=native.Execution(ROOT,a.evidence,a.pg_bin,a.work_root,360,socket_parent=a.socket_root)
 try:
  e.start();db=e.database();install_financial_foundation(e,db,ROOT,a.evidence);install_f06_extension(e,db,ROOT)
  diamond=module(ROOT/'scripts/ci/fixtures/tournament-abort/diamond/diamond_abort_native.py','original69_diamond_dependencies');diamond.install_diamond_extension(e,db,ROOT)
  install_money_guard(e,db)
  e.sql(db,file=ROOT/'supabase/migrations/20261030161824_started_tournament_abort_uses_original_charges_and_a_drained.sql',label='actual-canonical-started-abort',seconds=120)
  provenance=json.loads((DATA/'canonical-provenance.json').read_text());fixture=DATA/'canonical32ff-postimage.sql'
  assert hashlib.sha256(fixture.read_bytes()).hexdigest()==provenance['fixture_sha256']
  e.sql(db,file=fixture,label='exact-owning32ff-postimage')
  _,out,_=e.sql(db,"SELECT md5(pg_get_functiondef('public.fn_ca_settle_tournament_abort(uuid,uuid,text)'::regprocedure));",label='exact-canonical-body-pin')
  assert out.strip()==provenance['required_canonical_md5']
  e.sql(db,file=MIGRATION,label='candidate-probe-functions-only')
  diamond_db=e.database(template=db)
  scope=json.loads((DATA/'scope.json').read_text());event=scope['tournament_ids'][0];op=scope['original_operation_id'];table='ad000000-0000-4000-8000-000000000001'
  seed=(ROOT/'scripts/ci/probes/satellite-cancel-current-native.sql').read_text().split('-- Fund the source through')[0]
  seed=seed.replace('ON COMMIT DROP;','ON COMMIT PRESERVE ROWS;').replace('d3000000-0000-4000-8000-000000000002',event)
  sql_file(e,db,'real-original-chip-charge','BEGIN;'+seed+'COMMIT;')
  # Causal representation-only fixture: widening these synthetic columns lets
  # original100.0000/90.0000/10.0000 be compared with actual fixed-scale posted
  # tranches100.00/90.00/10.00. No financial value or canonical body changes.
  sql_file(e,db,'same-values-different-source-scales',"BEGIN;ALTER TABLE public.tournament_refund_entitlements ALTER COLUMN gross TYPE numeric,ALTER COLUMN refund_prize TYPE numeric,ALTER COLUMN refund_bounty TYPE numeric,ALTER COLUMN refund_fee TYPE numeric;SET LOCAL session_replication_role=replica;UPDATE public.tournament_refund_entitlements SET gross=100.0000,refund_prize=90.0000,refund_bounty=0.0000,refund_fee=10.0000 WHERE tournament_id='"+event+"';COMMIT;")
  money=prepare_quiesced(e,db,event,op,table)
  args="'"+op+"','"+event+"'"
  state="public.fn_ca_original69_probe_state("+args+",NULL)"
  call="public.fn_ca_probe_original69_abort("+args+",'"+money+"','github-run-123456')"
  def read_state(label):
   _,out,_=e.sql(db,'BEGIN;'+SERVICE+'SELECT '+state+';COMMIT;',label=label)
   return json.loads(out.strip().splitlines()[-1])
  before=read_state('before-scoped-state')
  _,wallet_before,_=e.sql(db,"SELECT chip_balance FROM public.club_members WHERE club_id='d2000000-0000-4000-8000-000000000002' AND user_id='d1000000-0000-4000-8000-000000000001';",label='isolated-original-wallet-before')
  assert Decimal(wallet_before.strip())==100
  # Deliberately uncaught at the top statement: psql exits nonzero and the whole
  # transaction aborts, including genuine wallet/ledger/escrow/receipt writes.
  code,out,error=e.sql(db,"\\set VERBOSITY verbose\nBEGIN;"+SERVICE+'SELECT '+call+';COMMIT;',label='uncaught-real-financial-probe',check=False)
  assert code!=0 and 'PZ069' in error and 'ORIGINAL69_PROBE_ROLLBACK_V1' in error
  detail=next(line.split('DETAIL:',1)[1].strip() for line in error.splitlines() if 'DETAIL:' in line)
  receipt=json.loads(detail);assert Decimal(receipt['total_refunded'])==100 and Decimal(receipt['fees_reversed'])==10
  assert receipt['refund_line_count']==1
  allowed={'schema','operation_id','tournament_id','nonce','probe_xid','money_hash','canonical_md5','state_sha256','asset','source_player_count','refunded_count','refund_line_count','total_refunded','fees_reversed','refund_prize','refund_bounty','refund_fee','economic_sha256'}
  assert set(receipt)==allowed and len(detail.encode())<=4096
  after=read_state('after-scoped-state');assert before==after
  _,wallet_after,_=e.sql(db,"SELECT chip_balance FROM public.club_members WHERE club_id='d2000000-0000-4000-8000-000000000002' AND user_id='d1000000-0000-4000-8000-000000000001';",label='isolated-original-wallet-after')
  assert wallet_after==wallet_before
  _,out,_=e.sql(db,'BEGIN;'+SERVICE+"SELECT public.fn_ca_original69_probe_state("+args+",'"+receipt['probe_xid']+"')->>'probe_xid_status';COMMIT;",label='actual-aborted-xid-readback');assert out.strip().splitlines()[-1]=='aborted'
  sql_file(e,db,'local-only-canonical-idempotence',"BEGIN;"+SERVICE+"DO $$DECLARE first jsonb;second jsonb;BEGIN first:=public.fn_ca_settle_tournament_abort("+args+",'"+money+"');second:=public.fn_ca_settle_tournament_abort("+args+",'"+money+"');IF first IS DISTINCT FROM second THEN RAISE EXCEPTION 'canonical replay changed';END IF;END$$;ROLLBACK;")
  assert read_state('after-local-only-idempotence')==before
  # Fault injection changes actual posted component values while preserving the
  # gross sum. The real unchanged payer/receipt guards or new economics check
  # must refuse; no mock payer or substituted canonical body is involved.
  code,_,mismatch=e.sql(db,"\\set VERBOSITY verbose\nBEGIN;"+SERVICE+"CREATE FUNCTION pg_temp.change_actual_refund_components() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.refund_prize:=NEW.refund_prize-0.01;NEW.refund_fee:=NEW.refund_fee+0.01;RETURN NEW;END$$;CREATE TRIGGER fixture_changed_refund_components BEFORE INSERT ON public.tournament_refund_tranches FOR EACH ROW EXECUTE FUNCTION pg_temp.change_actual_refund_components();SELECT "+call+";COMMIT;",label='actual-component-value-mismatch-refused',check=False)
  assert code!=0 and 'P0404' in mismatch and 'has no single component receipt' in mismatch
  assert read_state('after-value-mismatch-refusal')==before
  # Repeat an explicit local fixture call only to prove no idempotent money/state
  # residue survives. The maintained service transport itself refuses retries.
  code,_,error=e.sql(db,'BEGIN;'+SERVICE+'SELECT '+call+';COMMIT;',label='second-isolated-rollback-no-residue',check=False)
  assert code!=0 and 'ORIGINAL69_PROBE_ROLLBACK_V1' in error and read_state('repeat-scoped-state')==before
  def refuse(label,body,expected):
   code,_,err=e.sql(db,"\\set VERBOSITY verbose\nBEGIN;"+body+'COMMIT;',label=label,check=False)
   assert code!=0 and expected in err
   assert read_state(label+'-no-event-change')==before
  refuse('unauthenticated-refused',"SELECT "+call+';','42501')
  refuse('wrong-cohort-refused',SERVICE+"SELECT public.fn_ca_probe_original69_abort('"+op+"','00000000-0000-4000-8000-000000000001','"+money+"','github-run-123456');",'22023')
  refuse('wrong-money-hash-refused',SERVICE+'SELECT '+call.replace(money,'0'*32)+';','55000')
  refuse('wrong-operation-refused',SERVICE+'SELECT '+call.replace(op,'00000000-0000-4000-8000-000000000001')+';','22023')
  sql_file(e,db,'acl-and-private-basis-privacy',"""DO $$BEGIN
 IF has_function_privilege('authenticated','public.fn_ca_probe_original69_abort(uuid,uuid,text,text)','EXECUTE')
 OR has_function_privilege('anon','public.fn_ca_original69_probe_state(uuid,uuid,text)','EXECUTE')
 OR has_function_privilege('service_role','smarter_private.original69_probe_economics(uuid,jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 'probe ACL broadened';END IF;END$$;""")
  # Pin drift refusal without modifying any shipping or canonical payer body.
  sql_file(e,db,'canonical-drift-refused',"BEGIN;ALTER FUNCTION public.fn_ca_settle_tournament_abort(uuid,uuid,text) RENAME TO fixture_saved_canonical;CREATE FUNCTION public.fn_ca_settle_tournament_abort(uuid,uuid,text) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;"+SERVICE+"DO $$DECLARE refused boolean:=false;BEGIN BEGIN PERFORM "+call+";EXCEPTION WHEN SQLSTATE '55000' THEN refused:=true;END;IF NOT refused THEN RAISE EXCEPTION 'canonical drift admitted';END IF;END$$;ROLLBACK;")
  assert read_state('final-scoped-state')==before
  # One actual Diamond charge exercises the second projection branch, without
  # rerunning the owning nineteen-case Diamond suite.
  db=diamond_db
  diamond.seed(e,db)
  diamond_event=scope['tournament_ids'][1];diamond_table='ad000000-0000-4000-8000-000000000002'
  e.sql(db,"SELECT setval('public.poker_diamond_tournament_ledger_id_seq'::regclass,9007199254740992,true);",label='isolated-bigint-source-id-boundary')
  sql_file(e,db,'one-real-diamond-charge',diamond.event_sql(diamond_event,'Original69 isolated Diamond')+diamond.charge(diamond.U1,diamond_event,'entry',20,18,2,'original69-private-diamond')+'COMMIT;')
  _,bigint_projection,_=e.sql(db,"SELECT smarter_private.original69_probe_economics('"+diamond_event+"',NULL);",label='private-source-id-text-exact')
  assert json.loads(bigint_projection.strip())[0]['source_charge_id']=='9007199254740993'
  diamond_hash=prepare_quiesced(e,db,diamond_event,op,diamond_table)
  diamond_args="'"+op+"','"+diamond_event+"'"
  _,out,_=e.sql(db,'BEGIN;'+SERVICE+'SELECT public.fn_ca_original69_probe_state('+diamond_args+',NULL);COMMIT;',label='diamond-before-state')
  diamond_before=json.loads(out.strip().splitlines()[-1])
  _,diamond_wallet_before,_=e.sql(db,"SELECT diamonds FROM public.profiles WHERE id='"+diamond.U1+"';",label='isolated-diamond-wallet-before')
  assert Decimal(diamond_wallet_before.strip())==480
  code,_,error=e.sql(db,"\\set VERBOSITY verbose\nBEGIN;"+SERVICE+"SELECT public.fn_ca_probe_original69_abort("+diamond_args+",'"+diamond_hash+"','github-run-123457');COMMIT;",label='diamond-uncaught-probe',check=False)
  assert code!=0 and 'PZ069' in error
  diamond_receipt=json.loads(next(line.split('DETAIL:',1)[1].strip() for line in error.splitlines() if 'DETAIL:' in line))
  assert set(diamond_receipt)==allowed and diamond_receipt['asset']=='diamonds' and Decimal(diamond_receipt['total_refunded'])==20 and Decimal(diamond_receipt['fees_reversed'])==0 and Decimal(diamond_receipt['refund_fee'])==2
  _,out,_=e.sql(db,'BEGIN;'+SERVICE+"SELECT public.fn_ca_original69_probe_state("+diamond_args+",'"+diamond_receipt['probe_xid']+"');COMMIT;",label='diamond-after-aborted-state')
  diamond_after=json.loads(out.strip().splitlines()[-1]);assert diamond_after['state_sha256']==diamond_before['state_sha256'] and diamond_after['probe_xid_status']=='aborted'
  _,diamond_wallet_after,_=e.sql(db,"SELECT diamonds FROM public.profiles WHERE id='"+diamond.U1+"';",label='isolated-diamond-wallet-after')
  assert diamond_wallet_after==diamond_wallet_before
  e.report['source_sha256'].update({str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),MIGRATION,*DATA.iterdir(),ROOT/'scripts/ci/test-tournament-abort.py',ROOT/'.github/scripts/original69-nonpaying-probe.mjs',ROOT/'.github/workflows/original69-nonpaying-probe.yml',ROOT/'tests/operations/original69-nonpaying-probe.test.mjs'] if p.is_file()})
  e.report.update(passed=True,status='passed',cases=['actual32ff-canonical-pin','real100-fee10-uncaught-whole-txn-rollback','exact-original-economics-digest','local-only-canonical-idempotence','actual-aborted-xid','no-residue-repeated-local-probe','unauthenticated','wrong-cohort','wrong-operation','wrong-money-hash','private-ACL','wrong-canonical-body','same-value-different-scale','actual-component-value-mismatch-refused','private-bigint-source-id-exact','aggregate-only-detail','actual-diamond20-fee2-aborted-and-unchanged'],public_receipt=receipt)
 finally:
  e.close();(a.evidence/'probe-report.json').write_text(json.dumps(e.report,indent=2)+'\n')
if __name__=='__main__':main()
