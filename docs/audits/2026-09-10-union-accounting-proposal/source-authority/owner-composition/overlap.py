#!/usr/bin/env python3
"""Actual accepted-owner activation races in a disposable PG17 database."""
import os,json,time,subprocess
from pathlib import Path
p=Path(__file__).resolve().parent
psql=os.environ['COMMISSION_PSQL']
base=[psql,'-X','-qAt','-v','ON_ERROR_STOP=1']
def query(sql,ok=True):
 r=subprocess.run(base+['-c',sql],capture_output=True,text=True)
 if ok and r.returncode:raise RuntimeError(r.stderr)
 return r
def check(name,expr):
 query("SELECT test_assert("+quote(name)+","+expr+")")
 print("PASS",name,flush=True)
def quote(s):return "'"+s.replace("'","''")+"'"
def start(sql,name):
 env=dict(os.environ,PGAPPNAME=name)
 return subprocess.Popen(base+['-c',sql],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
def finish(proc,ok=True):
 out,err=proc.communicate(timeout=12)
 if ok and proc.returncode:raise RuntimeError(err)
 return out,err,proc.returncode
def wait_for(name,event):
 end=time.monotonic()+6
 while time.monotonic()<end:
  r=query("SELECT coalesce(jsonb_agg(jsonb_build_object('pid',pid,'event',wait_event,'blockers',pg_blocking_pids(pid))),'[]') FROM pg_stat_activity WHERE application_name="+quote(name))
  rows=json.loads(r.stdout)
  if any(x['event']==event and x['blockers'] for x in rows):return rows
  time.sleep(.015)
 raise RuntimeError("No observed "+event+" wait for "+name)
def holder(locksql,name):
 env=dict(os.environ,PGAPPNAME=name)
 proc=subprocess.Popen(base,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 proc.stdin.write("BEGIN; "+locksql+"; SELECT 'READY';\n");proc.stdin.flush()
 while proc.stdout.readline().strip()!="READY":
  if proc.poll() is not None:raise RuntimeError(proc.stderr.read())
 return proc
def release(proc):
 proc.stdin.write("COMMIT;\n");proc.stdin.close();proc.stdin=None
 return finish(proc)
activation=(p.parent/'03-receipt-source-boundary.sql').read_text()+"\n"+(p.parent/'04-cash-admission.sql').read_text()
activate_sql="BEGIN;SET LOCAL lock_timeout='250ms';SET LOCAL statement_timeout='8s';"+activation+"COMMIT;"
# Before-envelope barrier exists only in this isolated fixture.
query("""CREATE FUNCTION test_pause_envelope() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN IF NEW.hand_number=1000002 AND OLD.post_commit_payload IS NULL AND NEW.post_commit_payload IS NOT NULL THEN
 PERFORM pg_advisory_xact_lock(8844,1); END IF; RETURN NEW; END $f$;
CREATE TRIGGER test_pause_envelope BEFORE UPDATE OF post_commit_payload ON hand_atomic_commits
 FOR EACH ROW EXECUTE FUNCTION test_pause_envelope();""")
gate=holder("SELECT pg_advisory_xact_lock(8844,1)","source-before-envelope-gate")
old=start("SELECT test_owner(1000002)","source-old-before-envelope")
w1=wait_for("source-old-before-envelope","advisory")
ddl=start(activate_sql,"source-activation-blocked")
w2=wait_for("source-activation-blocked","relation")
out,err,rc=finish(ddl,False)
assert rc and 'lock timeout' in err,err
check("Activation times out atomically while old receipt writer is in flight",
 "NOT EXISTS(SELECT 1 FROM ca_cash_commission_authority) AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='hand_atomic_commits' AND column_name='commission_capture_version')")
release(gate);finish(old)
query("DROP TRIGGER test_pause_envelope ON hand_atomic_commits")
check("Old receipt writer finishes before activation without invented source facts",
 "EXISTS(SELECT 1 FROM hand_atomic_commits WHERE hand_number=1000002 AND post_commit_payload IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM ca_cash_commission_sources)")
# A historical NULL envelope remains outside the new source contract.
query("""INSERT INTO hand_history(id,table_id,hand_number)
VALUES(test_id(1999900),test_id(950),1999900);
INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result)
VALUES(test_id(950),1999900,test_id(1999900),repeat('a',64),'{}');""")
# The old public function is already running but has not touched its receipt.
barrier=holder("SELECT pg_advisory_xact_lock(hashtextextended('ca:hand-settlement-barrier:v1',0))","source-before-receipt-gate")
late=start("SELECT test_owner(1000003)","source-old-before-receipt")
w3=wait_for("source-old-before-receipt","advisory")
query(activate_sql)
release(barrier);finish(late)
check("In-flight old owner sees the new receipt trigger after activation",
 "EXISTS(SELECT 1 FROM hand_atomic_commits WHERE hand_number=1000003 AND commission_capture_version=1) AND EXISTS(SELECT 1 FROM ca_cash_commission_sources WHERE hand_number=1000003)")
check("Activation preserves the accepted owner body",
 "(SELECT md5(prosrc)='0ef3c57a6a31acc383ce4b95a0f9519f' FROM pg_proc WHERE oid='public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure)")
check("Existing NULL and non-NULL receipts keep their legacy marker",
 "(SELECT count(*)=3 AND bool_and(commission_capture_version IS NULL) FROM hand_atomic_commits WHERE hand_number IN(1000001,1000002,1999900))")
check("Whole actual hand captures exact seats, book club, hierarchy and fractions",
 "(SELECT count(*)=2 AND bool_and(booked_club_id=test_id(900) AND direct_agent_id=test_id(103) AND payer_user_id=test_id(303) AND rake_credit=1 AND player_rebate_entitlement=.10 AND jsonb_array_length(hierarchy)=3 AND errors='[]') FROM ca_cash_commission_facts WHERE hand_id=test_id(1000003))")
# Source capture fails at its last fact, after the full stack/history owner ran.
before=query("""SELECT jsonb_build_object('stacks',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s),
 'commits',(SELECT count(*) FROM hand_atomic_commits),'history',(SELECT count(*) FROM hand_history),
 'outbox',(SELECT count(*) FROM hand_projection_outbox),'settlements',(SELECT count(*) FROM ca_settlements),
 'ledger',(SELECT count(*) FROM chip_ledger),'facts',(SELECT count(*) FROM ca_cash_commission_facts))""").stdout.strip()
query("""CREATE FUNCTION test_fail_last_fact() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN IF NEW.hand_id=test_id(1000004) AND NEW.player_id=test_id(202) THEN RAISE EXCEPTION 'last source fact failure'; END IF;RETURN NEW;END $f$;
CREATE TRIGGER test_fail_last_fact BEFORE INSERT ON ca_cash_commission_facts FOR EACH ROW EXECUTE FUNCTION test_fail_last_fact();""")
failure=query("SELECT test_owner(1000004)",False)
assert failure.returncode and 'last source fact failure' in failure.stderr,failure.stderr
after=query("""SELECT jsonb_build_object('stacks',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s),
 'commits',(SELECT count(*) FROM hand_atomic_commits),'history',(SELECT count(*) FROM hand_history),
 'outbox',(SELECT count(*) FROM hand_projection_outbox),'settlements',(SELECT count(*) FROM ca_settlements),
 'ledger',(SELECT count(*) FROM chip_ledger),'facts',(SELECT count(*) FROM ca_cash_commission_facts))""").stdout.strip()
check("Last source fact failure rolls the entire accepted owner back",quote(before)+"::jsonb="+quote(after)+"::jsonb")
query("DROP TRIGGER test_fail_last_fact ON ca_cash_commission_facts")
denied=query("UPDATE hand_atomic_commits SET commission_capture_version=1 WHERE hand_number=1999900",False)
assert denied.returncode and 'capture generation is immutable' in denied.stderr
check("Historical receipt cannot be promoted into source capture",
 "NOT EXISTS(SELECT 1 FROM ca_cash_commission_sources WHERE hand_number=1999900)")
# Deliberately grant broad service mutation in the fixture to prove the trigger
# boundary independently of the caller table ACL.
query("GRANT SELECT,UPDATE ON hand_atomic_commits TO service_role")
denied=query("""SET ROLE service_role; UPDATE hand_atomic_commits
 SET post_commit_payload=post_commit_payload||'{"forged":true}'::jsonb WHERE hand_number=1000003""",False)
assert denied.returncode and 'envelope is immutable' in denied.stderr,denied.stderr
check("Direct service cannot rewrite a captured envelope",
 "(SELECT accepted_payload_hash=c.post_commit_payload_hash FROM ca_cash_commission_sources s JOIN hand_atomic_commits c USING(hand_id) WHERE s.hand_number=1000003)")
check("Legacy sources never gained captured source authority",
 "NOT EXISTS(SELECT 1 FROM ca_cash_commission_sources WHERE hand_number IN(1000001,1000002,1999900))")
check("Generation admits an owner transaction already in flight before activation",
 "(SELECT req.started_at<a.activated_at AND s.accepted_at>=a.activated_at AND c.commission_capture_version=1 FROM ca_cash_commission_sources s JOIN hand_atomic_commits c USING(hand_id) JOIN test_owner_requests req ON req.hand_number=s.hand_number CROSS JOIN ca_cash_commission_authority a WHERE s.hand_number=1000003)")
query("""INSERT INTO hand_history(id,table_id,hand_number) VALUES(test_id(1999901),test_id(950),1999901);
INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result)
SELECT table_id,1999901,test_id(1999901),repeat('b',64),stack_result FROM hand_atomic_commits WHERE hand_number=1000003;""")
denied=query("""SET ROLE service_role; UPDATE hand_atomic_commits target
 SET post_commit_payload=original.post_commit_payload,post_commit_payload_hash=original.post_commit_payload_hash
 FROM hand_atomic_commits original WHERE target.hand_number=1999901 AND original.hand_number=1000003""",False)
assert denied.returncode and 'Only the accepted hand owner' in denied.stderr,denied.stderr
check("Direct service cannot manufacture a first captured envelope",
 "NOT EXISTS(SELECT 1 FROM ca_cash_commission_sources WHERE hand_number=1999901)")
# Preserve an exact lost-response request across a real membership rate change.
facts_before=query("SELECT jsonb_agg(to_jsonb(f) ORDER BY player_id) FROM ca_cash_commission_facts f WHERE hand_id=test_id(1000003)").stdout.strip()
query("UPDATE club_members SET player_rakeback_pct=.20 WHERE club_id=test_id(900) AND user_id=test_id(201)")
replay=query("SELECT test_owner(1000003)")
assert json.loads(replay.stdout)['replay'] is True,replay.stdout
facts_after=query("SELECT jsonb_agg(to_jsonb(f) ORDER BY player_id) FROM ca_cash_commission_facts f WHERE hand_id=test_id(1000003)").stdout.strip()
check("Exact lost-response replay keeps original source-time player terms",
 quote(facts_before)+"::jsonb="+quote(facts_after)+"::jsonb")
query("SELECT test_owner(1000006)")
check("Next actual accepted hand sees the committed membership terms",
 "(SELECT player_rebate_rate=.20 AND player_rebate_entitlement=.20 FROM ca_cash_commission_facts WHERE hand_id=test_id(1000006) AND player_id=test_id(201))")
proof={'checks':json.loads(query("SELECT jsonb_build_object('count',count(*),'passed',bool_and(passed)) FROM test_checks").stdout),
 'observed_waits':{'old_before_envelope':w1,'activation_receipt_relation':w2,'old_before_receipt':w3},
 'scope':'Actual accepted owner and capture boundary. Rake banking, full payer and Round2 cascade not yet composed.'}
(p/'local-proof.json').write_text(json.dumps(proof,indent=2)+"\n")
print(json.dumps(proof),flush=True)
