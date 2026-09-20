"""Release authority rejects ephemeral storage for journal-capable images."""
import argparse
import contextlib
import copy
import io
import tempfile
import time
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('engine_seal', ROOT / 'server/scripts/engine-release-seal.py')
seal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seal)
DESTINATION = '/var/lib/club-arena/engine-alerts'
IMAGE = {'Config': {'Labels': {'sp.alert-journal.schema': '1'}}}


class JournalMountProof(unittest.TestCase):
    def setUp(self):
        self.runtime = {
            'Config': {'Env': [f'ENGINE_ALERT_JOURNAL_DIR={DESTINATION}']},
            'Mounts': [{'Type': 'bind', 'Source': str(Path(DESTINATION).resolve()), 'Destination': DESTINATION, 'RW': True}],
        }
        self.environment = patch.dict(os.environ, {'ENGINE_ALERT_JOURNAL_HOST_DIR': DESTINATION})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_expected_persistent_mount_passes(self):
        seal.require_alert_journal_mount(self.runtime, IMAGE)

    def test_old_sealed_image_stays_recoverable(self):
        seal.require_alert_journal_mount({}, {'Config': {'Labels': {}}})

    def test_missing_readonly_wrong_source_and_tmpfs_fail(self):
        mutations = [
            lambda c: c.update(Mounts=[]),
            lambda c: c['Mounts'][0].update(RW=False),
            lambda c: c['Mounts'][0].update(Source='/tmp/ephemeral'),
            lambda c: c['Mounts'][0].update(Type='tmpfs'),
            lambda c: c['Config'].update(Env=[]),
            lambda c: c['Config'].update(Env=['ENGINE_ALERT_JOURNAL_DIR=/tmp']),
            lambda c: c['Mounts'].append(copy.deepcopy(c['Mounts'][0])),
        ]
        for mutation in mutations:
            runtime = copy.deepcopy(self.runtime)
            mutation(runtime)
            with self.subTest(runtime=runtime), self.assertRaises(SystemExit):
                seal.require_alert_journal_mount(runtime, IMAGE)

    def test_container_label_cannot_disable_immutable_image_requirement(self):
        self.runtime['Mounts'] = []
        self.runtime['Config']['Labels'] = {'sp.alert-journal.schema': '0'}
        with self.assertRaises(SystemExit):
            seal.require_alert_journal_mount(self.runtime, IMAGE)


