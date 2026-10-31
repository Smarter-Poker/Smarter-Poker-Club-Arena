#!/usr/bin/env python3
"""Controller boundary qualification only. Never executes the native scale case."""
import copy
import importlib.util
import io
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('scale', ROOT / 'server/scripts/legacy-census-scale-preflight.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def valid_result():
    return {'schema':'legacy-native-scale-fixture/v1', 'ok':True,
            'qualification':'synthetic-cardinality-and-memory-only', 'fixtureSHA256':'f'*64,
            'count':35000000, 'prototypeRestored':True, 'matched':11, 'node':'v22.23.2',
            'v8':'12.4.254.21-node.56', 'platform':'linux', 'arch':'x64',
            'sourceSHA256':'cbd7279fc6595a31bd2044769d2ad85684d63713351acd0bb602dbfcdbdce31e',
            'binarySHA256':'b'*64, 'before':{'used':3913011648, 'available':322107592,
            'process':50471874560}, 'queryMs':19000, 'fixtureMs':34000,
            'cgroupPeak':5*1024**3, 'maxRSSKiB':4000000,
            'attempt':{'predicateVisits':35010000, 'arrayAllocated':True, 'deadlineRefused':False},
            'cgroup':{'memoryMax':str(m.CAP), 'swapMax':'0', 'cpuMax':'100000 100000', 'pidsMax':'32'}}


class Response(io.BytesIO):
    status = 200


class ScaleBoundary(unittest.TestCase):
    def test_actual_measurement_validation_never_treats_smaller_case_as_scale(self):
        value = valid_result()
        m.validate_result(value, 'f'*64)
        alterations = [('count',34999999), ('queryMs',20001), ('fixtureMs',35001),
                       ('prototypeRestored',False), ('node','v26.0.0'), ('matched',10)]
        for key, replacement in alterations:
            bad = copy.deepcopy(value)
            bad[key] = replacement
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m.validate_result(bad, 'f'*64)
        for key, replacement in [('used',3913011647), ('available',322107593), ('process',31337647615)]:
            bad = copy.deepcopy(value)
            bad['before'][key] = replacement
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m.validate_result(bad, 'f'*64)
        bad = copy.deepcopy(value)
        bad['cgroup']['swapMax'] = 'max'
        with self.assertRaises(RuntimeError):
            m.validate_result(bad, 'f'*64)

    def serving_commands(self, classification=None, pending='none'):
        revision = next(iter(m.LEGACY))
        container = ' '.join(json.dumps(v) for v in ['a'*64,'sha256:'+'b'*64,'running','2026-10-31T00:00:00Z',revision])
        return revision, [subprocess.CompletedProcess([],0,container,''),
                          subprocess.CompletedProcess([],0,classification or 'desired '+revision,''),
                          subprocess.CompletedProcess([],0,pending,'')]

    def test_actual_serving_identity_requires_seal_and_health_agreement(self):
        revision, commands = self.serving_commands()
        body = json.dumps({'running':True,'releaseSha':revision,'instanceId':'1-12345678'}).encode()
        with patch.object(m,'command',side_effect=commands), patch.object(m.urllib.request,'urlopen',return_value=Response(body)):
            self.assertEqual(m.serving('42-1')['revision'], revision)
        for classification in ['drift', 'pending '+revision, 'desired '+'c'*40]:
            _, commands = self.serving_commands(classification)
            with patch.object(m,'command',side_effect=commands), self.assertRaisesRegex(RuntimeError,'seal disagree'):
                m.serving('42-1')
        _, commands = self.serving_commands()
        wrong_body = json.dumps({'running':True,'releaseSha':'c'*40,'instanceId':'1-12345678'}).encode()
        with patch.object(m,'command',side_effect=commands), patch.object(m.urllib.request,'urlopen',return_value=Response(wrong_body)), self.assertRaisesRegex(RuntimeError,'health.*disagree'):
            m.serving('42-1')

    def test_unknown_and_competing_pending_owner_refuse(self):
        for pending in ['active 43-1 false 9999999999','expired 42-1 false 1',
                        'active 42-1 true 9999999999', 'none garbage']:
            _, commands = self.serving_commands(pending=pending)
            with patch.object(m,'command',side_effect=commands), self.assertRaisesRegex(RuntimeError,'pending'):
                m.serving('42-1')

    def test_degraded_503_keeps_identity_contract(self):
        revision, commands = self.serving_commands()
        body = json.dumps({'running':True,'releaseSha':revision,'instanceId':'1-12345678'}).encode()
        error = m.urllib.error.HTTPError('http://127.0.0.1:8080/health',503,'degraded',{},io.BytesIO(body))
        with patch.object(m,'command',side_effect=commands), patch.object(m.urllib.request,'urlopen',side_effect=error):
            self.assertEqual(m.serving('42-1')['revision'],revision)

    def test_cleanup_requires_exact_owned_label_and_authoritative_absence(self):
        wrong = subprocess.CompletedProcess([],0,json.dumps('a'*64)+' '+json.dumps('wrong'),'')
        with patch.object(m,'command',return_value=wrong) as cmd, self.assertRaisesRegex(RuntimeError,'ownership'):
            m.cleanup('own','k'*64,time.monotonic()+5)
        self.assertEqual(cmd.call_count,1)
        unknown = subprocess.CompletedProcess([],1,'','daemon unavailable')
        with patch.object(m,'command',return_value=unknown), self.assertRaisesRegex(RuntimeError,'unknown'):
            m.cleanup('own','k'*64,time.monotonic()+5)
        # An unrecognised inspect failure whose daemon listing still shows the
        # name, or whose listing itself fails, stays unknown.
        listed = subprocess.CompletedProcess([],0,'b'*64+'\n','')
        with patch.object(m,'command',side_effect=[unknown,listed]), self.assertRaisesRegex(RuntimeError,'unknown'):
            m.cleanup('own','k'*64,time.monotonic()+5)
        own0 = subprocess.CompletedProcess([],0,json.dumps('a'*64)+' '+json.dumps('k'*64),'')
        # Lowercase not-found wording (newer Docker CLIs) is absence.
        lower = subprocess.CompletedProcess([],1,'[]','error: no such object: own')
        with patch.object(m,'command',side_effect=[own0,subprocess.CompletedProcess([],0,'',''),lower]):
            self.assertTrue(m.cleanup('own','k'*64,time.monotonic()+5))
        # Any other wording is absence only when the daemon lists nothing by
        # this exact name; the listing is anchored to the full name.
        other = subprocess.CompletedProcess([],1,'','Error response from daemon: object not present')
        empty = subprocess.CompletedProcess([],0,'','')
        with patch.object(m,'command',side_effect=[own0,subprocess.CompletedProcess([],0,'',''),other,empty]) as cmd:
            self.assertTrue(m.cleanup('own','k'*64,time.monotonic()+5))
        self.assertEqual(cmd.call_args_list[3].args[0][:2],['docker','ps'])
        self.assertIn('name=^/?own$',cmd.call_args_list[3].args[0])
        own = subprocess.CompletedProcess([],0,json.dumps('a'*64)+' '+json.dumps('k'*64),'')
        absent = subprocess.CompletedProcess([],1,'','Error: No such object: own')
        with patch.object(m,'command',side_effect=[own,subprocess.CompletedProcess([],0,'',''),absent]) as cmd:
            m.cleanup('own','k'*64,time.monotonic()+5)
        self.assertEqual(cmd.call_args_list[1].args[0],['docker','rm','-f','own'])

    def test_unresolved_one_shot_intent_cleans_without_running_again(self):
        with tempfile.TemporaryDirectory(prefix='native-scale-controller-') as directory:
            state = Path(directory)
            identity = {'revision':next(iter(m.LEGACY))}
            with patch.object(m,'STATE',state), patch.object(m.os,'geteuid',return_value=0), patch.object(m.sys,'platform','linux'), patch.object(m,'serving',return_value=identity), patch.object(m,'candidate_identity',return_value={}), patch.object(m,'secure_directory'), patch.object(m.os,'fstat',return_value=type('S',(),{'st_mode':0o100600,'st_uid':0})()), patch.object(m.Path,'exists',return_value=True), patch.object(m,'read_state',return_value={'status':'refused'}) as read, patch.object(m,'command') as command:
                with self.assertRaisesRegex(RuntimeError,'binding refused'):
                    m.main('sha256:'+'a'*64,'42-1',str(int(time.time())+600))
                command.assert_not_called()
                self.assertEqual(read.call_count,1)
            # Existing intent only: cleanup uses only its exact image-bound name,
            # then refuses permanently without invoking a second fixture.
            def exists(path):
                return str(path).endswith('.intent')
            def read_intent(path):
                key = path.name[:-7]
                fixture_sha = m.digest((m.ROOT/'legacy-census-scale-fixture.mjs').read_bytes())
                binding = {'schema':'legacy-native-scale-binding/v1','image':'sha256:'+'a'*64,
                           'fixtureSHA256':fixture_sha,'controllerSHA256':m.digest(Path(m.__file__).read_bytes()),'profile':m.PROFILE}
                return {'binding':binding,'container':'ca-native-scale-'+key[:32]}
            with patch.object(m,'STATE',state), patch.object(m.os,'geteuid',return_value=0), patch.object(m.sys,'platform','linux'), patch.object(m,'serving',return_value=identity), patch.object(m,'candidate_identity',return_value={}), patch.object(m,'secure_directory'), patch.object(m.os,'fstat',return_value=type('S',(),{'st_mode':0o100600,'st_uid':0})()), patch.object(m.Path,'exists',exists), patch.object(m,'read_state',side_effect=read_intent), patch.object(m,'cleanup',return_value=True) as cleanup, patch.object(m,'command') as command:
                with self.assertRaisesRegex(RuntimeError,'no automatic repeat'):
                    m.main('sha256:'+'a'*64,'42-1',str(int(time.time())+600))
                cleanup.assert_called_once()
                command.assert_not_called()

    def test_positive_receipt_reuses_without_container_and_insufficient_host_refuses(self):
        with tempfile.TemporaryDirectory(prefix='native-scale-controller-') as directory:
            state = Path(directory)
            identity = {'revision':next(iter(m.LEGACY))}
            fixture_sha = m.digest((m.ROOT/'legacy-census-scale-fixture.mjs').read_bytes())
            binding = {'schema':'legacy-native-scale-binding/v1','image':'sha256:'+'a'*64,
                       'fixtureSHA256':fixture_sha,'controllerSHA256':m.digest(Path(m.__file__).read_bytes()),'profile':m.PROFILE}
            result = valid_result()
            result['fixtureSHA256'] = fixture_sha
            receipt = {'binding':binding,'candidate':{},'status':'qualified','cleanupProved':True,
                       'elapsedMs':39000,'result':result}
            with patch.object(m,'STATE',state), patch.object(m.os,'geteuid',return_value=0), patch.object(m.sys,'platform','linux'), patch.object(m,'serving',return_value=identity), patch.object(m,'candidate_identity',return_value={}), patch.object(m,'secure_directory'), patch.object(m.os,'fstat',return_value=type('S',(),{'st_mode':0o100600,'st_uid':0})()), patch.object(m.Path,'exists',return_value=True), patch.object(m,'read_state',return_value=receipt), patch.object(m,'command') as command, patch('sys.stdout',new_callable=io.StringIO) as stdout:
                m.main('sha256:'+'a'*64,'42-1',str(int(time.time())+600))
                command.assert_not_called()
                self.assertIn('reused-qualified',stdout.getvalue())
            original = Path.read_text
            def read(path, *args, **kwargs):
                return 'MemAvailable:       1000000 kB\n' if str(path) == '/proc/meminfo' else original(path,*args,**kwargs)
            with patch.object(m,'STATE',state), patch.object(m.os,'geteuid',return_value=0), patch.object(m.sys,'platform','linux'), patch.object(m,'serving',return_value=identity), patch.object(m,'candidate_identity',return_value={}), patch.object(m,'secure_directory'), patch.object(m.os,'fstat',return_value=type('S',(),{'st_mode':0o100600,'st_uid':0})()), patch.object(m.Path,'exists',return_value=False), patch.object(m.Path,'read_text',read), patch.object(m,'write_state') as write, patch.object(m,'command') as command:
                with self.assertRaisesRegex(RuntimeError,'real host headroom'):
                    m.main('sha256:'+'a'*64,'42-1',str(int(time.time())+600))
                command.assert_not_called()
                write.assert_not_called()

    def test_real_term_int_hup_enter_main_finally_and_leave_nonretryable_receipt(self):
        for signum, observed in [(signal.SIGTERM,True), (signal.SIGINT,True), (signal.SIGHUP,True), (signal.SIGTERM,False)]:
            with self.subTest(signal=signum, observed=observed), tempfile.TemporaryDirectory(prefix='native-scale-signal-') as directory:
                state = Path(directory)
                identity = {'revision':next(iter(m.LEGACY))}
                original = Path.read_text
                def read(path, *args, **kwargs):
                    return 'MemAvailable:       60000000 kB\n' if str(path) == '/proc/meminfo' else original(path,*args,**kwargs)
                def interrupt(*args, **kwargs):
                    os.kill(os.getpid(), signum)
                    self.fail('signal did not refuse')
                previous = signal.signal(signum, m.refuse_signal)
                try:
                    with patch.object(m,'STATE',state), patch.object(m.os,'geteuid',return_value=0), patch.object(m.sys,'platform','linux'), patch.object(m,'serving',return_value=identity), patch.object(m,'candidate_identity',return_value={}), patch.object(m,'secure_directory'), patch.object(m.os,'fstat',return_value=type('S',(),{'st_mode':0o100600,'st_uid':0})()), patch.object(m.Path,'read_text',read), patch.object(m.subprocess,'run',side_effect=interrupt), patch.object(m,'cleanup',return_value=observed) as cleanup:
                        with self.assertRaisesRegex(RuntimeError,'interrupted by signal'):
                            m.main('sha256:'+'a'*64,'42-1',str(int(time.time())+600))
                        cleanup.assert_called_once()
                    receipt = json.loads(next(state.glob('*.json')).read_text())
                    self.assertEqual(receipt['status'],'refused')
                    self.assertIs(receipt['cleanupProved'],observed)
                    self.assertIs(receipt['executionAcknowledged'],False)
                    if not observed:
                        self.assertIn('creation acknowledgement unknown',receipt['error'])
                    self.assertIn('interrupted by signal',receipt['error'])
                    self.assertEqual(len(list(state.glob('*.intent'))),1)
                finally:
                    signal.signal(signum,previous)

    def test_new_state_namespace_is_durable_before_intent(self):
        with tempfile.TemporaryDirectory(prefix='native-scale-directory-') as directory:
            state = Path(directory)/'state'
            with patch.object(m.Path,'lstat',return_value=type('S',(),{'st_mode':0o040700,'st_uid':0})()), patch.object(m.os,'open',wraps=os.open) as opened, patch.object(m.os,'fsync',wraps=os.fsync) as synced:
                m.secure_directory(state)
                self.assertEqual([call.args[0] for call in opened.call_args_list], [state,state.parent])
                self.assertEqual(synced.call_count,2)
            self.assertTrue(state.is_dir())

    def test_connected_source_enforces_existing_route_and_containment(self):
        helper = (ROOT/'server/scripts/prewarm-engine-image.sh').read_text()
        installer = (ROOT/'server/scripts/install-engine-supervisor.sh').read_text()
        workflow = (ROOT/'.github/workflows/auto-deploy-hetzner.yml').read_text()
        source = Path(m.__file__).read_text()
        for name in ['legacy-census-scale-preflight.py','legacy-census-scale-fixture.mjs']:
            self.assertIn(name,installer)
            self.assertIn(name,workflow)
        self.assertIn('legacy-census-scale-preflight.py',helper)
        self.assertLess(workflow.index('for asset in legacy-census-scale'),workflow.index('name: Dispatch the staged SHA'))
        for flag in ["'--network', 'none'","'--read-only'","'--no-healthcheck'","'--memory-swap'",
                     "'--log-driver', 'none'","'-i', '/usr/local/bin/node'",'fcntl.LOCK_NB','exclusive=True']:
            self.assertIn(flag,source)
        self.assertNotIn('--env-file',source)
        self.assertIn('COPY scripts/legacy-census-scale-fixture.mjs ./native/legacy-census/scale-fixture.mjs', (ROOT/'server/Dockerfile').read_text())


if __name__ == '__main__':
    unittest.main()
