"""Guarded existing-job cadence qualification with the real native pg_cron API.
No production connection or schedule is used. Original activation is preserved.
"""
import json,subprocess,shlex,time,sys
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts/ci'))
from satellite_qualifier_fixture import module,sha,lit
MIG=Path('supabase/migrations/20261012181304_existing_horse_retention_cadence_follows_measured_bounded_wo.sql')
COMMAND="\nselect case\n         when pg_try_advisory_lock(hashtext('sp-prune-hand-history'))\n           then (select set_config('statement_timeout','30s',true) is not null\n                    and public.sp_prune_hand_history(5000) >= 0)::text\n         else 'skipped: previous run still in progress'\n       end;\n"
def qualify(parent,template):
 # Provider postgres is not initdb's immutable bootstrap superuser. Keep this
 # focused authority fixture in its own tiny cluster, without changing the
 # financial world's roles or rebuilding that already qualified world.
 _,definition,_=parent.sql(template,"SELECT pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure);",label='cadence-real-original-prune-source')
 report=qualify_definition(parent.root,parent.output/'cadence-provider',parent.pg,definition,parent.socket.parent)
 parent.report['source_sha256'].update(report['source_sha256'])
 for key in ['retention_cadence_proven','retention_cadence_native','retention_subminute_proven','retention_subminute_native']:parent.report[key]=report[key]
 return report['retention_cadence_proven']

def qualify_definition(root,out,pg,definition,socket_parent):
 """Same focused provider fixture from an explicit captured prune definition.
 Connected CI obtains this definition from its already qualified real world;
 the standalone entry point records the exact supplied source hash instead.
 """
 out.mkdir(exist_ok=False)
 native=module(root/'scripts/ci/test-mtt-unlimited.py','cadence_native_owner')
 class CadenceExecution(native.Execution):
  def start(self):
   _,version,_=self.run('postgres-version',[self.pg/'postgres','--version']);assert ' 17.' in version
   self.run('initdb',[self.pg/'initdb','-D',self.cluster,'-A','trust','-U','supabase_admin','--no-locale','--encoding=UTF8'])
   opts=shlex.join(['-k',str(self.socket),'-p',self.port,'-c','listen_addresses=','-c','shared_buffers=32MB','-c','max_connections=16','-c','shared_preload_libraries=pg_cron','-c','cron.database_name=postgres','-c','cron.use_background_workers=on','-c','cron.launch_active_jobs=off'])
   self.start_attempted=True
   self.run('start',[self.pg/'pg_ctl','-D',self.cluster,'-l',self.output/'postgres.log','-o',opts,'-w','start'])
   self.run('nonbootstrap-postgres-role',[self.pg/'psql','-X','-qAt','-h',str(self.socket),'-p',self.port,'-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1','-c','CREATE ROLE postgres LOGIN SUPERUSER CREATEDB CREATEROLE;'])
 e=CadenceExecution(root,out,pg,out,60,socket_parent=str(socket_parent))
 try:
  e.start();result=_qualify(e,definition)
  successor=module(root/'scripts/verification-harness/horse-retention-subminute-cadence.py','original_retention_subminute')
  successor.qualify(e);e.report['status']='passed'
  return e.report
 except BaseException as ex:e.report.update(status='failed',failure=repr(ex));raise
 finally:
  e.close();(out/'result.json').write_text(json.dumps(e.report,indent=2))

