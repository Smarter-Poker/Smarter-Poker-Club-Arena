#!/usr/bin/env python3
"""Real Git, filesystem, atomic seal journal and flock tests; no production IO."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone, timedelta

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('seal', ROOT / 'server/scripts/engine-release-seal.py')
seal = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(seal)


class DatabaseReservation(unittest.TestCase):
    def setUp(self):
        # Git hooks export GIT_DIR/INDEX/WORK_TREE. A native fixture must never
        # inherit them or address its caller's checkout/index.
        self.original_git_environment = os.environ.copy()
        self.addCleanup(DatabaseReservation.restore_environment, self)
        for key in list(os.environ):
            if key.startswith('GIT_'):
                del os.environ[key]
        os.environ.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT='0')
        self.temp = tempfile.TemporaryDirectory(prefix='database-reservation-')
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'; self.repo.mkdir()
        self.git('init', '-q', '--initial-branch=main')
        # These disposable repositories must have no writer after a Git command
        # returns: modern fetch detaches automatic maintenance, racing cleanup.
        # Disable only automatic fixture work (including older Git's auto-GC).
        self.git('config', 'maintenance.auto', 'false')
        self.git('config', 'gc.auto', '0')
        self.git('config', 'user.name', 'Native Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'core.hooksPath', str(self.root / 'no-hooks'))
        (self.repo / 'served.txt').write_text('served\n')
        self.git('add', '.'); self.git('commit', '-qm', 'serving boundary')
        self.serving = self.git('rev-parse', 'HEAD').strip()
        now = datetime.now(timezone.utc)
        iso = lambda d: d.isoformat().replace('+00:00', 'Z')
        self.window = {'id': 'native-db', 'ownerOrder': 'Explicit finite owner order for this native test',
            'contains': self.serving, 'notBefore': iso(now - timedelta(minutes=1)),
            'notAfter': iso(now + timedelta(minutes=30)), 'migrations': ['20990101000000_native.sql']}
        self.sql = '-- @install-window: daily-maintenance\nBEGIN;\nSELECT 1;\nCOMMIT;\n'
        (self.repo / 'supabase/migrations').mkdir(parents=True)
        (self.repo / 'supabase/migrations/20990101000000_native.sql').write_text(self.sql)
        self.publish_window()
        seal.STATE_DIR = self.root / 'state'; seal.STATE_FILE = seal.STATE_DIR / 'seal.json'
        seal.RESULT_DIR = seal.STATE_DIR / 'results'; seal.AUDIT_FILE = seal.STATE_DIR / 'audit.jsonl'
        seal.LOCK_FILE = self.root / 'seal.lock'; seal.ensure_dirs()
        self.state = {'schema': 1, 'generation': 1, 'desired': {'sha': self.serving,
            'imageId': 'sha256:' + '1' * 64}, 'highWaterSha': self.serving,
            'pending': None, 'finalization': None, 'committedRuns': {}}
        seal.write_state(self.state)
        self.before = seal.STATE_FILE.read_bytes()
        # Docker is a transport boundary; Git, locks, journal and admission run for real.
        seal.database_container_identity = lambda: {'running': True, **self.state['desired']}

    def restore_environment(self):
        os.environ.clear(); os.environ.update(self.original_git_environment)

    def tearDown(self):
        self.temp.cleanup()
        DatabaseReservation.restore_environment(self)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], stderr=subprocess.PIPE).decode()

    def publish_window(self):
        p = self.repo / 'server/release/owner-maintenance-windows.json'; p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({'version': 1, 'windows': [], 'databaseWindows': [self.window]}))
        self.git('add', '.'); self.git('commit', '--allow-empty', '-qm', 'reviewed database boundary')
        self.control = self.git('rev-parse', 'HEAD').strip()
        self.git('update-ref', 'refs/remotes/origin/main', self.control)

    def request(self, run='100-1'):
        return {'runId': run, 'controlSha': self.control, 'servingSha': self.serving, 'windowId': 'native-db'}

    def reserve(self, request=None):
        return seal.reserve_database_window(request or self.request(), str(self.repo))

    def test_real_protected_git_and_byte_exact_sql_journal(self):
        r = self.reserve()
        self.assertEqual(r['migrationSHA256'], hashlib.sha256(self.sql.encode()).hexdigest())
        self.assertEqual(r['endsAt'] - r['announcedAt'], 420000)
        self.assertEqual(r['type'], 'database-maintenance/v1')
        self.assertEqual(seal.STATE_FILE.read_bytes(), self.before)
        self.assertEqual(len(seal.AUDIT_FILE.read_text().splitlines()), 1)

    def test_exact_replay_keeps_original_fixed_stamp(self):
        first = self.reserve(); second = self.reserve()
        self.assertEqual(first, second)
        self.assertEqual(len(seal.AUDIT_FILE.read_text().splitlines()), 1)

    def test_rolling_hour_is_shared_with_engine_reservations(self):
        first = self.reserve()
        self.assertEqual(seal.recent_recovery_window('200-1', first['announcedAt']), '100-1')
        with self.assertRaises(SystemExit): self.reserve(self.request('200-1'))

    def test_engine_reservation_refuses_database_same_hour(self):
        import time
        seal.write_json_atomic(seal.STATE_DIR / 'engine-recovery-window-200-1.json', {'announcedAt': int(time.time()*1000)})
        with self.assertRaises(SystemExit): self.reserve()

    def test_ambiguous_reviewed_window_refused(self):
        p = self.repo / 'server/release/owner-maintenance-windows.json'
        p.write_text(json.dumps({'version': 1, 'databaseWindows': [self.window, self.window]}))
        self.git('add', '.'); self.git('commit', '-qm', 'ambiguous fixture')
        self.control = self.git('rev-parse', 'HEAD').strip(); self.git('update-ref', 'refs/remotes/origin/main', self.control)
        with self.assertRaises(SystemExit): self.reserve()

    def test_owner_order_missing_refused(self):
        self.window['ownerOrder'] = ''; self.publish_window()
        with self.assertRaises(SystemExit): self.reserve()

    def test_expiry_must_fit_whole_notice_and_break(self):
        self.window['notAfter'] = (datetime.now(timezone.utc)+timedelta(seconds=419)).isoformat()
        self.publish_window()
        with self.assertRaises(SystemExit): self.reserve()

    def test_unprotected_control_refused(self):
        self.git('update-ref', 'refs/remotes/origin/main', self.serving)
        with self.assertRaises(SystemExit): self.reserve()

    def test_wrong_serving_identity_refused(self):
        request = self.request(); request['servingSha'] = self.control
        with self.assertRaises(SystemExit): self.reserve(request)

    def test_replay_mutation_is_refused(self):
        self.reserve(); request = self.request(); request['windowId'] = 'other'
        with self.assertRaises(SystemExit): self.reserve(request)

    def test_unknown_or_multiple_files_refused(self):
        for files in [[], ['../../bad.sql'], ['20990101000000_native.sql'] * 2]:
            with self.subTest(files=files):
                self.window['migrations'] = files; self.publish_window()
                with self.assertRaises(SystemExit): self.reserve()

    def test_pending_engine_owner_refused(self):
        self.state['pending'] = {**self.state['desired'], 'mode':'deploy','expiresAt':9999999999,
            'used':False,'tokenHash':'a'*64,'runId':'200-1'}
        seal.write_state(self.state)
        with self.assertRaises(SystemExit): self.reserve()

    def test_wrong_immutable_image_is_refused(self):
        seal.database_container_identity = lambda: {'running': True, 'sha': self.serving, 'imageId': 'sha256:'+'2'*64}
        with self.assertRaises(SystemExit): self.reserve()

    def test_control_must_include_high_water_after_rollback(self):
        (self.repo/'later.txt').write_text('later')
        self.git('add','.'); self.git('commit','-qm','later protected high water')
        self.state['highWaterSha'] = self.git('rev-parse','HEAD').strip()
        self.git('update-ref','refs/remotes/origin/main',self.state['highWaterSha'])
        seal.write_state(self.state)
        with self.assertRaises(SystemExit): self.reserve()

    def test_ordinary_engine_list_does_not_admit_database(self):
        p=self.repo/'server/release/owner-maintenance-windows.json'
        p.write_text(json.dumps({'version':1,'windows':[self.window],'databaseWindows':[]}))
        self.git('add','.');self.git('commit','-qm','engine only fixture')
        self.control=self.git('rev-parse','HEAD').strip();self.git('update-ref','refs/remotes/origin/main',self.control)
        with self.assertRaises(SystemExit):self.reserve()


CONTROLLER_SPEC = importlib.util.spec_from_file_location('db_controller', ROOT/'scripts/ci/database-maintenance-window.py')
controller = importlib.util.module_from_spec(CONTROLLER_SPEC)
CONTROLLER_SPEC.loader.exec_module(controller)

class ControllerCertificates(unittest.TestCase):
    def setUp(self):
        self.request={'servingSha':'a'*40}
        self.reservation={'announcedAt':100000,'endsAt':520000}
        self.h={'running':True,'releaseSha':'a'*40,'instanceId':'1-12345678','maintenance':{
            'active':True,'phase':'counting_down','durableConfirmed':True,'readyForRestart':True,
            'unparkedTables':0,'reason':'Deployment Recovery','breakEndsAt':520000,'remainingMs':285000,
            'presentation':{'break_id':100000}}}

    def test_exact_drained_freeze_admits(self):
        self.assertTrue(controller.freeze_certificate(self.h,self.request,'1-12345678',self.reservation))

    def test_every_freeze_boundary_fails_closed(self):
        for key,value in [('active',False),('phase','last_hand'),('durableConfirmed',False),
                ('readyForRestart',False),('unparkedTables',1),('reason','Other'),('breakEndsAt',520001),('remainingMs',284999)]:
            with self.subTest(key=key):
                h=copy.deepcopy(self.h);h['maintenance'][key]=value
                self.assertFalse(controller.freeze_certificate(h,self.request,'1-12345678',self.reservation))
        self.h['maintenance']['presentation']['break_id']=1
        self.assertFalse(controller.freeze_certificate(self.h,self.request,'1-12345678',self.reservation))

    def thawed(self):
        h=copy.deepcopy(self.h);h['maintenance'].update(active=False,phase='idle',resumeWaves={
            'total':8,'done':8,'startedAt':520000,'finishedAt':531000})
        return h

    def test_own_v3_thaw_and_complete_resume_admits(self):
        self.assertTrue(controller.thaw_certificate(self.thawed(),self.request,'1-12345678',self.reservation,531000))

    def test_historical_thaw_or_incomplete_waves_refused(self):
        for key,value in [('startedAt',1),('finishedAt',1),('done',7),('total',0)]:
            h=self.thawed();h['maintenance']['resumeWaves'][key]=value
            self.assertFalse(controller.thaw_certificate(h,self.request,'1-12345678',self.reservation,531000))
        h=self.thawed();h['maintenance']['presentation']['break_id']=1
        self.assertFalse(controller.thaw_certificate(h,self.request,'1-12345678',self.reservation,531000))

    def test_replaced_engine_refused(self):
        self.h['instanceId']='2-12345678'
        with self.assertRaises(ValueError):controller.freeze_certificate(self.h,self.request,'1-12345678',self.reservation)

    def test_unknown_ack_is_observed_not_replayed(self):
        calls=[]
        def lost(args,timeout):
            calls.append(args);raise subprocess.TimeoutExpired(args,timeout)
        self.assertEqual(controller.request_fixed_window('code',100000,lost),'unknown')
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0][-1],'100000')

    def test_known_refusal_is_not_unknown_or_retried(self):
        calls=[]
        def refusal(args,timeout):calls.append(args);return '{"status":"busy"}'
        with self.assertRaises(ValueError):controller.request_fixed_window('code',100000,refusal)
        self.assertEqual(len(calls),1)


class ControllerLifecycle(unittest.TestCase):
    # Real Git, source binding, OS locks and durable seal/terminal files.
    # Docker, health, clock and the already-qualified SQL install are explicit
    # fixture boundaries; no production process or database is contacted.
    git = DatabaseReservation.git
    publish_window = DatabaseReservation.publish_window
    request = DatabaseReservation.request

    def setUp(self):
        DatabaseReservation.setUp(self)
        self.environment = os.environ.copy()
        os.environ.update(ENGINE_RELEASE_STATE_DIR=str(seal.STATE_DIR), ENGINE_RELEASE_STATE_FILE=str(seal.STATE_FILE),
            ENGINE_RELEASE_RESULT_DIR=str(seal.RESULT_DIR), ENGINE_RELEASE_AUDIT_FILE=str(seal.AUDIT_FILE),
            ENGINE_RELEASE_LOCK_FILE=str(seal.LOCK_FILE))
        self.source=(ROOT/'scripts/ci/database-maintenance-window.py').read_text()
        (self.repo/'scripts/ci').mkdir(parents=True)
        (self.repo/'scripts/ci/database-maintenance-window.py').write_text(self.source)
        (self.repo/'server/scripts').mkdir(parents=True)
        (self.repo/'server/scripts/engine-release-seal.py').write_text((ROOT/'server/scripts/engine-release-seal.py').read_text())
        self.git('add','.');self.git('commit','-qm','qualified host source')
        self.control=self.git('rev-parse','HEAD').strip();self.git('update-ref','refs/remotes/origin/main',self.control)
        self.git('remote','add','origin',str(self.repo))
        fakebin=self.root/'bin';fakebin.mkdir()
        docker=fakebin/'docker'
        docker.write_text('#!/usr/bin/env python3\nimport json\nprint(json.dumps('+repr({'running':True,**self.state['desired']})+'))\n')
        docker.chmod(0o700);os.environ['PATH']=str(fakebin)+os.pathsep+self.environment['PATH']
        self.saved={k:getattr(controller,k,None) for k in ['ROOT','REPO','ENGINE_LOCK','SOURCE_LOCK','REMOTE_SOURCE','health','command','emit','time','select','signal']}
        controller.ROOT=seal.STATE_DIR;controller.REPO=str(self.repo);controller.ENGINE_LOCK=str(self.root/'engine.lock')
        controller.SOURCE_LOCK=str(self.root/'source.lock')
        controller.REMOTE_SOURCE=self.source
        import io,time,types
        self.clock=types.SimpleNamespace(now=time.time())
        self.clock.time=lambda:self.clock.now
        self.clock.sleep=lambda n:setattr(self.clock,'now',self.clock.now+n)
        controller.time=self.clock
        controller.signal=types.SimpleNamespace(SIGHUP=1,SIGTERM=15,SIGINT=2,SIG_IGN=1,signal=lambda *a:None)
        controller.select=types.SimpleNamespace(select=lambda readers,*a:(readers,[],[]))
        self.saved_stdin=controller.sys.stdin
        controller.sys.stdin=io.StringIO(json.dumps(self.request())+'\n'+json.dumps({'runId':'100-1','installer':'passed'})+'\n')
        self.messages=[];controller.emit=self.messages.append
        self.sent=[];self.unknown=False;self.stale=False
        def transport(args,timeout=30):
            self.sent.append(args)
            if args[0]=='docker':
                if self.unknown:raise subprocess.TimeoutExpired(args,timeout)
                return '{"status":"accepted"}'
            return command_real(args,timeout)
        def command_real(args,timeout):
            return subprocess.check_output(args,timeout=timeout,stderr=subprocess.PIPE).decode()
        controller.command=transport
        self.reads=0
        def snapshot():
            self.reads+=1
            h={'running':True,'status':'ok','liveness':'ok','releaseSha':self.serving,'instanceId':'1-12345678',
               'maintenance':{'active':False,'phase':'idle'}}
            path=seal.STATE_DIR/'engine-recovery-window-100-1.json'
            if not path.exists():return h
            r=json.loads(path.read_text());end=r['endsAt'];stamp=r['announcedAt']
            if not any(m.get('phase')=='install' for m in self.messages):
                self.clock.now=max(self.clock.now,(stamp+120000)/1000)
                h['maintenance']={'active':True,'phase':'counting_down','durableConfirmed':True,'readyForRestart':True,
                    'unparkedTables':0,'reason':'Deployment Recovery','breakEndsAt':end,'remainingMs':300000,
                    'presentation':{'break_id':stamp}}
            else:
                self.clock.now=(end+(90001 if self.stale else 1000))/1000
                h['maintenance'].update(presentation={'break_id':1 if self.stale else stamp},
                    resumeWaves={'total':8,'done':8,'startedAt':end,'finishedAt':end+1000})
            return h
        controller.health=snapshot

    def tearDown(self):
        controller.sys.stdin=self.saved_stdin
        for k,v in self.saved.items():setattr(controller,k,v)
        os.environ.clear();os.environ.update(self.environment)
        DatabaseReservation.tearDown(self)

    def test_fixture_fetch_does_not_launch_automatic_maintenance(self):
        # Fetch is real in the controller. A detached Git child can outlive
        # check_output and recreate .git entries during TemporaryDirectory cleanup.
        environment = os.environ.copy()
        environment['GIT_TRACE'] = '1'
        result = subprocess.run(['git', '-C', str(self.repo), 'fetch', '--no-tags', 'origin', 'main'],
            env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        self.assertNotRegex(result.stderr.decode(), r'(?:maintenance run|gc --auto)')

    def test_complete_same_instance_and_terminal_receipt(self):
        controller.remote()
        self.assertEqual([m['phase'] for m in self.messages],['reserved','install','terminal'])
        receipt=self.messages[-1]['receipt']
        self.assertEqual(receipt['result'],'completed')
        self.assertEqual(receipt['controlSHA256'],hashlib.sha256(self.source.encode()).hexdigest())
        self.assertEqual(seal.STATE_FILE.read_bytes(),self.before)
        self.assertEqual(sum(a[0]=='docker' for a in self.sent),1)
        self.assertTrue((seal.STATE_DIR/'database-maintenance-result-100-1.json').exists())

    def test_lost_ack_reattaches_same_window_without_resending(self):
        self.unknown=True;controller.remote()
        self.assertEqual(self.messages[-1]['receipt']['result'],'completed')
        self.assertEqual(sum(a[0]=='docker' for a in self.sent),1)

    def test_stale_thaw_cannot_certify(self):
        self.stale=True
        with self.assertRaises(ValueError):controller.remote()
        self.assertEqual(self.messages[-1]['receipt']['result'],'unproven')

    def test_active_older_consumer_lock_refuses_before_reservation(self):
        import fcntl
        with open(controller.ENGINE_LOCK,'a+') as holder:
            fcntl.flock(holder,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):controller.remote()
        self.assertFalse((seal.STATE_DIR/'engine-recovery-window-100-1.json').exists())

    def test_awaiting_engine_owner_refuses_before_reservation(self):
        p=seal.STATE_DIR/'engine-release-requests';p.mkdir();(p/'200-1.awaiting-certificate').write_text('owned')
        with self.assertRaises(ValueError):controller.remote()
        self.assertFalse((seal.STATE_DIR/'engine-recovery-window-100-1.json').exists())


class RunnerPreflight(unittest.TestCase):
    def test_already_installed_never_contacts_host_or_requests_break(self):
        from unittest.mock import patch
        import types
        with tempfile.TemporaryDirectory(prefix='database-noop-') as directory:
            old=os.getcwd()
            try:
                os.chdir(directory)
                with patch.dict(os.environ, {'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':'refs/heads/main',
                        'OWNER_WINDOW_ID':'reviewed-db','GITHUB_SHA':'a'*40}), \
                        patch.object(controller.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout='NOTHING QUEUED')) as preflight, \
                        patch.object(controller.urllib.request,'urlopen',side_effect=AssertionError('network forbidden')):
                    controller.runner()
                self.assertIn('--preflight-only',preflight.call_args.args[0])
                receipt=json.loads(Path('artifacts/database-maintenance/receipt.json').read_text())
                self.assertEqual(receipt['result'],'already-installed')
                self.assertTrue(receipt['noMaintenanceRequested'])
            finally:os.chdir(old)

    def test_unreadable_history_refuses_before_host(self):
        from unittest.mock import patch
        import types
        with patch.dict(os.environ, {'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':'refs/heads/main','OWNER_WINDOW_ID':'reviewed-db'}), \
                patch.object(controller.subprocess,'run',return_value=types.SimpleNamespace(returncode=3,stdout='UNKNOWN')), \
                patch.object(controller.urllib.request,'urlopen',side_effect=AssertionError('network forbidden')):
            with self.assertRaises(ValueError):controller.runner()


class HookEnvironmentIsolation(unittest.TestCase):
    def test_valid_caller_repository_config_head_and_index_are_unchanged(self):
        from unittest.mock import patch
        safe = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        safe.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
        with tempfile.TemporaryDirectory(prefix='caller-git-sentinel-') as directory:
            caller = Path(directory)
            def git(*args):
                return subprocess.check_output(['git', '-C', directory, *args], env=safe, stderr=subprocess.PIPE)
            git('init', '-q', '--initial-branch=main')
            git('config', 'user.name', 'Caller Sentinel')
            git('config', 'user.email', 'sentinel@example.invalid')
            (caller/'sentinel').write_text('unchanged caller source\n')
            git('add', '.'); git('commit', '-qm', 'caller sentinel')
            paths = [caller/'.git'/name for name in ('HEAD', 'config', 'index', 'refs/heads/main')]
            before = {str(p): p.read_bytes() for p in paths}
            poison = {'GIT_DIR':str(caller/'.git'), 'GIT_WORK_TREE':directory,
                      'GIT_INDEX_FILE':str(caller/'.git/index'), 'GIT_CONFIG_COUNT':'1',
                      'GIT_CONFIG_KEY_0':'core.bare', 'GIT_CONFIG_VALUE_0':'true'}
            with patch.dict(os.environ, poison):
                fixture = DatabaseReservation('test_real_protected_git_and_byte_exact_sql_journal')
                try:
                    fixture.setUp()
                    fixture.test_real_protected_git_and_byte_exact_sql_journal()
                finally:
                    fixture.tearDown()
                    fixture.doCleanups()
                self.assertEqual(os.environ['GIT_DIR'], poison['GIT_DIR'])
            self.assertEqual({str(p): p.read_bytes() for p in paths}, before)


if __name__ == '__main__':
    unittest.main()
