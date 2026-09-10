#!/usr/bin/env python3
"""Local Unix-socket concurrency proofs with observed PostgreSQL lock waits."""
import json, os, pathlib, select, subprocess, time
assert os.environ["PGHOST"].startswith(("/tmp/ca-source-proof.", "/var/folders/"))
psql=os.environ["COMMISSION_PSQL"]
def query(sql):
 r=subprocess.run([psql,"-X","-At","-v","ON_ERROR_STOP=1","-c",sql],text=True,capture_output=True,check=True,timeout=15)
 return r.stdout.strip()
def session(name):
 env=dict(os.environ,PGAPPNAME=name)
 return subprocess.Popen([psql,"-X","-At","-v","ON_ERROR_STOP=1"],text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,bufsize=1)
def send(p,sql):
 p.stdin.write(sql+"\n");p.stdin.flush()
def marker(p,name):
 deadline=time.monotonic()+10
 while time.monotonic()<deadline:
  if select.select([p.stdout],[],[],.1)[0]:
   line=p.stdout.readline().strip()
   if line==name:return
  if p.poll() is not None:raise AssertionError(p.stderr.read())
 raise AssertionError("Missing session marker "+name)
def blocked(name):
 deadline=time.monotonic()+10
 while time.monotonic()<deadline:
  if query("SELECT count(*) FROM pg_stat_activity WHERE application_name='"+name+"' AND wait_event_type='Lock'")=="1":return
  time.sleep(.03)
 raise AssertionError("Did not observe PostgreSQL lock wait for "+name)
def finish(p):
 send(p,"\\q");p.stdin.close();p.wait(timeout=15)
 assert p.returncode==0,p.stderr.read()
def record(name,cond):
 assert cond,name
 query("SELECT test_assert('"+name+"',true)")
 print("PASS "+name)
# Receipt duplicate waits on the actual unique-key transaction.
hand="00000000-0000-4000-8000-000000001020"
query("SELECT test_accept('"+hand+"'); SELECT test_bank('"+hand+"')")
a=session("source_first_accrual");b=session("source_duplicate_accrual")
try:
 send(a,"BEGIN; SELECT test_accrue('"+hand+"'); SELECT 'ready';");marker(a,"ready")
 send(b,"SELECT test_accrue('"+hand+"'); SELECT 'done';")
 blocked("source_duplicate_accrual")
 send(a,"COMMIT;");marker(b,"done")
 record("Observed overlapping duplicate books exactly one contributor",
 query("SELECT count(*)=3 AND sum(amount)=70 FROM agent_commissions WHERE source_id='"+hand+"'")=="t")
finally:
 finish(a);finish(b)
# Capture is paused after its whole-hand snapshot but before first fact insert.
# A concurrent atomic assignment/rate mutation commits while it is paused.
query("""CREATE FUNCTION test_capture_barrier() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN IF current_setting('test.capture_barrier',true)='on' THEN
 PERFORM pg_advisory_xact_lock(190010); END IF; RETURN NEW; END $f$;
CREATE TRIGGER test_capture_barrier BEFORE INSERT ON ca_cash_commission_facts
FOR EACH ROW EXECUTE FUNCTION test_capture_barrier();""")
a=session("source_terms_mutator");b=session("source_snapshot_capture")
hand="00000000-0000-4000-8000-000000001021"
try:
 send(a,"BEGIN; SELECT pg_advisory_xact_lock(190010); SELECT 'ready';");marker(a,"ready")
 send(b,"BEGIN; SET LOCAL test.capture_barrier='on'; SELECT test_accept('"+hand+"'); COMMIT; SELECT 'done';")
 blocked("source_snapshot_capture")
 send(a,"UPDATE agents SET commission_rate=.65 WHERE id='00000000-0000-4000-8000-000000000003'; UPDATE club_members SET agent_id='00000000-0000-4000-8000-000000000103',player_rakeback_pct=.20; COMMIT;")
 marker(b,"done")
 record("Observed concurrent mutation cannot mix whole-hand terms",
 query("SELECT count(*)=2 AND bool_and(direct_commission_rate=.25 AND player_rebate_rate=.10 AND payer_user_id='00000000-0000-4000-8000-000000000101') FROM ca_cash_commission_facts WHERE hand_id='"+hand+"'")=="t")
finally:
 finish(a);finish(b)
query("DROP TRIGGER test_capture_barrier ON ca_cash_commission_facts")
query("SELECT test_accept('00000000-0000-4000-8000-000000001022')")
record("Next accepted source sees committed new terms",
 query("SELECT count(*)=2 AND bool_and(direct_commission_rate=.65 AND player_rebate_rate=.20 AND payer_user_id='00000000-0000-4000-8000-000000000103') FROM ca_cash_commission_facts WHERE hand_id='00000000-0000-4000-8000-000000001022'")=="t")
# A transaction rollback removes accepted source, captured facts, accrual and rollups together.
before=query("SELECT jsonb_build_array((SELECT sum(owed) FROM agent_commission_unsettled_rollup),(SELECT sum(amount) FROM ca_club_commission_daily))")
query("BEGIN; SELECT test_accept('00000000-0000-4000-8000-000000001023'); SELECT test_bank('00000000-0000-4000-8000-000000001023'); SELECT test_accrue('00000000-0000-4000-8000-000000001023'); ROLLBACK;")
record("Explicit rollback preserves no source, receipt, accrual or rollup effect",
 query("SELECT NOT EXISTS(SELECT 1 FROM hand_atomic_commits WHERE hand_id='00000000-0000-4000-8000-000000001023') AND NOT EXISTS(SELECT 1 FROM ca_cash_commission_sources WHERE hand_id='00000000-0000-4000-8000-000000001023') AND NOT EXISTS(SELECT 1 FROM agent_commissions WHERE source_id='00000000-0000-4000-8000-000000001023')")=="t"
 and query("SELECT jsonb_build_array((SELECT sum(owed) FROM agent_commission_unsettled_rollup),(SELECT sum(amount) FROM ca_club_commission_daily))")==before)
proof=json.loads(query("SELECT jsonb_agg(jsonb_build_object('name',name,'passed',passed) ORDER BY name) FROM test_checks"))
pathlib.Path(__file__).with_name("local-proof.json").write_text(json.dumps({"passed":len(proof),"scope":"real capture, cash admission and five actual agent_commissions triggers; isolated synthetic accepted envelope rows, not full stack-owner dependencies","checks":proof},indent=2)+"\n")
