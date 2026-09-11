"""Real filesystem/flock/subprocess tests; no production paths or credentials."""
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    loaded = importlib.util.module_from_spec(spec); spec.loader.exec_module(loaded)
    return loaded


N = module('wiring', ROOT / 'operations/release/native/engine-native-v2.py')
I = module('installer_v2', ROOT / 'operations/release/native/install-engine-native-v2.py')
V = module('actuator_v2', ROOT / 'operations/release/native/engine-operation-v2.py')
F = module('runtime_fixture', ROOT / 'tests/operations/native-operation-v2.test.py')


class Crash(BaseException):
    pass


class WiringTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='engine-native-v2-')
        self.root = Path(self.temp.name).resolve()
        self.state = self.root / 'state'; self.state.mkdir()
        self.units = self.root / 'units'; self.units.mkdir()
        (self.units / 'multi-user.target.wants').mkdir()
        self.bundle = self.root / ('a' * 64); (self.bundle / 'native').mkdir(parents=True)
        for suffix in ('service', 'path'):
            name = 'club-arena-engine-operation-v2@.' + suffix
            shutil.copyfile(ROOT / 'operations/release/native' / name, self.bundle / 'native' / name)
        shutil.copyfile(ROOT/'operations/release/native/engine-intake-dispatch-v2.py',self.bundle/'native/engine-intake-dispatch-v2.py')
        self.config = {'protocol': 2, 'policy_digest': V.POLICY_DIGEST,
            'bundle_path': str(self.bundle), 'bundle_digest': self.bundle.name,
            'actuator_credential_name': 'actuator', 'actuator_credential_path': str(self.root / 'credential'),
            'authority_config_path': str(self.root / ('b' * 64) / 'authority.json'), 'authority_config_digest': 'b' * 64}
        self.envelope, self.authority, self.health = F.fixture(int(F.time.time()*1000))
        self.operation = self.envelope['operation_id']; self.folder = self.state / self.operation
        self.patches = []
        def trusted(path, file=True):
            path = Path(path)
            self.assertTrue(path == self.root or self.root in path.parents)
            for value in (path, *path.parents):
                if value == self.root.parent: break
                self.assertFalse(value.is_symlink()); self.assertFalse(value.lstat().st_mode & 0o022)
            if file: self.assertTrue(path.is_file())
            return path
        for m in (N, N.BASE, I.NATIVE, I.BASE, V, V.NATIVE, V.BASE):
            self.patches.append(patch.object(m, 'secure', side_effect=trusted))
        self.patches.extend([patch.object(N, 'UNITS', self.units),
            patch.object(N, 'ROOT_UID', os.getuid()),
            patch.object(N, 'WANTS', self.units / 'multi-user.target.wants'), patch.object(V, 'STATE', self.state)])
        for p in self.patches: p.start()
        self.calls = []
        # An external process persists the native-manager fixture across caller
        # interruption. Actual helper installation/fsync/flock paths run above it.
        self.fixture = self.root / 'systemd-fixture.py'
        self.fixture.write_text('''import json,sys
from pathlib import Path
root=Path(sys.argv[1]);args=sys.argv[2:];calls=root/'calls.json'
history=json.loads(calls.read_text()) if calls.exists() else []
history.append(args);calls.write_text(json.dumps(history))
statefile=root/'manager.json';state=json.loads(statefile.read_text()) if statefile.exists() else {'enabled':[],'active':[]}
if Path(args[0]).name=='systemd-analyze':
 for item in args[2:]:
  text=Path(item).read_text()
  if 'RestartForceExitStatus=' in text or '@BUNDLE@' in text:sys.exit(1)
elif args[1]=='daemon-reload':pass
elif args[1]=='show':
 name=args[2];raw=(root/'units'/name).read_text();source=dict(line.split('=',1) for line in raw.splitlines() if '=' in line)
 properties=args[4::2]
 vals={'LoadState':'loaded','FragmentPath':str(root/'units'/name),'DropInPaths':'','NeedDaemonReload':'no',
 'Type':'oneshot','User':'root','Restart':'on-failure','TimeoutStartUSec':'30min','TimeoutStopUSec':'11min',
 'KillMode':'control-group','RestartPreventExitStatus':'1','Unit':source.get('Unit',''),
 'Paths':source.get('PathExists','')+' (PathExists)'}
 for key in ('ExecStart','ExecStopPost'):
  vals[key]='{ path=/usr/bin/python3 ; argv[]='+source.get(key,'')+' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }'
 overrides=root/'overrides.json'
 if overrides.exists():vals.update(json.loads(overrides.read_text()))
 print('\\n'.join(key+'='+vals.get(key,'') for key in properties))
elif args[1]=='enable':state['enabled']=list(set(state['enabled']+args[2:]))
elif args[1]=='disable':state['enabled']=[n for n in state['enabled'] if n not in args[2:]]
elif args[1]=='start':state['active']=list(set(state['active']+args[2:]))
elif args[1]=='stop':state['active']=[n for n in state['active'] if n not in args[2:]]
elif args[1]=='is-enabled':print('enabled' if args[2] in state['enabled'] else 'disabled')
elif args[1]=='is-active':print('active' if args[2] in state['active'] else 'inactive')
else:sys.exit(2)
statefile.write_text(json.dumps(state))
''')
        self.command_patch = patch.object(N.BASE, 'command', side_effect=lambda args,timeout=35:
            subprocess.run([sys.executable, '-B', str(self.fixture), str(self.root), *map(str,args)],
                capture_output=True,text=True,timeout=timeout))
        self.command_patch.start()
        self.manager=N.Manager()

    def tearDown(self):
        self.command_patch.stop()
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()

    def prepare(self, interrupt=lambda stage:None):
        return N.prepare(self.envelope,self.config,self.manager,self.state,interrupt)

    def test_acceptance_follows_durable_boot_edges_and_exact_loaded_units(self):
        self.assertTrue(self.prepare()['accepted'])
        state=json.loads((self.root/'manager.json').read_text())
        self.assertEqual(len(state['enabled']),2)
        self.assertEqual(state['active'],[f'club-arena-engine-operation-v2@{self.operation}.path'])
        calls=json.loads((self.root/'calls.json').read_text())
        self.assertFalse(any('start' in a and a[-1].endswith('.service') for a in calls))
        self.assertTrue((self.folder/'acceptance.json').exists())
        self.assertEqual(self.prepare()['replayed'],True)

    def test_every_acceptance_crash_replays_same_operation_and_single_event(self):
        for stage in ('PINNED','INSTALLED','ARMED','ACCEPTED'):
            with self.subTest(stage=stage):
                self.operation=str(uuid4());self.envelope['operation_id']=self.operation;self.folder=self.state/self.operation
                def crash(observed):
                    if observed==stage:raise Crash()
                with self.assertRaises(Crash):self.prepare(crash)
                self.assertTrue(self.prepare()['accepted'])
                pin=N.claim_event(self.folder)
                self.assertFalse((self.folder/'acceptance.json').exists())
                self.assertEqual(N.claim_event(self.folder),pin)
                self.assertTrue(self.prepare()['replayed'])
                self.assertFalse((self.folder/'acceptance.json').exists())

    def test_real_provider_reconciliation_resumes_only_the_exact_partial_native_pin(self):
        intake=module('intake_v2',ROOT/'operations/release/native/engine-intake-v2.py')
        intake.V2=V;intake.NATIVE=N;intake.BASE=N.BASE
        intake.__file__=str(self.bundle/'native/engine-intake-v2.py')
        self.envelope['request'].update(manifest_digest='b'*64,server_tree_sha='a'*40,actor='native-fixture')
        with patch.object(N,'verify_configuration',return_value={}),patch.object(N.BASE,'dispatch',return_value={'ready':True}):
            with self.assertRaises(ValueError):intake.dispatch('resume-acceptance',self.envelope,self.config,self.manager)
            for stage in ('PINNED','INSTALLED','ARMED'):
                with self.subTest(stage=stage):
                    self.operation=str(uuid4());self.envelope['operation_id']=self.operation;self.folder=self.state/self.operation
                    def crash(observed):
                        if observed==stage:raise Crash()
                    with self.assertRaises(Crash):self.prepare(crash)
                    code='''import {createInterface} from 'node:readline';
import {HetznerIntakeAdapter} from ADAPTER;
const envelope=ENVELOPE;const io=createInterface({input:process.stdin});
const request=(action,payload)=>new Promise((resolve,reject)=>{io.once('line',line=>{const result=JSON.parse(line);result.__lost?reject(new Error('fixture lost native reply')):resolve(result);});console.log(JSON.stringify({action,payload}));});
const adapter=new HetznerIntakeAdapter({controlSha:envelope.request.control_sha,request});
let result;try{await adapter.reconcile(envelope.request,{id:envelope.operation_id,epoch:envelope.epoch});throw new Error('fixture must lose resume reply');}
catch{result=await adapter.reconcile(envelope.request,{id:envelope.operation_id,epoch:envelope.epoch});}
console.log(JSON.stringify({done:result}));io.close();process.stdin.destroy();
'''.replace('ADAPTER',json.dumps((ROOT/'operations/release/adapters/hetzner.mjs').as_uri())).replace('ENVELOPE',json.dumps(self.envelope))
                    node=shutil.which('node');self.assertIsNotNone(node)
                    child=subprocess.Popen([node,'--input-type=module','-e',code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                    seen=[]
                    try:
                        for line in child.stdout:
                            message=json.loads(line)
                            if 'done' in message:
                                self.assertFalse(message['done']['terminal']);break
                            seen.append(message['action'])
                            answer=intake.dispatch(message['action'],message['payload'],self.config,self.manager)
                            if message['action']=='resume-acceptance':answer={'__lost':True}
                            child.stdin.write(json.dumps(answer)+'\n');child.stdin.flush()
                        child.wait(timeout=10);self.assertEqual(child.returncode,0,child.stderr.read())
                    finally:
                        if child.poll() is None:child.kill();child.wait()
                        for stream in (child.stdin,child.stdout,child.stderr):stream.close()
                    self.assertEqual(seen,['observe','resume-acceptance','observe'])
                    self.assertTrue((self.folder/'acceptance.json').exists())
                    changed=copy.deepcopy(self.envelope);changed['epoch']=str(uuid4())
                    with self.assertRaises(ValueError):intake.dispatch('resume-acceptance',changed,self.config,self.manager)
                    with self.assertRaises(ValueError):intake.dispatch('resume-acceptance',self.envelope,self.config,self.manager)
                    N.claim_event(self.folder)
                    V.persist(self.folder/'result.json',{'terminal':True})
                    with self.assertRaises(ValueError):intake.dispatch('resume-acceptance',self.envelope,self.config,self.manager)

    def test_changed_envelope_config_or_loaded_command_cannot_reattach(self):
        self.prepare()
        for change in ('envelope','config','loaded'):
            with self.subTest(change=change):
                e,c=copy.deepcopy(self.envelope),copy.deepcopy(self.config)
                if change=='envelope':e['epoch']=str(uuid4())
                if change=='config':c['actuator_credential_name']='foreign'
                if change=='loaded':(self.root/'overrides.json').write_text(json.dumps({'ExecStart':'untrusted'}))
                with self.assertRaises(ValueError):N.prepare(e,c,self.manager,self.state)
                (self.root/'overrides.json').unlink(missing_ok=True)

    def test_loaded_dropin_timeout_path_or_daemon_drift_refuses_before_acceptance(self):
        for key,value in [('DropInPaths','foreign.conf'),('TimeoutStartUSec','infinity'),('Paths','wrong (PathExists)'),
                          ('NeedDaemonReload','yes'),('Restart','always')]:
            with self.subTest(key=key):
                (self.root/'overrides.json').write_text(json.dumps({key:value}))
                with self.assertRaises(ValueError):self.prepare()
                self.assertFalse((self.folder/'acceptance.json').exists())

    def test_atomic_bytes_reject_mismatch_symlink_and_writable_parent(self):
        target=self.root/'value.json';N.immutable(target,b'first');N.immutable(target,b'first')
        with self.assertRaises(ValueError):N.immutable(target,b'second')
        link=self.root/'link';link.symlink_to(target)
        with self.assertRaises(AssertionError):N.immutable(link,b'first')
        self.root.chmod(0o777)
        try:
            with self.assertRaises(AssertionError):N.directory(self.root/'untrusted')
        finally:self.root.chmod(0o700)

    def test_real_flock_excludes_other_process_without_native_actions(self):
        lock=self.root/'engine.lock'
        with N.mutation_lock(lock,timeout=.1):
            code='import fcntl,os,sys;f=open(sys.argv[1],"a");fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)'
            child=subprocess.run([sys.executable,'-c',code,str(lock)],capture_output=True)
            self.assertNotEqual(child.returncode,0)
        with N.mutation_lock(lock,timeout=.1):pass

    def test_fixed_system_alias_and_sticky_directory_reuse_the_existing_lock_inode(self):
        var=self.root/'var';run=self.root/'run';var.mkdir();run.mkdir()
        canonical=run/'lock';canonical.mkdir();alias=var/'lock';alias.symlink_to(canonical)
        lock=alias/'club-arena-engine-up.lock';lock.write_bytes(b'');lock.chmod(0o644)
        original=(lock.stat().st_dev,lock.stat().st_ino)
        with patch.object(N,'LOCK',lock),patch.object(N,'LOCK_ALIAS',alias),patch.object(N,'LOCK_CANONICAL_PARENT',canonical):
            for mode in (0o755,0o1777):
                with self.subTest(mode=oct(mode)):
                    canonical.chmod(mode)
                    with N.mutation_lock(lock,timeout=.1):
                        self.assertEqual((lock.stat().st_dev,lock.stat().st_ino),original)
                        code='import fcntl,sys;f=open(sys.argv[1],"a");fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)'
                        child=subprocess.run([sys.executable,'-c',code,str(canonical/lock.name)],capture_output=True)
                        self.assertNotEqual(child.returncode,0)
                    self.assertEqual(lock.stat().st_mode & 0o777,0o644)
            canonical.chmod(0o755)

    def test_lock_refuses_foreign_alias_owner_and_nonsticky_shared_directory(self):
        var=self.root/'var';run=self.root/'run';var.mkdir();run.mkdir()
        canonical=run/'lock';canonical.mkdir();alias=var/'lock';alias.symlink_to(canonical)
        lock=alias/'club-arena-engine-up.lock'
        with patch.object(N,'LOCK',lock),patch.object(N,'LOCK_ALIAS',alias),patch.object(N,'LOCK_CANONICAL_PARENT',canonical):
            canonical.chmod(0o777)
            with self.assertRaises(ValueError):
                with N.mutation_lock(lock):self.fail('untrusted directory entered')
            canonical.chmod(0o755)
            with patch.object(N,'ROOT_UID',os.getuid()+1):
                with self.assertRaises(ValueError):
                    with N.mutation_lock(lock):self.fail('foreign alias entered')
            alias.unlink();alias.symlink_to(self.root/'state')
            with self.assertRaises(ValueError):
                with N.mutation_lock(lock):self.fail('foreign destination entered')

    def test_lock_refuses_final_symlink_writable_owner_or_inode_replacement(self):
        lock=self.root/'engine.lock';other=self.root/'other';other.write_bytes(b'')
        lock.symlink_to(other)
        with self.assertRaises(ValueError):
            with N.mutation_lock(lock):self.fail('final symlink entered')
        lock.unlink();lock.write_bytes(b'');lock.chmod(0o666)
        with self.assertRaises(ValueError):
            with N.mutation_lock(lock):self.fail('writable lock entered')
        lock.chmod(0o600)
        with patch.object(N,'ROOT_UID',os.getuid()+1):
            with self.assertRaises(ValueError):
                with N.mutation_lock(lock):self.fail('foreign lock entered')
        original=N.fcntl.flock
        def replaced(descriptor,flags):
            original(descriptor,flags)
            lock.rename(self.root/'prior-lock');lock.write_bytes(b'')
        with patch.object(N.fcntl,'flock',side_effect=replaced):
            with self.assertRaises(ValueError):
                with N.mutation_lock(lock):self.fail('changed inode entered')

    def test_invocation_budget_survives_replay_and_does_not_reset_on_recovery(self):
        self.prepare();N.claim_event(self.folder)
        for index in range(12):
            invocation=uuid4().hex
            self.assertTrue(N.invocation(self.folder,invocation,'apply'))
            self.assertTrue(N.invocation(self.folder,invocation,'recover'))
        self.assertFalse(N.invocation(self.folder,uuid4().hex,'apply'))
        self.assertFalse(N.invocation(self.folder,uuid4().hex,'recover'))
        self.assertEqual(len(list((self.folder/'invocations').glob('*.json'))),12)

    def test_pinned_configuration_survives_new_default_but_wrong_executable_refuses(self):
        self.prepare()
        config,_=N.pinned_configuration(self.folder,executable=self.bundle/'native/engine-operation-v2.py')
        self.assertEqual(config,self.config)
        with self.assertRaises(ValueError):N.pinned_configuration(self.folder,executable=self.root/'foreign/native/engine-operation-v2.py')

    def test_real_lifecycle_retires_only_after_terminal_receipt_and_does_not_repeat_trial(self):
        self.prepare();host=F.FakeHost(self.envelope,self.authority,self.health)
        for mode in ('apply','recover','apply'):
            result,code=V.execute_native(self.operation,mode,manager=self.manager,verify=lambda c:None,
                host_factory=lambda e,c:host,executable=self.bundle/'native/engine-operation-v2.py',native_id='1'*32)
            self.assertEqual(code,0);self.assertTrue(result['terminal'])
        self.assertEqual(host.trials,1);self.assertEqual(host.claims,1)
        self.assertTrue((self.folder/'retired.json').exists())
        self.assertEqual(json.loads((self.root/'manager.json').read_text())['enabled'],[])

    def test_lost_consume_response_on_new_invocation_restores_only_sealed_desired(self):
        self.prepare();host=F.FakeHost(self.envelope,self.authority,self.health);host.fail='lost_claim'
        arguments=dict(manager=self.manager,verify=lambda c:None,host_factory=lambda e,c:host,
            executable=self.bundle/'native/engine-operation-v2.py')
        with self.assertRaises(TimeoutError):V.execute_native(self.operation,'apply',native_id='1'*32,**arguments)
        result,code=V.execute_native(self.operation,'apply',native_id='2'*32,**arguments)
        self.assertEqual(code,0);self.assertEqual(result['outcome'],'FAILED')
        self.assertEqual(host.trials,0);self.assertEqual(host.claims,1);self.assertEqual(host.restores,1)

    def test_recovery_deadline_and_unknown_result_survive_process_restart(self):
        self.prepare();host=F.FakeHost(self.envelope,self.authority,self.health)
        V.persist(self.folder/'claim-attempt.json',{'fixture':'already attempted'})
        V.persist(self.folder/'recovery-window.json',{'deadline_ms':0})
        with self.assertRaises(ValueError):V.transaction(self.envelope,host,self.folder,True)
        self.assertEqual(host.restores,0);self.assertFalse((self.folder/'result.json').exists())

    def test_terminal_cleanup_after_lost_disable_response_survives_exhausted_attempts(self):
        self.prepare();host=F.FakeHost(self.envelope,self.authority,self.health)
        args=dict(manager=self.manager,verify=lambda c:None,host_factory=lambda e,c:host,
            executable=self.bundle/'native/engine-operation-v2.py')
        original=self.manager.retire
        def lost(operation):
            original(operation);raise TimeoutError('lost native disable reply')
        with patch.object(self.manager,'retire',side_effect=lost):
            with self.assertRaises(TimeoutError):V.execute_native(self.operation,'apply',native_id='1'*32,**args)
        self.assertTrue((self.folder/'result.json').exists());self.assertFalse((self.folder/'retired.json').exists())
        for i in range(11):self.assertTrue(N.invocation(self.folder,uuid4().hex,'apply'))
        result,code=V.execute_native(self.operation,'apply',native_id='2'*32,**args)
        self.assertEqual(code,0);self.assertTrue(result['terminal']);self.assertEqual(host.trials,1)

    def test_inactive_installer_cas_and_lost_pointer_response_replay(self):
        current=self.root/'current.json';versions=self.root/'versions'
        raw=N.canonical(self.config);digest=N.digest(raw)
        class Validator:
            def verify(this,files,directory):
                self.assertEqual(len(files),2)
        def run(interrupt=lambda stage:None,prior='none'):
            return I.install(raw,digest,prior,current=current,versions=versions,verifier=lambda c:None,
                router=self.root/'installed-router',validator=Validator(),interrupt=interrupt)
        def crash(stage):
            if stage=='POINTER_UPDATED':raise Crash()
        with self.assertRaises(Crash):run(crash)
        result=run();self.assertFalse(result['execution_activated']);self.assertFalse(result['identity_verified'])
        self.assertEqual(result['state'],'INSTALLED_INACTIVE')
        self.assertEqual(run(),result)
        with self.assertRaises(ValueError):run(prior='c'*64)
        self.assertFalse((self.root/'calls.json').exists())

    def test_router_preserves_accepted_bundle_across_default_upgrade(self):
        router=module('dispatch_v2',ROOT/'operations/release/native/engine-intake-dispatch-v2.py')
        def bundle(tag):
            directory=self.root/tag;(directory/'native').mkdir(parents=True)
            script=directory/'native/engine-intake-v2.py';script.write_text('# '+tag)
            raw=N.canonical({'format':1,'schema_version':1,'provider_schema_version':1,
                'files':{'native/engine-intake-v2.py':N.digest(script.read_bytes())}})
            (directory/'bundle-manifest.json').write_bytes(raw)
            target=self.root/N.digest(raw);directory.rename(target)
            config={**self.config,'bundle_path':str(target),'bundle_digest':target.name}
            return config,target/'native/engine-intake-v2.py'
        old,old_path=bundle('old');new,new_path=bundle('new')
        current=self.root/'route-default.json';current.write_bytes(N.canonical(new))
        read=lambda p:p.read_bytes()
        self.assertEqual(router.select(self.envelope,current=current,state=self.state,read=read),new_path)
        self.folder.mkdir()
        intent=N.canonical(self.envelope);config=N.canonical(old)
        (self.folder/'intent.json').write_bytes(intent);(self.folder/'configuration.json').write_bytes(config)
        (self.folder/'installation.json').write_bytes(N.canonical({'operation_id':self.operation,
            'configuration_digest':N.digest(config),'envelope_digest':N.digest(intent),'bundle_digest':old['bundle_digest']}))
        self.assertEqual(router.select(self.envelope,current=current,state=self.state,read=read),old_path)
        changed=copy.deepcopy(self.envelope);changed['epoch']=str(uuid4())
        with self.assertRaises(ValueError):router.select(changed,current=current,state=self.state,read=read)
        old_path.write_text('# changed installed code')
        with self.assertRaises(ValueError):router.select(self.envelope,current=current,state=self.state,read=read)

    def test_native_entrypoint_import_needs_no_service_credentials_and_writes_no_bytecode(self):
        isolated=self.root/'import-only';native=isolated/'native';native.mkdir(parents=True)
        for filename in ('engine-operation-v2.py','engine-native-v2.py','engine-boundary.py'):
            shutil.copyfile(ROOT/'operations/release/native'/filename,native/filename)
        shutil.copyfile(ROOT/'operations/release/operationPolicy.json',isolated/'operationPolicy.json')
        code='import runpy,subprocess;subprocess.Popen=lambda *a,**k:(_ for _ in ()).throw(RuntimeError("unexpected import action"));runpy.run_path(__import__("sys").argv[1],run_name="native_import_probe")'
        process=subprocess.run([sys.executable,'-B','-c',code,str(native/'engine-operation-v2.py')],
            env={'PATH':'/usr/bin:/bin'},capture_output=True,text=True,timeout=10)
        self.assertEqual(process.returncode,0,process.stderr)
        self.assertEqual(list(isolated.rglob('__pycache__')),[])

    @unittest.skipUnless(sys.platform=='linux' and shutil.which('systemd-analyze'),
                         'actual systemd parser runs on Linux CI, not macOS')
    def test_linux_systemd_parser_accepts_units_and_rejects_invalid_oneshot_restart(self):
        sandbox=self.root/'systemd-root';units=sandbox/'etc/systemd/system';units.mkdir(parents=True)
        binaries=sandbox/'usr/bin';binaries.mkdir(parents=True)
        for name in ('python3','true'):
            (binaries/name).write_text('#!/bin/sh\nexit 0\n');(binaries/name).chmod(0o755)
        for name in ('sysinit','basic','shutdown','sockets','timers','paths','multi-user','network-online'):
            (units/(name+'.target')).write_text('[Unit]\nDescription=Isolated syntax fixture\nDefaultDependencies=no\n')
        (units/'docker.service').write_text('[Service]\nType=oneshot\nExecStart=/usr/bin/true\n')
        files=N.rendered_units(self.operation,self.config,self.folder)
        for name,raw in files.items():(units/name).write_bytes(raw)
        argv=[shutil.which('systemd-analyze'),'--root='+str(sandbox),'verify',*files]
        good=subprocess.run(argv,capture_output=True,text=True,timeout=20,env={'PATH':'/usr/bin:/bin'})
        self.assertEqual(good.returncode,0,good.stderr)
        service=next(name for name in files if name.endswith('.service'))
        (units/service).write_bytes(files[service].replace(b'Restart=on-failure',b'Restart=on-failure\nRestartForceExitStatus=75'))
        bad=subprocess.run(argv,capture_output=True,text=True,timeout=20,env={'PATH':'/usr/bin:/bin'})
        self.assertNotEqual(bad.returncode,0)


if __name__=='__main__':unittest.main()
