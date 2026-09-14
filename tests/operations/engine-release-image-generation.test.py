"""Real local Git objects and held files; no host, image, install or dispatch."""
import copy
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load("generation", ROOT / "server/scripts/engine-release-image-generation.py")
fixtures = load("request_fixtures", Path(__file__).with_name("engine-release-image-request.test.py"))


class GenerationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store = tempfile.TemporaryDirectory(prefix="image-generation-objects-")
        cls.addClassCleanup(cls.store.cleanup)
        cls.repo = Path(cls.store.name).resolve() / "fixture.git"
        cls.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        cls.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                       GIT_AUTHOR_NAME="Fixture", GIT_AUTHOR_EMAIL="fixture@example.invalid",
                       GIT_COMMITTER_NAME="Fixture", GIT_COMMITTER_EMAIL="fixture@example.invalid")
        subprocess.run(["git", "init", "--bare", "-q", str(cls.repo)], env=cls.env, check=True)
        cls.scripts = ROOT / "server/scripts"
        cls.installer = (cls.scripts / "install-engine-supervisor.sh").read_bytes()
        cls.names = m.required_files(cls.installer)
        cls.contents = {name: (cls.scripts / name).read_bytes() for name in cls.names}
        entries = []
        for name, raw in sorted(cls.contents.items()):
            oid = cls.git_fixture(["hash-object", "-w", "--stdin"], raw).strip()
            entries.append(b"100644 blob " + oid + b"\t" + name.encode() + b"\n")
        scripts = cls.git_fixture(["mktree"], b"".join(entries)).strip()
        server = cls.git_fixture(["mktree"], b"040000 tree " + scripts + b"\tscripts\n").strip()
        tree = cls.git_fixture(["mktree"], b"040000 tree " + server + b"\tserver\n").strip()
        cls.sha = cls.git_fixture(["commit-tree", tree.decode(), "-m", "fixture"]).strip().decode()
        cls.git_fixture(["update-ref", "refs/remotes/origin/main", cls.sha])

    @classmethod
    def git_fixture(cls, args, raw=None):
        return subprocess.run(["git", "-C", str(cls.repo), *args], input=raw,
                              env=cls.env, check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=10).stdout

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="image-generation-files-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.generation = self.root / self.sha
        self.generation.mkdir(mode=0o755)
        for name, raw in self.contents.items():
            path = self.generation / name
            path.write_bytes(raw)
            path.chmod(0o644 if name.endswith(".schema") else 0o755)
        (self.generation / "generation-files").write_text("\n".join(self.names) + "\n")
        (self.generation / "control-sha").write_text(self.sha + "\n")
        self.root_patch = patch.object(m, "GENERATION_ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def verify(self, seconds=30):
        return m.validate_generation(self.repo, self.sha, time.monotonic() + seconds)

    def test_exact_installed_manifest_and_all_git_bytes_pass(self):
        proof = self.verify()
        self.assertEqual(proof["control_sha"], self.sha)
        self.assertEqual(proof["generation_path"], str(self.generation))
        self.assertEqual(set(proof["files"]), set(self.names) | {"control-sha", "generation-files"})
        for name, digest in proof["files"].items():
            self.assertEqual(digest, m.request.digest((self.generation / name).read_bytes()))
        self.assertFalse((self.generation / "__pycache__").exists())

    def test_source_changed_with_same_manifest_is_refused(self):
        (self.generation / "engine-release-image-request.py").write_bytes(b"# substituted\n")
        with self.assertRaisesRegex(ValueError, "PROTECTED_SOURCE_MISMATCH"):
            self.verify()

    def test_missing_and_extra_files_are_refused(self):
        path = self.generation / "engine-release-image-result.py"
        raw = path.read_bytes()
        path.unlink()
        with self.assertRaisesRegex(ValueError, "GENERATION_ENTRIES"):
            self.verify()
        path.write_bytes(raw)
        extra = self.generation / "unmanifested.py"
        extra.write_text("# unmanifested\n")
        with self.assertRaisesRegex(ValueError, "GENERATION_ENTRIES"):
            self.verify()

    def test_manifest_cannot_omit_duplicate_reorder_or_add_names(self):
        path = self.generation / "generation-files"
        for names in [self.names[:-1], self.names + [self.names[0]],
                      list(reversed(self.names)), self.names + ["../outside"]]:
            with self.subTest(names=names):
                path.write_text("\n".join(names) + "\n")
                with self.assertRaisesRegex(ValueError, "FILE_MANIFEST"):
                    self.verify()

    def test_control_manifest_is_exact_not_truncated_or_normalized(self):
        path = self.generation / "control-sha"
        for raw in [self.sha.encode(), (self.sha + "\r\n").encode(), b"f" * 40 + b"\n"]:
            with self.subTest(raw=raw):
                path.write_bytes(raw)
                with self.assertRaisesRegex(ValueError, "CONTROL_MANIFEST"):
                    self.verify()

    def test_symlink_and_fifo_are_refused_without_following_or_blocking(self):
        path = self.generation / "engine-release-image-request.py"
        path.unlink()
        path.symlink_to(self.scripts / path.name)
        with self.assertRaises(OSError):
            self.verify()
        path.unlink()
        os.mkfifo(path)
        with self.assertRaisesRegex(ValueError, "INSTALLED_FILE"):
            self.verify()

    def test_writable_directory_and_file_are_refused(self):
        self.generation.chmod(0o777)
        with self.assertRaisesRegex(ValueError, "GENERATION_OWNER_MODE"):
            self.verify()
        self.generation.chmod(0o755)
        (self.generation / "engine-release-image-request.py").chmod(0o666)
        with self.assertRaisesRegex(ValueError, "INSTALLED_FILE"):
            self.verify()

    def test_other_owner_is_refused(self):
        with patch.object(m.os, "geteuid", return_value=os.geteuid() + 1), \
                self.assertRaisesRegex(ValueError, "GENERATION_OWNER_MODE"):
            self.verify()

    def test_symlink_generation_and_parent_are_refused(self):
        renamed = self.root / "saved"
        self.generation.rename(renamed)
        self.generation.symlink_to(renamed, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "CANONICAL_GENERATION"):
            self.verify()

    def test_changed_held_inode_and_same_bytes_replacement_are_refused(self):
        original = m.git_blob
        target = self.generation / "engine-release-image-request.py"
        for kind in ["in_place", "replacement"]:
            target.write_bytes(self.contents[target.name])
            def changed(repo, sha, name, deadline):
                raw = original(repo, sha, name, deadline)
                if name == "retain-engine-images.sh":
                    if kind == "replacement":
                        replacement = self.generation / "temporary"
                        replacement.write_bytes(target.read_bytes())
                        replacement.replace(target)
                    else:
                        target.write_bytes(target.read_bytes() + b"\n")
                return raw
            with self.subTest(kind=kind), patch.object(m, "git_blob", side_effect=changed), \
                    self.assertRaisesRegex(ValueError, "GENERATION_CHANGED"):
                self.verify()

    def test_directory_replacement_after_files_held_is_refused(self):
        original = m.git_blob
        def changed(repo, sha, name, deadline):
            raw = original(repo, sha, name, deadline)
            if name == "retain-engine-images.sh":
                old = self.root / "retained"
                self.generation.rename(old)
                shutil.copytree(old, self.generation)
            return raw
        with patch.object(m, "git_blob", side_effect=changed), \
                self.assertRaisesRegex(ValueError, "GENERATION_REPLACED"):
            self.verify()

    def test_expired_local_proof_deadline_refuses_before_git(self):
        with patch.object(m.subprocess, "run") as process, self.assertRaisesRegex(ValueError, "PROOF_DEADLINE"):
            self.verify(seconds=-1)
        process.assert_not_called()

    def test_late_git_read_and_injected_deadline_are_refused(self):
        with self.assertRaisesRegex(ValueError, "PROOF_DEADLINE"):
            self.verify(seconds=-1)
        with patch.object(m.subprocess, "run", side_effect=subprocess.TimeoutExpired("git", 1)), \
                self.assertRaises(subprocess.TimeoutExpired):
            self.verify()

    def test_foreign_commit_and_unprotected_source_are_refused(self):
        with self.assertRaises(ValueError):
            m.validate_generation(self.repo, "z" * 40, time.monotonic() + 10)
        foreign = self.git_fixture(["mktree"], b"").strip().decode()
        other = self.git_fixture(["commit-tree", foreign, "-m", "unprotected"]).strip().decode()
        self.generation.rename(self.root / other)
        with self.assertRaisesRegex(ValueError, "LOCAL_GIT_PROOF"):
            m.validate_generation(self.repo, other, time.monotonic() + 10)

    def test_ambient_git_redirects_do_not_replace_explicit_source(self):
        before = (self.repo / "config").read_bytes()
        with patch.dict(os.environ, {"GIT_DIR": "/missing", "GIT_OBJECT_DIRECTORY": "/missing",
                                    "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.bare",
                                    "GIT_CONFIG_VALUE_0": "false", "GIT_NO_REPLACE_OBJECTS": "0"}):
            self.verify()
        self.assertEqual((self.repo / "config").read_bytes(), before)

    def test_installer_manifest_is_literal_unique_and_complete(self):
        for replacement in [b"  $(touch /tmp/never-executed)", b"  ../outside", b"  control-sha"]:
            bad = self.installer.replace(b"  engine-release-image-result.py", replacement, 1)
            with self.subTest(replacement=replacement), self.assertRaises(ValueError):
                m.required_files(bad)
        for bad in [self.installer.replace(b"  engine-release-image-result.py\n", b"", 1),
                    self.installer.replace(b"  engine-release-image-result.py\n",
                                           b"  engine-release-image-result.py\n" * 2, 1)]:
            with self.assertRaises(ValueError):
                m.required_files(bad)

    def test_bounded_file_and_total_bytes_are_enforced(self):
        with patch.object(m, "FILE_LIMIT", 16), self.assertRaisesRegex(ValueError, "SOURCE_FILE_SIZE"):
            self.verify()
        with patch.object(m, "TOTAL_LIMIT", 32), self.assertRaisesRegex(ValueError, "GENERATION_SIZE"):
            self.verify()

    def test_intake_digest_and_expiry_precede_generation_reads(self):
        request_case = fixtures.RequestTest(methodName="test_actual_prepare_calls_existing_admission_and_fixed_metadata_routes")
        request_case.setUp()
        try:
            raw = request_case.raw
            with patch.object(m, "validate_generation") as verify, \
                    self.assertRaisesRegex(ValueError, "BOUND_REQUEST_DIGEST"):
                m.bind_installed_generation(raw, "123-2", "0" * 64, self.repo)
            verify.assert_not_called()
            with patch.object(m, "validate_generation") as verify, \
                    patch.object(m.time, "time", return_value=request_case.deadline), \
                    self.assertRaisesRegex(ValueError, "EXPIRED"):
                m.bind_installed_generation(raw, "123-2", m.request.digest(raw), self.repo)
            verify.assert_not_called()
        finally:
            request_case.tearDown()
            request_case.doCleanups()

    def test_binding_retains_exact_authority_and_original_deadline(self):
        request_case = fixtures.RequestTest(methodName="test_actual_prepare_calls_existing_admission_and_fixed_metadata_routes")
        request_case.setUp()
        try:
            expected, receipt = copy.deepcopy(request_case.expected), copy.deepcopy(request_case.receipt)
            expected["identity"]["workflow_control_sha"] = self.sha
            receipt["identity"]["workflow_control_sha"] = self.sha
            raw = m.request.make_intake(expected, receipt, "release-owner", request_case.deadline, request_case.now)
            # Only the fixed host path syntax is mapped to this test's private directory.
            path_ok = lambda path, sha: path == str(self.root / sha)
            with patch.object(m.request, "generation_ok", side_effect=path_ok), \
                    patch.object(m.time, "time", return_value=request_case.now):
                release, proof = m.bind_installed_generation(raw, "123-2", m.request.digest(raw), self.repo)
                value = m.request.parse(release, "release", "123-2")
            self.assertEqual(value["intake_sha256"], m.request.digest(raw))
            self.assertEqual(value["not_after_epoch"], request_case.deadline)
            self.assertEqual(value["image_authority"]["expected"], expected)
            self.assertEqual(proof["control_sha"], self.sha)
            self.assertFalse(value["deployment_authorized"])
            with patch.object(m.time, "time", side_effect=[request_case.now, request_case.deadline]), \
                    patch.object(m.request, "generation_ok", side_effect=path_ok), \
                    self.assertRaisesRegex(ValueError, "EXPIRED"):
                m.bind_installed_generation(raw, "123-2", m.request.digest(raw), self.repo)
        finally:
            request_case.tearDown()
            request_case.doCleanups()


    def test_cli_has_no_dispatch_and_refuses_nonroot_before_reading_request(self):
        argv = ["generation", "--intake", "/missing", "--intake-sha256", "0" * 64,
                "--run-key", "123-2", "--output", "/missing/123-2.release.prepared-v2"]
        with patch("sys.argv", argv), patch.object(m.os, "geteuid", return_value=1001), \
                patch.object(m.request.bundle, "read_regular") as read, \
                self.assertRaisesRegex(ValueError, "ROOT_REQUIRED"):
            m.main()
        read.assert_not_called()

    def test_cli_late_durable_write_emits_no_success_or_executable_request(self):
        request_case = fixtures.RequestTest(methodName="test_actual_prepare_calls_existing_admission_and_fixed_metadata_routes")
        request_case.setUp()
        try:
            raw = request_case.raw
            release = m.request.derive_release(raw, "123-2", request_case.generation, m.request.digest(raw))
            intake_path = self.root / "input"
            intake_path.write_bytes(raw)
            output_dir = self.root / "prepared"
            output_dir.mkdir(mode=0o700)
            output = output_dir / "123-2.release.prepared-v2"
            argv = ["generation", "--intake", str(intake_path), "--intake-sha256", m.request.digest(raw),
                    "--run-key", "123-2", "--output", str(output)]
            text = io.StringIO()
            real_uid = os.geteuid()
            # Root entry check is simulated; the real filesystem writer still
            # checks the actual test user's private directory and created inode.
            with patch("sys.argv", argv), patch.object(m.os, "geteuid", side_effect=[0, real_uid, real_uid]), \
                    patch.object(m, "bind_installed_generation", return_value=(release, {})), \
                    patch.object(m.time, "time", return_value=request_case.deadline), \
                    contextlib.redirect_stdout(text), self.assertRaisesRegex(ValueError, "EXPIRED"):
                m.main()
            self.assertEqual(text.getvalue(), "")
            self.assertEqual(output.read_bytes(), release)
            self.assertEqual({p.name for p in output_dir.iterdir()}, {output.name})
        finally:
            request_case.tearDown()
            request_case.doCleanups()


if __name__ == "__main__":
    unittest.main()
