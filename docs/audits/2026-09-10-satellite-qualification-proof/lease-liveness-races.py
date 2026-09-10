#!/usr/bin/env python3
"""Observed target waits with actual current lease owners in an owned PG17 fixture.
No new cluster or remote connection is accepted. Every prepare/takeover rolls back.
"""
import json, os, subprocess, time
from pathlib import Path
HERE=Path(__file__).resolve().parent
PSQL=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-qAt','-h','/tmp/codex-satellite-cohort-pg17/socket','-p','55387','-d','satellite_qualification_lease_race','-v','ON_ERROR_STOP=1']
SOURCE='e1000000-0000-4000-8000-000000000001'
TARGET='e1000000-0000-4000-8000-000000000002'
LEASE='e1000000-0000-4000-8000-000000000051'
NEXT='e1000000-0000-4000-8000-000000000052'
A='10000000-0000-0000-0000-000000000001'
B='e1000000-0000-4000-8000-000000000004'
C='e1000000-0000-4000-8000-000000000005'
INSTANCE='qualification-native-probe'
def query(sql):
 r=subprocess.run(PSQL,input=sql,text=True,capture_output=True,timeout=15)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
query("DO $$ BEGIN IF current_database()<>'satellite_qualification_lease_race' OR current_setting('data_directory') NOT LIKE '/tmp/codex-satellite-cohort-pg17/%' THEN RAISE EXCEPTION 'Isolated fixture only'; END IF; END $$;")
migration=(HERE.parents[2]/'supabase/migrations/20260910054035_satellites_record_equal_qualifiers_without_fabricated_finish.sql').read_text()
a=migration.index('CREATE FUNCTION public.fn_prepare_satellite_qualification(')
z=migration.index('-- Presentation reads exactly',a)
fixed=migration[a:z].replace('CREATE FUNCTION public.fn_prepare_satellite_qualification(','CREATE OR REPLACE FUNCTION public.fn_prepare_satellite_qualification(',1)
old=fixed.replace('WHERE l.tournament_id=p_tournament_id FOR KEY SHARE;','WHERE l.tournament_id=p_tournament_id FOR UPDATE;',1)
assert old!=fixed
gate='DO $qualification_lease_gate$'+migration.split('DO $qualification_lease_gate$')[1].split('$qualification_lease_gate$;')[0]+'$qualification_lease_gate$;'
query(gate)
PREP=f"SELECT public.fn_prepare_satellite_qualification('{SOURCE}',ARRAY['{A}','{B}','{C}']::uuid[],'{LEASE}');"
def process(app,sql,keep_open=False):
 p=subprocess.Popen(PSQL,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'PGAPPNAME':app})
 p.stdin.write(sql+'\n');p.stdin.flush()
 if not keep_open:p.stdin.close()
 return p
def observed(app):
 deadline=time.monotonic()+5
 while time.monotonic()<deadline:
  raw=query("SELECT json_build_object('pid',pid,'blocking_pids',pg_blocking_pids(pid),'wait_type',wait_event_type,'wait_event',wait_event) FROM pg_stat_activity WHERE application_name='"+app+"' AND cardinality(pg_blocking_pids(pid))>0")
  if raw:return json.loads(raw)
  time.sleep(.03)
 raise AssertionError('No observed wait for '+app)
def finish(p):
 p.wait(timeout=8)
 return p.returncode,p.stdout.read(),p.stderr.read()
def state():
 return json.loads(query(f"""SELECT json_build_object(
 'source_status',(SELECT status FROM public.tournaments WHERE id='{SOURCE}'),
 'boundaries',(SELECT count(*) FROM public.tournament_satellite_qualification_boundaries WHERE tournament_id='{SOURCE}'),
 'headers',(SELECT count(*) FROM public.tournament_satellite_settlements WHERE tournament_id='{SOURCE}'),
 'payouts',(SELECT count(*) FROM public.tournament_payouts WHERE tournament_id='{SOURCE}'),
 'qualifiers',(SELECT count(*) FROM public.tournament_satellite_qualifiers WHERE tournament_id='{SOURCE}'),
 'awards',(SELECT count(*) FROM public.tournament_satellite_awards WHERE tournament_id='{SOURCE}'),
 'source_liability',(SELECT prize_balance+bounty_balance+fee_balance FROM public.tournament_escrow WHERE tournament_id='{SOURCE}'),
 'source_seats',(SELECT count(*) FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id='{SOURCE}' AND s.left_at IS NULL),
 'target_entries',(SELECT count(*) FROM public.tournament_players WHERE tournament_id='{TARGET}'),
 'target_liability',COALESCE((SELECT prize_balance+bounty_balance+fee_balance FROM public.tournament_escrow WHERE tournament_id='{TARGET}'),0),
 'tickets',(SELECT count(*) FROM public.tournament_tickets WHERE source_satellite_id='{SOURCE}'),
 'club_balances',(SELECT sum(chip_balance) FROM public.club_members))"""))
