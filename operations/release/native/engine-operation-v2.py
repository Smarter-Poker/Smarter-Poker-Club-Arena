#!/usr/bin/python3
"""One admitted on-demand engine transaction; the frozen v1 protocol is untouched.

The existing engine lock, image seal, canonical run specification and exact
desired recovery remain authoritative. The database owns the maintenance step.
"""
from datetime import datetime
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

sys.dont_write_bytecode = True
NATIVE_SPEC = importlib.util.spec_from_file_location('engine_native_v2', Path(__file__).with_name('engine-native-v2.py'))
NATIVE = importlib.util.module_from_spec(NATIVE_SPEC); NATIVE_SPEC.loader.exec_module(NATIVE)
SPEC = importlib.util.spec_from_file_location('engine_boundary', Path(__file__).with_name('engine-boundary.py'))
BASE = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(BASE)
require, secure = BASE.require, BASE.secure

def persist(path, data):
    existed = path.exists()
    NATIVE.immutable(path, NATIVE.canonical(data))
    return not existed
STATE = Path('/var/lib/club-arena/engine-operation-v2')
LOCK = Path('/var/lock/club-arena-engine-up.lock')
CONFIG = Path('/etc/club-arena-release-controller/engine-operation-v2.json')
POLICY_DIGEST = '1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda'

def instant(value):
    require(isinstance(value, str))
    return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)

def validate_authority(a, envelope, now_ms, health):
    r, e, s, interval = envelope['request'], a['provider_operation'], a['step'], a['interval']
    require(a['policy_version'] == 2 and a['policy_digest'] == POLICY_DIGEST)
    require(re.fullmatch(r'[0-9a-f-]{36}', a['activation_receipt']))
    require(e['id'] == envelope['operation_id'] and e['epoch'] == envelope['epoch'] and
            e['intent']['provider_request'] == r and a['provider_request'] == r)
    require(a['current_owner'] == {'owner_id': e['owner_id'], 'epoch': e['epoch'], 'active_release': e['release_id']})
    require(e['status'] in ('INTENT', 'UNKNOWN') and e['kind'] == 'PUBLISH')
    require(s['owner_id'] == e['owner_id'] and s['epoch'] == e['epoch'] and s['kind'] == 'engine_cutover')
    require(s['operation_id'] == interval['operation_id'] and interval['release_id'] == e['release_id'] and
            s['step_key'] == 'publish:' + a['provider_plan']['id'] and interval['phase'] == 'applying')
    require(-1000 <= now_ms - instant(a['observed_at']) <= 5000)
    require(all(type(s[k]) is int and 0 < s[k] <= BASE.POLICY['plannedHoldMs'] for k in ('estimated_ms', 'recovery_ms', 'margin_ms')))
    end, forward = instant(interval['deadline_at']), instant(interval['forward_deadline_at'])
    require(end == instant(interval['freeze_started_at']) + BASE.POLICY['plannedHoldMs'] and
            forward == instant(interval['freeze_started_at']) + BASE.POLICY['forwardWorkMs'])
    require(now_ms < instant(s['not_after_at']) and now_ms < r['not_after_epoch'] * 1000)
    require(now_ms + s['estimated_ms'] + s['margin_ms'] <= forward)
    require(now_ms + s['estimated_ms'] + max(BASE.POLICY['recoveryReserveMs'], s['recovery_ms']) + s['margin_ms'] <= end)
    m = health.get('maintenance', {})
    require(health.get('running') is True and health.get('liveness') == 'ok' and health.get('releaseSha') == r['expected_current']['source_sha'])
    require(m.get('policyVersion') == 2 and m.get('policyDigest') == POLICY_DIGEST and m.get('activationReceipt') == a['activation_receipt'])
    require(m.get('readyForRestart') is True and m.get('operation', {}).get('operationId') == interval['operation_id'])
    require(m['operation'].get('releaseId') == e['release_id'] and m['operation'].get('phase') in ('ready', 'applying'))
    return {'forward_deadline_ms': min(now_ms + s['estimated_ms'], forward - s['margin_ms'], instant(s['not_after_at'])),
            'recovery_deadline_ms': end, 'operation_id': interval['operation_id'], 'step_id': s['id']}

