"""Actual payer and original transaction locks on two private PostgreSQL sessions."""
import json,os,subprocess,sys,time,concurrent.futures
psql,socket,port=sys.argv[1:]
base=[psql,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','postgres','-h',socket,'-p',port,'-d','postgres']
def query(sql):return subprocess.check_output(base+['-c',sql],text=True).strip()
def connection(name):return subprocess.Popen(base,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,env=dict(os.environ,PGAPPNAME=name))
def write(p,sql):p.stdin.write(sql+'\n');p.stdin.flush()
def until(p,marker):
 lines=[]
 while True:
  line=p.stdout.readline()
  if not line:raise AssertionError('ended before '+marker+': '+p.stderr.read())
  if line.strip()==marker:return '\n'.join(lines)
  lines.append(line)
def finish(p):
 p.stdin.close();code=p.wait(timeout=6)
 return code,p.stderr.read()
def wait_lock(name):
 limit=time.monotonic()+5
 while time.monotonic()<limit:
  if query("SELECT count(*) FROM pg_stat_activity WHERE application_name='"+name+"' AND wait_event_type='Lock' AND wait_event='advisory'")=='1':return
  time.sleep(.02)
 raise AssertionError('expected original book lock wait')
book="hashtextextended('union-pnl-inventory:'||extract(epoch FROM '2026-09-07 07:00Z'::timestamptz)::bigint::text,0)"
period="hashtextextended('union-accounting:00000000-0000-0000-0000-000000000201:'||extract(epoch FROM '2026-09-07 07:00Z'::timestamptz)::text||':'||extract(epoch FROM '2026-09-14 07:00Z'::timestamptz)::text,0)"
call="SET request.jwt.claims='{\"role\":\"service_role\",\"sub\":\"00000000-0000-0000-0000-000000000900\"}'; SELECT fn_union_settle_player_pnl(fixture.u(201),'2026-09-07 07:00Z','2026-09-14 07:00Z',false);"
# Placement of a real still-running transaction on the isolated old calendar.
# The source uses precisely this book shared lock before its Union period lock.
source=query("SELECT pg_get_functiondef('fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)'::regprocedure)")
needle='  PERFORM public.fn_union_pnl_closed_book_barrier(p_end);'
assert source.count(needle)==1

def race(old=False):
 writer=connection('weekly_original_pending_writer')
 write(writer,"BEGIN; SET LOCAL deadlock_timeout='100ms'; SET LOCAL lock_timeout='3s'; SELECT pg_advisory_xact_lock_shared("+book+"); INSERT INTO union_pnl_transaction_frames VALUES(pg_current_xact_id(),'2026-09-10 12:00Z','2026-09-07 07:00Z'); UPDATE table_seats SET stack=stack+0.01 WHERE user_id=fixture.u(903); SELECT 'pending';")
 until(writer,'pending')
 reader=connection('weekly_actual_payer')
 write(reader,"SET deadlock_timeout='100ms'; SET lock_timeout='3s'; "+call+" SELECT 'payer-complete';")
 wait_lock('weekly_actual_payer')
 write(writer,'SELECT pg_advisory_xact_lock('+period+"); ROLLBACK; SELECT 'writer-complete';")
 if old:
  writer.stdin.close();reader.stdin.close();writer.stdin=None;reader.stdin=None
  with concurrent.futures.ThreadPoolExecutor(2) as pool:
   outputs=list(pool.map(lambda p:p.communicate(timeout=8),[writer,reader]))
  codes=[p.returncode for p in [writer,reader]]
  errors='\n'.join(x[1] for x in outputs)
  assert sum(c!=0 for c in codes)==1 and 'deadlock detected' in errors,(codes,errors)
  print('PASS: original period-before-book payer reproduces the real lock cycle')
 else:
  until(writer,'writer-complete');assert finish(writer)[0]==0
  result=json.loads(until(reader,'payer-complete').strip())
  assert result.get('success') is True and result.get('already_settled') is True,result
  assert finish(reader)[0]==0
  print('PASS: actual repaired payer waits before its period lock, then sees committed original state and replays once')
try:
 query(source.replace(needle,''));race(old=True)
finally:query(source)
race()
