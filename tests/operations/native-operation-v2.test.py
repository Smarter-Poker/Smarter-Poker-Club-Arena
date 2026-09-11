import copy
from datetime import datetime, timezone
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import subprocess
import threading
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[2]
SPEC=importlib.util.spec_from_file_location('operation_v2',ROOT/'operations/release/native/engine-operation-v2.py')
V2=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(V2)
iso=lambda ms:datetime.fromtimestamp(ms/1000,timezone.utc).isoformat()

def fixture(now):
    release,operation,epoch,owner,plan,step,interval,activation=[str(uuid4()) for _ in range(8)]
    request={'target':'club-arena-engine','source_sha':'a'*40,'control_sha':'c'*40,'artifact_image_id':'sha256:'+'a'*64,
             'run_key':'123-1','not_after_epoch':now//1000+3600,'expected_current':{'source_sha':'9'*40,'image_id':'sha256:'+'9'*64}}
    envelope={'operation_id':operation,'epoch':epoch,'request':request}
    authority={'policy_version':2,'policy_digest':V2.POLICY_DIGEST,'activation_receipt':activation,
      'provider_operation':{'id':operation,'epoch':epoch,'owner_id':owner,'release_id':release,'kind':'PUBLISH','status':'UNKNOWN','intent':{'provider_request':request}},
      'provider_request':request,'provider_plan':{'id':plan},'current_owner':{'owner_id':owner,'epoch':epoch,'active_release':release},
      'step':{'id':step,'operation_id':interval,'step_key':'publish:'+plan,'owner_id':owner,'epoch':epoch,'kind':'engine_cutover',
              'estimated_ms':180000,'recovery_ms':300000,'margin_ms':30000,'not_after_at':iso(now+900000)},
      'interval':{'operation_id':interval,'release_id':release,'phase':'applying','freeze_started_at':iso(now-120000),
                  'forward_deadline_at':iso(now+1080000),'deadline_at':iso(now+1680000)},'observed_at':iso(now)}
    health={'running':True,'liveness':'ok','releaseSha':'9'*40,'maintenance':{'policyVersion':2,'policyDigest':V2.POLICY_DIGEST,
      'activationReceipt':activation,'readyForRestart':True,'operation':{'operationId':interval,'releaseId':release,'phase':'applying'}}}
    return envelope,authority,health

class FakeHost:
    def __init__(self,envelope,authority,health):
        self.envelope=envelope;self.context=authority;self.served=health;self.trials=0;self.claims=0;self.restores=0
        self.is_committed=False;self.deadline=time.time()+60;self.fail=None
    def preflight(self):pass
    def health(self, sealed_source=False):return self.served
    def authority(self,action,context=None):
        if action=='context':return self.context
        self.claims+=1
        if self.fail=='lost_claim':raise TimeoutError('fixture only')
        return {'consumed':True,'authority':self.context,'receipt_id':str(uuid4())}
    def trial(self):
        self.trials+=1
        if self.fail=='trial':raise ValueError('fixture only')
        return {'instance_id':'123-abcd1234'}
    def commit(self,witness):
        self.is_committed=True
        if self.fail=='lost_commit':raise TimeoutError('fixture only')
    def committed(self):return self.is_committed
    def finalize(self):return {}
    def recover(self):
        self.restores+=1
        return {'recovered_sha':'9'*40,'image_id':'sha256:'+'9'*64}

class OperationV2Tests(unittest.TestCase):
    def http_host(self):
        state={'status':200,'body':{'running':True,'liveness':'ok','releaseSha':'9'*40,'instanceId':'1-abcd1234'}}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                self.send_response(state['status']);self.end_headers()
                self.wfile.write(state.get('raw',json.dumps(state['body']).encode()))
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join(timeout=2)))
        host=V2.LinuxActuator.__new__(V2.LinuxActuator)
        host.deadline=time.time()+30
        original=host.run
        def run(args,**kwargs):
            if args[0]=='/usr/bin/curl':
                return original([*args[:-1],f'http://127.0.0.1:{server.server_port}/health'],**kwargs)
            state['database_proofs']=state.get('database_proofs',0)+1
            if state.get('database_failure'):raise ValueError('fixture stale database leader')
            return subprocess.CompletedProcess(args,0,'','')
        host.run=run
        return host,state

    def test_real_http_existing_source_accepts_complete_200_or_503_but_candidate_requires_200(self):
        host,state=self.http_host()
        for status in (200,503,302,500,502):
            state['status']=status
            for source in (False,True):
                with self.subTest(status=status,sealed_source=source):
                    if status==200 or (source and status==503):
                        self.assertEqual(host.health(sealed_source=source),state['body'])
                    else:
                        with self.assertRaises(ValueError):host.health(sealed_source=source)
        state['status']=503
        for raw in (b'{"running":',b'[]',b'null'):
            state['raw']=raw
            with self.assertRaises(ValueError):host.health(sealed_source=True)

    def test_degraded_source_witness_still_requires_exact_seal_identity_liveness_and_database_leader(self):
        host,state=self.http_host();state['status']=503
        sha='9'*40;image='sha256:'+'9'*64
        host.r={'expected_current':{'source_sha':sha,'image_id':image}}
        host.scripts=Path('/fixture-no-execution')
        seal={'desired-sha':sha,'desired-image-id':image}
        host.seal=lambda action,field:subprocess.CompletedProcess([],0,seal[field]+'\n','')
        host.inspect=lambda:{'Id':'container-fixture','Image':image,'State':{'Status':'running','StartedAt':'unchanged'},
                            'Config':{'Labels':{'sp.release.sha':sha}}}
        self.assertEqual(host.witness(sha,image,sealed_source=True)['instance_id'],'1-abcd1234')
        self.assertEqual(state['database_proofs'],1)
        with self.assertRaises(ValueError):host.witness(sha,image)
        original=copy.deepcopy(state['body'])
        for key,value in [('releaseSha',None),('releaseSha','a'*40),('running',False),('liveness','failed'),('instanceId','wrong')]:
            state['body']={**original,key:value}
            with self.assertRaises(ValueError):host.witness(sha,image,sealed_source=True)
        state['body']=original;state['database_failure']=True
        with self.assertRaises(ValueError):host.witness(sha,image,sealed_source=True)
        state['database_failure']=False;seal['desired-sha']='a'*40
        with self.assertRaises(ValueError):host.witness(sha,image,sealed_source=True)

    def test_all_clock_minutes_accept_owned_ready_operation_without_hourly_lane_dependency(self):
        for minute in range(60):
            now=1800000000000+minute*60000
            envelope,authority,health=fixture(now)
            budget=V2.validate_authority(authority,envelope,now,health)
            self.assertEqual(budget['forward_deadline_ms'],now+180000)
    def test_missing_stale_expired_wrong_artifact_or_epoch_refuses_before_authority(self):
        now=int(time.time()*1000);envelope,authority,health=fixture(now)
        for change in [lambda a:a['step'].update(epoch=str(uuid4())),
                       lambda a:a.update(observed_at=iso(now-5001)),
                       lambda a:a['step'].update(not_after_at=iso(now)),
                       lambda a:a['current_owner'].update(owner_id=str(uuid4())),
                       lambda a:a['interval'].update(phase='recovering'),
                       lambda a:a['step'].update(estimated_ms=1100000),
                       lambda a:a.update(policy_digest='0'*64)]:
            value=copy.deepcopy(authority);change(value)
            with self.assertRaises(ValueError):V2.validate_authority(value,envelope,now,health)
        wrong=copy.deepcopy(health);wrong['maintenance']['readyForRestart']=False
        with self.assertRaises(ValueError):V2.validate_authority(authority,envelope,now,wrong)
    def run_case(self,failure=None,uncertain=False):
        now=int(time.time()*1000);envelope,authority,health=fixture(now);host=FakeHost(envelope,authority,health);host.fail=failure
        with tempfile.TemporaryDirectory() as temp,patch.object(V2,'secure',side_effect=lambda p,file=True:Path(p)),patch.object(V2.BASE,'secure',side_effect=lambda p,file=True:Path(p)),patch.object(V2.NATIVE,'secure',side_effect=lambda p,file=True:Path(p)):
            folder=Path(temp)
            if uncertain:V2.persist(folder/'uncertain-command.json',{'fixture':'lost native response'})
            if failure=='lost_claim':
                with self.assertRaises(TimeoutError):V2.transaction(envelope,host,folder)
                self.assertEqual(host.trials,0)
                result=V2.transaction(envelope,host,folder,True)
            else:result=V2.transaction(envelope,host,folder)
            again=V2.transaction(envelope,host,folder,True)
            self.assertEqual(host.claims,1)
            self.assertLessEqual(host.trials,1)
            return result,again,host
    def test_success_claim_is_single_use_and_result_replay_cannot_repeat_trial(self):
        result,again,host=self.run_case();self.assertEqual(result,again);self.assertEqual(result['outcome'],'SUCCEEDED');self.assertEqual(host.trials,1)
    def test_lost_claim_commit_response_restores_only_sealed_desired_without_starting_candidate(self):
        result,again,host=self.run_case('lost_claim');self.assertEqual(result['outcome'],'FAILED');self.assertEqual(host.restores,1);self.assertEqual(host.trials,0)
    def test_failed_trial_restores_old_seal_and_lost_commit_response_finalizes_exact_commit(self):
        result,_,host=self.run_case('trial');self.assertEqual(result['recovered_sha'],'9'*40);self.assertEqual(host.restores,1)
        result,_,host=self.run_case('lost_commit');self.assertEqual(result['outcome'],'SUCCEEDED');self.assertEqual(host.restores,0)
    def test_unknown_native_mutation_never_becomes_terminal_from_recovery_health_alone(self):
        result,again,host=self.run_case('trial',True);self.assertFalse(result['terminal']);self.assertFalse(again['terminal']);self.assertEqual(host.trials,1)
    def test_lost_consume_then_delayed_restart_cannot_create_a_later_recovery_deadline(self):
        now=int(time.time()*1000);envelope,authority,health=fixture(now)
        host=FakeHost(envelope,authority,health);host.fail='lost_claim'
        with tempfile.TemporaryDirectory() as temp,patch.object(V2,'secure',side_effect=lambda p,file=True:Path(p)),patch.object(V2.NATIVE,'secure',side_effect=lambda p,file=True:Path(p)):
            folder=Path(temp)
            with self.assertRaises(TimeoutError):V2.transaction(envelope,host,folder)
            deadline=V2.instant(authority['interval']['deadline_at'])
            self.assertEqual(json.loads((folder/'claim-attempt.json').read_text())['recovery_deadline_ms'],deadline)
            self.assertFalse((folder/'recovery-window.json').exists())
            with patch.object(V2.time,'time',return_value=deadline/1000+1):
                with self.assertRaises(ValueError):V2.transaction(envelope,host,folder,True)
            self.assertFalse((folder/'recovery-window.json').exists())
            self.assertEqual(host.trials,0);self.assertEqual(host.restores,0);self.assertEqual(host.claims,1)

if __name__=='__main__':unittest.main()
