import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('engine_boundary', ROOT / 'operations/release/native/engine-boundary.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)

class NativeEngineTests(unittest.TestCase):
    def setUp(self):
        (ROOT / 'work').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='native-engine-', dir=ROOT / 'work')
        root = Path(self.temp.name)
        self.staging, self.state = root / 'staging', root / 'state'
        self.run = '34611012800-1'
        scripts = self.staging / self.run / 'server/scripts'
        scripts.mkdir(parents=True)
        names = ['engine-release-seal.py', 'install-engine-intake.sh', 'observe-engine-release.sh']
        for name in names: (scripts / name).write_text('native fixture ' + name)
        self.config = {'trusted_control_sha': 'c' * 40, 'control_files': {name: hashlib.sha256((scripts / name).read_bytes()).hexdigest() for name in names}}
        self.request = {'target': 'club-arena-engine', 'source_sha': 'a' * 40, 'control_sha': 'c' * 40, 'manifest_digest': 'f' * 64,
            'run_key': self.run, 'actor': 'fixture $(literal; no shell)', 'not_after_epoch': int(time.time()) + 3600,
            'server_tree_sha': 'e' * 40, 'artifact_image_id': 'sha256:' + 'd' * 64,
            'expected_current': {'source_sha': 'b' * 40, 'image_id': 'sha256:' + 'b' * 64}}
        leases = root / 'leases'
        leases.mkdir()
        (leases / (self.run + '.lease')).write_text(self.request['source_sha'] + '\n')
        self.envelope = {'operation_id': str(uuid4()), 'epoch': str(uuid4()), 'request': self.request}
        self.calls = []
        self.observed = False
        self.failure = False
        self.image = self.request['artifact_image_id']
        self.units_valid = True
        self.patches = [patch.object(engine, 'STAGING', self.staging), patch.object(engine, 'STATE', self.state), patch.object(engine, 'LEASE_ROOT', leases),
                        patch.object(engine, 'secure', lambda path, file=True: Path(path)),
                        patch.object(engine, 'command', self.command), patch.object(engine, 'retired', lambda run: True)]
        for p in self.patches: p.start()

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.temp.cleanup()

    def command(self, argv, timeout=35):
        args = [str(a) for a in argv]
        self.calls.append(args)
        result = lambda text='', code=0: SimpleNamespace(returncode=code, stdout=text)
        if args[0] == '/usr/bin/systemd-analyze': return result(code=0 if self.units_valid else 1)
        if args[0] == '/usr/bin/systemctl': return result('loaded')
        if args[0] == '/usr/bin/docker':
            return result(json.dumps({'Id': self.image, 'Config': {'Labels': {
                'org.opencontainers.image.revision': self.request['source_sha'],
                'com.smarterpoker.engine.source-tree': self.request['server_tree_sha'],
                'com.smarterpoker.engine.build-contract': 'clean-server-archive-v1'}}}))
        if args[1] == 'get':
            if args[2] == 'desired-sha': return result(self.request['source_sha'] if self.observed and not self.failure else self.request['expected_current']['source_sha'])
            return result(self.request['artifact_image_id'] if self.observed and not self.failure else self.request['expected_current']['image_id'])
        if args[0].endswith('install-engine-intake.sh'):
            self.assertTrue((self.state / (self.run + '.json')).exists())
            self.assertEqual(args[1:], ['--target-sha', self.request['source_sha'], '--control-sha', self.request['control_sha'],
                '--run-id', self.run, '--actor', self.request['actor'], '--not-after-epoch', str(self.request['not_after_epoch'])])
            return result(code=76)  # lost/uncertain durable handoff
        if args[1] == 'attest-failure':
            if not self.failure: return result(code=1)
            return result(' '.join(['failed', self.request['source_sha'], self.request['control_sha'], 'f' * 32, '1',
                self.request['expected_current']['source_sha'], self.request['expected_current']['image_id']]))
        if args[1] == 'attest-result':
            return result(' '.join(['sealed', self.request['source_sha'], self.request['artifact_image_id'], 'd' * 64, 'started', '123-abcd1234', self.request['control_sha']]))
        if args[0].endswith('observe-engine-release.sh'):
            self.observed = True
            return result('ENGINE_RELEASE_UNIT_RESULT=success\nENGINE_RELEASE_SHA=' + self.request['source_sha'] + '\nENGINE_RELEASE_RESULT=sealed\n')
        raise AssertionError(args)

    def test_exact_frozen_argument_contract_and_host_intent_precede_intake_once(self):
        self.assertTrue(engine.dispatch('preflight', self.envelope, self.config)['ready'])
        self.assertTrue(engine.dispatch('submit', self.envelope, self.config)['requires_readback'])
        engine.dispatch('submit', self.envelope, self.config)
        self.assertEqual(sum(call[0].endswith('install-engine-intake.sh') for call in self.calls), 1)
        result = engine.dispatch('observe', self.envelope, self.config)
        self.assertEqual(result['outcome'], 'SUCCEEDED')
        self.assertEqual(result['image_id'], self.request['artifact_image_id'])

    def test_absent_host_intent_is_unknown_and_expired_readback_remains_supported(self):
        self.assertFalse(engine.dispatch('observe', self.envelope, self.config)['terminal'])
        self.request['not_after_epoch'] = 1
        with self.assertRaises(ValueError): engine.dispatch('submit', self.envelope, self.config)
        self.state.mkdir()
        engine.persist(self.state / (self.run + '.json'), self.envelope)
        self.assertEqual(engine.dispatch('observe', self.envelope, self.config)['outcome'], 'SUCCEEDED')

    def test_wrong_image_unknown_helpers_and_other_operation_cannot_reuse_run(self):
        self.units_valid = False
        with self.assertRaises(ValueError): engine.dispatch('preflight', self.envelope, self.config)
        self.assertFalse(any(call[0].endswith('install-engine-intake.sh') for call in self.calls))
        self.units_valid = True
        self.image = 'sha256:' + '0' * 64
        with self.assertRaises(ValueError): engine.dispatch('preflight', self.envelope, self.config)
        self.image = self.request['artifact_image_id']
        engine.dispatch('submit', self.envelope, self.config)
        self.envelope['operation_id'] = str(uuid4())
        with self.assertRaises(ValueError): engine.dispatch('observe', self.envelope, self.config)
        (self.staging / self.run / 'server/scripts/unknown-helper.py').write_text('extra')
        with self.assertRaises(ValueError): engine.dispatch('preflight', self.envelope, self.config)

    def test_failure_requires_exact_terminal_attestation_and_retired_native_units(self):
        engine.dispatch('submit', self.envelope, self.config)
        self.failure = True
        with patch.object(engine, 'retired', lambda run: False):
            self.assertFalse(engine.dispatch('observe', self.envelope, self.config)['terminal'])
        self.assertEqual(engine.dispatch('observe', self.envelope, self.config)['outcome'], 'FAILED')

if __name__ == '__main__': unittest.main()
