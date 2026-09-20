"""Focused stdlib regression for the path/hash boundary; no database operations.

The existing BBJ runner explicitly loads all six cases before cluster allocation.
They confer no funded-case or runtime qualification; final execution is pending.
"""
import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('bbj_funded_custody', Path(__file__).with_name('custody.py'))
custody = importlib.util.module_from_spec(spec)
spec.loader.exec_module(custody)


class CustodyBoundaryTests(unittest.TestCase):
    def test_original_inputs_are_preserved_and_do_not_authorize_execution(self):
        sources = custody.FundedSourceCustody()
        self.assertEqual(len(sources.ordered_sql()), 9)
        self.assertEqual(sources.receipt()['funded_cases_executed'], [])
        self.assertIs(sources.receipt()['financial_execution_authorized'], False)
        self.assertIs(sources.receipt()['runtime_verified'], False)

    def test_historical_admission_is_never_an_executable_input(self):
        sources = custody.FundedSourceCustody()
        for source in ('backup_adapter/SOURCE-PINS.json', 'promo/OPERATION.json',
                       'supplement/SOURCE-AUTHORITY.json'):
            with self.assertRaisesRegex(ValueError, 'Historical admission/path metadata'):
                sources.read_bytes(source)

    def test_unknown_original_reference_has_no_external_fallback(self):
        sources = custody.FundedSourceCustody()
        with self.assertRaisesRegex(ValueError, 'No external-path fallback'):
            sources.resolve_original_reference('/tmp/unowned-financial-source.py')

    def test_modified_source_is_rejected_at_use_not_only_initial_inventory(self):
        sources = custody.FundedSourceCustody()
        target = sources.source_path('resources/seed.sql')
        original = Path.read_bytes
        def read(path):
            return b'changed after inventory' if path == target else original(path)
        with patch.object(Path, 'read_bytes', read):
            with self.assertRaisesRegex(ValueError, 'Retained source hash changed'):
                sources.read_bytes('resources/seed.sql')

    def test_noncanonical_and_symlink_paths_are_rejected(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for relative in ('../escape', '/absolute', 'a/../escape', './member', 'a//member'):
                with self.assertRaises(ValueError):
                    custody._contained(root, relative)
            (root / 'link').symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'Symlink'):
                custody._contained(root, 'link/member')

    def test_duplicate_manifest_json_fields_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON field'):
            custody._json(b'{"scope": "old", "scope": "changed"}')
