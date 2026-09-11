#!/usr/bin/env python3
"""Fresh Node processes execute compiled recovery and actual local SQL owners."""
import importlib.util, json, os, signal, subprocess, select, hashlib, time
from pathlib import Path
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('native_setup',HERE/'running-target-native.py')
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
NODE=['/opt/homebrew/bin/node','--loader',str(HERE/'recovery-native-loader.mjs'),str(HERE/'recovery-native-process.mjs')]
env={**os.environ,'SATELLITE_PROOF_DATABASE':native.DB}
env.pop('NODE_OPTIONS',None)
def check(sql):
 r=native.run(sql)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout
def state():
 raw=check(f"""SELECT jsonb_build_object(
 'status',(SELECT status FROM tournaments WHERE id='{native.SOURCE}'),
 'boundaries',(SELECT count(*) FROM tournament_satellite_qualification_boundaries WHERE tournament_id='{native.SOURCE}'),
 'receipts',(SELECT count(*) FROM tournament_satellite_settlements WHERE tournament_id='{native.SOURCE}'),
 'payouts',(SELECT count(*) FROM tournament_payouts WHERE tournament_id='{native.SOURCE}'),
 'paid',(SELECT coalesce(sum(amount),0) FROM tournament_payouts WHERE tournament_id='{native.SOURCE}'),
 'source_seats',(SELECT count(*) FROM table_seats s JOIN tables t ON t.id=s.table_id WHERE t.tournament_id='{native.SOURCE}' AND s.left_at IS NULL),
 'target_players',(SELECT current_players FROM tournaments WHERE id='{native.TARGET}'),
 'wallets',(SELECT coalesce(sum(chip_balance),0) FROM club_members),
 'receipt',(SELECT fn_ca_satellite_settlement_receipt('{native.SOURCE}',NULL) WHERE EXISTS(SELECT 1 FROM tournament_satellite_settlements WHERE tournament_id='{native.SOURCE}'))
 );""")
 return json.loads(raw.strip().splitlines()[-1])
def child(mode,extra=None):
 r=subprocess.run(NODE+[mode],env={**env,**(extra or {})},capture_output=True,text=True,timeout=45)
 if r.returncode: raise RuntimeError(r.stderr+'\n'+r.stdout)
 result=json.loads(r.stdout.strip().splitlines()[-1])
 assert not result['errors'],result
 return result
