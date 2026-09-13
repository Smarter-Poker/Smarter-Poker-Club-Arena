"""Release authority rejects ephemeral storage for journal-capable images."""
import copy
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


if __name__ == '__main__':
    unittest.main()
