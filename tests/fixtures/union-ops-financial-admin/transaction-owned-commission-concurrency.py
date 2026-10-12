import subprocess,sys,selectors,time,os
from decimal import Decimal
p=[sys.argv[1],'-X','-At','-v','ON_ERROR_STOP=1','-h',sys.argv[2],'-p',sys.argv[3],'-U','postgres','-d','postgres']
club='95000000-0000-4000-8000-000000000001';agent='96000000-0000-4000-8000-000000000001'
def run(sql,ok=True):
 r=subprocess.run(p,input=sql,text=True,capture_output=True,timeout=12)
 if ok and r.returncode:raise AssertionError(r.stderr)
 return r
def ready(proc):
 deadline=time.monotonic()+12;pending=b''
 with selectors.DefaultSelector() as selector:
  selector.register(proc.stdout,selectors.EVENT_READ)
  while time.monotonic()<deadline:
   if not selector.select(max(0,deadline-time.monotonic())):break
   chunk=os.read(proc.stdout.fileno(),4096)
   if not chunk:break
   pending+=chunk
   if any(line.strip()==b'READY' for line in pending.splitlines()):return
 proc.kill();_,error=proc.communicate(timeout=12)
 raise AssertionError('native concurrency READY boundary failed: '+error)
def hold(sql):
 proc=subprocess.Popen(p,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 proc.stdin.write(sql);proc.stdin.close();ready(proc)
 return proc
def complete(proc):
 proc.stdin=None
 stdout,stderr=proc.communicate(timeout=12)
 assert proc.returncode==0,(stdout,stderr)
def exact(day,expected,label):
 q=f"SELECT d.amount,(SELECT COALESCE(SUM(a.amount),0) FROM agent_commissions a WHERE a.club_id=d.club_id AND a.user_id=d.user_id AND (a.created_at AT TIME ZONE 'UTC')::date=d.day) FROM smarter_private.agent_commission_report_daily d JOIN smarter_private.agent_commission_report_days m USING(club_id,day) WHERE m.complete AND d.club_id='{club}' AND d.user_id='{agent}' AND d.day={day};"
 vals=run(q).stdout.strip().split('|');assert len(vals)==2 and Decimal(vals[0])==Decimal(vals[1])==expected,(label,vals);print('COMMISSION_CONCURRENCY_PASS: '+label)
day="(now() AT TIME ZONE 'UTC')::date-1";day2="(now() AT TIME ZONE 'UTC')::date-2";day3="(now() AT TIME ZONE 'UTC')::date-3"
run(f"INSERT INTO clubs(id,name) VALUES('{club}','Concurrent Commission Fixture');")
# Existing writer holds the original key; initializer waits and then gets a fresh snapshot.
w=hold(f"BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('agent-commission:{club}',0));SELECT 'READY';INSERT INTO agent_commissions(club_id,user_id,amount,created_at) VALUES('{club}','{agent}',20,({day})::timestamp AT TIME ZONE 'UTC');SELECT pg_sleep(0.4);COMMIT;")
run(f"SELECT smarter_private.initialize_agent_commission_report_day('{club}',{day});");complete(w);exact(day,Decimal(20),'initializer waits for original writer without lost or doubled delta')
# Writer's source insert waits at its original AFTER owner while locked initializer commits.
i=hold(f"BEGIN;SELECT smarter_private.initialize_agent_commission_report_day('{club}',{day2});SELECT 'READY';SELECT pg_sleep(0.4);COMMIT;")
run(f"INSERT INTO agent_commissions(club_id,user_id,amount,created_at) VALUES('{club}','{agent}',10,({day2})::timestamp AT TIME ZONE 'UTC');");complete(i);exact(day2,Decimal(10),'original writer after initialization adds exactly once')
# An already-visible RR source/fact is legal, with no isolation restriction on money callers.
run(f"BEGIN ISOLATION LEVEL REPEATABLE READ;INSERT INTO agent_commissions(club_id,user_id,amount,created_at) VALUES('{club}','{agent}',3,({day})::timestamp AT TIME ZONE 'UTC');COMMIT;");exact(day,Decimal(23),'visible repeatable-read original financial insert remains legal')
# An initializer may not silently use a stale RR snapshot.
r=run(f"BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT smarter_private.initialize_agent_commission_report_day('{club}',{day});",False);assert r.returncode and 'COMMISSION_REPORT_INITIALIZATION_REQUIRES_FRESH_SNAPSHOT' in r.stderr;print('COMMISSION_CONCURRENCY_PASS: stale initializer snapshot refused')
run(f"INSERT INTO agent_commissions(club_id,user_id,amount,created_at) VALUES('{club}','{agent}',5,({day3})::timestamp AT TIME ZONE 'UTC');")
# Take RR snapshot before the baseline rewrites its existing pair fact; ON CONFLICT must serialize.
rr=subprocess.Popen(p,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
rr.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT count(*) FROM smarter_private.agent_commission_report_days;SELECT 'READY';\n");rr.stdin.flush()
ready(rr)
run(f"SELECT smarter_private.initialize_agent_commission_report_day('{club}',{day3});")
rr.stdin.write(f"INSERT INTO agent_commissions(club_id,user_id,amount,created_at) VALUES('{club}','{agent}',99,({day3})::timestamp AT TIME ZONE 'UTC');COMMIT;\n");rr.stdin.close();rr.stdin=None;_,err=rr.communicate(timeout=12);assert rr.returncode!=0 and 'serialize' in err,err;exact(day3,Decimal(5),'invisible concurrently initialized fact serializes whole original insert')
# A moved/amount correction with an invisible marker also conflicts, never leaves complete stale facts.
run(f"UPDATE agent_commissions SET amount=6 WHERE club_id='{club}' AND (created_at AT TIME ZONE 'UTC')::date={day3};")
rr=subprocess.Popen(p,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
rr.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT count(*) FROM smarter_private.agent_commission_report_days;SELECT 'READY';\n");rr.stdin.flush()
ready(rr)
run(f"SELECT smarter_private.initialize_agent_commission_report_day('{club}',{day3});")
rr.stdin.write(f"UPDATE agent_commissions SET amount=7 WHERE club_id='{club}' AND (created_at AT TIME ZONE 'UTC')::date={day3};COMMIT;\n");rr.stdin.close();rr.stdin=None;_,err=rr.communicate(timeout=12);assert rr.returncode!=0 and 'serialize' in err,err;exact(day3,Decimal(6),'concurrent correction cannot retain invisible stale completeness')

# Current/future frontier interleavings preserve the original financial caller.
future="(now() AT TIME ZONE 'UTC')::date+3"
club='95000000-0000-4000-8000-000000000002'
run(f"INSERT INTO clubs(id,name) VALUES('{club}','Concurrent Future Fixture');")
def future_exact(expected,label):
 vals=run(f"SELECT SUM(d.amount),(SELECT SUM(a.amount) FROM agent_commissions a WHERE a.club_id='{club}') FROM smarter_private.agent_commission_report_daily d WHERE d.club_id='{club}';").stdout.strip().split('|')
 assert len(vals)==2 and Decimal(vals[0])==Decimal(vals[1])==expected,(label,vals)
 print('COMMISSION_FRONTIER_PASS: '+label)
w=hold(f"BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('agent-commission:{club}',0));SELECT 'READY';INSERT INTO agent_commissions(club_id,user_id,amount,created_at) VALUES('{club}','{agent}',20,({future})::timestamp AT TIME ZONE 'UTC');SELECT pg_sleep(0.4);COMMIT;")
run(f"SELECT smarter_private.initialize_agent_commission_report_frontier('{club}');");complete(w);future_exact(Decimal(20),'frontier waits and captures already-committing future source exactly once')
club='95000000-0000-4000-8000-000000000003'
run(f"INSERT INTO clubs(id,name) VALUES('{club}','Concurrent Frontier First');")
i=hold(f"BEGIN;SELECT smarter_private.initialize_agent_commission_report_frontier('{club}');SELECT 'READY';SELECT pg_sleep(0.4);COMMIT;")
run(f"INSERT INTO agent_commissions(club_id,user_id,amount,created_at) VALUES('{club}','{agent}',10,({future})::timestamp AT TIME ZONE 'UTC');");complete(i);future_exact(Decimal(10),'writer after empty frontier establishes first future fact in original transaction')
club='95000000-0000-4000-8000-000000000004'
run(f"INSERT INTO clubs(id,name) VALUES('{club}','Invisible Future Frontier');INSERT INTO agent_commissions(club_id,user_id,amount,created_at) VALUES('{club}','{agent}',5,({future})::timestamp AT TIME ZONE 'UTC');")
rr=subprocess.Popen(p,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
rr.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT count(*) FROM smarter_private.agent_commission_report_frontiers;SELECT 'READY';\n");rr.stdin.flush();ready(rr)
run(f"SELECT smarter_private.initialize_agent_commission_report_frontier('{club}');")
rr.stdin.write(f"INSERT INTO agent_commissions(club_id,user_id,amount,created_at) VALUES('{club}','{agent}',99,({future})::timestamp AT TIME ZONE 'UTC');COMMIT;\n");rr.stdin.close();rr.stdin=None;_,err=rr.communicate(timeout=12);assert rr.returncode and 'serialize' in err,err;future_exact(Decimal(5),'invisible frontier baseline conflict serializes whole original source and delta')
r=run(f"BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT smarter_private.initialize_agent_commission_report_frontier('{club}');",False);assert r.returncode and 'COMMISSION_REPORT_INITIALIZATION_REQUIRES_FRESH_SNAPSHOT' in r.stderr;print('COMMISSION_FRONTIER_PASS: repeatable-read baseline refused locally')
print(run("SELECT p.oid::regprocedure,md5(pg_get_functiondef(p.oid)),p.proowner::regrole,p.prosecdef,p.proconfig,p.proacl FROM pg_proc p WHERE p.proname IN('fn_union_agent_risk_report','trg_agent_commission_rollup_insert','initialize_agent_commission_report_day','initialize_agent_commission_report_frontier','invalidate_agent_commission_report_days');").stdout)