class HorsePositiveQualification(unittest.TestCase):
    """Actual seal transactions with isolated Docker and Git witnesses."""
    SHA = 'a' * 40
    OLD_SHA = 'b' * 40
    IMAGE_ID = 'sha256:' + 'a' * 64
    OLD_IMAGE = 'sha256:' + 'b' * 64
    CID = 'c' * 64
    START = '2026-09-18T06:00:00.000000000Z'
    HORSE = '/var/lib/club-arena/horse-decisions'

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='horse-positive-seal-')
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        for name, path in [('STATE_DIR', root), ('STATE_FILE', root / 'seal.json'),
                           ('RESULT_DIR', root / 'results'), ('AUDIT_FILE', root / 'audit.jsonl'),
                           ('LOCK_FILE', root / 'seal.lock')]:
            mocked = patch.object(seal, name, path)
            mocked.start(); self.addCleanup(mocked.stop)
        env = patch.dict(os.environ, {'ENGINE_HORSE_JOURNAL_HOST_DIR': self.HORSE,
                                     'CONTAINER': 'club-arena-engine'})
        env.start(); self.addCleanup(env.stop)
        self.runtime = {'Id': self.CID, 'Image': self.IMAGE_ID,
                        'State': {'Status': 'running', 'StartedAt': self.START},
                        'Config': {'Labels': {'sp.release.sha': self.SHA},
                                   'Env': ['HORSE_DECISION_JOURNAL_DIR=' + self.HORSE]},
                        'Mounts': [{'Type': 'bind', 'Source': str(Path(self.HORSE).resolve()),
                                    'Destination': self.HORSE, 'RW': True}]}
        self.image = {'Id': self.IMAGE_ID,
                      'Config': {'Labels': {'org.opencontainers.image.revision': self.SHA},
                                 'Env': ['GIT_COMMIT_SHA=' + self.SHA]}}
        self.docker_calls = []
        def docker(kind, reference):
            self.docker_calls.append((kind, reference))
            self.assertIn(kind, ('container', 'image'))
            return copy.deepcopy(self.runtime if kind == 'container' else self.image)
        mocked = patch.object(seal, 'docker_json', side_effect=docker)
        mocked.start(); self.addCleanup(mocked.stop)
        self.args = argparse.Namespace(repo=str(root), sha=self.SHA, image=self.IMAGE_ID, image_id=self.IMAGE_ID,
            container='club-arena-engine', container_id=self.CID, started_at=self.START,
            run_id='123-1', run_url='https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/123', actor='fixture',
            reason='isolated positive qualification', control_sha='d' * 40,
            instance_id='1-deadbeef', invocation_id='e' * 32, result='sealed',
            recover_orphan_finalization_fd=None)
        self.original = {'schema': 1, 'generation': 1,
            'desired': {'sha': self.OLD_SHA, 'imageId': self.OLD_IMAGE, 'legacyUnlabelled': False},
            'highWaterSha': self.OLD_SHA, 'committedRuns': {}, 'finalization': None,
            'pending': {'sha': self.SHA, 'imageId': self.IMAGE_ID, 'mode': 'deploy',
                        'used': True, 'tokenHash': 'f' * 64, 'expiresAt': int(time.time()) + 300, 'runId': '123-1'}}
        seal.write_state(copy.deepcopy(self.original))

    def mutations(self):
        return [
            ('missing mount', lambda c: c.update(Mounts=[])),
            ('read-only mount', lambda c: c['Mounts'][0].update(RW=False)),
            ('wrong host source', lambda c: c['Mounts'][0].update(Source='/tmp/ephemeral')),
            ('tmpfs', lambda c: c['Mounts'][0].update(Type='tmpfs')),
            ('duplicate mount', lambda c: c['Mounts'].append(copy.deepcopy(c['Mounts'][0]))),
            ('missing environment', lambda c: c['Config'].update(Env=[])),
            ('wrong environment', lambda c: c['Config'].update(Env=['HORSE_DECISION_JOURNAL_DIR=/tmp'])),
            ('duplicate environment', lambda c: c['Config']['Env'].append(c['Config']['Env'][0])),
            ('wrong container', lambda c: c.update(Id='f' * 64)),
            ('wrong image', lambda c: c.update(Image=self.OLD_IMAGE)),
            ('changed start', lambda c: c['State'].update(StartedAt=self.START.replace('06:', '07:'))),
            ('wrong release label', lambda c: c['Config']['Labels'].update({'sp.release.sha': self.OLD_SHA})),
            ('stopped process', lambda c: c['State'].update(Status='exited')),
        ]

    def assert_refused_without_writes(self, action):
        before = seal.STATE_FILE.read_bytes()
        audit = seal.AUDIT_FILE.read_bytes() if seal.AUDIT_FILE.exists() else None
        result = seal.result_path(self.args.run_id)
        receipt = result.read_bytes() if result.exists() else None
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            action(self.args)
        self.assertEqual(seal.STATE_FILE.read_bytes(), before)
        self.assertEqual(seal.AUDIT_FILE.read_bytes() if seal.AUDIT_FILE.exists() else None, audit)
        self.assertEqual(result.read_bytes() if result.exists() else None, receipt)

    def test_candidate_refuses_bad_storage_and_generation_before_seal_write(self):
        valid = copy.deepcopy(self.runtime)
        for label, mutate in self.mutations():
            with self.subTest(label=label):
                seal.write_state(copy.deepcopy(self.original))
                seal.AUDIT_FILE.unlink(missing_ok=True)
                self.runtime = copy.deepcopy(valid)
                mutate(self.runtime)
                self.assert_refused_without_writes(seal.cmd_commit)

    def test_both_terminal_outcomes_refuse_before_receipt_or_finalization_write(self):
        valid = copy.deepcopy(self.runtime)
        for outcome in ('sealed', 'already-released'):
            state = copy.deepcopy(self.original)
            state.update(desired={'sha': self.SHA, 'imageId': self.IMAGE_ID}, pending=None)
            if outcome == 'sealed':
                state['committedRuns'] = {'123-1': {'sha': self.SHA, 'imageId': self.IMAGE_ID}}
                state['finalization'] = {'runId': '123-1', 'sha': self.SHA, 'imageId': self.IMAGE_ID}
            seal.write_state(state)
            self.args.result = outcome
            for label, mutate in self.mutations():
                with self.subTest(outcome=outcome, label=label):
                    seal.write_state(copy.deepcopy(state))
                    seal.AUDIT_FILE.unlink(missing_ok=True)
                    seal.result_path(self.args.run_id).unlink(missing_ok=True)
                    self.runtime = copy.deepcopy(valid)
                    mutate(self.runtime)
                    self.assert_refused_without_writes(seal.cmd_record_result)

    def test_candidate_commit_and_current_result_replay_keep_original_authorship(self):
        seal.cmd_commit(self.args)
        seal.cmd_record_result(self.args)
        original = seal.load_result(self.args.run_id)['completionRuntime']
        self.runtime['Id'] = self.args.container_id = 'f' * 64
        self.runtime['State']['StartedAt'] = self.args.started_at = self.START.replace('06:', '07:')
        self.args.invocation_id = 'f' * 32
        seal.cmd_record_result(self.args)
        result = seal.load_result(self.args.run_id)
        self.assertEqual(result['completionRuntime'], original)
        self.assertEqual(result['containerId'], 'f' * 64)
        self.runtime['Mounts'] = []
        self.assert_refused_without_writes(seal.cmd_record_result)
        self.assert_refused_without_writes(seal.cmd_commit)
        # Historical attestation remains true; it is not new runtime qualification.
        seal.cmd_attest_result(self.args)

    def test_mountless_legacy_predecessor_is_still_classified_and_authorized_for_recovery(self):
        self.runtime['Mounts'] = []
        self.runtime['Config'] = {'Env': []}
        self.image['Config']['Labels'] = {}
        seal.STATE_FILE.unlink()
        with patch.object(seal, 'git_has_commit'), patch.object(seal, 'git_is_ancestor'):
            seal.cmd_bootstrap_running(self.args)
        self.args.with_sha = False
        with contextlib.redirect_stdout(io.StringIO()) as output:
            seal.cmd_classify(self.args)
        self.assertEqual(output.getvalue().strip(), 'desired')
        self.args.token_stdin = False
        with contextlib.redirect_stdout(io.StringIO()) as output:
            seal.cmd_authorize(self.args)
        self.assertEqual(output.getvalue().strip(), f'desired {self.SHA} {self.IMAGE_ID}')
        self.args.result = 'already-released'
        self.assert_refused_without_writes(seal.cmd_record_result)

    def test_canonical_rollback_with_durable_mount_preserves_high_water(self):
        state = copy.deepcopy(self.original)
        state['pending']['mode'] = 'rollback'
        seal.write_state(state)
        seal.cmd_commit(self.args)
        self.assertEqual(seal.load_state()['highWaterSha'], self.OLD_SHA)
        seal.cmd_record_result(self.args)
        self.assertEqual(seal.load_result(self.args.run_id)['result'], 'sealed')


if __name__ == '__main__':
    unittest.main()