class LinuxActuator:
    def __init__(self, envelope, config):
        self.envelope, self.config, self.r = envelope, config, envelope['request']
        self.scripts = secure(BASE.STAGING / self.r['run_key'] / 'server/scripts', file=False)
        files = {p.relative_to(self.scripts).as_posix(): p for p in self.scripts.rglob('*') if p.is_file() or p.is_symlink()}
        require(set(files) == set(config['control_files']) and self.r['control_sha'] == config['trusted_control_sha'])
        import hashlib
        require(all(hashlib.sha256(secure(p).read_bytes()).hexdigest() == config['control_files'][n] for n, p in files.items()))
        self.deadline = time.time() + 60
    def run(self, args, *, env=None, input=None, pass_fds=(), timeout=30, checked=True):
        budget = min(timeout, self.deadline - time.time())
        require(budget > 0)
        child = subprocess.Popen([str(x) for x in args], env={**BASE.ENV, **(env or {})}, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, pass_fds=pass_fds, start_new_session=True)
        try:
            stdout, _ = child.communicate(input, timeout=budget)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)
            try: child.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL);child.communicate(timeout=2)
            command_name=Path(str(args[0])).name
            if command_name in ('docker','engine-up.sh','engine-supervisor.sh'):
                marker=STATE/self.envelope['operation_id']/'uncertain-command.json'
                if not marker.exists():persist(marker,{'command':command_name,'reason':'native_response_timeout'})
            raise
        result=subprocess.CompletedProcess(args,child.returncode,stdout,'')
        require(len(result.stdout) <= 65536)
        if checked: require(result.returncode == 0)
        return result
    def seal(self, *args, **kwargs): return self.run([self.scripts/'engine-release-seal.py', *args], **kwargs)
    def authority(self, action, context=None):
        payload = {'action': action, 'provider_operation_id': self.envelope['operation_id']}
        if action == 'consume':
            payload.update(owner=context['provider_operation']['owner_id'], epoch=self.envelope['epoch'],
                operation_id=context['interval']['operation_id'], step_id=context['step']['id'])
        # Only the separately installed credential reference enters this trusted
        # database helper; it never enters engine-up or candidate environment.
        credential_dir = os.environ.get('CREDENTIALS_DIRECTORY')
        require(credential_dir and credential_dir.startswith('/run/credentials/'))
        authority_path = secure(Path(self.config['authority_config_path']))
        require(NATIVE.digest(authority_path.read_bytes()) == self.config['authority_config_digest'])
        result = self.run(['/usr/bin/node', secure(Path(self.config['bundle_path'])/'actuator-journal.mjs'),
            authority_path], input=json.dumps(payload),
            env={'CREDENTIALS_DIRECTORY': credential_dir}, timeout=20)
        return json.loads(result.stdout)
    def health(self, public=False, sealed_source=False):
        url = 'https://engine.smarter.poker/health' if public else 'http://127.0.0.1:8080/health'
        result = self.run(['/usr/bin/curl','--silent','--show-error','--max-time','10',
            '--header','Cache-Control: no-cache, no-store','--write-out','\n%{http_code}',url],timeout=12)
        body, status = result.stdout.rsplit('\n', 1)
        require(status in ('200','503') if sealed_source else status == '200')
        value = json.loads(body)
        require(isinstance(value,dict))
        return value
    def inspect(self):
        return json.loads(self.run(['/usr/bin/docker','container','inspect','--format','{{json .}}','club-arena-engine']).stdout)
    def witness(self, sha, image, sealed_source=False):
        if sealed_source:
            require(sha == self.r['expected_current']['source_sha'] and image == self.r['expected_current']['image_id'])
            require(self.seal('get','desired-sha').stdout.strip() == sha and self.seal('get','desired-image-id').stdout.strip() == image)
        c = self.inspect(); local, public = self.health(sealed_source=sealed_source), self.health(True,sealed_source=sealed_source)
        require(c['Image'] == image and c['State']['Status'] == 'running' and c['Config']['Labels'].get('sp.release.sha') == sha)
        require(local.get('running') is True and local.get('liveness') == 'ok' and local.get('releaseSha') == sha and
                re.fullmatch(r'[1-9][0-9]*-[0-9a-f]{8}', local.get('instanceId','')))
        require(public.get('running') is True and public.get('instanceId') == local['instanceId'] and public.get('releaseSha') == sha and public.get('liveness') == 'ok')
        self.run([self.scripts/'engine-release-database-proof.py','--env-file','/opt/club-arena/server/.env','--sha',sha,
            '--instance-id',local['instanceId'],'--timeout-seconds','15','--poll-seconds','3','--max-heartbeat-age-seconds','15'],timeout=18)
        current = self.inspect(); refreshed = self.health(sealed_source=sealed_source)
        require(current['Id'] == c['Id'] and current['Image'] == image and current['State']['Status'] == 'running' and
                current['State']['StartedAt'] == c['State']['StartedAt'] and
                refreshed.get('instanceId') == local['instanceId'] and refreshed.get('releaseSha') == sha and
                refreshed.get('running') is True and refreshed.get('liveness') == 'ok')
        return {'container_id':c['Id'],'started_at':c['State']['StartedAt'],'instance_id':local['instanceId']}
    def preflight(self):
        BASE.dispatch('preflight', self.envelope, self.config)
        require(self.seal('get','desired-sha').stdout.strip() == self.r['expected_current']['source_sha'])
        require(self.seal('get','desired-image-id').stdout.strip() == self.r['expected_current']['image_id'])
        self.witness(self.r['expected_current']['source_sha'],self.r['expected_current']['image_id'],sealed_source=True)
    def audit(self):
        return ['--run-id',self.r['run_key'],'--run-url','https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/'+self.r['run_key'].split('-')[0],
            '--actor',self.r['actor'],'--reason','owned policy2 exact engine replacement']
    def trial(self):
        token = self.seal('prepare','--sha',self.r['source_sha'],'--image',self.r['artifact_image_id'],'--mode','deploy',
            '--repo','/opt/club-arena',*self.audit()).stdout.strip()
        require(re.fullmatch(r'[0-9a-f]{64}',token))
        self.run(['/usr/bin/docker','stop','-t','15','sp-autoheal'],timeout=20)
        reader,writer=os.pipe()
        try:
            require(3 <= reader <= 9)
            os.write(writer,(token+'\n').encode());os.close(writer);writer=-1;token=''
            self.run([self.scripts/'engine-up.sh'],env={'ENGINE_UP_LOCK_HELD':'1','ENGINE_RELEASE_TOKEN_FD':str(reader),
                'ENGINE_CONTROL_DIR':str(self.scripts),'IMAGE':self.r['artifact_image_id']},pass_fds=(reader,),timeout=90)
        finally:
            os.close(reader)
            if writer>=0:os.close(writer)
        while True:
            try: return self.witness(self.r['source_sha'],self.r['artifact_image_id'])
            except Exception:
                require(time.time()+5 < self.deadline);time.sleep(5)
    def commit(self, witness):
        self.seal('commit','--sha',self.r['source_sha'],'--image',self.r['artifact_image_id'],'--container','club-arena-engine',*self.audit(),checked=False)
        require(self.committed())
        return self.finalize()
    def committed(self):
        return self.seal('attest-commit','--sha',self.r['source_sha'],'--image-id',self.r['artifact_image_id'],
            '--run-id',self.r['run_key'],checked=False).returncode == 0
    def finalize(self):
        self.run(['/usr/bin/docker','tag',self.r['artifact_image_id'],'club-arena-engine:current'])
        self.run(['/usr/bin/docker','update','--restart','always','club-arena-engine'])
        self.run(['/usr/bin/docker','start','sp-autoheal'])
        witness=self.witness(self.r['source_sha'],self.r['artifact_image_id'])
        invocation=os.environ.get('INVOCATION_ID','')
        require(re.fullmatch(r'[0-9a-f]{32}',invocation))
        self.seal('record-result','--sha',self.r['source_sha'],'--image-id',self.r['artifact_image_id'],'--result','sealed',
            '--instance-id',witness['instance_id'],'--container-id',witness['container_id'],'--started-at',witness['started_at'],
            '--run-id',self.r['run_key'],'--control-sha',self.r['control_sha'],'--invocation-id',invocation)
        return witness
    def recover(self):
        require(self.seal('get','desired-sha').stdout.strip()==self.r['expected_current']['source_sha'] and
                self.seal('get','desired-image-id').stdout.strip()==self.r['expected_current']['image_id'])
        self.seal('abort','--run-id',self.r['run_key'],checked=False)
        self.run([self.scripts/'engine-supervisor.sh'], env={'ENGINE_SUPERVISOR_LOCK_HELD':'1','ENGINE_SUPERVISOR_FORCE_DESIRED':'1',
            'ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH':'1','ENGINE_RECOVERY_DEADLINE_EPOCH':str(int(self.deadline)),
            'ENGINE_CONTROL_DIR':str(self.scripts)},timeout=600)
        sha=self.seal('get','desired-sha').stdout.strip();image=self.seal('get','desired-image-id').stdout.strip()
        self.witness(sha,image,sealed_source=True)
        return {'recovered_sha':sha,'image_id':image}

