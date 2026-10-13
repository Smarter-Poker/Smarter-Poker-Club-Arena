#!/usr/bin/env python3
"""Finite native PG17 table-storage correction proof; no production or money."""
import argparse,datetime,json,sys,subprocess
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import module,sha
MIGRATION=Path('supabase/migrations/20261013160912_horse_journal_vacuum_trigger.sql')
ORIGINAL=Path('supabase/migrations/20260913170729_horse_adaptive_observation_journal.sql')
def qualify(e):
 checks=[];db=e.database()
 def yes(q,label):
  assert e.sql(db,q,label=label)[1].strip()=='t',label
  checks.append(label)
 original=(ROOT/ORIGINAL).read_text();start=original.index('CREATE TABLE public.horse_adaptive_observation_journal (');end=original.index(');',start)+2
 e.sql(db,original[start:end]+"ALTER TABLE horse_adaptive_observation_journal ENABLE ROW LEVEL SECURITY; ALTER TABLE horse_adaptive_observation_journal SET(fillfactor=80,autovacuum_vacuum_cost_delay=3); INSERT INTO horse_adaptive_observation_journal VALUES('fixture:0','11111111-1111-4111-8111-111111111111','actor','session',1,'training','scope','player','immutable native fixture',now());",label='actual-original-table-with-unrelated-options')
 before=e.sql(db,"SELECT jsonb_build_object('data',(SELECT jsonb_agg(to_jsonb(j)) FROM horse_adaptive_observation_journal j),'owner',relowner,'acl',relacl,'rls',relrowsecurity,'force_rls',relforcerowsecurity)::text FROM pg_class WHERE oid='horse_adaptive_observation_journal'::regclass;",label='retained-before')[1].strip()
 yes("SELECT 50+0.2*20031400>472600;",'fail-before-measured-dead-count-below-default-trigger')
 sql=(ROOT/MIGRATION).read_text();proof=next(line[len('-- @live-proof: '):] for line in sql.splitlines() if line.startswith('-- @live-proof: '));yes('SELECT NOT ('+proof+');','declared-live-proof-fails-before-correction');body=sql.replace('BEGIN;','',1).rsplit('COMMIT;',1)[0]
 e.sql(db,'BEGIN;'+body+'ROLLBACK;',label='native-change-rollback')
 yes("SELECT reloptions @> ARRAY['fillfactor=80','autovacuum_vacuum_cost_delay=3'] AND cardinality(reloptions)=2 FROM pg_class WHERE oid='horse_adaptive_observation_journal'::regclass;",'rollback-restores-exact-prior-options')
 e.report['journal_owner_is_superuser']=e.sql(db,"SELECT rolsuper FROM pg_roles WHERE rolname=current_user;",label='native-owner-capability')[1].strip()=='t'
 status,_,err=e.sql(db,'SET ROLE service_role;'+sql,label='nonowner-refused',check=False)
 assert status and 'permission denied' in err;checks.append('nonowner-cannot-change-storage-options')
 lock=subprocess.Popen([str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 lock.stdin.write("BEGIN;LOCK TABLE horse_adaptive_observation_journal IN ROW EXCLUSIVE MODE;SELECT 'locked';SELECT pg_sleep(3);ROLLBACK;\n");lock.stdin.close()
 while lock.stdout.readline().strip()!='locked':
  if lock.poll() is not None:raise RuntimeError('native owning lock absent')
 status,_,err=e.sql(db,file=ROOT/MIGRATION,label='bounded-DDL-lock-refusal',check=False)
 assert status and 'lock timeout' in err;checks.append('busy-table-refused-with-two-second-lock-timeout')
 lock.wait(timeout=10);assert lock.returncode==0
 yes("SELECT cardinality(reloptions)=2 FROM pg_class WHERE oid='horse_adaptive_observation_journal'::regclass;",'lock-refusal-retains-prior-options')
 e.sql(db,file=ROOT/MIGRATION,label='qualified-setting-only-forward')
 yes('SELECT ('+proof+');','declared-live-proof-passes-after-exact-correction')
 yes("SELECT reloptions @> ARRAY['fillfactor=80','autovacuum_vacuum_cost_delay=3','autovacuum_vacuum_threshold=20000','autovacuum_vacuum_scale_factor=0.02'] AND cardinality(reloptions)=4 FROM pg_class WHERE oid='horse_adaptive_observation_journal'::regclass;",'only-two-target-settings-changed')
 yes("SELECT 20000+0.02*20031400=420628 AND 20000+0.02*20031400<472600;",'pass-after-measured-dead-count-exceeds-new-trigger')
 after=e.sql(db,"SELECT jsonb_build_object('data',(SELECT jsonb_agg(to_jsonb(j)) FROM horse_adaptive_observation_journal j),'owner',relowner,'acl',relacl,'rls',relrowsecurity,'force_rls',relforcerowsecurity)::text FROM pg_class WHERE oid='horse_adaptive_observation_journal'::regclass;",label='retained-after')[1].strip()
 assert before==after;checks.append('data-owner-ACL-RLS-byte-identical')
 status,_,err=e.sql(db,file=ROOT/MIGRATION,label='forward-replay-refused',check=False)
 assert status and 'HORSE_JOURNAL_VACUUM_PREIMAGE_CHANGED_OR_REPLAY' in err;checks.append('forward-replay-refused')
 e.sql(db,"ALTER TABLE horse_adaptive_observation_journal RESET(autovacuum_vacuum_threshold,autovacuum_vacuum_scale_factor); ALTER TABLE horse_adaptive_observation_journal SET(autovacuum_vacuum_threshold=12345);",label='native-changed-setting-preimage')
 status,_,err=e.sql(db,file=ROOT/MIGRATION,label='drift-refused',check=False)
 assert status and 'HORSE_JOURNAL_VACUUM_PREIMAGE_CHANGED_OR_REPLAY' in err;checks.append('foreign-setting-preimage-refused')
 yes("SELECT reloptions @> ARRAY['autovacuum_vacuum_threshold=12345'] AND NOT EXISTS(SELECT 1 FROM pg_options_to_table(reloptions) WHERE option_name='autovacuum_vacuum_scale_factor') FROM pg_class WHERE oid='horse_adaptive_observation_journal'::regclass;",'refusal-does-not-partially-change-options')
 e.sql(db,"ALTER TABLE horse_adaptive_observation_journal RESET(autovacuum_vacuum_threshold); ALTER TABLE horse_adaptive_observation_journal ALTER COLUMN hand_id DROP NOT NULL;",label='native-target-shape-drift')
 status,_,err=e.sql(db,file=ROOT/MIGRATION,label='shape-refused',check=False)
 assert status and 'HORSE_JOURNAL_VACUUM_TARGET_CHANGED' in err;checks.append('target-shape-drift-refused')
 e.report['journal_vacuum_trigger_checks']=checks
 for path in [MIGRATION,ORIGINAL,Path(__file__).relative_to(ROOT)]:e.report['source_sha256'][str(path)]=sha(ROOT/path)
 e.discard(db)
 return checks

def main():
 p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);a=p.parse_args()
 out=a.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 scratch=ROOT/'scratch';scratch.mkdir(exist_ok=True)
 sock=Path('/Volumes/SmarterWork/agent-work/jvt-20261013-sock') if sys.platform=='darwin' else out;sock.mkdir(exist_ok=True)
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','journal_vacuum_execution')
 e=native.Execution(ROOT,out,a.pg_bin.resolve(),scratch,120,socket_parent=str(sock))
 try:
  e.start()
  e.sql('postgres',"CREATE ROLE native_admin SUPERUSER LOGIN;",label='native-private-bootstrap-admin')
  e.run('native-production-nonsuper-role',[e.pg/'psql','-X','-qAt','-h',e.socket,'-p',e.port,'-U','native_admin','-d','postgres','-v','ON_ERROR_STOP=1'],text="ALTER ROLE postgres RENAME TO native_bootstrap; CREATE ROLE postgres NOSUPERUSER CREATEDB LOGIN; CREATE ROLE service_role; GRANT service_role TO postgres;")
  qualify(e);assert e.report['journal_owner_is_superuser'] is False;e.report['status']='passed' 
 except BaseException as exc:e.report['failure']=repr(exc)
 finally:
  try:e.close()
  except BaseException as exc:e.report.update(cleanup_failure=repr(exc),status='failed')
  e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n');print(json.dumps({k:e.report.get(k) for k in ['status','failure','cleanup']}))
 return 0 if e.report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
