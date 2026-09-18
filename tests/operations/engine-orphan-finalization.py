#!/usr/bin/env python3
"""Exercise actual seal/file/lock recovery; native witnesses are isolated doubles."""
import argparse
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('seal', os.environ.get('ENGINE_ORPHAN_TEST_SEAL_SOURCE', str(ROOT / 'server/scripts/engine-release-seal.py')))
seal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seal)
SHA = 'a' * 40
CONTROL = 'c' * 40
IMAGE = 'sha256:' + 'b' * 64
OLD = '111-2'
CURRENT = '222-1'
INVOCATION = 'd' * 32
INSTANCE = '1-1234abcd'
CID = 'e' * 64
START = '2026-09-18T01:56:28.078929094Z'


class OrphanFinalization(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='engine-orphan-finalization-')
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        for name, path in [('STATE_DIR', self.root), ('STATE_FILE', self.root / 'seal.json'),
                           ('RESULT_DIR', self.root / 'results'), ('AUDIT_FILE', self.root / 'audit.jsonl'),
                           ('LOCK_FILE', self.root / 'seal.lock')]:
            p = patch.object(seal, name, path)
            p.start(); self.addCleanup(p.stop)
        self.engine_lock = self.root / 'engine.lock'
        self.fd = os.open(self.engine_lock, os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, self.fd)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        p = patch.dict(os.environ, {'ENGINE_LOCK_FILE': str(self.engine_lock), 'INVOCATION_ID': INVOCATION})
        p.start(); self.addCleanup(p.stop)
        self.args = argparse.Namespace(run_id=CURRENT, sha=SHA, image_id=IMAGE,
            control_sha=CONTROL, instance_id=INSTANCE, container_id=CID, started_at=START,
            invocation_id=INVOCATION, result='already-released', recover_orphan_finalization_fd=self.fd)
        self.original = {'schema': 1, 'generation': 53, 'desired': {'sha': SHA, 'imageId': IMAGE, 'legacyUnlabelled': False},
            'highWaterSha': SHA, 'pending': None, 'committedRuns': {OLD: {'sha': SHA, 'imageId': IMAGE}},
            'finalization': {'runId': OLD, 'sha': SHA, 'imageId': IMAGE},
            'updatedBy': {'actor': 'manual-original-actor', 'runId': OLD}, 'updatedAt': 123}
        seal.write_state(copy.deepcopy(self.original))
        self.current_unit = {'LoadState': 'loaded', 'ActiveState': 'activating', 'SubState': 'start',
            'MainPID': '123', 'ControlPID': '0', 'Job': '', 'InvocationID': INVOCATION,
            'ControlGroup': '/system.slice/current', 'UnitFileState': 'enabled'}
        self.owner_unit = {'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead',
            'MainPID': '0', 'ControlPID': '0', 'Job': '', 'InvocationID': '',
            'ControlGroup': '', 'UnitFileState': 'disabled'}
        self.container = {'Id': CID, 'Image': IMAGE, 'State': {'Status': 'running', 'StartedAt': START},
                          'Config': {'Labels': {'sp.release.sha': SHA}}}
        self.image = {'Id': IMAGE, 'Config': {'Labels': {'org.opencontainers.image.revision': SHA},
                                            'Env': ['GIT_COMMIT_SHA=' + SHA]}}
        self.health = {'releaseSha': SHA, 'instanceId': INSTANCE, 'running': True, 'liveness': 'ok'}
        self.control = Path(seal.__file__).resolve().parent
        self.request = [SHA, 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/222',
                        'real-current-actor', str(self.control), CONTROL, str(int(time.time()) + 300)]
        self.proof_failure = False
        self.read_counts = 0
        original_read_text = Path.read_text
        def read_text(path, *args, **kwargs):
            if str(path) == '/proc/self/cgroup':
                return '0::/system.slice/current\n'
            return original_read_text(path, *args, **kwargs)
        mocks = [patch.object(seal, 'native_unit', create=True, side_effect=lambda unit: dict(self.current_unit if CURRENT in unit else self.owner_unit)),
                 patch.object(seal, 'durable_lines', create=True, side_effect=self.lines),
                 patch.object(seal, 'docker_json', side_effect=lambda kind, ref: copy.deepcopy(self.container if kind == 'container' else self.image)),
                 patch.object(seal, 'run', side_effect=self.native_run), patch.object(Path, 'read_text', read_text)]
        for p in mocks:
            p.start(); self.addCleanup(p.stop)

    def lines(self, path):
        if path.name == 'control-sha': return [CONTROL]
        if path.name.endswith('.generation'): return [str(self.control), CONTROL]
        return self.request[:]

    def native_run(self, command):
        if command[0] == 'curl':
            self.read_counts += 1
            return json.dumps(self.health)
        self.assertEqual(Path(command[0]).name, 'engine-release-database-proof.py')
        self.assertEqual(command[-2:], ['--max-heartbeat-age-seconds', '15'])
        if self.proof_failure: seal.die('database proof unreadable or stale')
        return '[engine-release-database-proof] proved exact elected leader with a fresh heartbeat'

    def refuse(self, phrase):
        before = seal.STATE_FILE.read_bytes()
        with self.assertRaises(SystemExit): seal.cmd_record_result(self.args)
        self.assertEqual(seal.STATE_FILE.read_bytes(), before, phrase)
        self.assertFalse(seal.result_path(CURRENT).exists(), phrase)

    def test_recovers_current_receipt_preserves_original_author_and_replays(self):
        seal.cmd_record_result(self.args)
        state = seal.load_state()
        self.assertIsNone(state['finalization'])
        self.assertEqual(state['committedRuns'], self.original['committedRuns'])
        self.assertEqual(state['updatedBy'], self.original['updatedBy'])
        self.assertEqual(state['generation'], 53)
        self.assertFalse(seal.result_path(OLD).exists())
        self.assertEqual(seal.load_result(CURRENT)['result'], 'already-released')
        self.assertEqual(state['orphanFinalizationResolutions'][OLD]['verifiedByRunId'], CURRENT)
        self.assertEqual(self.read_counts, 4)
        seal.cmd_record_result(self.args)
        self.assertEqual(seal.load_state(), state)
        events = [json.loads(x)['event'] for x in seal.AUDIT_FILE.read_text().splitlines()]
        self.assertEqual(events.count('orphan_finalization_retired'), 1)

    def test_original_commit_and_result_cannot_recreate_ownership_or_completion(self):
        seal.cmd_record_result(self.args)
        state = seal.STATE_FILE.read_bytes()
        old = copy.copy(self.args); old.run_id = OLD; old.result = 'sealed'
        with self.assertRaises(SystemExit): seal.cmd_record_result(old)
        with patch.object(seal, 'metadata', return_value={'runId': OLD}), \
             patch.object(seal, 'image_identity', return_value=(IMAGE, SHA, True)), \
             patch.object(seal, 'container_identity', return_value=('running', IMAGE)):
            old.image = IMAGE; old.container = 'club-arena-engine'
            with self.assertRaises(SystemExit): seal.cmd_commit(old)
            with self.assertRaises(SystemExit): seal.cmd_prepare(old)
        self.assertEqual(seal.STATE_FILE.read_bytes(), state)
        self.assertFalse(seal.result_path(OLD).exists())
        seal.cmd_attest_commit(old)  # Authorship remains true, completion does not.

    def test_original_active_queued_or_unknown_native_owner_refuses(self):
        for key, value in [('ActiveState', 'active'), ('MainPID', '123'), ('ControlPID', '3'),
                           ('Job', '52'), ('UnitFileState', 'enabled'), ('LoadState', 'error')]:
            with self.subTest(key=key):
                original = self.owner_unit[key]; self.owner_unit[key] = value
                self.refuse(key); self.owner_unit[key] = original
        with patch.object(seal, 'native_unit', create=True, side_effect=SystemExit(1)):
            self.refuse('unreadable native state')

    def test_retained_original_evidence_refuses(self):
        for folder, suffix in [('engine-release-requests', 'request'), ('engine-release-requests', 'intent'),
                               ('engine-release-generation-pins', 'generation'), ('engine-intake-requests', 'request'),
                               ('engine-image-leases', 'lease'), ('engine-release-requests', 'break-deadline')]:
            with self.subTest(suffix=suffix):
                path = self.root / folder / f'{OLD}.{suffix}'
                path.parent.mkdir(exist_ok=True); path.write_text('retained')
                self.refuse(suffix); path.unlink()

    def test_missing_opt_in_and_unheld_or_wrong_lock_refuse(self):
        self.args.recover_orphan_finalization_fd = None
        self.refuse('ordinary foreign finalization remains refused')
        self.args.recover_orphan_finalization_fd = self.fd
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        self.refuse('unheld real descriptor')
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        wrong = os.open(self.root / 'wrong.lock', os.O_RDWR | os.O_CREAT, 0o600)
        try:
            self.args.recover_orphan_finalization_fd = wrong
            self.refuse('wrong descriptor')
        finally: os.close(wrong)

    def test_runtime_database_request_and_invocation_must_match(self):
        for target, key, value in [(self.health, 'releaseSha', 'f' * 40), (self.health, 'instanceId', '1-87654321'),
                                    (self.health, 'liveness', 'failed'), (self.container['State'], 'StartedAt', 'changed'),
                                    (self.container, 'Image', 'sha256:' + 'f' * 64),
                                    (self.current_unit, 'InvocationID', 'f' * 32),
                                    (self.current_unit, 'ControlGroup', '/system.slice/foreign')]:
            with self.subTest(key=key):
                previous = target[key]; target[key] = value
                self.refuse(key); target[key] = previous
        self.proof_failure = True; self.refuse('database stale'); self.proof_failure = False
        self.request[0] = 'f' * 40; self.refuse('wrong current request')

    def test_pending_and_wrong_desired_are_not_retired(self):
        self.original['desired']['imageId'] = 'sha256:' + 'f' * 64
        seal.write_state(self.original)
        self.refuse('wrong desired image')
        self.original['desired']['imageId'] = IMAGE
        self.original['pending'] = {'sha': SHA, 'imageId': IMAGE, 'runId': '333-1', 'mode': 'deploy',
                                    'expiresAt': int(time.time()) + 60, 'used': False, 'tokenHash': 'f' * 64}
        seal.write_state(self.original); self.refuse('pending candidate')

    def test_interruption_after_result_or_audit_durability_resumes_exact_evidence(self):
        with patch.object(seal, 'write_state', side_effect=OSError('simulated final seal fsync interruption')):
            with self.assertRaises(OSError): seal.cmd_record_result(self.args)
        self.assertEqual(seal.load_state()['finalization']['runId'], OLD)
        self.assertEqual(seal.load_result(CURRENT)['result'], 'already-released')
        first = (seal.RESULT_DIR / f'{CURRENT}.{INVOCATION}.orphan-finalization.json').read_bytes()
        seal.cmd_record_result(self.args)
        self.assertEqual((seal.RESULT_DIR / f'{CURRENT}.{INVOCATION}.orphan-finalization.json').read_bytes(), first)
        self.assertIsNone(seal.load_state()['finalization'])
        self.assertFalse(seal.result_path(OLD).exists())

    def test_interrupted_completion_reproves_a_new_real_native_invocation(self):
        with patch.object(seal, 'write_state', side_effect=OSError('lost seal replacement')):
            with self.assertRaises(OSError): seal.cmd_record_result(self.args)
        next_invocation = 'f' * 32
        self.args.invocation_id = next_invocation
        self.current_unit['InvocationID'] = next_invocation
        with patch.dict(os.environ, {'INVOCATION_ID': next_invocation}):
            seal.cmd_record_result(self.args)
        self.assertEqual(seal.load_result(CURRENT)['invocationIds'], [INVOCATION, next_invocation])
        self.assertEqual(seal.load_state()['orphanFinalizationResolutions'][OLD]['invocationId'], next_invocation)
        self.assertFalse(seal.result_path(OLD).exists())
        # The disposition is historical: it must not bind future desired state
        # to the old release after normal forward publication changes it.
        state = seal.load_state()
        state['generation'] += 1
        state['desired'] = {'sha': 'f' * 40, 'imageId': 'sha256:' + 'f' * 64}
        state['highWaterSha'] = 'f' * 40
        seal.write_state(state)
        self.assertEqual(seal.load_state()['generation'], 54)

    def test_conflicting_resolution_and_current_result_refuse(self):
        resolution = seal.RESULT_DIR / f'{CURRENT}.{INVOCATION}.orphan-finalization.json'
        resolution.write_text('{}')
        self.refuse('conflicting resolution')
        resolution.unlink()
        seal.result_path(CURRENT).write_text('{}')
        before = seal.STATE_FILE.read_bytes()
        with self.assertRaises(SystemExit): seal.cmd_record_result(self.args)
        self.assertEqual(seal.STATE_FILE.read_bytes(), before)

    def test_seal_changes_during_proof_refuse_compare_and_swap(self):
        native_run = self.native_run
        def race(command):
            if command[0] != 'curl':
                changed = seal.load_state(); changed['generation'] += 1; seal.write_state(changed)
            return native_run(command)
        with patch.object(seal, 'run', side_effect=race):
            with self.assertRaises(SystemExit): seal.cmd_record_result(self.args)
        self.assertEqual(seal.load_state()['generation'], 54)
        self.assertEqual(seal.load_state()['finalization']['runId'], OLD)
        self.assertFalse(seal.result_path(CURRENT).exists())


if __name__ == '__main__': unittest.main()
