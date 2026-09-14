#!/usr/bin/env python3
"""Portable cleanup boundary regressions; no Docker or systemd is executed."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SUBJECT = Path(os.environ.get('ENGINE_RESOURCE_PROOF_TEST_SUBJECT',
               Path(__file__).with_name('engine-build-resource-proof.py')))
spec = importlib.util.spec_from_file_location('resource_proof_cleanup_subject', SUBJECT)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class FinalReceiptBoundaryTests(unittest.TestCase):
    sentinel = 'owned-sentinel'
    reader = 'owned-reader'
    tag = 'club-arena-engine:' + 'a' * 40
    before = {'State': {'Running': True, 'StartedAt': 'start-identity'}, 'RestartCount': 0}

    def finalize(self, *, neighbor='alive', retained=None, missing_inventory=None,
                 malformed_inventory=None, timeout_remove=None, extra_image=None):
        """Execute the real main finally block, including persistence and refusal."""
        commands = []
        containers = {self.sentinel, self.reader, proof.CONTAINER}
        volume = proof.CONTAINER + '_state'
        volumes = {volume}
        images = {self.tag, self.tag + '-candidate-1234'}
        if extra_image:
            images.add(extra_image)
        receipt = {'status': 'passed'}
        current = json.loads(json.dumps(self.before))
        if neighbor == 'stopped':
            current['State']['Running'] = False
        if neighbor == 'restarted':
            current['RestartCount'] += 1
        if neighbor == 'new-instance':
            current['State']['StartedAt'] = 'different-identity'
        def inspect(name):
            if neighbor == 'unavailable':
                raise RuntimeError('simulated observation failure')
            return current
        def run(args, **kwargs):
            commands.append(args)
            rc, output = 0, ''
            if args[:3] == ['docker', 'rm', '--force']:
                name = args[-1]
                if name == timeout_remove:
                    raise subprocess.TimeoutExpired(args, 30)
                if name != retained:
                    containers.discard(name)
                else:
                    rc = 1
            elif args[:3] == ['docker', 'volume', 'rm']:
                volumes.discard(args[-1])
            elif args[:3] == ['docker', 'image', 'rm']:
                images.discard(args[-1])
            elif args[:2] == ['docker', 'inspect']:
                # A failed observation is not proof that a retained object left.
                rc = 1
                output = 'simulated daemon observation unavailable'
            elif args[:3] == ['docker', 'volume', 'inspect']:
                rc = 1
            elif args[:3] == ['docker', 'container', 'ls']:
                if missing_inventory == 'container':
                    rc = 1
                elif malformed_inventory == 'container':
                    output = '{"unexpected":"object"}\n'
                else:
                    output = ''.join(json.dumps(n) + '\n' for n in sorted(containers))
            elif args[:3] == ['docker', 'volume', 'ls']:
                if missing_inventory == 'volume':
                    rc = 1
                else:
                    output = ''.join(json.dumps(n) + '\n' for n in sorted(volumes))
            elif args[:3] == ['docker', 'image', 'ls']:
                if missing_inventory == 'image':
                    rc = 1
                elif malformed_inventory == 'image':
                    output = 'untrusted command error output\n'
                else:
                    output = ''.join(n + '\n' for n in sorted(images))
            return subprocess.CompletedProcess(args, rc, output)
        tree = ast.parse(SUBJECT.read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        finalizer = next(n for n in main.body if isinstance(n, ast.Try)).finalbody
        script = compile(ast.fix_missing_locations(ast.Module(body=finalizer, type_ignores=[])),
                         str(SUBJECT), 'exec')
        with tempfile.TemporaryDirectory() as tmp, patch.object(proof, 'run', side_effect=run), \
                patch.object(proof, 'inspect', side_effect=inspect):
            scope = {**proof.__dict__, 'receipt': receipt, 'before': self.before,
                     'sentinel': self.sentinel, 'image_reader': self.reader,
                     'owned_tags': [self.tag], 'out': Path(tmp)}
            error = None
            try:
                exec(script, scope)
            except RuntimeError as caught:
                error = caught
            persisted = json.loads((Path(tmp) / 'receipt.json').read_text())
        return receipt, persisted, commands, error, images

    def test_success_requires_all_removals_and_same_live_neighbor(self):
        receipt, persisted, commands, error, images = self.finalize()
        self.assertIsNone(error)
        self.assertEqual(receipt['status'], 'passed')
        self.assertEqual(persisted, receipt)
        self.assertTrue(receipt['neighbor_alive_before_cleanup'])
        self.assertTrue(all(receipt['cleanup'].values()))
        self.assertFalse(images)

    def test_final_neighbor_loss_or_unknown_state_cannot_pass(self):
        for state in ('stopped', 'restarted', 'new-instance', 'unavailable'):
            with self.subTest(state=state):
                receipt, persisted, _, error, _ = self.finalize(neighbor=state)
                self.assertIsInstance(error, RuntimeError)
                self.assertEqual(receipt['status'], 'failed')
                self.assertEqual(persisted, receipt)
                self.assertFalse(receipt['neighbor_alive_before_cleanup'])

    def test_failed_inspect_does_not_prove_retained_container_absent(self):
        receipt, persisted, _, error, _ = self.finalize(retained=self.reader)
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(receipt['status'], 'failed')
        self.assertFalse(receipt['cleanup'][self.reader])
        self.assertEqual(persisted, receipt)

    def test_cleanup_inventory_unavailable_cannot_pass(self):
        for kind in ('container', 'volume', 'image'):
            with self.subTest(kind=kind):
                receipt, persisted, _, error, _ = self.finalize(missing_inventory=kind)
                self.assertIsInstance(error, RuntimeError)
                self.assertEqual(receipt['status'], 'failed')
                self.assertTrue(receipt['cleanup_errors'])
                self.assertEqual(persisted, receipt)

    def test_malformed_cleanup_inventory_cannot_pass_or_become_a_delete_target(self):
        for kind in ('container', 'image'):
            with self.subTest(kind=kind):
                receipt, persisted, commands, error, _ = self.finalize(malformed_inventory=kind)
                self.assertIsInstance(error, RuntimeError)
                self.assertEqual(receipt['status'], 'failed')
                self.assertFalse(any('untrusted command error output' in a for a in commands))
                self.assertEqual(persisted, receipt)

    def test_removal_timeout_preserves_receipt_and_continues_other_cleanup(self):
        receipt, persisted, commands, error, images = self.finalize(timeout_remove=self.sentinel)
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(receipt['status'], 'failed')
        self.assertTrue(any(a[:3] == ['docker', 'volume', 'rm'] for a in commands))
        self.assertTrue(any(a[:3] == ['docker', 'image', 'rm'] for a in commands))
        self.assertFalse(images)
        self.assertEqual(persisted, receipt)
        self.assertIn({'stage': 'remove_container:' + self.sentinel, 'error_type': 'TimeoutExpired'},
                      receipt['cleanup_errors'])

    def test_valid_digest_only_and_untagged_images_are_preserved(self):
        for image in ('<none>:<none>', 'moby/buildkit:<none>', 'node:<none>'):
            with self.subTest(image=image):
                receipt, _, commands, error, images = self.finalize(extra_image=image)
                self.assertIsNone(error)
                self.assertEqual(receipt['status'], 'passed')
                self.assertEqual(images, {image})
                self.assertFalse(any(a[:3] == ['docker', 'image', 'rm'] and a[-1] == image
                                     for a in commands))

    def test_tag_prefix_neighbor_is_preserved(self):
        unrelated = self.tag + '-another-release'
        receipt, _, commands, error, images = self.finalize(extra_image=unrelated)
        self.assertIsNone(error)
        self.assertEqual(receipt['status'], 'passed')
        self.assertEqual(images, {unrelated})
        self.assertFalse(any(a[:3] == ['docker', 'image', 'rm'] and a[-1] == unrelated
                             for a in commands))


if __name__ == '__main__':
    unittest.main()
