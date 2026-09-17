import hashlib
import tempfile
from pathlib import Path
import unittest
from retain_evidence import manifest, REQUIRED, REPOSITORY


class RetainedEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.head = 'a' * 40
        self.env = {'GITHUB_REPOSITORY': REPOSITORY, 'GITHUB_JOB': 'accounting_postgres',
                    'GITHUB_SHA': self.head, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '2',
                    'GITHUB_EVENT_NAME': 'schedule', 'BBJ_STEP_OUTCOME': 'failure'}
        self.output = self.root/'artifacts/bbj-bank-replay'
        self.output.mkdir(parents=True)

    def test_failed_attempt_retains_available_bytes_and_names_missing_receipts(self):
        (self.output/'failure.log').write_bytes(b'original failure')
        row = manifest(self.root, self.env, {}, self.head)
        self.assertEqual(row['missing_required_receipts'], list(REQUIRED))
        self.assertEqual(row['files'], [{'path': 'failure.log', 'bytes': 16,
                          'sha256': hashlib.sha256(b'original failure').hexdigest()}])
        self.assertFalse(row['financial_acceptance'])

    def test_complete_receipts_bind_pr_source_separately_from_checkout(self):
        for name in REQUIRED:
            p = self.output/name
            p.parent.mkdir(exist_ok=True)
            p.write_bytes(b'{}')
        self.env.update(GITHUB_EVENT_NAME='pull_request', BBJ_STEP_OUTCOME='success')
        event = {'pull_request': {'head': {'sha': 'b'*40, 'repo': {'full_name': REPOSITORY}},
                                  'base': {'repo': {'full_name': REPOSITORY}}}}
        row = manifest(self.root, self.env, event, self.head)
        self.assertEqual(row['checkout_commit'], self.head)
        self.assertEqual(row['source_commit'], 'b'*40)
        self.assertEqual(row['missing_required_receipts'], [])
        self.assertFalse(row['financial_acceptance'])

    def test_skipped_or_wrong_revision_is_not_an_attempt(self):
        for changed in ({'BBJ_STEP_OUTCOME': 'skipped'}, {'GITHUB_SHA': 'c'*40},
                        {'GITHUB_JOB': 'another_job'}, {'GITHUB_RUN_ATTEMPT': '0'}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                manifest(self.root, {**self.env, **changed}, {}, self.head)

    def test_timing_failure_retains_diagnostics_without_claiming_financial_invocation(self):
        self.env.update(BBJ_STEP_OUTCOME='skipped', BBJ_TIMING_OUTCOME='failure')
        row = manifest(self.root, self.env, {}, self.head)
        self.assertEqual(row['attempted_phase'], 'timing_admission')
        self.assertEqual(row['bbj_step_outcome'], 'skipped')
        self.assertEqual(row['missing_required_receipts'], list(REQUIRED))
        self.assertFalse(row['financial_acceptance'])

    def test_symlink_or_database_directory_cannot_be_uploaded(self):
        link = self.output/'other.log'
        link.symlink_to(self.root/'outside')
        with self.assertRaises(ValueError):
            manifest(self.root, self.env, {}, self.head)
        link.unlink()
        (self.output/'PG_VERSION').write_text('17')
        with self.assertRaises(ValueError):
            manifest(self.root, self.env, {}, self.head)


if __name__ == '__main__':
    unittest.main()
