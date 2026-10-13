#!/usr/bin/env python3
"""Private PG17 original cash concurrency and response interruption, real RPC only."""
import argparse,json,pathlib,subprocess,os,uuid,time,threading,queue
p=argparse.ArgumentParser();p.add_argument('--state',type=pathlib.Path,required=True);a=p.parse_args();state=json.loads(a.state.read_text());out=a.state.parent
assert str(a.state.resolve()).startswith('/Volumes/SmarterWork/agent-work/')
assert str(pathlib.Path(state['socket']).resolve()).startswith('/Volumes/SmarterWork/agent-work/')
env={k:v for k,v in os.environ.items() if not k.startswith('PG') and k not in ('DATABASE_URL','SUPABASE_DB_URL')};env.update(LC_ALL='C',LANG='C',TZ='UTC')
base=[state['pg_bin']+'/psql','-X','-qAt','-h',state['socket'],'-p','55496','-U','postgres','-d',state['database'],'-v','ON_ERROR_STOP=1']
def query(sql):
 r=subprocess.run(base+['-c',sql],env=env,capture_output=True,text=True,timeout=10)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
assert query("SELECT inet_server_addr() IS NULL AND current_setting('server_version_num')::int BETWEEN 170000 AND 179999")=='t'
submission,table=query('SELECT submission_id,table_id FROM smarter_private.hand_submissions ORDER BY submission_id LIMIT 1').split('|');generation=str(uuid.uuid4());instance='cash17-native-concurrency'
query("BEGIN;DO $q$ DECLARE l record;BEGIN PERFORM smarter_private.certify_original_hand_source_correction('"+submission+"');SELECT * INTO l FROM public.claim_table_lease_v2('"+table+"','"+instance+"','native-only','"+generation+"',public.fn_engine_lease_stale_seconds());IF l.granted IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'ACTUAL_CLAIM_NOT_GRANTED';END IF;END $q$;COMMIT;")
results=[];children=[]
def start(name):
 e=env.copy();e['PGAPPNAME']=name
 proc=subprocess.Popen(base,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=e,bufsize=1);children.append(proc);lines=[];errs=[];events=queue.Queue()
 def consume(pipe,dest,event=False):
  for line in pipe:dest.append(line);events.put(line.strip()) if event else None
 threading.Thread(target=consume,args=(proc.stdout,lines,True),daemon=True).start();threading.Thread(target=consume,args=(proc.stderr,errs),daemon=True).start()
 return proc,lines,errs,events
rpc="public.fn_ca_resume_hand_submission('"+table+"','"+instance+"','"+generation+"')"
def send(proc,s):proc.stdin.write(s+'\n');proc.stdin.flush()
def ready(q,expected):
 deadline=time.monotonic()+15
 while time.monotonic()<deadline:
  try:
   if q.get(timeout=.2)==expected:return
  except queue.Empty:pass
 raise RuntimeError('Financial barrier never reached')
try:
 for mode in ('interrupt','duplicate'):
  suffix=uuid.uuid4().hex[:10];nameA='cash17-owned-A-'+suffix;nameB='cash17-owned-B-'+suffix
  A,al,ae,aq=start(nameA)
  send(A,"BEGIN;SET LOCAL request.jwt.claim.role='service_role';DO $q$ DECLARE r jsonb;BEGIN r:="+rpc+";IF r->'completed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'ORIGINAL_A_NOT_COMPLETED';END IF;END $q$;SELECT 'A_FINANCIAL_READY';")
  ready(aq,'A_FINANCIAL_READY')
  B,bl,be,bq=start(nameB)
  send(B,"BEGIN;SET LOCAL request.jwt.claim.role='service_role';SELECT ("+rpc+"->'completed')='true'::jsonb;COMMIT;");B.stdin.close()
  deadline=time.monotonic()+15;seen=None
  while time.monotonic()<deadline:
   value=query("SELECT b.pid,b.wait_event_type,b.wait_event,a.pid=ANY(pg_blocking_pids(b.pid)) FROM pg_stat_activity b CROSS JOIN pg_stat_activity a WHERE b.application_name='"+nameB+"' AND a.application_name='"+nameA+"'")
   if value:
    vals=value.split('|')
    if vals[1]=='Lock' and vals[3]=='t':seen=vals;break
   if B.poll() is not None:raise RuntimeError('Second original did not wait for owning first transaction')
   time.sleep(.05)
  if not seen:raise RuntimeError('Actual original transaction lock barrier not observed')
  if mode=='interrupt':
   assert query('SELECT pg_cancel_backend('+seen[0]+')')=='t'
   assert B.wait(timeout=10)!=0
   deadline=time.monotonic()+3
   while not be and time.monotonic()<deadline:time.sleep(.02)
   assert 'canceling statement due to user request' in ''.join(be)
   send(A,"ROLLBACK;SELECT 'A_DONE';");ready(aq,'A_DONE');A.stdin.close();assert A.wait(timeout=10)==0
   assert query("SELECT count(*) FROM public.hand_atomic_commits WHERE table_id='"+table+"' AND hand_number=(SELECT hand_number FROM smarter_private.hand_submissions WHERE submission_id='"+submission+"')")=='0'
   assert query("SELECT count(*) FROM smarter_private.hand_submission_correction_claims WHERE submission_id='"+submission+"'")=='0'
   assert query("SELECT count(*) FROM smarter_private.hand_submission_correction_results WHERE submission_id='"+submission+"'")=='0'
  else:
   send(A,"COMMIT;SELECT 'A_DONE';");ready(aq,'A_DONE');A.stdin.close();assert A.wait(timeout=10)==0;assert B.wait(timeout=10)==0
   deadline=time.monotonic()+3
   while not bl and time.monotonic()<deadline:time.sleep(.02)
   assert ''.join(bl).strip()=='t'
   assert query("SELECT (SELECT count(*) FROM smarter_private.hand_submission_correction_claims WHERE submission_id='"+submission+"'),(SELECT count(*) FROM smarter_private.hand_submission_correction_results WHERE submission_id='"+submission+"'),(SELECT count(*) FROM public.poker_diamond_hand_receipts WHERE table_id='"+table+"' AND hand_number=(SELECT hand_number FROM smarter_private.hand_submissions WHERE submission_id='"+submission+"'))")=='1|1|1'
  results.append({'mode':mode,'actualWaitEvent':seen[2],'blockingOwnerObserved':True,'passed':True})
  (out/('cash17-native-'+mode+'-A.stdout')).write_text(''.join(al));(out/('cash17-native-'+mode+'-A.stderr')).write_text(''.join(ae));(out/('cash17-native-'+mode+'-B.stdout')).write_text(''.join(bl));(out/('cash17-native-'+mode+'-B.stderr')).write_text(''.join(be))
 (out/'cash17-native-concurrency-result.json').write_text(json.dumps({'production':False,'privatePG17':True,'sameOriginal':submission,'controlledBarrier':results})+'\n')
 print(json.dumps({'interruption':'PASS','sameOriginalDuplicate':'PASS','actualObservedLocks':results}))
finally:
 for child in children:
  if child.poll() is None:child.terminate()
  try:child.wait(timeout=5)
  except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