def transaction(envelope, host, folder, recovery_only=False):
    r=envelope['request']; result_file=folder/'result.json'
    if result_file.exists(): return json.loads(secure(result_file).read_text())
    attempted=folder/'claim-attempt.json'
    if not attempted.exists() and not recovery_only:
        host.preflight()
        context=host.authority('context')
        original_budget=validate_authority(context,envelope,int(time.time()*1000),host.health(sealed_source=True))
        persist(attempted, {'envelope':envelope,'attempted_at_ms':int(time.time()*1000),
                           'recovery_deadline_ms':original_budget['recovery_deadline_ms']})
        # A lost commit response follows the recovery branch on native restart.
        claim=host.authority('consume',context)
        require(claim.get('consumed') is True)
        authority=claim['authority']
        budget=validate_authority(authority,envelope,int(time.time()*1000),host.health(sealed_source=True))
        require(budget['recovery_deadline_ms']==original_budget['recovery_deadline_ms'])
        persist(folder/'consumption.json',claim)
        persist(folder/'recovery-window.json', {'deadline_ms': budget['recovery_deadline_ms']})
        host.deadline=budget['forward_deadline_ms']/1000
        try:
            witness=host.trial();host.commit(witness)
            result={'terminal':True,'outcome':'SUCCEEDED','result':'sealed','image_id':r['artifact_image_id']}
        except Exception:
            host.deadline=budget['recovery_deadline_ms']/1000
            if host.committed(): host.finalize();result={'terminal':True,'outcome':'SUCCEEDED','result':'sealed','image_id':r['artifact_image_id']}
            else: result={'terminal':True,'outcome':'FAILED',**host.recover()}
    elif attempted.exists():
        # Lost consume responses retain only sealed recovery authority. A single
        # persisted recovery clock survives restart; retries cannot extend it.
        recovery_window = folder / 'recovery-window.json'
        if not recovery_window.exists():
            original=json.loads(secure(attempted).read_text())
            require(original['envelope']==envelope and type(original['recovery_deadline_ms']) is int and
                    time.time()*1000 < original['recovery_deadline_ms'])
            persist(recovery_window, {'deadline_ms': original['recovery_deadline_ms']})
        host.deadline=json.loads(secure(recovery_window).read_text())['deadline_ms']/1000
        require(time.time() < host.deadline)
        if host.committed():host.finalize();result={'terminal':True,'outcome':'SUCCEEDED','result':'sealed','image_id':r['artifact_image_id']}
        else:result={'terminal':True,'outcome':'FAILED',**host.recover()}
    else: return {'terminal':False,'reason':'NO_OWNED_MUTATION_ATTEMPT'}
    result.update(operation_id=envelope['operation_id'],source_sha=r['source_sha'],control_sha=r['control_sha'],run_key=r['run_key'])
    if (folder/'uncertain-command.json').exists():
        return {'terminal':False,'reason':'NATIVE_MUTATION_OUTCOME_REQUIRES_EXPLICIT_RECONCILIATION',
                'operation_id':envelope['operation_id']}
    persist(result_file,result);return result

