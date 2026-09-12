import importlib.util
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('installer', ROOT / 'operations/release/native/install-controller.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

class Crash(BaseException):
    pass

class Manager:
    def __init__(self, target, failure=False, crash=False):
        self.calls = []
        self.target = target
        self.failure = failure
        self.crash = crash

    def stop(self): self.calls.append('stop')
    def install(self, source): self.calls.append('install:' + source.name)
    def start(self): self.calls.append('start')
    def ready(self, digest, prior, instance):
        self.calls.append('ready:' + digest)
        if self.crash:
            self.crash = False
            raise Crash()
        if self.failure and digest == self.target:
            raise ValueError('candidate startup failure')
        return {'epoch': str(uuid4()), 'bundle_digest': digest, 'instance_id': instance,
                'reconciliation_required': True}

class NativeInstallTests(unittest.TestCase):
    def setUp(self):
        (ROOT / 'work').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='native-upgrade-', dir=ROOT / 'work')
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.state.mkdir()
        (self.root / 'versions').mkdir()
        self.prior = self.bundle('prior')
        self.target = self.bundle('target')
        os.symlink('versions/' + self.prior, self.root / 'current')
        self.intent = {'operation_id': str(uuid4()), 'release_id': str(uuid4()), 'instance_id': str(uuid4()),
                       'native_upgrade': {'prior_bundle_digest': self.prior, 'bundle_digest': self.target,
                       'service': installer.SERVICE, 'schema_version': 1, 'provider_schema_version': 1, 'prior_epoch': str(uuid4())}}

    def tearDown(self): self.temp.cleanup()

    def bundle(self, tag):
        contents = {f'code-{i}.txt': f'{tag}-{i}'.encode() for i in range(5)}
        manifest = {'format': 1, 'schema_version': 1, 'provider_schema_version': 1,
                    'operation_policy_digest': '1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda',
                    'files': {k: hashlib.sha256(v).hexdigest() for k, v in contents.items()}}
        raw = json.dumps(manifest).encode()
        digest = hashlib.sha256(raw).hexdigest()
        directory = self.root / 'versions' / digest
        directory.mkdir()
        for name, value in contents.items(): (directory / name).write_bytes(value)
        (directory / 'bundle-manifest.json').write_bytes(raw)
        return digest

    def verify(self, directory, digest):
        return installer.verify_bundle(directory, digest, lambda p: p.read_bytes())

    def run_install(self, manager, interrupt=None, journal=lambda: None):
        return installer.install(self.intent, root=self.root, state=self.state, manager=manager,
                                 verifier=self.verify, check_journal=journal, interrupt=interrupt)

    def test_journal_intent_is_checked_before_stop_and_no_activation_is_claimed(self):
        manager = Manager(self.target)
        def check():
            self.assertEqual(manager.calls, [])
            self.assertTrue((self.state / (self.intent['operation_id'] + '.checkpoint.json')).exists())
        result = self.run_install(manager, journal=check)
        self.assertEqual(result['state'], 'STARTED_RECONCILIATION_REQUIRED')
        self.assertEqual(os.readlink(self.root / 'current'), 'versions/' + self.target)
        calls = manager.calls.copy()
        self.run_install(manager)
        self.assertEqual(calls, manager.calls)

    def test_interrupted_before_install_after_install_and_before_completion_resume_same_intent(self):
        for stage in ['STOPPED', 'INSTALLED', 'READY_BEFORE_RECEIPT']:
            with self.subTest(stage=stage):
                checkpoint = self.state / (self.intent['operation_id'] + '.checkpoint.json')
                checkpoint.unlink(missing_ok=True)
                (self.root / 'current').unlink()
                os.symlink('versions/' + self.prior, self.root / 'current')
                manager = Manager(self.target, crash=stage == 'READY_BEFORE_RECEIPT')
                def interrupt(name):
                    if name == stage: raise Crash()
                with self.assertRaises(Crash): self.run_install(manager, interrupt=interrupt)
                result = self.run_install(manager)
                self.assertEqual(result['operation_id'], self.intent['operation_id'])
                self.assertEqual(result['state'], 'STARTED_RECONCILIATION_REQUIRED')

    def test_failed_successor_restores_prior_and_interrupted_restore_never_retries_candidate(self):
        manager = Manager(self.target, failure=True)
        def interrupt(name):
            if name == 'RESTORING': raise Crash()
        with self.assertRaises(Crash): self.run_install(manager, interrupt=interrupt)
        manager.calls.clear()
        result = self.run_install(manager)
        self.assertNotIn('install:' + self.target, manager.calls)
        self.assertEqual(result['state'], 'ROLLED_BACK_RECONCILIATION_REQUIRED')
        self.assertEqual(os.readlink(self.root / 'current'), 'versions/' + self.prior)

    def test_wrong_hash_extra_file_or_missing_journal_proof_cannot_stop_service(self):
        manager = Manager(self.target)
        extra = self.root / 'versions' / self.target / 'unreviewed.py'
        extra.write_text('unreviewed')
        with self.assertRaises(ValueError): self.run_install(manager)
        self.assertEqual(manager.calls, [])
        extra.unlink()
        def refused(): raise ValueError('journal unknown')
        with self.assertRaises(ValueError): self.run_install(manager, journal=refused)
        self.assertEqual(manager.calls, [])

    def test_initial_install_requires_idle_observe_proof_and_records_reconciliation_pending(self):
        (self.root / 'current').unlink()
        manager = Manager(self.target)
        result = installer.bootstrap(self.target, root=self.root, state=self.state, manager=manager, verifier=self.verify,
            check_journal=lambda: {'bootstrap_observe_only': True, 'epoch': str(uuid4()), 'instance_id': self.intent['instance_id']})
        self.assertEqual(result['mode'], 'OBSERVE')
        self.assertEqual(result['state'], 'STARTED_RECONCILIATION_REQUIRED')

if __name__ == '__main__': unittest.main()
