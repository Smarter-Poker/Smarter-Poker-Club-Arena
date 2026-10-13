#!/usr/bin/env python3
"""Finite native PG17 table-storage correction proof; no production or money."""
import argparse,datetime,json,sys,subprocess
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import module,sha
MIGRATION=Path('supabase/migrations/20261013170504_cash_retention_vacuum_trigger.sql')
ORIGINAL=Path('supabase/migrations/20260917230925_cash_funding_retains_original_participant_custody.sql')
def qualify(e):
 checks=[];db=e.database()
 def yes(q,label):
  assert e.sql(db,q,label=label)[1].strip()=='t',label
  checks.append(label)
 original=(ROOT/ORIGINAL).read_text();start=original.index('CREATE TABLE public.cash_hand_provenance_receipts (');end=original.index(');',start)+2
 e.sql(db,original[start:end]+"ALTER TABLE cash_hand_provenance_receipts ADD COLUMN transaction_id xid8; ALTER TABLE cash_hand_provenance_receipts ENABLE ROW LEVEL SECURITY; GRANT SELECT ON cash_hand_provenance_receipts TO service_role; ALTER TABLE cash_hand_provenance_receipts SET(fillfactor=80,autovacuum_vacuum_cost_delay=3,toast.autovacuum_vacuum_cost_delay=4); INSERT INTO cash_hand_provenance_receipts(table_id,hand_number,hand_id,payload_hash,accepted_request,atomic_receipt,stack_claim,stack_settlement,status,participants,all_players_included,funding_provenance_complete,issues) SELECT '11111111-1111-4111-8111-111111111111',1,'22222222-2222-4222-8222-222222222222',repeat('a',64),jsonb_build_object('native_fixture',string_agg(md5(i::text),'')),'{}','{}','{}','captured','[]',true,true,'[]' FROM generate_series(1,3000)i;",label='actual-original-cash-table-and-real-TOAST-unrelated-options')
 fn_start=original.index('CREATE FUNCTION public.fn_cash_provenance_immutable()');fn_end=original.index('$$;',fn_start)+3
 e.sql(db,original[fn_start:fn_end]+"CREATE TRIGGER cash_hand_provenance_immutable BEFORE UPDATE OR DELETE ON cash_hand_provenance_receipts FOR EACH ROW EXECUTE FUNCTION fn_cash_provenance_immutable();CREATE INDEX cash_hand_provenance_time ON cash_hand_provenance_receipts(accepted_at,table_id,hand_number);",label='actual-original-immutable-guard-and-time-index')
 toast=e.sql(db,"SELECT reltoastrelid::regclass::text FROM pg_class WHERE oid='cash_hand_provenance_receipts'::regclass;",label='actual-original-toast')[1].strip()
 yes("SELECT pg_relation_size(reltoastrelid)>8192 FROM pg_class WHERE oid='cash_hand_provenance_receipts'::regclass;",'real-original-payload-uses-TOAST')

 before=e.sql(db,"SELECT jsonb_build_object('data',(SELECT md5(string_agg(to_jsonb(j)::text,'')) FROM cash_hand_provenance_receipts j),'toast_catalog',(SELECT (to_jsonb(t)-'reloptions')||jsonb_build_object('heap_bytes',pg_relation_size(t.oid)) FROM pg_class t WHERE t.oid=c.reltoastrelid),'indices',(SELECT jsonb_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname='public' AND tablename='cash_hand_provenance_receipts'),'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'guard',md5(pg_get_functiondef('fn_cash_provenance_immutable()'::regprocedure)),'owner',relowner,'acl',relacl,'rls',relrowsecurity,'force_rls',relforcerowsecurity)::text FROM pg_class c WHERE c.oid='cash_hand_provenance_receipts'::regclass;",label='retained-before')[1].strip()
 yes("SELECT 50+0.2*4070100>146942 AND 50+0.2*25818300>538658;",'fail-before-measured-dead-count-below-default-trigger')
 sql=(ROOT/MIGRATION).read_text();proof=next(line[len('-- @live-proof: '):] for line in sql.splitlines() if line.startswith('-- @live-proof: '));yes('SELECT NOT ('+proof+');','declared-live-proof-fails-before-correction');body=sql.replace('BEGIN;','',1).rsplit('COMMIT;',1)[0]
 e.sql(db,'BEGIN;'+body+'ROLLBACK;',label='native-change-rollback')
 yes("SELECT reloptions @> ARRAY['fillfactor=80','autovacuum_vacuum_cost_delay=3'] AND cardinality(reloptions)=2 AND (SELECT reloptions @> ARRAY['autovacuum_vacuum_cost_delay=4'] AND cardinality(reloptions)=1 FROM pg_class WHERE oid=c.reltoastrelid) FROM pg_class c WHERE c.oid='cash_hand_provenance_receipts'::regclass;",'rollback-restores-exact-parent-and-TOAST-prior-options')
 e.report['cash_owner_is_superuser']=e.sql(db,"SELECT rolsuper FROM pg_roles WHERE rolname=current_user;",label='native-owner-capability')[1].strip()=='t'
 status,_,err=e.sql(db,'SET ROLE service_role;'+sql,label='nonowner-refused',check=False)
 assert status and 'permission denied' in err;checks.append('nonowner-cannot-change-storage-options')
 lock=subprocess.Popen([str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 lock.stdin.write("BEGIN;LOCK TABLE cash_hand_provenance_receipts IN SHARE UPDATE EXCLUSIVE MODE;SELECT 'locked';SELECT pg_sleep(3);ROLLBACK;\n");lock.stdin.close()
 while lock.stdout.readline().strip()!='locked':
  if lock.poll() is not None:raise RuntimeError('native owning lock absent')
 status,_,err=e.sql(db,file=ROOT/MIGRATION,label='bounded-DDL-lock-refusal',check=False)
 assert status and 'lock timeout' in err;checks.append('busy-table-refused-with-two-second-lock-timeout')
 lock.wait(timeout=10);assert lock.returncode==0
 yes("SELECT cardinality(reloptions)=2 FROM pg_class WHERE oid='cash_hand_provenance_receipts'::regclass;",'lock-refusal-retains-prior-options')
 writer=subprocess.Popen([str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 writer.stdin.write("BEGIN;LOCK TABLE cash_hand_provenance_receipts IN ROW EXCLUSIVE MODE;SELECT 'writer|'||pg_backend_pid();SELECT pg_sleep(3);ROLLBACK;\n");writer.stdin.close()
 marker=writer.stdout.readline().strip();assert marker.startswith('writer|'),marker;writer_pid=int(marker.split('|')[1])
 e.sql(db,file=ROOT/MIGRATION,label='qualified-setting-only-forward')
 yes("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid="+str(writer_pid)+" AND relation='cash_hand_provenance_receipts'::regclass AND mode='RowExclusiveLock' AND granted);",'ordinary-original-writer-lock-remains-compatible-with-storage-correction')
 writer.wait(timeout=10);assert writer.returncode==0

 yes('SELECT ('+proof+');','declared-live-proof-passes-after-exact-correction')
 yes("SELECT reloptions @> ARRAY['fillfactor=80','autovacuum_vacuum_cost_delay=3','autovacuum_vacuum_threshold=20000','autovacuum_vacuum_scale_factor=0.02'] AND cardinality(reloptions)=4 FROM pg_class WHERE oid='cash_hand_provenance_receipts'::regclass;",'only-two-target-settings-changed')
 yes("SELECT reloptions @> ARRAY['autovacuum_vacuum_cost_delay=4','autovacuum_vacuum_threshold=20000','autovacuum_vacuum_scale_factor=0.01'] AND cardinality(reloptions)=3 FROM pg_class WHERE oid=(SELECT reltoastrelid FROM pg_class WHERE oid='cash_hand_provenance_receipts'::regclass);",'only-two-original-TOAST-settings-changed')
 yes("SELECT 20000+0.02*4070100=101402 AND 101402<146942 AND 20000+0.01*25818300=278183 AND 278183<538658;",'pass-after-measured-dead-count-exceeds-new-trigger')
 after=e.sql(db,"SELECT jsonb_build_object('data',(SELECT md5(string_agg(to_jsonb(j)::text,'')) FROM cash_hand_provenance_receipts j),'toast_catalog',(SELECT (to_jsonb(t)-'reloptions')||jsonb_build_object('heap_bytes',pg_relation_size(t.oid)) FROM pg_class t WHERE t.oid=c.reltoastrelid),'indices',(SELECT jsonb_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname='public' AND tablename='cash_hand_provenance_receipts'),'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'guard',md5(pg_get_functiondef('fn_cash_provenance_immutable()'::regprocedure)),'owner',relowner,'acl',relacl,'rls',relrowsecurity,'force_rls',relforcerowsecurity)::text FROM pg_class c WHERE c.oid='cash_hand_provenance_receipts'::regclass;",label='retained-after')[1].strip()
 assert before==after;checks.append('data-owner-ACL-RLS-byte-identical')
 status,_,err=e.sql(db,file=ROOT/MIGRATION,label='forward-replay-refused',check=False)
 assert status and 'CASH_VACUUM_PREIMAGE_CHANGED_OR_REPLAY' in err;checks.append('forward-replay-refused')
 e.sql(db,"ALTER TABLE cash_hand_provenance_receipts RESET(autovacuum_vacuum_threshold,autovacuum_vacuum_scale_factor,toast.autovacuum_vacuum_threshold,toast.autovacuum_vacuum_scale_factor); ALTER TABLE cash_hand_provenance_receipts SET(autovacuum_vacuum_threshold=12345);",label='native-changed-setting-preimage')
 status,_,err=e.sql(db,file=ROOT/MIGRATION,label='drift-refused',check=False)
 assert status and 'CASH_VACUUM_PREIMAGE_CHANGED_OR_REPLAY' in err;checks.append('foreign-setting-preimage-refused')
 yes("SELECT reloptions @> ARRAY['autovacuum_vacuum_threshold=12345'] AND NOT EXISTS(SELECT 1 FROM pg_options_to_table(reloptions) WHERE option_name='autovacuum_vacuum_scale_factor') FROM pg_class WHERE oid='cash_hand_provenance_receipts'::regclass;",'refusal-does-not-partially-change-options')
 e.sql(db,"ALTER TABLE cash_hand_provenance_receipts RESET(autovacuum_vacuum_threshold); ALTER TABLE cash_hand_provenance_receipts SET(toast.autovacuum_vacuum_threshold=12345);",label='native-original-toast-preimage-drift')
 status,_,err=e.sql(db,file=ROOT/MIGRATION,label='toast-drift-refused',check=False)
 assert status and 'CASH_VACUUM_PREIMAGE_CHANGED_OR_REPLAY' in err;checks.append('foreign-original-TOAST-setting-preimage-refused')
 yes("SELECT cardinality(reloptions)=2 AND (SELECT reloptions @> ARRAY['autovacuum_vacuum_cost_delay=4','autovacuum_vacuum_threshold=12345'] AND cardinality(reloptions)=2 FROM pg_class WHERE oid=c.reltoastrelid) FROM pg_class c WHERE c.oid='cash_hand_provenance_receipts'::regclass;",'TOAST-refusal-retains-parent-and-TOAST-options')
 e.sql(db,"ALTER TABLE cash_hand_provenance_receipts RESET(toast.autovacuum_vacuum_threshold); ALTER TABLE cash_hand_provenance_receipts ALTER COLUMN hand_id DROP NOT NULL;",label='native-target-shape-drift')
 status,_,err=e.sql(db,file=ROOT/MIGRATION,label='shape-refused',check=False)
 assert status and 'CASH_VACUUM_TARGET_CHANGED' in err;checks.append('target-shape-drift-refused')
 e.report['cash_vacuum_trigger_checks']=checks
 for path in [MIGRATION,ORIGINAL,Path(__file__).relative_to(ROOT)]:e.report['source_sha256'][str(path)]=sha(ROOT/path)
 e.discard(db)
 return checks

def main():
 p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);a=p.parse_args()
 out=a.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 scratch=ROOT/'scratch';scratch.mkdir(exist_ok=True)
 sock=Path('/Volumes/SmarterWork/agent-work/cvt-20261013-sock') if sys.platform=='darwin' else out;sock.mkdir(exist_ok=True)
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','journal_vacuum_execution')
 e=native.Execution(ROOT,out,a.pg_bin.resolve(),scratch,120,socket_parent=str(sock))
 try:
  e.start()
  e.sql('postgres',"CREATE ROLE native_admin SUPERUSER LOGIN;",label='native-private-bootstrap-admin')
  e.run('native-production-nonsuper-role',[e.pg/'psql','-X','-qAt','-h',e.socket,'-p',e.port,'-U','native_admin','-d','postgres','-v','ON_ERROR_STOP=1'],text="ALTER ROLE postgres RENAME TO native_bootstrap; CREATE ROLE postgres NOSUPERUSER CREATEDB LOGIN; CREATE ROLE service_role; GRANT service_role TO postgres;")
  qualify(e);assert e.report['cash_owner_is_superuser'] is False;e.report['status']='passed' 
 except BaseException as exc:e.report['failure']=repr(exc)
 finally:
  try:e.close()
  except BaseException as exc:e.report.update(cleanup_failure=repr(exc),status='failed')
  e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n');print(json.dumps({k:e.report.get(k) for k in ['status','failure','cleanup']}))
 return 0 if e.report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
