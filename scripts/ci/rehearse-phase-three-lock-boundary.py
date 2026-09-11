#!/usr/bin/env python3
"""Exercise the exact activation prefix against competing native lease requests."""
import argparse, datetime, hashlib, importlib.util, json, os, re, subprocess, time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument("--root",type=Path,required=True);p.add_argument("--native-socket",required=True);p.add_argument("--evidence",type=Path,required=True);a=p.parse_args()
r=a.root.resolve()
spec=importlib.util.spec_from_file_location("lock_native_whole",r/"scripts/ci/rehearse-whole-phase-three-cutover.py")
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w);w.SOCKET=a.native_socket
assert w.read_sql("select current_database()||'|'||(inet_server_addr() is null)::text")=="full_stage1|true"
sql=(r/w.ACTIVATION_PATH).read_text();prefix=sql.split("-- BEGIN ACTIVATION COMPONENT ",1)[0]
assert sql==w.assemble_activation_bundle(r)
assert not re.search(r"CREATE|ALTER|DROP|GRANT|REVOKE",prefix)
before=w.snapshot()
base=[w.PSQL,"-X","-qAt","-h",a.native_socket,"-p","55473","-U","postgres","-d","full_stage1","-v","ON_ERROR_STOP=1","-v","VERBOSITY=verbose"]
sessions=[]
class Session:
 def __init__(self):
  self.p=subprocess.Popen(base,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  sessions.append(self)
  lines=self.exec("SET statement_timeout='5s'; SELECT 'PID='||pg_backend_pid();")
  self.pid=int(next(x.split("=",1)[1] for x in lines if x.startswith("PID=")))
 def send(self,s):self.p.stdin.write(s+"\n");self.p.stdin.flush()
 def until(self,tag):
  out=[]
  while True:
   line=self.p.stdout.readline()
   if not line:raise RuntimeError(self.p.stderr.read())
   line=line.rstrip("\n")
   if line==tag:return out
   out.append(line)
 def exec(self,s):
  tag="DONE_"+str(time.monotonic_ns());self.send(s+" SELECT '"+tag+"';")
  return self.until(tag)
 def close(self):
  if self.p.poll() is None:
   self.send("ROLLBACK;\n\\q")
   self.p.wait(timeout=6)
def waiting(pid,relation):
 for _ in range(20):
  state=w.read_sql("select count(*) from pg_locks where pid="+str(pid)+" and relation='"+relation+"'::regclass and not granted")
  if state=="1":return True
  time.sleep(.025)
 return False
def refusal(s,command):
 start=time.monotonic();s.send(command)
 out,err=s.p.communicate(timeout=6)
 return {"sqlstate_55p03":"55P03" in err,"seconds":round(time.monotonic()-start,4),"exit_code":s.p.returncode}
result={}
try:
 # Old order: request owns its lease while waiting for the cutover's table.
 cut=Session();mgr=Session()
 cut.exec("BEGIN; LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT; LOCK TABLE public.tables IN SHARE ROW EXCLUSIVE MODE NOWAIT;")
 mgr.exec("BEGIN; LOCK TABLE public.engine_tournament_leases IN ROW SHARE MODE;")
 mgr.send("LOCK TABLE public.tables IN ROW EXCLUSIVE MODE; SELECT 'OLD_MANAGER_ENTERED';")
 assert waiting(mgr.pid,"public.tables")
 old=refusal(cut,"LOCK TABLE public.engine_tournament_leases IN EXCLUSIVE MODE NOWAIT;")
 assert old["sqlstate_55p03"] and old["seconds"]<1
 mgr.until("OLD_MANAGER_ENTERED");mgr.close();cut.close()
 result["original_late_lease_race"]=old
 # New exact prefix: an arriving manager waits before it can own the lease.
 cut=Session();mgr=Session();cut.exec(prefix)
 mgr.send("BEGIN; LOCK TABLE public.engine_tournament_leases IN ROW SHARE MODE; LOCK TABLE public.tables IN ROW EXCLUSIVE MODE; SELECT 'NEW_MANAGER_ENTERED';")
 assert waiting(mgr.pid,"public.engine_tournament_leases")
 assert w.read_sql("select count(*) from pg_locks where pid="+str(mgr.pid)+" and relation='public.engine_tournament_leases'::regclass and mode='RowShareLock' and granted")=="0"
 cut.exec("ROLLBACK;")
 mgr.until("NEW_MANAGER_ENTERED");mgr.close();cut.close()
 result["arriving_request_cannot_hold_lease_across_cutover"]=True
 # A manager already in flight still causes immediate whole-prefix refusal.
 mgr=Session();cut=Session();mgr.exec("BEGIN; LOCK TABLE public.engine_tournament_leases IN ROW SHARE MODE;")
 busy=refusal(cut,prefix)
 assert busy["sqlstate_55p03"] and busy["seconds"]<1
 mgr.close();cut.close();result["busy_request_still_refuses_nowait"]=busy
finally:
 for s in sessions:s.close()
after=w.snapshot()
result.update(recorded_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),passed=before==after,exact_rollback=before==after,activation_sha256=hashlib.sha256(sql.encode()).hexdigest(),native_socket=a.native_socket,production_mutations=False,limits=["Native PostgreSQL lock scheduling with the exact activation prefix and protocol-2 relation-lock order; it is not a live traffic witness.","The separate whole-bundle proof covers financial authorities and exact catalog/business rollback."])
assert before==after
a.evidence.write_text(json.dumps(result,indent=2)+"\n")
print(json.dumps(result))