def execute_native(operation, mode, *, manager=None, verify=NATIVE.verify_configuration,
                   host_factory=LinuxActuator, executable=__file__, native_id=None):
    manager = manager or NATIVE.Manager()
    folder=secure(STATE/operation,file=False)
    config, files = NATIVE.pinned_configuration(folder, executable=executable)
    verify(config)
    manager.verify(files)
    envelope=json.loads(secure(folder/'intent.json').read_text())
    require(envelope['operation_id']==operation)
    if not (folder/'acceptance.json').exists() and not (folder/'execution-owner.json').exists():
        return {'terminal':False,'reason':'NO_ACCEPTED_NATIVE_EVENT'}, 0
    native_id = native_id or os.environ.get('INVOCATION_ID', '')
    NATIVE.claim_event(folder)
    if (folder/'result.json').exists():
        # Exact terminal cleanup is readback of prior authority, not another
        # candidate/recovery attempt. It remains resumable after retry expiry.
        result=json.loads(secure(folder/'result.json').read_text())
    else:
        if not NATIVE.invocation(folder, native_id, mode):
            return {'terminal':False,'reason':'NATIVE_ATTEMPT_BUDGET_EXHAUSTED_OR_NO_APPLY'}, (1 if mode=='apply' else 0)
        result = transaction(envelope,host_factory(envelope,config),folder,mode=='recover')
    if result.get('terminal') is True and not (folder/'uncertain-command.json').exists():
        request=envelope['request']
        require(all(result[key]==value for key,value in {'operation_id':operation,'run_key':request['run_key'],
            'source_sha':request['source_sha'],'control_sha':request['control_sha']}.items()))
        require((result['outcome']=='SUCCEEDED' and result['image_id']==request['artifact_image_id']) or
            (result['outcome']=='FAILED' and result['image_id']==request['expected_current']['image_id'] and
             result['recovered_sha']==request['expected_current']['source_sha']))
        manager.retire(operation)
        persist(folder/'retired.json', {'operation_id':operation,
            'result_digest':NATIVE.digest(secure(folder/'result.json').read_bytes()),
            'installation_digest':NATIVE.digest(secure(folder/'installation.json').read_bytes())})
        return result, 0
    return result, (75 if mode=='apply' else 0)


