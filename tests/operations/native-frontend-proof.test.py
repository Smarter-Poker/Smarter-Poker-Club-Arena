import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('native_frontend', REPO / 'scripts/ci/read-native-frontend.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeArtifactProof(unittest.TestCase):
    def setUp(self):
        # Resolve macOS's private temp path; on Linux use a secured workspace
        # if /tmp is shared. The real native ancestor checks remain in force.
        (REPO / 'work').mkdir(exist_ok=True)
        for candidate in [Path(tempfile.gettempdir()).resolve(), REPO / 'work']:
            if not candidate.exists():
                continue
            if all(p.lstat().st_uid in (0, os.geteuid()) and p.lstat().st_mode & 0o022 == 0
                   for p in [candidate, *candidate.parents] if str(p) != '/'):
                break
        else:
            raise RuntimeError('native fixture needs a secured existing parent')
        self.base = Path(tempfile.mkdtemp(dir=candidate))
        self.root = self.base / 'root'
        self.source = 'a' * 40
        self.release = self.root / 'releases' / self.source
        self.release.mkdir(parents=True)
        self.lock = self.root / '.publish.lock'
        self.lock.write_text('existing publisher lock\n')
        self.lock.chmod(0o664)
        (self.root / 'current').symlink_to(self.release)
        (self.release / 'index.html').write_text('real immutable bytes\n')
        self.build = {'ca_sha': self.source, 'built_by': 'publish-club-arena.yml', 'built_at': '2026-09-11T18:13:00Z', 'run_id': '34631421377'}
        self.provenance = {'commit': self.source, 'builtBy': 'github-actions', 'dirty': False, 'historyComplete': True, 'aheadMain': 0, 'behindMain': 0,
                           'ciRun': 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34631421377'}
        (self.release / 'build-info.json').write_text(json.dumps(self.build))
        (self.release / 'ca-provenance.json').write_text(json.dumps(self.provenance))
        self.seal()

    def tearDown(self):
        shutil.rmtree(self.base)

    def seal(self):
        lines = [hashlib.sha256(p.read_bytes()).hexdigest() + '  ./' + p.name + '\n'
                 for p in sorted(self.release.iterdir()) if p.name != '.release-manifest.sha256']
        (self.release / '.release-manifest.sha256').write_text(''.join(lines))

    def read(self):
        return native.read_artifact(self.source, str(self.root), 0.1)

    def test_real_0664_lock_and_exact_manifest_are_read_only(self):
        before = {str(p): (p.lstat().st_ino, p.lstat().st_mtime_ns, hashlib.sha256(p.read_bytes()).hexdigest()) for p in self.root.rglob('*') if p.is_file() and not p.is_symlink()}
        result = self.read()
        self.assertEqual(result['file_count'], 3)
        self.assertEqual(result['source_sha'], self.source)
        self.assertEqual(result['lock']['inode'], self.lock.stat().st_ino)
        after = {str(p): (p.lstat().st_ino, p.lstat().st_mtime_ns, hashlib.sha256(p.read_bytes()).hexdigest()) for p in self.root.rglob('*') if p.is_file() and not p.is_symlink()}
        self.assertEqual(before, after)

    def test_publisher_exclusive_lock_prevents_proof(self):
        with self.lock.open('r') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, 'lock timeout'):
                self.read()
        self.read()

    def test_lock_inode_replacement_after_flock_is_refused(self):
        original = native.fcntl.flock
        def replace(fd, flags):
            original(fd, flags)
            self.lock.rename(self.root / 'old-lock')
            self.lock.write_text('replacement')
            self.lock.chmod(0o664)
        with patch.object(native.fcntl, 'flock', side_effect=replace):
            with self.assertRaisesRegex(RuntimeError, 'lock changed'):
                self.read()

    def test_actual_file_mutation_during_read_is_refused(self):
        target = self.release / 'index.html'
        inode = target.stat().st_ino
        original = native.os.read
        changed = False
        def mutate(fd, length):
            nonlocal changed
            data = original(fd, length)
            if os.fstat(fd).st_ino == inode and not changed:
                changed = True
                target.write_text('actual concurrent corruption')
            return data
        with patch.object(native.os, 'read', side_effect=mutate):
            with self.assertRaisesRegex(RuntimeError, 'artifact file changed'):
                self.read()
        self.assertTrue(changed)

    def test_missing_lock_is_not_created(self):
        self.lock.unlink()
        with self.assertRaises(FileNotFoundError):
            self.read()
        self.assertFalse(self.lock.exists())

    def test_world_writable_lock_refused(self):
        self.lock.chmod(0o666)
        with self.assertRaisesRegex(RuntimeError, 'unsafe existing publisher lock'):
            self.read()

    def test_symlink_lock_refused_without_touching_target(self):
        outside = self.base / 'OUTSIDE'
        outside.write_text('unchanged')
        self.lock.unlink()
        self.lock.symlink_to(outside)
        with self.assertRaises(OSError):
            self.read()
        self.assertEqual(outside.read_text(), 'unchanged')

    def test_missing_manifest_never_backfilled(self):
        manifest = self.release / '.release-manifest.sha256'
        manifest.unlink()
        with self.assertRaises(FileNotFoundError):
            self.read()
        self.assertFalse(manifest.exists())

    def test_modified_omitted_or_extra_file_refused(self):
        for scenario in ['modified', 'extra', 'omitted']:
            with self.subTest(scenario=scenario):
                file = self.release / 'index.html'
                if scenario == 'modified':
                    file.write_text('different')
                elif scenario == 'extra':
                    file.write_text('real immutable bytes\n')
                    (self.release / 'extra').write_text('not sealed')
                else:
                    (self.release / 'extra').unlink()
                    file.unlink()
                with self.assertRaisesRegex(RuntimeError, 'manifest'):
                    self.read()

    def test_symlink_and_fifo_in_artifact_refused(self):
        bad = self.release / 'bad'
        bad.symlink_to(self.lock)
        with self.assertRaises(RuntimeError):
            self.read()
        bad.unlink()
        os.mkfifo(bad)
        with self.assertRaises(RuntimeError):
            self.read()

    def test_wrong_source_or_dirty_original_provenance_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'current source changed'):
            native.read_artifact('b' * 40, str(self.root), 0.1)
        self.provenance['dirty'] = True
        (self.release / 'ca-provenance.json').write_text(json.dumps(self.provenance))
        self.seal()
        with self.assertRaisesRegex(RuntimeError, 'publisher provenance'):
            self.read()


if __name__ == '__main__':
    unittest.main()
