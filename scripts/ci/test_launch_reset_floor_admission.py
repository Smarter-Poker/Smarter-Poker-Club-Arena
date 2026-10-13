"""Source-bound scoped tournament creation/start regression and original floor lock race."""
from pathlib import Path
import argparse,hashlib,json,os,re,subprocess,tempfile,time
parser=argparse.ArgumentParser();parser.add_argument('--candidate',required=True,type=Path);parser.add_argument('--fixture',type=Path,default=Path(__file__).with_name('floor-admission-qualification.sql'));parser.add_argument('--work-root',type=Path);parser.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/opt/homebrew/bin')));args=parser.parse_args()
fixture=args.fixture.read_text();candidate=args.candidate.read_text();pat=r'CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\([^;]*?\s+AS\s+(\$[^$]*\$)(.*?)\2;'
def bodies(sql):return {m.group(1):m.group(3) for m in re.finditer(pat,sql,re.S)}
f=bodies(fixture);c=bodies(candidate);names=['fn_ca_launch_tournament_held','fn_ca_launch_tournament_has_started','fn_ca_launch_tournament_start_refused','fn_ca_launch_tournament_admission_guard','fn_begin_tournament_launch_before_lease_generation','fn_spin_draw_and_settle_atomic','fn_spin_settle_game']
for n in names:
 if n not in c or f.get(n)!=c[n]:raise SystemExit('Candidate admission postimage missing or changed: '+n)
trigger=r'CREATE TRIGGER zzzzzzzz_launch_tournament_admission\b[^;]*;'
ft=re.search(trigger,fixture,re.S);ct=re.search(trigger,candidate,re.S)
if not ft or not ct or re.sub(r'\s+',' ',ft.group())!=re.sub(r'\s+',' ',ct.group()):raise SystemExit('Candidate admission trigger missing or changed')
parent=args.work_root or args.fixture.resolve().parent;parent.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='fa-',dir=parent)as folder:
 root=Path(folder);socket=root/'s';socket.mkdir(mode=0o700);data=root/'d';env=dict(os.environ,PGHOST=str(socket),PGUSER='fixture',PGDATABASE='postgres',PGPORT='5432',PGSSLMODE='disable')
 def run(cmd,sql=None):
  r=subprocess.run([str(x)for x in cmd],input=sql,text=True,capture_output=True,env=env,timeout=60)
  if r.returncode:raise RuntimeError(r.stderr)
  return r.stdout
 q=[args.pg_bin/'psql','-X','-At','-v','ON_ERROR_STOP=1'];holder=None;waiter=None;started=False
 run([args.pg_bin/'initdb','-D',data,'-U','fixture','--auth-local=trust','--auth-host=reject','--no-locale'])
 with(data/'postgresql.conf').open('a')as g:g.write("\nlisten_addresses=''\nunix_socket_directories='"+str(socket)+"'\n")
 try:
  run([args.pg_bin/'pg_ctl','-D',data,'-l',root/'server.log','-w','start']);started=True;run(q,fixture)
  holder=subprocess.Popen([str(x)for x in q],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
  holder.stdin.write("BEGIN; SELECT pg_advisory_xact_lock(530093); INSERT INTO ca_operator_floor_hold(id,operation_id,mode,reason) VALUES(true,'20000000-0000-0000-0000-000000000001','park','Scoped concurrency qualification'); SELECT 'PARK_LOCK_HELD';\n");holder.stdin.flush()
  while holder.stdout.readline().strip()!='PARK_LOCK_HELD':
   if holder.poll()is not None:raise RuntimeError(holder.stderr.read())
  race_env=dict(env,PGAPPNAME='launch-floor-waiter')
  waiter=subprocess.Popen([str(x)for x in q]+['-c',"INSERT INTO tournaments(name,buy_in_amount,buy_in_fee,start_time,ban_chat,max_players,club_id) VALUES('race blocked spawn',1,0,now(),false,60,'fade0000-0000-0000-0000-000000000001')"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=race_env)
  deadline=time.monotonic()+5;blocked=False
  while time.monotonic()<deadline:
   observed=run(q,"SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='launch-floor-waiter' AND l.locktype='advisory' AND l.objid=530093 AND NOT l.granted);").strip()
   if observed=='t':blocked=True;break
   if waiter.poll()is not None:break
   time.sleep(.02)
  if not blocked:raise AssertionError('Creation did not serialize behind original exclusive floor lock')
  if run(q,"SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='launch-floor-waiter' AND l.locktype='advisory' AND l.classid=530090 AND l.objid=1 AND l.objsubid=2 AND l.mode='ShareLock' AND l.granted);").strip()!='t':raise AssertionError('Waiting floor writer did not first own original global530090,1 lane')
  holder.stdin.write('COMMIT;\n\\q\n');holder.stdin.flush();holder.communicate(timeout=10)
  out,err=waiter.communicate(timeout=10)
  if waiter.returncode==0 or 'OPERATOR_FLOOR_PARKED'not in err:raise AssertionError('Waiter did not see committed hold after statement began: '+err)
  if run(q,"SELECT count(*) FROM tournaments WHERE name='race blocked spawn';").strip()!='0':raise AssertionError('Blocked spawn persisted')
  print(json.dumps({'native_floor_admission':'passed','source_binding':'seven exact candidate function postimages and actual trigger','original_before':'creation/status/launch claim remained open under scoped hold','after':'scoped creation/status/timestamp/union/partial claim/atomic and legacy spin launch refused; outside and played recovery preserved','concurrency':'actual global530090,1 shared acquired before waiting on exclusive530093; after commit writer sees hold and refuses before persistence','candidate_sha256':hashlib.sha256(candidate.encode()).hexdigest(),'fixture_sha256':hashlib.sha256(fixture.encode()).hexdigest(),'production_installation':False,'financial_finish_or_refund_qualification':False}))
 finally:
  for proc in[waiter,holder]:
   if proc is not None and proc.poll()is None:
    proc.terminate()
    try:proc.wait(timeout=5)
    except subprocess.TimeoutExpired:proc.kill();proc.wait()
  if started:run([args.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