def _qualify(e,definition):
 root=e.root;passed=[]
 e.report['source_sha256'].update({str(MIG):sha(root/MIG),'scripts/verification-harness/horse-retention-cadence.py':sha(Path(__file__))})
 db='postgres'
 def yes(q,label):
  _,v,_=e.sql(db,q,label='cadence-'+label);assert v.strip()=='t',(label,v);passed.append(label)
 e.sql(db,'SET ROLE supabase_admin;CREATE EXTENSION pg_cron;RESET ROLE;',label='cadence-real-native-extension')
 _,version,_=e.sql(db,"SELECT extversion FROM pg_extension WHERE extname='pg_cron';",label='cadence-real-native-version')
 assert version.strip().startswith('1.6'),version
 e.sql(db,definition,label='cadence-actual-budget-source')
 e.sql(db,"SELECT setval('cron.jobid_seq',117,false);SELECT cron.schedule('sp_prune_hand_history_10m','3,13,23,33,43,53 * * * *',"+lit(COMMAND)+");UPDATE cron.job SET nodeport=5432;SELECT setval('cron.jobid_seq',119,false);SELECT cron.schedule('native-unrelated-job','17 * * * *','SELECT 1');SELECT cron.alter_job(119,active:=false);",label='cadence-existing-held-native-job-fixture')
 e.sql(db,"GRANT pg_monitor TO postgres;ALTER TABLE cron.job OWNER TO supabase_admin;ALTER FUNCTION cron.alter_job(bigint,text,text,text,text,boolean) OWNER TO supabase_admin;REVOKE ALL ON cron.job FROM PUBLIC,postgres;GRANT USAGE ON SCHEMA cron TO postgres;GRANT SELECT ON cron.job TO postgres;REVOKE ALL ON FUNCTION cron.alter_job(bigint,text,text,text,text,boolean) FROM PUBLIC;GRANT EXECUTE ON FUNCTION cron.alter_job(bigint,text,text,text,text,boolean) TO postgres;ALTER ROLE postgres NOSUPERUSER CREATEDB CREATEROLE;",label='cadence-provider-least-privilege-authority')
 yes("SELECT NOT rolsuper AND NOT has_table_privilege('cron.job','UPDATE') AND has_table_privilege('cron.job','SELECT') AND has_function_privilege('cron.alter_job(bigint,text,text,text,text,boolean)','EXECUTE') FROM pg_roles WHERE rolname=current_user;",'provider-caller-read-and-api-without-table-update')
 _,before,_=e.sql(db,"SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j;",label='cadence-original-job-image')
 yes("BEGIN;SELECT cron.alter_job(117,active:=false);"+(root/MIG).read_text().replace('BEGIN;','',1).rsplit('COMMIT;',1)[0]+"SELECT NOT active AND schedule='* * * * *' FROM cron.job WHERE jobid=117;ROLLBACK;",'safety-held-native-caller-stays-held')
 e.sql(db,'BEGIN;'+(root/MIG).read_text().replace('BEGIN;','',1).rsplit('COMMIT;',1)[0]+'ROLLBACK;',label='cadence-rollback')
 _,rolled,_=e.sql(db,"SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j;",label='cadence-rollback-readback');assert json.loads(before)==json.loads(rolled);passed.append('configuration-rollback-exact')
 def admin(q,label):
  return e.run('cadence-admin-'+label,[e.pg/'psql','-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','supabase_admin','-d',db,'-v','ON_ERROR_STOP=1','-c',q])
 original=json.loads(before)[0]
 for column,value in [('command',"'SELECT 1'"),('username',"'supabase_admin'"),('schedule',"'*/5 * * * *'"),('database',"'template1'")]:
  admin('SELECT cron.alter_job(117,'+column+':='+value+');','drift-'+column)
  code,_,err=e.sql(db,file=root/MIG,label='cadence-refuse-'+column,check=False);assert code and 'HORSE_RETENTION_JOB_SOURCE_CHANGED' in err;passed.append(column+'-drift-refused')
  admin('SELECT cron.alter_job(117,'+column+':='+lit(original[column])+');','restore-'+column)
 # A real competing owner changes another field after our plain SELECT while
 # the supported API waits for its row lock. Only our schedule change rolls
 # back; the foreign owner's committed command remains exact.
 argv=[str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-d',db,'-v','ON_ERROR_STOP=1']
 holder=subprocess.Popen(argv+['-U','supabase_admin'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);racer=None
 changed=COMMAND+'\n-- Native concurrent owner\n'
 try:
  holder.stdin.write("BEGIN;SELECT jobid FROM cron.job WHERE jobid=117 FOR UPDATE;SELECT 'held';\n");holder.stdin.flush();assert holder.stdout.readline().strip()=='117' and holder.stdout.readline().strip()=='held'
  racer=subprocess.Popen(argv+['-U','postgres','-c',"SET application_name='horse_cadence_migration_race';"+(root/MIG).read_text()],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  waited=False
  for _ in range(100):
   _,v,_=e.sql(db,"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='horse_cadence_migration_race' AND wait_event_type='Lock');",label='cadence-observe-api-row-lock')
   if v.strip()=='t':waited=True;break
   time.sleep(.025)
  assert waited,'supported API must wait for the original job row owner'
  holder.stdin.write('UPDATE cron.job SET command='+lit(changed)+" WHERE jobid=117;COMMIT;\n");holder.stdin.close();holder.wait(timeout=10);o,err=racer.communicate(timeout=10);assert holder.returncode==0 and racer.returncode and 'HORSE_RETENTION_JOB_POSTIMAGE_CHANGED' in err,(o,err)
  yes("SELECT command="+lit(changed)+" AND schedule='3,13,23,33,43,53 * * * *' FROM cron.job WHERE jobid=117;",'concurrent-foreign-command-preserved-and-own-schedule-rollback')
  passed.append('real-api-row-lock-and-postimage-drift-refusal')
 finally:
  for process in [holder,racer]:
   if process is not None and process.poll() is None:process.terminate();process.wait(timeout=10)
 admin('SELECT cron.alter_job(117,command:='+lit(COMMAND)+');','restore-original-command-after-race')
 e.sql(db,file=root/MIG,label='cadence-real-c-api-install')
 _,after,_=e.sql(db,"SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j;",label='cadence-actual-native-postimage')
 a=json.loads(before);b=json.loads(after);assert len(a)==len(b)==2
 assert b[0]['schedule']=='* * * * *' and b[0]['active'] is True
 a[0].pop('schedule');b[0].pop('schedule');assert a==b;passed.extend(['only-existing-schedule-changes','original-active-state-preserved','unrelated-job-byte-identical'])
 code,_,err=e.sql(db,file=root/MIG,label='cadence-replay-refused',check=False);assert code and 'HORSE_RETENTION_JOB_SOURCE_CHANGED' in err;passed.append('replay-refused')
 # The exact original command's advisory-lock branch refuses an overlapping
 # owner before invoking its real prune. No financial function is substituted.
 holder=subprocess.Popen([str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  holder.stdin.write("SELECT pg_advisory_lock(hashtext('sp-prune-hand-history'));SELECT 'held';\n");holder.stdin.flush();holder.stdout.readline();assert holder.stdout.readline().strip()=='held'
  _,answer,_=e.sql(db,COMMAND,label='cadence-original-overlap-refusal');assert answer.strip()=='skipped: previous run still in progress';passed.append('original-advisory-owner-skips-overlap')
 finally:
  if holder.poll() is None:holder.terminate();holder.wait(timeout=10)
 yes("SELECT active AND md5(command)='96244362bf46b39e75ef1100b1372203' AND schedule='* * * * *' FROM cron.job WHERE jobid=117;",'native-final-active-command-readback')
 e.report['retention_cadence_proven']=passed;e.report['retention_cadence_native']={'extension_version':version.strip(),'actual_C_API':True,'scheduler_execution_disabled':True,'production_capacity_verified':False,'one_instance_contract_source':'https://github.com/citusdata/pg_cron#how-pg_cron-works'}
 return passed

if __name__=='__main__':
 import argparse,hashlib,sys
 parser=argparse.ArgumentParser();parser.add_argument('--evidence',type=Path,required=True);parser.add_argument('--pg-bin',type=Path,required=True);parser.add_argument('--prune-source',type=Path,required=True);parser.add_argument('--socket-parent',type=Path,required=True)
 args=parser.parse_args();root=Path(__file__).resolve().parents[2]
 try:
  report=qualify_definition(root,args.evidence.resolve(),args.pg_bin.resolve(),args.prune_source.read_text(),args.socket_parent.resolve())
  report['captured_prune_source_sha256']=hashlib.sha256(args.prune_source.read_bytes()).hexdigest()
  (args.evidence/'result.json').write_text(json.dumps(report,indent=2)+'\n');print(report['status'],len(report['retention_cadence_proven']),len(report['retention_subminute_proven']))
 except BaseException as exc:
  print(repr(exc));sys.exit(1)
