#!/usr/bin/env python3
"""Actual host certificate and pinned DB adapter; only HTTP/health are synthetic."""
import importlib.util,json,os,subprocess,tempfile,unittest
from pathlib import Path
R=Path(__file__).resolve().parents[2]
S=(R/'server/scripts/engine-release-transaction.sh').read_text()
ENTRY_READ=S[S.index('legacy_entry_read() {'):S.index('legacy_entry_trace() {')]
CERT=S[S.index('maintenance_certificate() {'):S.index("\n# Entry to the exact predecessor's checkpoint")]
LEGACY=S[S.index('legacy_checkpoint_countdown() {'):S.index('\n# This is one optional event',S.index('legacy_checkpoint_countdown() {'))]
class WeeklyPriority(unittest.TestCase):
 def test_actual_certificates_and_readonly_adapter(self):
  root=os.environ.get('RUNNER_TEMP')or os.environ.get('TMPDIR')
  self.assertTrue(root and (os.name!='posix' or not __import__('sys').platform=='darwin' or root.startswith('/Volumes/SmarterWork/agent-work/')))
  with tempfile.TemporaryDirectory(prefix='weekly-release-priority-',dir=root)as d:
   d=Path(d);adapter=d/'adapter';adapter.write_text('''#!/usr/bin/env python3
import importlib.util,json,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('actual',os.environ['ACTUAL_ADAPTER']);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.read_fixed_env=lambda _: {'SUPABASE_URL':'https://kuklfnapbkmacvwxktbh.supabase.co','SUPABASE_SERVICE_ROLE_KEY':'synthetic-private-key'}
def read(url,key,timeout,payload=None):
 if '/rpc/'not in url:return []
 with open(os.environ['EVENTS'],'a')as log:log.write('DB\\n')
 if os.environ.get('CONSUME_RPC_BUDGET')=='yes':
  p=Path(os.environ['HEALTH_FILE']);body=json.loads(p.read_text());body['maintenance']['remainingMs']=282000;body['maintenance']['breakEndsAt']=(__import__('time').time()+282)*1000;p.write_text(json.dumps(body))
 assert url.endswith('/rpc/fn_weekly_accounting_payout_pause_state') and payload=={'p_run_id':None,'p_ownership_token':None}
 if os.environ.get('READ_FAILURE')=='yes':m.unknown('synthetic HTTP404')
 return json.loads(os.environ['RPC_STATE'])
m.get_json=read;m.main()
''');adapter.chmod(0o755)
   inactive={'contract':'weekly-payout-owned-phase-v1','observed_at':'2026-11-02T10:00:00+00:00','boundary':None}
   cases=[]
   for kind in ['normal','f06','legacy']:
    for field in ['draining','ready','paying','malformed']:
     cases.append((kind,field,inactive,False,False))
    for phase in ['draining','ready','paying']:
     cases.append((kind,'missing',{**inactive,'boundary':{'phase':phase,'ownership_token':'do-not-print-private-owner'}},False,False))
    for phase in ['draining','ready','paying']:
     cases.append((kind,'null',{**inactive,'boundary':{'phase':phase,'ownership_token':'do-not-print-private-owner'}},False,False))
    cases.extend([(kind,'missing',inactive,False,True),(kind,'missing',{},False,False),(kind,'missing',inactive,True,False),(kind,'null',inactive,False,True),(kind,'null',inactive,True,False),(kind,'rpc-budget',inactive,False,False)])
   for kind,field,state,fail,allow in cases:
    with self.subTest(kind=kind,field=field,state=state.get('boundary'),fail=fail):
     body={'running':True,'handsInFlightTotal':0,'maintenance':{'reason':'Deployment Recovery','active':True,'phase':'counting_down','durableConfirmed':True,'readyForRestart':kind=='normal','unparkedTables':1 if kind=='f06' else 0,'unparkedReasons':{'f06_preparation_stuck':1}if kind=='f06'else{},'remainingMs':296000,'breakEndsAt':(__import__('time').time()+296)*1000}}
     if field!='missing':body['weeklyPayout']=None if field in ['null','rpc-budget']else{'phase':field}
     events=d/'events';events.write_text('');health_file=d/'health';health_file.write_text(json.dumps(body))
     script='set -u\nMIN_BREAK_REMAINING_MS=285000\nENV_FILE=/dev/null\nINFLIGHT_HANDS="$ADAPTER"\ncurl() { printf \'HEALTH\\n\' >> "$EVENTS"; cat "$HEALTH_FILE"; printf \'\\n200\'; }\n'+ENTRY_READ+'\n'+CERT+'\n'+LEGACY+'\n'+('legacy_checkpoint_countdown'if kind=='legacy'else'maintenance_certificate')+'\n'
     p=subprocess.run(['bash','-c',script],capture_output=True,text=True,timeout=10,env={**os.environ,'EVENTS':str(events),'HEALTH_FILE':str(health_file),'CONSUME_RPC_BUDGET':'yes'if field=='rpc-budget'else'no','RPC_STATE':json.dumps(state),'READ_FAILURE':'yes'if fail else'no','ADAPTER':str(adapter),'ACTUAL_ADAPTER':str(R/'server/scripts/engine-release-inflight-hands.py')})
     self.assertEqual(p.returncode==0,allow,(p.returncode,p.stdout,p.stderr))
     order=events.read_text().splitlines();self.assertTrue(order and order[0]=='DB',order)
     if 'HEALTH'in order:self.assertEqual(order[:2],['DB','HEALTH'])
     self.assertNotIn('do-not-print-private-owner',p.stdout+p.stderr);self.assertNotIn('synthetic-private-key',p.stdout+p.stderr)
 def test_rpc_transport_is_post_and_never_redirects(self):
  spec=importlib.util.spec_from_file_location('actual',R/'server/scripts/engine-release-inflight-hands.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  class Response:
   status=200
   def __enter__(self):return self
   def __exit__(self,*_):pass
   def read(self,_):return b'{}'
  class Opener:
   def open(self,request,timeout):
    self.request=request;return Response()
  o=Opener();m.build_opener=lambda *args:o
  m.get_json('https://kuklfnapbkmacvwxktbh.supabase.co/rest/v1/rpc/fn_weekly_accounting_payout_pause_state','synthetic-private-key',8,{'p_run_id':None,'p_ownership_token':None})
  self.assertEqual(o.request.get_method(),'POST');self.assertEqual(json.loads(o.request.data),{'p_run_id':None,'p_ownership_token':None});self.assertIsNone(m.RefuseRedirects().redirect_request(None))
if __name__=='__main__':unittest.main()
