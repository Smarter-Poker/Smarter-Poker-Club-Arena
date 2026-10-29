"""Finite real-PG17 maintenance admission qualification; no production DSN."""
from pathlib import Path
import argparse,hashlib,json,os,re,subprocess,tempfile,time
p=argparse.ArgumentParser(description=__doc__)
for name in ('repository','scratch','pg-bin','migration','output'):p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();r=a.repository.resolve();here=Path(__file__).resolve().parent;pg=a.pg_bin.resolve();a.scratch.mkdir(parents=True,exist_ok=True)
rows=json.loads((here/'preimages.json').read_text());candidate=a.migration.read_text()
inputs=[a.migration,here/'preimages.json',here/'postimages.json',Path(__file__),r/'scripts/ci/fixtures/hand-prune-one-page.sql',r/'supabase/migrations/20261029154153_hand_history_pruning_commits_one_raw_page_before_releasing_m.sql']
source={str(x.resolve().relative_to(r)):hashlib.sha256(x.read_bytes()).hexdigest() for x in inputs}
assert ' 17.' in subprocess.check_output([str(pg/'postgres'),'--version'],text=True)
report={'production_actions':False,'source_sha256':source,'passed':False,'cases':[]}
with tempfile.TemporaryDirectory(prefix='ma-',dir=a.scratch) as temp:
 root=Path(temp);sock=root/'s';sock.mkdir();data=root/'d';started=False;children=[]
 env=dict(os.environ,PGHOST=str(sock),PGPORT='5432',PGUSER='journal_test',PGDATABASE='postgres',PGSSLMODE='disable')
 q=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1']
 def command(argv,text=None,check=True,timeout=45):
  x=subprocess.run([str(z) for z in argv],input=text,text=True,capture_output=True,env=env,timeout=timeout)
  if check and x.returncode:raise AssertionError(x.stderr[-3500:])
  return x
 def sql(s,check=True):return command(q,s,check)
 def scalar(s):return sql(s).stdout.strip().splitlines()[-1]
 def launch(s,keep=False):
  x=subprocess.Popen(q,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);x.stdin.write(s+'\n');x.stdin.flush()
  if not keep:x.stdin.close()
  children.append(x);return x
 def finish(x,check=True,timeout=40):
  x.wait(timeout=timeout);out=x.stdout.read();err=x.stderr.read()
  if check and x.returncode:raise AssertionError(err[-3500:])
  return x.returncode,out,err
 def wait_for(predicate,label):
  deadline=time.monotonic()+4
  while scalar('SELECT ('+predicate+')::text;')!='true':
   if time.monotonic()>deadline:raise AssertionError('Missing real barrier: '+label)
   time.sleep(.005)
 def held(sqltext,marker):
  x=launch(sqltext+';SELECT pg_advisory_lock(530092,'+str(marker)+');',True)
  wait_for("EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=530092 AND objid="+str(marker)+' AND granted)','holder '+str(marker));return x
 def release(x):x.stdin.write('ROLLBACK;\n');x.stdin.close();finish(x)
 def observe(app,key,granted=False,mode=None):
  pred="EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity s ON s.pid=l.pid WHERE s.application_name='"+app+"' AND l.locktype='advisory' AND l.classid=530090 AND l.objid="+str(key)+' AND l.granted='+str(granted).lower()
  if mode:pred+=" AND l.mode='"+mode+"'"
  return pred+')'
 def case(name):report['cases'].append(name)
 try:
  command([pg/'initdb','-D',data,'-U','journal_test','-A','trust','--no-locale','-E','UTF8'])
  with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\n")
  command([pg/'pg_ctl','-D',data,'-l',root/'server.log','-w','start']);started=True
  # Existing pruner fixture dependency shapes instrument disposal hooks.
  # Economic correctness is not inferred from these isolated hook shapes.
  existing=(r/'scripts/ci/fixtures/hand-prune-one-page.sql').read_text();bootstrap=existing[:existing.index('CREATE OR REPLACE FUNCTION public.sp_prune_hand_history')]
  sql(bootstrap)
  sql("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.role',true)$$; CREATE TABLE engine_maintenance_break(id boolean PRIMARY KEY,phase text,announced_at timestamptz,break_started_at timestamptz,break_ends_at timestamptz,reason text,ownership_token uuid,declared_by text,updated_at timestamptz,enforce_freeze boolean); CREATE TABLE engine_maintenance_thaws(contract_version integer,release_target_at timestamptz,shifted jsonb); GRANT SELECT,INSERT,UPDATE,DELETE ON engine_maintenance_break TO service_role; GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;")
  for x in rows:
   sql(x['definition'].rstrip()+';ALTER FUNCTION '+x['signature']+' OWNER TO postgres;REVOKE ALL ON FUNCTION '+x['signature']+' FROM PUBLIC;')
   for grant in x['acl'].strip('{}').split(','):
    role=grant.split('=')[0]
    if role!='postgres':sql('GRANT EXECUTE ON FUNCTION '+x['signature']+' TO '+role+';')
  sql("CREATE TRIGGER aa_serialize_maintenance_break_write BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON engine_maintenance_break FOR EACH STATEMENT EXECUTE FUNCTION fn_serialize_engine_maintenance_break_write();")
  prune=(r/'supabase/migrations/20261029154153_hand_history_pruning_commits_one_raw_page_before_releasing_m.sql').read_text()
  definition=re.search(r'CREATE OR REPLACE FUNCTION public\.sp_prune_hand_history\(.*?\$function\$;',prune,re.S).group()
  sql(definition)
  assert scalar("SELECT md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure));")=='1b2f59cf765985058a8b146f9ed986d1'
  sql("CREATE OR REPLACE FUNCTION smarter_private.horse_cash_retention_accounting_ready(uuid,integer) RETURNS boolean LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_xact_lock_shared(530091,7); PERFORM pg_sleep(2);RETURN true;END$$;")
  token='00000000-0000-0000-0000-000000000001';nexttoken='00000000-0000-0000-0000-000000000002'
  def seed():sql("TRUNCATE hand_history;DELETE FROM engine_maintenance_break;INSERT INTO engine_maintenance_break VALUES(true,'last_hand',clock_timestamp(),NULL,NULL,'native','"+token+"',NULL,clock_timestamp(),true); UPDATE smarter_private.hand_history_prune_cursor SET resume_after=NULL,resume_id=NULL,pass_started_at=NULL;INSERT INTO hand_history VALUES('00000000-0000-0000-0000-000000000099','[]',now()-interval '9 days',NULL,NULL,99,false,false);")
  def race(phase):
   seed();gate=held('BEGIN;SELECT pg_advisory_xact_lock(530091,7)',7)
   pruner=launch("SET application_name='ma_pruner';SELECT sp_prune_hand_history(250);")
   wait_for(observe('ma_pruner',1,True,'ShareLock'),'pruner original shared lane')
   wait_for("EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity s ON s.pid=l.pid WHERE s.application_name='ma_pruner' AND l.locktype='advisory' AND l.classid=530091 AND l.objid=7 AND NOT l.granted)",'first guard')
   writer=launch("SET application_name='ma_writer';SET ROLE service_role;SELECT fn_claim_engine_maintenance_break('"+token+"','"+nexttoken+"','native');")
   wait_for(observe('ma_writer',1 if phase=='old' else 2,False,'ExclusiveLock'),'maintenance admission '+phase)
   if phase=='new':assert scalar('SELECT '+observe('ma_writer',1,False)+';')=='f'
   retainer=launch("SET application_name='ma_retainer';SELECT smarter_private.lock_hand_continuation_maintenance_lane();")
   code,out,err=finish(retainer,False,3)
   if phase=='old':assert code and 'lock timeout' in err,err
   else:assert code==0,err
   release(gate);finish(pruner);finish(writer)
   assert scalar('SELECT ownership_token::text FROM engine_maintenance_break;')==nexttoken
   case('actual_slow_pruner_'+phase+('_retainer_55P03' if phase=='old' else '_waits_only_key2_retainer_pass'))
  race('old')
  inside=candidate[candidate.index('BEGIN;\n')+len('BEGIN;\n'):-len('COMMIT;\n')]
  sql('SET ROLE postgres;BEGIN;'+inside+'ROLLBACK;')
  assert scalar("SELECT to_regprocedure('smarter_private.maintenance_write_admission()') IS NULL;")=='t'
  for x in rows:assert scalar("SELECT md5(pg_get_functiondef('"+x['signature']+"'::regprocedure));")==x['full_md5']
  case('full_installation_rollback_exact_preimages')
  target=next(x for x in rows if x['signature'].startswith('fn_claim_engine'))
  sql('ALTER FUNCTION '+target['signature']+" SET lock_timeout='31s';")
  bad=sql('SET ROLE postgres;'+candidate,False);assert bad.returncode and 'MAINTENANCE_WRITE_PREIMAGE_CHANGED' in bad.stderr
  sql('ALTER FUNCTION '+target['signature']+" SET lock_timeout='32s';")
  assert scalar("SELECT to_regprocedure('smarter_private.maintenance_write_admission()') IS NULL;")=='t'
  case('installation_config_drift_refused_atomically')
  sql('SET ROLE postgres;'+candidate);race('new')
  before=scalar('SELECT ownership_token::text FROM engine_maintenance_break;')
  assert 'ownership_token_required' in scalar("SELECT fn_claim_engine_maintenance_break(NULL,NULL,NULL);")
  assert 'ownership_changed' in scalar("SELECT fn_claim_engine_maintenance_break('"+token+"','"+token+"',NULL);")
  assert scalar('SELECT ownership_token::text FROM engine_maintenance_break;')==before
  for role in ('anon','authenticated'):
   bad=sql('SET ROLE '+role+";SELECT fn_claim_engine_maintenance_break(NULL,NULL,NULL);",False);assert bad.returncode and 'permission denied' in bad.stderr
  bad=sql('SET ROLE service_role;SELECT smarter_private.maintenance_write_admission();',False);assert bad.returncode and 'permission denied' in bad.stderr
  case('actual_token_and_permission_refusals_preserved')
  sql("SET ROLE service_role;SELECT fn_save_engine_maintenance_break('last_hand',clock_timestamp(),NULL,NULL,'native','native','"+nexttoken+"');")
  assert scalar("SELECT fn_clear_engine_maintenance_break(phase,announced_at,break_started_at,break_ends_at,reason,'"+token+"') FROM engine_maintenance_break;")=='f'
  assert scalar("SELECT fn_clear_engine_maintenance_break(phase,announced_at,break_started_at,break_ends_at,reason,ownership_token) FROM engine_maintenance_break;")=='t'
  case('actual_save_clear_and_wrong_owner_preserved')
  seed();shared=held('BEGIN;SELECT pg_advisory_xact_lock_shared(530090,1)',9)
  original=scalar('SELECT reason FROM engine_maintenance_break;')
  bad=sql("SET ROLE service_role;UPDATE engine_maintenance_break SET reason='wrong';",False)
  assert bad.returncode and 'MAINTENANCE_RAW_WRITE_ADMISSION_BUSY' in bad.stderr
  assert scalar('SELECT reason FROM engine_maintenance_break;')==original
  release(shared);case('raw_service_write_refuses_without_queue_or_false_ack')
  h2=held('BEGIN;SELECT pg_advisory_xact_lock(530090,2)',12)
  sql("BEGIN;SET LOCAL statement_timeout='500ms';SELECT pg_advisory_xact_lock(530090,1);SELECT smarter_private.maintenance_write_admission();UPDATE engine_maintenance_break SET reason='nested';ROLLBACK;")
  release(h2);case('reentrant_global_owner_never_inverts_into_key2')
  assert scalar("BEGIN;SET LOCAL lock_timeout='87ms';SELECT smarter_private.maintenance_write_admission();SELECT current_setting('lock_timeout');ROLLBACK;")=='87ms'
  case('caller_lock_timeout_restored_after_success')
  sql("UPDATE engine_maintenance_break SET phase='counting_down',announced_at=now()-interval '8 minutes',break_started_at=now()-interval '6 minutes',break_ends_at=now()-interval '1 minute';")
  assert scalar('SELECT fn_platform_frozen();')=='t'
  steps=['sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until','reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at','cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at','cluster_break_eligible_since','cluster_move_expires_at','reconnect_presence','reconnect_snapshots']
  shifted=json.dumps(dict(complete=True,**dict.fromkeys(steps,0)))
  sql("DELETE FROM engine_maintenance_break;INSERT INTO engine_maintenance_thaws VALUES(3,now()+interval '1 minute','"+shifted+"'::jsonb);")
  assert scalar('SELECT fn_platform_frozen();')=='t';sql('TRUNCATE engine_maintenance_thaws;')
  case('actual_expired_countdown_and_completed_future_release_boundary_stay_frozen')
  # Two real waits share the existing32s budget, not32s for each lock.
  h2=held('BEGIN;SELECT pg_advisory_xact_lock(530090,2)',20)
  h1=held('BEGIN;SELECT pg_advisory_xact_lock_shared(530090,1)',21)
  began=time.monotonic();pending=launch("SET application_name='ma_budget';SELECT smarter_private.maintenance_write_admission();")
  wait_for(observe('ma_budget',2,False),'budget reservation wait');sql('SELECT pg_sleep(1.25);');release(h2)
  wait_for(observe('ma_budget',1,False),'budget remaining global wait')
  code,out,err=finish(pending,False,36);elapsed=time.monotonic()-began
  assert code and 'lock timeout' in err and 31<elapsed<34,(elapsed,err)
  release(h1);report['total_admission_seconds']=elapsed;case('two_real_waits_share_one32second_budget')
  post=json.loads((here/'postimages.json').read_text())
  for x in post['changes']:assert scalar("SELECT md5(pg_get_functiondef('public."+x['signature']+"'::regprocedure));")==x['post_full_md5']
  for x in rows:
   if x['signature'].startswith(('fn_platform_frozen','fn_active_maintenance_release','smarter_private.certification')):assert scalar("SELECT md5(pg_get_functiondef('"+x['signature']+"'::regprocedure));")==x['full_md5']
  assert all(hashlib.sha256((r/name).read_bytes()).hexdigest()==digest for name,digest in source.items())
  report['passed']=True
 finally:
  for child in children:
   if child.poll() is None:child.terminate();child.wait(timeout=4)
  if started:command([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'],check=False)
  a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
