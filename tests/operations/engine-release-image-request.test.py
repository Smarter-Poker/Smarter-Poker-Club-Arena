"""Bounded source/filesystem/API-fixture tests; no production or native import."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

m = load("request", ROOT / "server/scripts/engine-release-image-request.py")
fixtures = load("bundle_fixtures", Path(__file__).with_name("engine-image-ci-bundle.test.py"))


class RequestTest(unittest.TestCase):
    def setUp(self):
        fixtures.BundleTest.setUp(self)
        self.directory = self.directory.resolve()
        self.generation = "/usr/local/lib/club-arena/engine-control-generations/" + "a" * 40
        self.deadline = 2000000100
        self.now = 2000000000
        self.receipt = dict(scope="same-run-engine-image-admission", status="passed", producer_job_id=999,
                            artifact_id="456", identity=copy.deepcopy(self.identity),
                            archive_sha256=self.expected["archive_sha256"], archive_bytes=2048,
                            descriptor_sha256=self.expected["descriptor_sha256"],
                            host_import_qualified=False, deployment_authorized=False)
        self.raw = m.make_intake(self.expected, self.receipt, "release-owner", self.deadline, self.now)
        self.prepared = self.directory.parent / (self.directory.name + "-prepared")
        self.prepared.mkdir(mode=0o700)
        self.addCleanup(lambda: self.prepared.rmdir())
        self.output = self.prepared / "123-2.intake.prepared-v2"
        self.addCleanup(lambda: self.output.unlink(missing_ok=True))
        self.expected_path = self.directory.parent / (self.directory.name + "-expected.json")
        self.expected_path.write_bytes(m.bundle.encode(self.expected))
        self.addCleanup(lambda: self.expected_path.unlink(missing_ok=True))

    def tearDown(self):
        fixtures.BundleTest.tearDown(self)

    def api_replies(self):
        return [self.repository, self.run, self.artifact, self.jobs]

    def prepare(self):
        return m.prepare_intake(self.directory, self.expected_path, "release-owner", self.deadline)

    def test_actual_prepare_calls_existing_admission_and_fixed_metadata_routes(self):
        with patch.dict(os.environ, self.environment), patch.object(m.time, "time", return_value=self.now), \
                patch.object(m.bundle, "github_api", side_effect=self.api_replies()) as api:
            actual = self.prepare()
        self.assertEqual(actual, self.raw)
        self.assertEqual([call.args[0] for call in api.call_args_list], [
            "repos/" + m.bundle.REPOSITORY,
            "repos/" + m.bundle.REPOSITORY + "/actions/runs/123/attempts/2",
            "repos/" + m.bundle.REPOSITORY + "/actions/artifacts/456",
            "repos/" + m.bundle.REPOSITORY + "/actions/runs/123/attempts/2/jobs?per_page=100"])
        value = m.parse(actual, "intake", "123-2")
        self.assertFalse(value["deployment_authorized"])
        self.assertFalse(value["host_import_qualified"])

    def test_qualification_foreign_attempt_and_failed_producer_do_not_prepare(self):
        cases = [("event", "pull_request"), ("attempt", "1"), ("producer", "failure"),
                 ("artifact", True)]
        for key, value in cases:
            env, replies = dict(self.environment), copy.deepcopy(self.api_replies())
            if key == "event": env["GITHUB_EVENT_NAME"] = value
            elif key == "attempt": env["GITHUB_RUN_ATTEMPT"] = value
            elif key == "producer": replies[3]["jobs"][0]["conclusion"] = value
            else: replies[2]["expired"] = value
            with self.subTest(case=key), patch.dict(os.environ, env), \
                    patch.object(m.time, "time", return_value=self.now), \
                    patch.object(m.bundle, "github_api", side_effect=replies), self.assertRaises(ValueError):
                self.prepare()
        self.assertFalse(self.output.exists())

    def test_archive_change_during_metadata_reads_never_prepares(self):
        replies = iter(self.api_replies())
        def api(endpoint):
            response = next(replies)
            if "/jobs?" in endpoint:
                (self.directory / "engine-image.tar").write_bytes(b"x" * 2048)
            return response
        with patch.dict(os.environ, self.environment), patch.object(m.time, "time", return_value=self.now), \
                patch.object(m.bundle, "github_api", side_effect=api), \
                self.assertRaisesRegex(ValueError, "ARCHIVE_DIGEST"):
            self.prepare()

    def test_original_deadline_is_checked_before_and_after_api_reads(self):
        with patch.object(m.time, "time", return_value=self.deadline), \
                patch.object(m.bundle, "github_api") as api, self.assertRaisesRegex(ValueError, "EXPIRED"):
            self.prepare()
        api.assert_not_called()
        with patch.dict(os.environ, self.environment), \
                patch.object(m.time, "time", side_effect=[self.now, self.deadline]), \
                patch.object(m.bundle, "github_api", side_effect=self.api_replies()), \
                self.assertRaisesRegex(ValueError, "EXPIRED"):
            self.prepare()

    def test_cli_emits_prepared_digest_only_after_exact_bytes_fsynced(self):
        output = io.StringIO()
        argv = ["request", "--directory", str(self.directory), "--expected", str(self.expected_path),
                "--actor", "release-owner", "--not-after-epoch", str(self.deadline), "--output", str(self.output)]
        with patch.dict(os.environ, self.environment), patch.object(m.time, "time", return_value=self.now), \
                patch.object(m.bundle, "github_api", side_effect=self.api_replies()), \
                patch("sys.argv", argv), contextlib.redirect_stdout(output):
            m.main()
        result = json.loads(output.getvalue())
        self.assertEqual(self.output.read_bytes(), self.raw)
        self.assertEqual(result["request_sha256"], m.digest(self.raw))
        self.assertFalse(result["deployment_authorized"])

    def test_cli_late_fsync_deadline_emits_no_success(self):
        output = io.StringIO()
        argv = ["request", "--directory", str(self.directory), "--expected", str(self.expected_path),
                "--actor", "release-owner", "--not-after-epoch", str(self.deadline), "--output", str(self.output)]
        with patch.dict(os.environ, self.environment), \
                patch.object(m.time, "time", side_effect=[self.now, self.now, self.deadline]), \
                patch.object(m.bundle, "github_api", side_effect=self.api_replies()), \
                patch("sys.argv", argv), contextlib.redirect_stdout(output), \
                self.assertRaisesRegex(ValueError, "EXPIRED"):
            m.main()
        self.assertEqual(output.getvalue(), "")
        # Failure leaves only inert prepared evidence, never an actionable intent.
        self.assertEqual({p.name for p in self.prepared.iterdir()}, {self.output.name})

    def test_all_independent_image_authority_axes_are_bound_to_request_digest(self):
        changes = [("identity", key, value) for key, value in {
            "repository": "Other/Repository", "workflow": "other.yml", "workflow_control_sha": "1" * 40,
            "source_sha": "2" * 40, "server_tree": "3" * 40, "run_id": "124", "run_attempt": "3",
            "image_id": "sha256:" + "4" * 64}.items()]
        changes += [("expected", key, value) for key, value in {
            "archive_sha256": "5" * 64, "archive_bytes": 4096, "descriptor_sha256": "6" * 64,
            "artifact_id": "457", "artifact_digest": "7" * 64}.items()]
        for scope, key, replacement in changes:
            value = m.bundle.decode(self.raw)
            target = value["image_authority"]["expected"]
            if scope == "identity": target = target["identity"]
            target[key] = replacement
            with self.subTest(scope=scope, key=key), self.assertRaisesRegex(ValueError, "BOUND_REQUEST_DIGEST"):
                m.verify_bound_request(m.bundle.encode(value), "intake", "123-2", m.digest(self.raw))

    def test_coherent_forged_receipt_cannot_replace_independent_request_digest(self):
        expected, receipt = copy.deepcopy(self.expected), copy.deepcopy(self.receipt)
        expected["artifact_digest"] = "7" * 64
        receipt["producer_job_id"] = 1000
        forged = m.make_intake(expected, receipt, "release-owner", self.deadline, self.now)
        # Offline syntax/hash checks alone intentionally are not authentication.
        self.assertIsNotNone(m.parse(forged, "intake", "123-2"))
        with self.assertRaisesRegex(ValueError, "BOUND_REQUEST_DIGEST"):
            m.verify_bound_request(forged, "intake", "123-2", m.digest(self.raw))

    def test_request_top_level_substitution_unknown_version_and_escalation_refuse(self):
        for key, value in {"source_sha": "f" * 40, "control_sha": "f" * 40, "run_key": "123-1",
                           "run_url": "https://evil.invalid/123", "protocol": "v1", "kind": "release",
                           "host_import_qualified": True, "deployment_authorized": True,
                           "extra": True}.items():
            changed = {**m.bundle.decode(self.raw), key: value}
            with self.subTest(key=key), self.assertRaises(ValueError):
                m.parse(m.bundle.encode(changed), "intake", "123-2")

    def test_receipt_hash_and_bound_fields_refuse_independent_changes(self):
        changes = {"producer_job_id": 1000, "identity": {**self.identity, "server_tree": "1" * 40},
                   "archive_sha256": "0" * 64, "archive_bytes": 1024,
                   "descriptor_sha256": "1" * 64, "artifact_id": "999", "status": "failed",
                   "scope": "qualification", "host_import_qualified": True, "deployment_authorized": True}
        for key, value in changes.items():
            changed = m.bundle.decode(self.raw)
            changed["image_authority"]["custody_receipt"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                m.parse(m.bundle.encode(changed), "intake", "123-2")

    def test_actor_deadline_and_numeric_types_are_strict(self):
        for actor in ["", "x" * 129, "a\nb", "a\rb", "a\x00b", "a\x7fb", None]:
            with self.subTest(actor=actor), self.assertRaises(ValueError):
                m.make_intake(self.expected, self.receipt, actor, self.deadline, self.now)
        for deadline in [True, 0, -1, 10000000000, "2000000100", 2000000100.5]:
            with self.subTest(deadline=deadline), self.assertRaises(ValueError):
                m.make_intake(self.expected, self.receipt, "owner", deadline, self.now)
        for job_id in [True, 0, -1, "999"]:
            with self.subTest(job_id=job_id), self.assertRaises(ValueError):
                m.make_intake(self.expected, {**self.receipt, "producer_job_id": job_id}, "owner", self.deadline, self.now)

    def test_request_size_duplicate_keys_noncanonical_and_trailing_bytes_refuse(self):
        bad = [b"", b" " * (m.LIMIT + 1), self.raw[:-1], self.raw + b"\n",
               b'{"protocol":"x","protocol":"y"}',
               json.dumps(m.bundle.decode(self.raw), indent=2).encode() + b"\n"]
        for raw in bad:
            with self.subTest(size=len(raw)), self.assertRaises(ValueError):
                m.parse(raw, "intake", "123-2")

    def test_release_derivation_binds_parent_hash_generation_and_unchanged_deadline(self):
        raw = m.derive_release(self.raw, "123-2", self.generation, m.digest(self.raw))
        value = m.parse(raw, "release", "123-2")
        self.assertEqual(value["intake_sha256"], m.digest(self.raw))
        self.assertEqual(value["not_after_epoch"], self.deadline)
        self.assertEqual(value["image_authority"], m.bundle.decode(self.raw)["image_authority"])
        self.assertEqual(value["generation_path"], self.generation)

    def test_release_derivation_refuses_other_parent_generation_attempt_and_digest(self):
        for generation in [self.generation + "/../other", self.generation.replace("a" * 40, "b" * 40),
                           "/tmp/" + "a" * 40, self.generation + "/", self.generation.replace("/a", "//a")]:
            with self.subTest(generation=generation), self.assertRaises(ValueError):
                m.derive_release(self.raw, "123-2", generation, m.digest(self.raw))
        with self.assertRaisesRegex(ValueError, "PROTOCOL_CONTEXT"):
            m.derive_release(self.raw, "123-1", self.generation, m.digest(self.raw))
        with self.assertRaisesRegex(ValueError, "BOUND_REQUEST_DIGEST"):
            m.derive_release(self.raw, "123-2", self.generation, "0" * 64)

    def test_release_request_cannot_widen_deadline_or_replace_parent_hash(self):
        raw = m.derive_release(self.raw, "123-2", self.generation, m.digest(self.raw))
        for key, replacement in [("not_after_epoch", self.deadline + 1), ("intake_sha256", "0" * 64),
                                 ("actor", "different")]:
            value = {**m.bundle.decode(raw), key: replacement}
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "INTAKE_BINDING"):
                m.parse(m.bundle.encode(value), "release", "123-2")

    def test_expired_request_remains_recoverable_but_cannot_authorize_new_work(self):
        raw = m.derive_release(self.raw, "123-2", self.generation, m.digest(self.raw))
        value = m.verify_pair(raw, raw, "release", "123-2")
        with self.assertRaisesRegex(ValueError, "EXPIRED"):
            m.require_unexpired(value, self.deadline)
        self.assertEqual(m.derive_release(self.raw, "123-2", self.generation, m.digest(self.raw)), raw)

    def test_recovery_pair_refuses_new_attempt_rebinding_or_renewal(self):
        changed = m.make_intake(self.expected, self.receipt, "release-owner", self.deadline + 1, self.now)
        with self.assertRaisesRegex(ValueError, "INTENT_REQUEST_MISMATCH"):
            m.verify_pair(self.raw, changed, "intake", "123-2")
        with self.assertRaisesRegex(ValueError, "PROTOCOL_CONTEXT"):
            m.verify_pair(self.raw, self.raw, "intake", "123-3")

    def test_prepared_file_is_durable_idempotent_and_has_no_active_suffix(self):
        first = m.write_prepared(self.output, self.raw, "intake", "123-2")
        inode = self.output.stat().st_ino
        second = m.write_prepared(self.output, self.raw, "intake", "123-2")
        self.assertEqual(first, second)
        self.assertEqual(self.output.stat().st_ino, inode)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o600)
        self.assertEqual({p.name for p in self.prepared.iterdir()}, {self.output.name})
        self.assertEqual(self.output.read_bytes(), self.raw)
        for suffix in (".intent", ".request"):
            with self.assertRaisesRegex(ValueError, "PREPARED_PATH"):
                m.write_prepared(self.prepared / ("123-2" + suffix), self.raw, "intake", "123-2")

    def test_lost_acknowledgement_after_link_is_recoverable_exactly(self):
        real_link = m.os.link
        def link_then_crash(*args, **kwargs):
            real_link(*args, **kwargs)
            raise OSError("simulated lost acknowledgement after atomic link")
        with patch.object(m.os, "link", side_effect=link_then_crash), self.assertRaises(OSError):
            m.write_prepared(self.output, self.raw, "intake", "123-2")
        self.assertEqual(self.output.read_bytes(), self.raw)
        m.write_prepared(self.output, self.raw, "intake", "123-2")
        self.assertEqual({p.name for p in self.prepared.iterdir()}, {self.output.name})

    def test_conflict_legacy_or_replacement_never_overwrites_record(self):
        for raw in [b"legacy v1 immutable intent\n", b"other owner\n",
                    m.make_intake(self.expected, self.receipt, "owner", self.deadline, self.now)]:
            self.output.write_bytes(raw)
            self.output.chmod(0o600)
            inode = self.output.stat().st_ino
            with self.subTest(raw=raw[:30]), self.assertRaisesRegex(ValueError, "PREPARED_CONFLICT"):
                m.write_prepared(self.output, self.raw, "intake", "123-2")
            self.assertEqual(self.output.read_bytes(), raw)
            self.assertEqual(self.output.stat().st_ino, inode)

    def test_symlink_fifo_and_wrong_mode_never_adopt_or_remove_other_file(self):
        target = self.prepared / "other-owner"
        target.write_bytes(b"keep")
        self.addCleanup(lambda: target.unlink(missing_ok=True))
        self.output.symlink_to(target)
        with self.assertRaises(OSError):
            m.write_prepared(self.output, self.raw, "intake", "123-2")
        self.assertEqual(target.read_bytes(), b"keep")
        self.output.unlink()
        os.mkfifo(self.output, mode=0o600)
        with self.assertRaisesRegex(ValueError, "EXISTING_PREPARED_FILE"):
            m.write_prepared(self.output, self.raw, "intake", "123-2")
        self.output.unlink()
        self.output.write_bytes(self.raw)
        self.output.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "EXISTING_PREPARED_FILE"):
            m.write_prepared(self.output, self.raw, "intake", "123-2")
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o644)

    def test_nonprivate_or_symlinked_parent_refuses_before_publication(self):
        self.prepared.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "PRIVATE_PARENT"):
            m.write_prepared(self.output, self.raw, "intake", "123-2")
        self.prepared.chmod(0o700)
        alias = self.prepared.parent / (self.prepared.name + "-alias")
        alias.symlink_to(self.prepared)
        try:
            with self.assertRaisesRegex(ValueError, "CANONICAL_PARENT"):
                m.write_prepared(alias / self.output.name, self.raw, "intake", "123-2")
        finally:
            alias.unlink()
        self.assertFalse(self.output.exists())

    def test_file_or_directory_fsync_failure_never_emits_success_or_deletes_other_record(self):
        real_fsync = m.os.fsync
        for fail_call in (1, 2, 3):
            self.output.unlink(missing_ok=True)
            count = 0
            def fsync(fd):
                nonlocal count
                count += 1
                if count == fail_call:
                    raise OSError("simulated fsync failure")
                return real_fsync(fd)
            with self.subTest(fail_call=fail_call), patch.object(m.os, "fsync", side_effect=fsync), \
                    self.assertRaises(OSError):
                m.write_prepared(self.output, self.raw, "intake", "123-2")
            self.assertFalse(any(p.name.startswith(".") for p in self.prepared.iterdir()))
            if self.output.exists():
                self.assertEqual(self.output.read_bytes(), self.raw)


class FrozenV1Test(unittest.TestCase):
    def test_versioned_schema_matches_codec_and_keeps_activation_outside_scope(self):
        raw = (ROOT / "server/scripts/engine-release-image-request-v2.schema").read_text()
        pairs = [line.split("=", 1) for line in raw.splitlines()]
        self.assertEqual(len({key for key, _ in pairs}), len(pairs))
        schema = dict(pairs)
        self.assertEqual(schema["protocol"], m.PROTOCOL)
        self.assertEqual(set(schema["intake-fields"].split(",")), m.FIELDS)
        self.assertEqual(set(schema["expected-fields"].split(",")), m.EXPECTED_FIELDS)
        self.assertEqual(set(schema["custody-receipt-fields"].split(",")), m.RECEIPT_FIELDS)
        self.assertEqual(int(schema["maximum-request-bytes"]), m.LIMIT)
        self.assertEqual(schema["scope"], "immutable-request-codec-only")
        self.assertEqual(schema["host-import-qualified"], "false")
        self.assertEqual(schema["deployment-authorized"], "false")

    def test_actual_frozen_v1_request_count_gates_accept_legacy_and_refuse_v2(self):
        before = Path(os.environ.get("ENGINE_IMAGE_REQUEST_V1_SOURCE_ROOT", str(ROOT))) / "server/scripts"
        for filename, count in [("engine-release-intake.sh", 5), ("engine-release-unit-wrapper.sh", 6),
                                ("engine-release-transaction.sh", 6)]:
            source = (before / filename).read_text()
            match = re.search(r'\[ "\$\{#REQUEST_LINES\[@\]\}" = [56] \]', source)
            self.assertIsNotNone(match)
            check = match.group(0)
            script = 'REQUEST_LINES=("$@"); ' + check
            for fields, success in [(count, True), (1, False), (count + 1, False)]:
                result = subprocess.run(["bash", "-c", script, "check", *(["field"] * fields)], capture_output=True)
                self.assertEqual(result.returncode == 0, success, (filename, fields))

    def test_frozen_v1_schema_digest_and_numeric_legacy_recovery_key_remain_unchanged(self):
        before = Path(os.environ.get("ENGINE_IMAGE_REQUEST_V1_SOURCE_ROOT", str(ROOT))) / "server/scripts"
        schema = (before / "engine-release-protocol-v1.schema").read_bytes()
        actual = hashlib.sha256(schema).hexdigest()
        for file in ["install-engine-supervisor.sh", "engine-release-unit-wrapper.sh"]:
            self.assertIn('PROTOCOL_V1_SHA256="' + actual + '"', (before / file).read_text())
        wrapper = (before / "engine-release-unit-wrapper.sh").read_text()
        self.assertIn('^\u005b1-9\u005d\u005b0-9\u005d*(-\u005b1-9\u005d\u005b0-9\u005d*)?$', wrapper)
        for fields in (5, 6):
            with self.assertRaises(ValueError):
                m.parse(b"legacy-field\n" * fields, "intake", "123-2")


if __name__ == "__main__":
    unittest.main(verbosity=2)
