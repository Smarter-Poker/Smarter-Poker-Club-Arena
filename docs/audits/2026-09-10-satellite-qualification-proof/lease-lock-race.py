#!/usr/bin/env python3
"""Observed PostgreSQL target-lock wait: lease expiry must prevent prepare.
Only an isolated fixture is used. A local negative control proves the old path
accepts the expired owner; both transactions roll back and final code is restored.
"""
import json,os,subprocess,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
PG='/opt/homebrew/opt/postgresql@17/bin/'
SOCKET='/tmp/codex-satellite-cohort-pg17/socket'
DB='satellite_qualification_lease_race'
BASE=[PG+'psql','-X','-qAt','-h',SOCKET,'-p','55387','-d',DB,'-v','ON_ERROR_STOP=1']
SOURCE='e1000000-0000-4000-8000-000000000001'
TARGET='e1000000-0000-4000-8000-000000000002'
LEASE='e1000000-0000-4000-8000-000000000051'
A='10000000-0000-0000-0000-000000000001'
B='e1000000-0000-4000-8000-000000000004'
C='e1000000-0000-4000-8000-000000000005'
def query(sql):
 result=subprocess.run(BASE,input=sql,text=True,capture_output=True)
 if result.returncode:raise RuntimeError(result.stderr)
 return result.stdout.strip()
existing=subprocess.run([PG+'psql','-X','-qAt','-h',SOCKET,'-p','55387','-d','postgres','-c',f"SELECT 1 FROM pg_database WHERE datname='{DB}'"],text=True,capture_output=True,check=True)
if not existing.stdout.strip():
 subprocess.run([PG+'createdb','-h',SOCKET,'-p','55387','-T','satellite_qualification_verified',DB],check=True)
query(f"DO $$ BEGIN IF current_database()<>'{DB}' OR current_setting('data_directory') NOT LIKE '/tmp/codex-satellite-cohort-pg17/%' THEN RAISE EXCEPTION 'Isolated fixture required'; END IF; END $$;")
if query(f"SELECT status FROM public.tournaments WHERE id='{SOURCE}'")=='REGISTERING':
 seed=(HERE/'native-seed.sql').read_text().split('COMMIT;',1)[1]
 query(seed+'COMMIT;')
migration=(HERE.parents[2]/'supabase/migrations/20260910054035_satellites_record_equal_qualifiers_without_fabricated_finish.sql').read_text()
a=migration.index('CREATE OR REPLACE FUNCTION public.fn_ca_settle_satellite_terminal(')
z=migration.index('CREATE OR REPLACE FUNCTION public.fn_ca_settle_satellite_with_seat_authority(',a)
fixed=migration[a:z]
a=fixed.index('      -- Target, roster and seat locks may wait after the outer lease check.')
z=fixed.index('      IF v_boundary.tournament_id IS NULL THEN',a)
old=fixed[:a]+fixed[z:]
results=[]
try:
 for label,source,should_refuse in [('Negative Control',old,False),('Corrected Write Boundary',fixed,True)]:
  query(source)
  query(f"UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '24 seconds' WHERE tournament_id='{SOURCE}';")
  blocker=subprocess.Popen(BASE,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'PGAPPNAME':'satellite_native_target_blocker'})
  blocker.stdin.write(f"BEGIN; SELECT id FROM public.tournaments WHERE id='{TARGET}' FOR UPDATE; SELECT 'TARGET_LOCKED';\n");blocker.stdin.flush()
  while True:
   line=blocker.stdout.readline()
   if 'TARGET_LOCKED' in line:break
   if not line:raise RuntimeError('Target blocker failed: '+blocker.stderr.read())
  worker=subprocess.Popen(BASE,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'PGAPPNAME':'satellite_native_prepare_worker'})
  worker.stdin.write(f"BEGIN; SET LOCAL request.jwt.claims='{{\"role\":\"service_role\"}}'; SELECT public.fn_prepare_satellite_qualification('{SOURCE}',ARRAY['{A}','{B}','{C}']::uuid[],'{LEASE}'); ROLLBACK;\n");worker.stdin.close()
  deadline=time.monotonic()+12;witness=None
  while time.monotonic()<deadline:
   raw=query("SELECT json_build_object('worker_pid',a.pid,'blocking_pids',pg_blocking_pids(a.pid),'wait_event',a.wait_event,'wait_type',a.wait_event_type) FROM pg_stat_activity a WHERE a.application_name='satellite_native_prepare_worker' AND cardinality(pg_blocking_pids(a.pid))>0;")
   if raw:witness=json.loads(raw);break
   if worker.poll() is not None:break
   time.sleep(.05)
  if witness is None:raise RuntimeError('Preparation never reached an observed target lock wait')
  while time.monotonic()<deadline:
   if query(f"SELECT heartbeat_at<clock_timestamp()-interval '30.25 seconds' FROM public.engine_tournament_leases WHERE tournament_id='{SOURCE}'")=='t':break
   time.sleep(.05)
  else:raise RuntimeError('Lease expiry deadline was not observed')
  blocker.stdin.write('ROLLBACK;\n');blocker.stdin.close();blocker.wait(timeout=5)
  worker.wait(timeout=5);out=worker.stdout.read();error=worker.stderr.read()
  refused=worker.returncode!=0 and 'lease expired while acquiring its settled cohort' in error
  accepted=worker.returncode==0 and 'qualification_prepared' in out
  state=query(f"SELECT status||':'||(SELECT count(*) FROM public.tournament_satellite_qualification_boundaries WHERE tournament_id='{SOURCE}')::text||':'||(SELECT count(*) FROM public.tournament_payouts WHERE tournament_id='{SOURCE}')::text FROM public.tournaments WHERE id='{SOURCE}';")
  passed=(refused if should_refuse else accepted) and state=='RUNNING:0:0'
  results.append({'case':label,'pass':passed,'observed_lock':witness,'exit_code':worker.returncode,'expired_owner_accepted':accepted,'expired_owner_refused':refused,'rollback_state':state,'error':error or None})
  print(('PASS ' if passed else 'FAIL ')+label,flush=True)
finally:
 query(fixed)
 (HERE/'lease-lock-race-results.json').write_text(json.dumps(results,indent=2)+'\n')
raise SystemExit(len(results)!=2 or any(not r['pass'] for r in results))