def main():
    require(os.geteuid()==0 and len(sys.argv)==3 and sys.argv[1] in ('apply','recover'))
    operation=sys.argv[2];require(re.fullmatch(r'[0-9a-f-]{36}',operation))
    mode=sys.argv[1]
    unit=f'club-arena-engine-operation-v2@{operation}.service'
    state=BASE.command(['/usr/bin/systemctl','show',unit,'-p','MainPID','-p','ControlPID','-p','InvocationID'])
    fields=dict(line.split('=',1) for line in state.stdout.splitlines() if '=' in line)
    require(state.returncode==0 and fields.get('InvocationID')==os.environ.get('INVOCATION_ID') and
            fields.get('MainPID' if mode=='apply' else 'ControlPID')==str(os.getpid()))
    with NATIVE.mutation_lock(LOCK):
        result, code = execute_native(operation,mode)
    print(json.dumps(result))
    return code
if __name__=='__main__':
    try:sys.exit(main())
    except Exception:
        print(json.dumps({'error':'RELEASE_ENGINE_OPERATION_V2_UNRESOLVED'}))
        # Recovery failure is never terminal proof and cannot reset the bounded
        # apply budget through an independently failing ExecStopPost hook.
        sys.exit(0 if len(sys.argv)>1 and sys.argv[1]=='recover' else 75)
