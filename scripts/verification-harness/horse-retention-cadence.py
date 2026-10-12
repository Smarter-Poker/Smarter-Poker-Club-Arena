"""Guarded existing-job cadence qualification with the real native pg_cron API.
No production connection or schedule is used. The original held state stays held.
"""
import json,subprocess,shlex
from pathlib import Path
from satellite_qualifier_fixture import sha,lit
MIG=Path('supabase/migrations/20261012174649_existing_horse_retention_cadence_follows_measured_bounded_wo.sql')
COMMAND="\nselect case\n         when pg_try_advisory_lock(hashtext('sp-prune-hand-history'))\n           then (select set_config('statement_timeout','30s',true) is not null\n                    and public.sp_prune_hand_history(5000) >= 0)::text\n         else 'skipped: previous run still in progress'\n       end;\n"
def qualify(e,template):
 root=e.root;passed=[]
 e.report['source_sha256'].update({str(MIG):sha(root/MIG),'scripts/verification-harness/horse-retention-cadence.py':sha(Path(__file__))})
 # The existing native owner has finished all transient clients. Restart only
 # its private cluster with the already installed scheduler library; disable
 # launching jobs while proving the actual C API, rather than model cron.job.
 e.run('cadence-private-stop',[e.pg/'pg_ctl','-D',e.cluster,'-w','stop','-m','fast'])
 with (e.cluster/'postgresql.conf').open('a') as f:f.write("\nshared_preload_libraries='pg_cron'\ncron.database_name='postgres'\ncron.use_background_workers=on\ncron.launch_active_jobs=off\n")
 e.run('cadence-private-start',[e.pg/'pg_ctl','-D',e.cluster,'-l',e.output/'postgres.log','-o',shlex.join(['-k',str(e.socket),'-p',e.port,'-c','listen_addresses=','-c','shared_buffers=32MB','-c','max_connections=16','-c','max_locks_per_transaction=128','-c','max_wal_size=128MB','-c','min_wal_size=32MB']),'-w','start'])
 db='postgres'
 def yes(q,label):
  _,v,_=e.sql(db,q,label='cadence-'+label);assert v.strip()=='t',(label,v);passed.append(label)
 e.sql(db,'CREATE EXTENSION pg_cron;',label='cadence-real-native-extension')
 _,version,_=e.sql(db,"SELECT extversion FROM pg_extension WHERE extname='pg_cron';",label='cadence-real-native-version')
 assert version.strip().startswith('1.6'),version
 _,definition,_=e.sql(template,"SELECT pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure);",label='cadence-real-original-prune-source')
 e.sql(db,definition,label='cadence-actual-budget-source')
 e.sql(db,"SELECT setval('cron.jobid_seq',117,false);SELECT cron.schedule('sp_prune_hand_history_10m','3,13,23,33,43,53 * * * *',"+lit(COMMAND)+");SELECT cron.alter_job(117,active:=false);UPDATE cron.job SET nodeport=5432;SELECT setval('cron.jobid_seq',119,false);SELECT cron.schedule('native-unrelated-job','17 * * * *','SELECT 1');SELECT cron.alter_job(119,active:=false);",label='cadence-existing-held-native-job-fixture')
 _,before,_=e.sql(db,"SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j;",label='cadence-original-job-image')
 e.sql(db,'BEGIN;'+(root/MIG).read_text().replace('BEGIN;','',1).rsplit('COMMIT;',1)[0]+'ROLLBACK;',label='cadence-rollback')
 _,rolled,_=e.sql(db,"SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j;",label='cadence-rollback-readback');assert json.loads(before)==json.loads(rolled);passed.append('configuration-rollback-exact')
 for column,value in [('command',"'SELECT 1'"),('username',"'other-owner'"),('schedule',"'*/5 * * * *'"),('database',"'other-database'")]:
  q='BEGIN;UPDATE cron.job SET '+column+'='+value+' WHERE jobid=117;'+(root/MIG).read_text().replace('BEGIN;','',1).rsplit('COMMIT;',1)[0]+'ROLLBACK;'
  code,_,err=e.sql(db,q,label='cadence-refuse-'+column,check=False);assert code and 'HORSE_RETENTION_JOB_SOURCE_CHANGED' in err;passed.append(column+'-drift-refused')
 e.sql(db,file=root/MIG,label='cadence-real-c-api-install')
 _,after,_=e.sql(db,"SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j;",label='cadence-actual-native-postimage')
 a=json.loads(before);b=json.loads(after);assert len(a)==len(b)==2
 assert b[0]['schedule']=='* * * * *' and b[0]['active'] is False
 a[0].pop('schedule');b[0].pop('schedule');assert a==b;passed.extend(['only-existing-schedule-changes','safety-hold-remains-held','unrelated-job-byte-identical'])
 code,_,err=e.sql(db,file=root/MIG,label='cadence-replay-refused',check=False);assert code and 'HORSE_RETENTION_JOB_SOURCE_CHANGED' in err;passed.append('replay-refused')
 # The exact original command's advisory-lock branch refuses an overlapping
 # owner before invoking its real prune. No financial function is substituted.
 holder=subprocess.Popen([str(e.pg/'psql'),'-X','-qAt','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  holder.stdin.write("SELECT pg_advisory_lock(hashtext('sp-prune-hand-history'));SELECT 'held';\n");holder.stdin.flush();holder.stdout.readline();assert holder.stdout.readline().strip()=='held'
  _,answer,_=e.sql(db,COMMAND,label='cadence-original-overlap-refusal');assert answer.strip()=='skipped: previous run still in progress';passed.append('original-advisory-owner-skips-overlap')
 finally:
  if holder.poll() is None:holder.terminate();holder.wait(timeout=10)
 yes("SELECT NOT active AND md5(command)='96244362bf46b39e75ef1100b1372203' AND schedule='* * * * *' FROM cron.job WHERE jobid=117;",'native-final-held-command-readback')
 e.report['retention_cadence_proven']=passed;e.report['retention_cadence_native']={'extension_version':version.strip(),'actual_C_API':True,'scheduler_execution_disabled':True,'production_capacity_verified':False,'one_instance_contract_source':'https://github.com/citusdata/pg_cron#how-pg_cron-works'}
 return passed