results=[]
baseline=state()
try:
 for label,body,heartbeat,takeover,expire,alter_generation in [
  ('Negative FOR UPDATE control makes actual heartbeat busy',old,True,False,False,False),
  ('KEY SHARE permits actual heartbeat and fences fresh claimant',fixed,True,True,False,False),
  ('Expired owner refuses after wait before stale takeover',fixed,False,True,True,False),
  ('Generation changed during later wait refuses preparation',fixed,False,False,False,True)
 ]:
  participants=[]
  try:
   query(body)
   query(f"UPDATE public.engine_tournament_leases SET instance_id='{INSTANCE}',lease_generation='{LEASE}',protocol_version=2,heartbeat_at=clock_timestamp()-interval '24 seconds' WHERE tournament_id='{SOURCE}'")
   blocker=process('qualification_target_owner',f"BEGIN; SELECT id FROM public.tournaments WHERE id='{TARGET}' FOR UPDATE; SELECT 'LOCKED';",True);participants.append(blocker)
   while True:
    line=blocker.stdout.readline()
    if 'LOCKED' in line:break
    if not line:raise AssertionError(blocker.stderr.read())
   worker=process('qualification_preparer',"BEGIN; SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}'; SET LOCAL ROLE service_role; "+PREP+" SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;");participants.append(worker)
   target_wait=observed('qualification_preparer')
   heartbeat_result=None;claim=None;claim_wait=None
   if heartbeat:
    claims=json.dumps([{'tournament_id':SOURCE,'lease_generation':LEASE}])
    before=query(f"SELECT heartbeat_at FROM public.engine_tournament_leases WHERE tournament_id='{SOURCE}'")
    started=time.monotonic()
    heartbeat_result=json.loads(query(f"BEGIN; SET LOCAL ROLE service_role; SELECT row_to_json(h) FROM public.heartbeat_tournament_leases_v4('{INSTANCE}','{claims}'::jsonb,30) h; COMMIT;"))
    elapsed=time.monotonic()-started
    after=query(f"SELECT heartbeat_at FROM public.engine_tournament_leases WHERE tournament_id='{SOURCE}'")
    expected='busy' if body==old else 'kept'
    assert heartbeat_result['state']==expected,heartbeat_result
    assert (before==after) if body==old else (after>before)
    assert elapsed<3,elapsed
    heartbeat_result.update(elapsed_seconds=elapsed,timestamp_before=before,timestamp_after=after)
    assert worker.poll() is None
   if takeover:
    claim=process('qualification_claimant',f"BEGIN; SET LOCAL ROLE service_role; SELECT row_to_json(c) FROM public.claim_tournament_lease_v2('{SOURCE}','qualification-new-owner','native','{NEXT}',30) c; ROLLBACK;");participants.append(claim)
    claim_wait=observed('qualification_claimant')
    assert target_wait['pid'] in claim_wait['blocking_pids'],claim_wait
    assert claim.poll() is None
   if expire:
    deadline=time.monotonic()+10
    while query(f"SELECT heartbeat_at<clock_timestamp()-interval '30.25 seconds' FROM public.engine_tournament_leases WHERE tournament_id='{SOURCE}'")!='t':
     assert time.monotonic()<deadline
     time.sleep(.04)
    assert claim.poll() is None
   if alter_generation:
    query(f"UPDATE public.engine_tournament_leases SET lease_generation='{NEXT}' WHERE tournament_id='{SOURCE}'")
   blocker.stdin.write('ROLLBACK;\n');blocker.stdin.close();finish(blocker)
   code,out,error=finish(worker)
   refuse=expire or alter_generation
   assert (code!=0 and 'lease expired while acquiring its settled cohort' in error) if refuse else (code==0 and 'qualification_prepared' in out),(code,out,error)
   claim_result=None
   if claim:
    c_code,c_out,c_error=finish(claim);assert c_code==0,c_error
    claim_result=json.loads(c_out.strip())
    assert claim_result['granted']==expire,claim_result
    if expire:assert claim_result['lease_generation']==NEXT
   assert state()==baseline,(state(),baseline)
   results.append({'case':label,'pass':True,'target_wait':target_wait,'heartbeat':heartbeat_result,'claim_wait':claim_wait,'claim_result':claim_result,'prepare_refused':refuse,'prepare_error':error or None,'rollback_state':state()})
   print('PASS '+label,flush=True)
  finally:
   for p in participants:
    if p.poll() is None:p.terminate()
    try:p.wait(timeout=3)
    except subprocess.TimeoutExpired:p.kill()
   query(f"UPDATE public.engine_tournament_leases SET instance_id='{INSTANCE}',lease_generation='{LEASE}',protocol_version=2,heartbeat_at=clock_timestamp() WHERE tournament_id='{SOURCE}'")
finally:
 query(fixed)
 (HERE/'lease-liveness-race-results.json').write_text(json.dumps(results,indent=2)+'\n')
raise SystemExit(len(results)!=4)