results={}
try:
 native.ensure_target_prelaunch()
 check(native.setup().replace(native.TARGET_LAUNCH, f"UPDATE tables SET max_players=3 WHERE id='{native.TARGET_TABLE}';"+native.TARGET_LAUNCH)+'SET CONSTRAINTS ALL IMMEDIATE; COMMIT;')
 before=state()
 p=subprocess.Popen(NODE+['prepare-and-crash'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 ready,_,_=select.select([p.stdout],[],[],30)
 if not ready: p.kill();raise RuntimeError('Native admission process timed out')
 line=p.stdout.readline()
 if not line: raise RuntimeError(p.stderr.read())
 prepared=json.loads(line)
 assert prepared['prepared'] and not prepared['errors'],prepared
 p.kill();p.wait(timeout=10)
 assert p.returncode==-signal.SIGKILL,p.returncode
 after_prepare=state()
 assert after_prepare['status']=='COMPLETING' and after_prepare['boundaries']==1 and after_prepare['payouts']==0 and after_prepare['source_seats']==3,after_prepare
 frozen=child('recover',{'SATELLITE_PROOF_FROZEN':'1'})
 assert not any(t['type']=='rpc' for t in frozen['trace']),frozen
 assert state()==after_prepare,'Frozen process changed prepared state'
 # Actual current rolling lane and capacity owner hold G shared/T exclusive.
 capacity_sql=native.GUARD+f"""BEGIN;SET LOCAL application_name='satellite-capacity-overlap';SET LOCAL ROLE service_role; SET LOCAL request.jwt.claims='{{"role":"service_role"}}';
 SELECT public.fn_ca_lock_settlement_lane_for_tournament('{native.TARGET}',NULL);
 SELECT public.fn_ensure_late_registration_capacity('{native.TARGET}',0);
 SELECT 'CAPACITY_LOCK_HELD'; SELECT pg_sleep(6); COMMIT;"""
 capacity=subprocess.Popen(native.PSQL,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 capacity.stdin.write(capacity_sql);capacity.stdin.close()
 held=False; start=time.monotonic()
 while time.monotonic()-start<5:
  available,_,_=select.select([capacity.stdout],[],[],max(0,5-(time.monotonic()-start)))
  if not available: break
  line=capacity.stdout.readline()
  if not line: break
  if 'CAPACITY_LOCK_HELD' in line: held=True;break
 assert held,'Capacity process did not hold its actual lane'
 recovery_process=subprocess.Popen(NODE+['recover'],env={**env,'SATELLITE_DROP_COMPLETION':'1'},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 observed=None;start=time.monotonic()
 while time.monotonic()-start<4:
  rows=json.loads(check("SELECT coalesce(jsonb_agg(jsonb_build_object('pid',a.pid,'wait_type',a.wait_event_type,'wait_event',a.wait_event,'blocker_pid',b.pid,'blocking_application',b.application_name,'waiting_locks',(SELECT jsonb_agg(jsonb_build_object('locktype',l.locktype,'classid',l.classid,'objid',l.objid,'objsubid',l.objsubid,'mode',l.mode,'granted',l.granted)) FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted),'blocking_advisory_locks',(SELECT jsonb_agg(jsonb_build_object('locktype',l.locktype,'classid',l.classid,'objid',l.objid,'objsubid',l.objsubid,'mode',l.mode,'granted',l.granted)) FROM pg_locks l WHERE l.pid=b.pid AND l.locktype='advisory' AND l.granted))),'[]') FROM pg_stat_activity a JOIN pg_stat_activity b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.application_name='satellite-recovery-proof' AND b.application_name='satellite-capacity-overlap' AND a.wait_event_type='Lock';").strip())
  if rows: observed=rows;break
  time.sleep(.1)
 
 if not observed:
  out,err=recovery_process.communicate(timeout=45);capacity.wait(timeout=15)
  raise RuntimeError('No observed overlap: '+out+' stderr '+err)

 capacity.wait(timeout=15);capacity_out=capacity.stdout.read();capacity_err=capacity.stderr.read()
 assert capacity.returncode==0,capacity_err
 out,err=recovery_process.communicate(timeout=45)
 assert recovery_process.returncode==0,err+'\n'+out
 recovered=json.loads(out.strip().splitlines()[-1]);assert not recovered['errors'],recovered
 overlap={'observed_blocking':observed,'capacity_exit':capacity.returncode,'capacity_stdout_after_marker':capacity_out,'capacity_stderr':capacity_err}
 capacity_post=json.loads(check(f"SELECT public.fn_ensure_late_registration_capacity('{native.TARGET}',0);").strip())
 assert capacity_post['created']==False and capacity_post['pending_table_count']==1,capacity_post
 assert check(f"SELECT count(*)=2 FROM tables WHERE tournament_id='{native.TARGET}';").strip()=='t'
 assert check(f"SELECT count(*)=1 FROM tournament_capacity_table_receipts r JOIN tournament_manager_wakes w ON w.id=r.manager_wake_id WHERE r.tournament_id='{native.TARGET}' AND w.consumed_at IS NULL;").strip()=='t'
 overlap['post_retry']=capacity_post
 calls=[t for t in recovered['trace'] if t['type']=='rpc']
 assert len([t for t in calls if t['name']=='fn_complete_satellite_qualification' and t['committed']])==5,calls
 assert calls[-1]['name']=='fn_resolve_satellite_qualification_outcome',calls
 after=state()
 assert after['status']=='COMPLETED' and after['payouts']==3 and after['paid']==600 and after['source_seats']==0 and after['target_players']==6 and after['wallets']==before['wallets'],after
 replay=child('replay')
 assert replay['receipt']['receiptVersion']==3 and replay['receipt']['winnerId'] is None,replay
 assert state()==after,'Fresh replay changed committed native state'
 repeated=child('recover')
 assert not any(t['type']=='rpc' for t in repeated['trace']),repeated
 assert state()==after,'Repeated cold scan changed committed state'
 results={'pass':True,'capacity_overlap':overlap,'prepare_process':prepared,'killed_process_exit':p.returncode,'after_prepare':after_prepare,'frozen_restart':frozen,'recovery_after_lost_responses':recovered,'post_recovery':after,'fresh_replay':replay,'repeated_restart':repeated,'limits':['Actual compiled recovery/RPC/parser modules with allowlisted local psql transport, not HTTP/PostgREST','No full GameServer process, websocket/browser, or production Stage B activation','Initial source600 liability is seeded; target original entrants are fixture setup']}
except Exception as e:
 results={'pass':False,'error':str(e)}
finally:
 (HERE/'recovery-restart-results.json').write_text(json.dumps(results,indent=2)+'\n')
 print(json.dumps(results,indent=2))
raise SystemExit(0 if results.get('pass') else 1)
