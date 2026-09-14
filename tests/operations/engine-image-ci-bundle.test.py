"""Real bounded-file tests and controlled GitHub protocol tests; no native load."""
import copy
import hashlib
import io
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("ci_bundle", ROOT / "server/scripts/engine-image-ci-bundle.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class BundleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("ENGINE_CI_BUNDLE_TEST_TMP"))
        self.directory = Path(self.temp.name)
        self.archive = bytes(2048)
        self.identity = dict(repository=m.REPOSITORY, workflow=m.WORKFLOW, workflow_control_sha="a" * 40,
                             source_sha="b" * 40, server_tree="c" * 40, run_id="123", run_attempt="2",
                             image_id="sha256:" + "d" * 64)
        self.runtime = {"index.js": "e" * 64, "engine/TournamentManager.js": "f" * 64}
        self.normal = dict(version=1, scope="engine-image-archive-normalization", image_id=self.identity["image_id"],
                           source_sha=self.identity["source_sha"], server_tree=self.identity["server_tree"],
                           build_contract=m.CONTRACT, input_sha256="1" * 64,
                           archive_sha256=hashlib.sha256(self.archive).hexdigest(), archive_bytes=2048,
                           layers=12, platform="linux/amd64", producer_authenticated=False, host_import_qualified=False)
        self.value = m.descriptor(self.identity, self.normal, self.runtime, dict(self.runtime))
        self.expected = dict(identity=dict(self.identity), archive_sha256=self.normal["archive_sha256"],
                             archive_bytes=2048, descriptor_sha256=hashlib.sha256(m.encode(self.value)).hexdigest(),
                             artifact_id="456", artifact_digest="2" * 64)
        (self.directory / "engine-image.tar").write_bytes(self.archive)
        (self.directory / "engine-image.json").write_bytes(m.encode(self.value))
        self.environment = dict(GITHUB_ACTIONS="true", GITHUB_REPOSITORY=m.REPOSITORY, GITHUB_RUN_ID="123",
                                GITHUB_RUN_ATTEMPT="2", GITHUB_SHA="a" * 40, GITHUB_EVENT_NAME="repository_dispatch")
        self.repository = dict(full_name=m.REPOSITORY, id=789)
        self.run = dict(id=123, run_attempt=2, event="repository_dispatch", path=m.WORKFLOW,
                        head_sha="a" * 40, repository=dict(id=789), head_repository=dict(id=789),
                        status="in_progress", conclusion=None)
        self.artifact = dict(id=456, name="engine-image-123-2", digest="sha256:" + "2" * 64, expired=False,
                             workflow_run=dict(id=123, head_sha="a" * 40, repository_id=789, head_repository_id=789))
        self.jobs = dict(total_count=1, jobs=[dict(id=999, run_id=123, head_sha="a" * 40, name=m.PRODUCER_JOB,
                                                  status="completed", conclusion="success")])

    def tearDown(self):
        self.temp.cleanup()

    def metadata(self):
        return m.validate_github_metadata(self.repository, self.run, self.artifact, self.jobs,
                                         self.expected, self.environment)

    def test_exact_bundle_and_successful_same_run_producer(self):
        self.assertEqual(m.validate_files(self.directory, self.expected), self.value)
        self.assertEqual(self.metadata(), 999)
        self.assertFalse(self.value["host_import_qualified"])
        self.assertFalse(self.value["deployment_authorized"])

    def producer_inputs(self):
        reference = self.directory / "reference"
        copied = self.directory / "copied"
        reference.mkdir()
        copied.mkdir()
        for path in (reference, copied):
            (path / "index.js").write_bytes(b"export const actualRuntime = true;\n")
            (path / "index.d.ts").write_bytes(b"ignored declarations only\n")
        return reference, copied

    def test_producer_packages_actual_matching_runtime_and_exact_archive_without_copy(self):
        reference, copied = self.producer_inputs()
        target = self.directory / "bundle"
        output = m.write_bundle(target, self.directory / "engine-image.tar", self.identity, self.normal,
                                reference, copied)
        expected = {key: value for key, value in output.items() if key in
                    {"identity", "archive_sha256", "archive_bytes", "descriptor_sha256"}}
        expected.update(artifact_id="456", artifact_digest="2" * 64)
        self.assertEqual(m.validate_files(target, expected)["identity"], self.identity)
        self.assertEqual(output["typechecked_runtime_files_matched"], 1)
        self.assertEqual((target / "engine-image.tar").stat().st_ino,
                         (self.directory / "engine-image.tar").stat().st_ino)

    def test_producer_refuses_changed_runtime_or_archive_before_creating_bundle(self):
        reference, copied = self.producer_inputs()
        target = self.directory / "bundle"
        (copied / "index.js").write_bytes(b"different runtime\n")
        with self.assertRaisesRegex(ValueError, "REFERENCE_RUNTIME_MISMATCH"):
            m.write_bundle(target, self.directory / "engine-image.tar", self.identity, self.normal, reference, copied)
        self.assertFalse(target.exists())
        (copied / "index.js").write_bytes((reference / "index.js").read_bytes())
        (self.directory / "engine-image.tar").write_bytes(b"x" * 2048)
        with self.assertRaisesRegex(ValueError, "PRODUCER_ARCHIVE_BYTES"):
            m.write_bundle(target, self.directory / "engine-image.tar", self.identity, self.normal, reference, copied)
        self.assertFalse(target.exists())

    def test_producer_never_overwrites_existing_bundle(self):
        reference, copied = self.producer_inputs()
        target = self.directory / "bundle"
        target.mkdir()
        marker = target / "keep"
        marker.write_text("other owner")
        with self.assertRaises(FileExistsError):
            m.write_bundle(target, self.directory / "engine-image.tar", self.identity, self.normal, reference, copied)
        self.assertEqual(marker.read_text(), "other owner")

    def test_producer_rejects_symlinked_runtime_before_packaging(self):
        reference, copied = self.producer_inputs()
        (copied / "index.js").unlink()
        (copied / "index.js").symlink_to(reference / "index.js")
        with self.assertRaisesRegex(ValueError, "RUNTIME_SYMLINK"):
            m.write_bundle(self.directory / "bundle", self.directory / "engine-image.tar", self.identity,
                           self.normal, reference, copied)

    def test_reference_runtime_must_match_every_file(self):
        for reference in ({"index.js": "e" * 64}, {**self.runtime, "extra.js": "e" * 64},
                          {**self.runtime, "index.js": "3" * 64}):
            with self.subTest(reference=reference), self.assertRaisesRegex(ValueError, "REFERENCE_RUNTIME"):
                m.descriptor(self.identity, self.normal, self.runtime, reference)

    def test_runtime_entries_are_bounded_and_safe(self):
        for runtime in ({}, {"../escape.js": "e" * 64}, {"/absolute.js": "e" * 64},
                        {"a//b.js": "e" * 64}, {"a.test.js": "e" * 64}, {"a.spec.js": "e" * 64},
                        {"__tests__/a.js": "e" * 64}, {"a.d.ts": "e" * 64}, {"a.js": "E" * 64},
                        {"a\\b.js": "e" * 64}, {"x" * 513: "e" * 64}):
            with self.subTest(runtime=runtime), self.assertRaises(ValueError):
                m.check_runtime(runtime)

    def test_normalization_cannot_change_source_or_claim_authority(self):
        cases = dict(version=True, scope="other", source_sha="0" * 40, server_tree="0" * 40,
                     image_id="sha256:" + "0" * 64, build_contract="different", platform="linux/arm64",
                     archive_sha256="broken", archive_bytes=True, layers=0,
                     producer_authenticated=True, host_import_qualified=True)
        for key, value in cases.items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                m.descriptor(self.identity, {**self.normal, key: value}, self.runtime, self.runtime)

    def test_descriptor_contract_refuses_extra_fields_and_overclaim(self):
        for key, value in dict(extra=True, host_import_qualified=True, deployment_authorized=True,
                               platform="linux/arm64", schema="v2", build_contract="v2").items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                m.validate_descriptor({**self.value, key: value}, self.expected)

    def test_expected_values_are_independent_and_exact(self):
        for key, value in dict(artifact_id="../2", artifact_digest="X" * 64, descriptor_sha256="0" * 63,
                               archive_bytes=True, archive_sha256="0" * 63).items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                m.validate_descriptor(self.value, {**self.expected, key: value})
        for key in self.identity:
            bad = copy.deepcopy(self.expected)
            bad["identity"][key] = "different"
            with self.subTest(identity=key), self.assertRaises(ValueError):
                m.validate_descriptor(self.value, bad)

    def test_changed_archive_is_a_hard_failure(self):
        (self.directory / "engine-image.tar").write_bytes(b"x" * 2048)
        with self.assertRaisesRegex(ValueError, "ARCHIVE_DIGEST"):
            m.validate_files(self.directory, self.expected)

    def test_changed_descriptor_is_a_hard_failure(self):
        (self.directory / "engine-image.json").write_bytes(m.encode({**self.value, "platform": "linux/arm64"}))
        with self.assertRaisesRegex(ValueError, "DESCRIPTOR_DIGEST"):
            m.validate_files(self.directory, self.expected)

    def test_missing_and_extra_bundle_files_refuse(self):
        (self.directory / "extra").write_text("not allowed")
        with self.assertRaisesRegex(ValueError, "BUNDLE_MEMBERS"):
            m.validate_files(self.directory, self.expected)
        (self.directory / "extra").unlink()
        (self.directory / "engine-image.tar").unlink()
        with self.assertRaisesRegex(ValueError, "BUNDLE_MEMBERS"):
            m.validate_files(self.directory, self.expected)

    def test_symlink_archive_and_descriptor_refuse(self):
        for name in ("engine-image.tar", "engine-image.json"):
            original = self.directory / name
            data = original.read_bytes()
            other = self.directory.parent / (self.directory.name + "-target")
            try:
                other.write_bytes(data)
                original.unlink()
                original.symlink_to(other)
                with self.subTest(name=name), self.assertRaises(OSError):
                    m.validate_files(self.directory, self.expected)
            finally:
                original.unlink(missing_ok=True)
                original.write_bytes(data)
                other.unlink(missing_ok=True)

    def test_fifo_and_oversized_file_refuse_before_read(self):
        path = self.directory / "fifo"
        os.mkfifo(path)
        with self.assertRaisesRegex(ValueError, "BOUNDED_REGULAR"):
            m.file_identity(path, 100)
        with self.assertRaisesRegex(ValueError, "BOUNDED_REGULAR"):
            m.file_identity(self.directory / "engine-image.tar", 1024)

    def test_duplicate_json_keys_refuse(self):
        with self.assertRaisesRegex(ValueError, "DUPLICATE_JSON_KEY"):
            m.decode(b'{"identity":{},"identity":{}}')

    def test_current_workflow_context_cannot_be_replayed(self):
        for key in self.environment:
            old = self.environment[key]
            self.environment[key] = "different"
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "CURRENT_WORKFLOW_CONTEXT"):
                self.metadata()
            self.environment[key] = old

    def test_other_repository_workflow_run_or_attempt_refuse(self):
        for key, value in dict(id=124, run_attempt=1, event="pull_request", path="other.yml",
                               head_sha="b" * 40, repository=dict(id=790), head_repository=dict(id=790),
                               status="queued", conclusion="failure").items():
            original = self.run[key]
            self.run[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "GITHUB_RUN"):
                self.metadata()
            self.run[key] = original
        self.repository["full_name"] = "Other/Repository"
        with self.assertRaisesRegex(ValueError, "GITHUB_REPOSITORY"):
            self.metadata()

    def test_only_matching_completed_successful_job_can_produce(self):
        for key, value in dict(id=0, name="Another Producer", run_id=124, head_sha="b" * 40,
                               status="in_progress", conclusion="skipped").items():
            original = self.jobs["jobs"][0][key]
            self.jobs["jobs"][0][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "GITHUB_PRODUCER"):
                self.metadata()
            self.jobs["jobs"][0][key] = original
        self.jobs["jobs"][0]["conclusion"] = "failure"
        with self.assertRaisesRegex(ValueError, "GITHUB_PRODUCER"):
            self.metadata()

    def test_incomplete_job_pages_and_duplicate_producer_refuse(self):
        self.jobs["total_count"] = 101
        with self.assertRaisesRegex(ValueError, "GITHUB_JOB_PAGE"):
            self.metadata()
        self.jobs["total_count"] = 2
        with self.assertRaisesRegex(ValueError, "GITHUB_JOB_PAGE"):
            self.metadata()
        self.jobs["jobs"].append(dict(self.jobs["jobs"][0]))
        with self.assertRaisesRegex(ValueError, "GITHUB_PRODUCER_UNIQUE"):
            self.metadata()

    def test_artifact_replacement_expiry_or_cross_run_refuse(self):
        for key, value in dict(id=457, name="engine-image-123-1", digest="sha256:" + "3" * 64,
                               expired=True).items():
            original = self.artifact[key]
            self.artifact[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "GITHUB_ARTIFACT"):
                self.metadata()
            self.artifact[key] = original
        for key, value in dict(id=124, head_sha="b" * 40, repository_id=790, head_repository_id=790).items():
            original = self.artifact["workflow_run"][key]
            self.artifact["workflow_run"][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "GITHUB_ARTIFACT"):
                self.metadata()
            self.artifact["workflow_run"][key] = original

    def test_finished_successful_run_allowed_but_incoherent_status_refused(self):
        self.run.update(status="completed", conclusion="success")
        self.assertEqual(self.metadata(), 999)
        for status, conclusion in [("completed", None), ("in_progress", "success"), ("completed", "cancelled")]:
            self.run.update(status=status, conclusion=conclusion)
            with self.subTest(status=status, conclusion=conclusion), self.assertRaisesRegex(ValueError, "GITHUB_RUN"):
                self.metadata()

    def cli_inputs(self):
        path = self.directory.parent / (self.directory.name + "-expected.json")
        path.write_bytes(m.encode(self.expected))
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        return ["engine-image-ci-bundle.py", "--directory", str(self.directory), "--expected", str(path)]

    def test_cli_requires_independent_metadata_and_emits_only_bounded_admission(self):
        output = io.StringIO()
        args = self.cli_inputs()
        with patch("sys.argv", args), patch.dict(os.environ, self.environment), \
                patch.object(m, "github_api", side_effect=[self.repository, self.run, self.artifact, self.jobs]) as api, \
                contextlib.redirect_stdout(output):
            m.main()
        record = json.loads(output.getvalue())
        self.assertEqual(record["status"], "passed")
        self.assertEqual(record["artifact_id"], "456")
        self.assertFalse(record["host_import_qualified"])
        self.assertFalse(record["deployment_authorized"])
        self.assertEqual(api.call_count, 4)

    def test_cli_rehashes_after_github_reads_before_admitting(self):
        args = self.cli_inputs()
        values = iter([self.repository, self.run, self.artifact, self.jobs])
        def reply(endpoint):
            value = next(values)
            if "/jobs?" in endpoint:
                (self.directory / "engine-image.tar").write_bytes(b"changed!" * 256)
            return value
        output = io.StringIO()
        with patch("sys.argv", args), patch.dict(os.environ, self.environment), \
                patch.object(m, "github_api", side_effect=reply), contextlib.redirect_stdout(output), \
                self.assertRaisesRegex(ValueError, "ARCHIVE_DIGEST"):
            m.main()
        self.assertEqual(output.getvalue(), "")

    def test_api_call_uses_fixed_public_host_and_no_mutation(self):
        response = type("Result", (), {"returncode": 0, "stdout": b'{"ok":true}'})()
        with patch.object(m.subprocess, "run", return_value=response) as run, patch.dict(os.environ, {"GH_HOST": "evil.invalid"}):
            self.assertEqual(m.github_api("repos/" + m.REPOSITORY), {"ok": True})
        args = run.call_args.args[0]
        self.assertEqual(args[:6], ["gh", "api", "--hostname", "github.com", "--method", "GET"])
        self.assertEqual(run.call_args.kwargs["env"]["GH_HOST"], "github.com")
        self.assertEqual(run.call_args.kwargs["timeout"], 30)

    def test_api_unexpected_response_shape_refuses(self):
        response = type("Result", (), {"returncode": 0, "stdout": b'[]'})()
        with patch.object(m.subprocess, "run", return_value=response), self.assertRaisesRegex(ValueError, "GITHUB_OBJECT"):
            m.github_api("repos/" + m.REPOSITORY)

    def test_api_exact_commit_and_ancestry_routes_reach_readonly_transport(self):
        prefix='repos/'+m.REPOSITORY
        endpoints=[prefix+'/git/commits/'+'a'*40,
                   prefix+'/compare/'+'a'*40+'...'+'b'*40+'?per_page=1&page=1']
        response=type('Result',(),{'returncode':0,'stdout':b'{"ok":true}'})()
        for endpoint in endpoints:
            with self.subTest(endpoint=endpoint),patch.object(m.subprocess,'run',return_value=response) as run:
                self.assertEqual(m.github_api(endpoint),{'ok':True})
                self.assertEqual(run.call_args.args[0],['gh','api','--hostname','github.com','--method','GET',endpoint])
                self.assertEqual(run.call_args.kwargs['timeout'],30)

    def test_api_ancestry_routes_refuse_foreign_partial_or_extra_queries(self):
        prefix='repos/'+m.REPOSITORY
        endpoints=[prefix+'/git/commits/'+'a'*39,prefix+'/git/commits/'+'A'*40,
            prefix+'/git/commits/'+'a'*40+'?extra=1',
            prefix+'/compare/'+'a'*40+'...'+'b'*40,
            prefix+'/compare/'+'a'*40+'...'+'b'*40+'?per_page=100&page=1',
            prefix+'/compare/'+'a'*40+'...'+'b'*40+'?per_page=1&page=1&extra=1',
            prefix+'/compare/main...HEAD?per_page=1&page=1',
            'repos/Other/Repository/git/commits/'+'a'*40,
            'https://api.github.com/'+prefix+'/git/commits/'+'a'*40]
        with patch.object(m.subprocess,'run') as run:
            for endpoint in endpoints:
                with self.subTest(endpoint=endpoint),self.assertRaisesRegex(ValueError,'GITHUB_ENDPOINT'):
                    m.github_api(endpoint)
            run.assert_not_called()

    def test_api_errors_and_foreign_endpoint_refuse(self):
        with patch.object(m.subprocess, "run", return_value=type("Result", (), {"returncode": 1, "stdout": b''})()):
            with self.assertRaisesRegex(ValueError, "GITHUB_READ"):
                m.github_api("repos/" + m.REPOSITORY)
        with self.assertRaisesRegex(ValueError, "GITHUB_ENDPOINT"):
            m.github_api("repos/Other/Repository")


if __name__ == "__main__":
    unittest.main(verbosity=2)
