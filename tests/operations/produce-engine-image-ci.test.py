"""Portable producer orchestration and real source extraction; no Docker/install."""
import copy
import contextlib
import subprocess
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
producer = load("producer", ROOT / "server/scripts/produce-engine-image-ci.py")
bundle = load("bundle", Path(os.environ.get("ENGINE_CI_BUNDLE_SUBJECT", ROOT / "server/scripts/engine-image-ci-bundle.py")))


class ProducerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("ENGINE_CI_WIRING_TEST_TMP"))
        self.root = Path(self.temp.name)
        self.target, self.control, self.tree = "a" * 40, "b" * 40, "c" * 40
        self.env = dict(GITHUB_ACTIONS="true", GITHUB_EVENT_NAME="repository_dispatch", GITHUB_REPOSITORY=producer.REPOSITORY,
                        GITHUB_SHA=self.control, GITHUB_RUN_ID="123", GITHUB_RUN_ATTEMPT="2", RUNNER_TEMP=str(self.root))
        self.destination = self.root / "engine-image-123-2"
        self.evidence = self.root / "engine-image-evidence-123-2"
        self.commands = []

    def tearDown(self):
        self.temp.cleanup()

    def archive(self, path, *, extra=None, missing=None):
        entries = {name: b"{}\n" for name in ("package.json", "package-lock.json", "tsconfig.json", "tsconfig.runtime.json")}
        entries.update({"Dockerfile": b"FROM scratch\n", "src/index.ts": b"export const x = true;\n"})
        if missing:
            del entries[missing]
        with tarfile.open(path, "w", format=tarfile.USTAR_FORMAT) as stream:
            for name, raw in entries.items():
                item = tarfile.TarInfo(name)
                item.size = len(raw)
                stream.addfile(item, io.BytesIO(raw))
            if extra is not None:
                stream.addfile(extra, io.BytesIO(b"x" * extra.size) if extra.isfile() else None)

    def fake_command(self, args, **kwargs):
        self.commands.append((args, kwargs))
        if args[:3] == ["git", "rev-parse", "HEAD"]:
            return self.control
        if args[:3] == ["git", "rev-parse", "--verify"]:
            return self.target
        if args[:3] == ["git", "rev-parse", "origin/main"]:
            return self.control
        if args[:2] == ["git", "rev-parse"]:
            return self.tree
        if args[:2] == ["git", "log"]:
            return self.target
        if args[:2] == ["git", "archive"]:
            self.archive(Path(next(value for value in args if value.startswith("--output=")).split("=", 1)[1]))
        if args[:3] == ["npm", "run", "build"]:
            output = Path(kwargs["cwd"]) / "dist"
            output.mkdir()
            (output / "index.js").write_text("export const x = true;\n")
        return ""

    def proof(self, mode="success"):
        def main(**kwargs):
            reference = kwargs["reference_directory"]
            data = bytes(2048)
            archive = kwargs["temporary_root"] / "normalized.tar"
            archive.write_bytes(data)
            normalization = dict(version=1, scope="engine-image-archive-normalization", image_id="sha256:" + "d" * 64,
                                 source_sha=self.target, server_tree=self.tree, build_contract=bundle.CONTRACT,
                                 input_sha256="1" * 64, archive_sha256=hashlib.sha256(data).hexdigest(),
                                 archive_bytes=len(data), layers=1, platform="linux/amd64",
                                 producer_authenticated=False, host_import_qualified=False)
            kwargs["image_ready"](archive, normalization, reference, reference)
            if mode == "exception_after_callback":
                raise RuntimeError("simulated native cleanup failure")
            if mode == "double_callback":
                kwargs["image_ready"](archive, normalization, reference, reference)
            receipt = dict(status="passed", source_sha=self.target, production_certificate=False,
                           neighbor_alive_before_cleanup=True, sentinel_unchanged=True,
                           cleanup={"owned-" + str(index): True for index in range(9)}, cleanup_errors=[],
                           isolated_native_import=dict(status="passed", cases={key: {} for key in
                               ("success", "image_identity", "runtime_bytes", "external_cancellation")},
                               production_host_import_qualified=False),
                           fault_exit_code=1, events_before=dict(oom_kill=0), events_after=dict(oom_kill=1),
                           image_id=normalization["image_id"], archive_normalization=normalization,
                           typechecked_runtime_files_matched=1)
            for key in ("wrapper_failure", "wrapper_cancellation", "wrapper_parent_cancellation"):
                receipt[key] = dict(exit_code=143)
            if mode == "late_neighbor_loss":
                receipt["neighbor_alive_before_cleanup"] = False
            elif mode == "missing_cleanup":
                receipt["cleanup"] = {}
            elif mode == "failed_cleanup":
                receipt["cleanup"]["owned-0"] = False
            elif mode == "cleanup_errors":
                receipt["cleanup_errors"] = [{"stage": "timeout"}]
            elif mode == "failed_matrix":
                receipt["isolated_native_import"]["status"] = "failed"
            elif mode == "missing_fault":
                del receipt["isolated_native_import"]["cases"]["external_cancellation"]
            elif mode == "wrong_source":
                receipt["source_sha"] = "0" * 40
            elif mode == "no_oom":
                receipt["events_after"]["oom_kill"] = 0
            elif mode == "failed_status":
                receipt["status"] = "failed"
            elif mode == "wrong_image":
                receipt["image_id"] = "sha256:" + "e" * 64
            elif mode == "wrong_count":
                receipt["typechecked_runtime_files_matched"] = 2
            return receipt
        return types.SimpleNamespace(main=main)

    def produce(self, mode="success", **kwargs):
        return producer.produce(self.target, self.destination, self.evidence, environment=self.env,
                                platform="linux", run=self.fake_command, proof_module=self.proof(mode), bundle_module=bundle, **kwargs)

    def test_complete_proof_then_outputs_and_reference_cleanup(self):
        result = self.produce()
        self.assertEqual(result["identity"]["source_sha"], self.target)
        self.assertEqual(set(p.name for p in self.destination.iterdir()), {"engine-image.tar", "engine-image.json"})
        receipt = json.loads((self.evidence / "producer-receipt.json").read_text())
        self.assertEqual(receipt["status"], "passed")
        self.assertTrue(receipt["owned_reference_source_removed"])
        self.assertFalse(receipt["host_import_qualified"])
        self.assertEqual(list(self.root.glob("engine-image-source-*")), [])
        self.assertEqual(sum(args[:2] == ["npm", "ci"] for args, _ in self.commands), 1)
        self.assertEqual(sum(args[:3] == ["npm", "run", "build"] for args, _ in self.commands), 1)
        for args, kwargs in self.commands:
            self.assertEqual(kwargs["environment"]["GIT_NO_REPLACE_OBJECTS"], "1")

    def test_native_exception_after_packaging_never_promotes_artifact(self):
        with self.assertRaisesRegex(RuntimeError, "simulated native cleanup"):
            self.produce("exception_after_callback")
        self.assertFalse(self.destination.exists())
        self.assertEqual(json.loads((self.evidence / "producer-receipt.json").read_text())["status"], "failed")

    def test_failed_final_verdicts_cannot_upload_provisional_bundle(self):
        modes = ("late_neighbor_loss", "missing_cleanup", "failed_cleanup", "cleanup_errors", "failed_matrix",
                 "missing_fault", "wrong_source", "no_oom", "failed_status", "wrong_image", "wrong_count", "double_callback")
        for mode in modes:
            with self.subTest(mode=mode):
                self.evidence = self.root / "engine-image-evidence-123-2"
                with self.assertRaises(RuntimeError):
                    self.produce(mode)
                self.assertFalse(self.destination.exists())
                self.assertEqual(json.loads((self.evidence / "producer-receipt.json").read_text())["status"], "failed")
                # The test owns this failed diagnostic directory, not production data.
                for file in self.evidence.iterdir():
                    file.unlink()
                self.evidence.rmdir()

    def test_mac_and_non_dispatch_invocations_refuse_before_any_command(self):
        with self.assertRaisesRegex(RuntimeError, "DISPOSABLE_CI"):
            producer.produce(self.target, self.destination, self.evidence, environment=self.env, platform="darwin", run=self.fake_command)
        self.env["GITHUB_EVENT_NAME"] = "pull_request"
        with self.assertRaisesRegex(RuntimeError, "RELEASE_CONTEXT"):
            self.produce()
        self.assertEqual(self.commands, [])
        self.assertFalse(self.evidence.exists())

    def test_existing_output_or_unowned_paths_refuse(self):
        self.destination.mkdir()
        (self.destination / "keep").write_text("existing owner")
        with self.assertRaisesRegex(RuntimeError, "OWNED_BUNDLE"):
            self.produce()
        self.assertEqual((self.destination / "keep").read_text(), "existing owner")
        self.assertEqual(self.commands, [])

    def test_uncontained_git_target_refuses_before_reference_install(self):
        real = self.fake_command
        def uncontained(args, **kwargs):
            if args[:4] == ["git", "merge-base", "--is-ancestor", self.target]:
                raise RuntimeError("ENGINE_CI_PRODUCER_COMMAND_FAILED")
            return real(args, **kwargs)
        with self.assertRaisesRegex(RuntimeError, "COMMAND_FAILED"):
            producer.produce(self.target, self.destination, self.evidence, environment=self.env,
                             platform="linux", run=uncontained, proof_module=self.proof(), bundle_module=bundle)
        self.assertFalse(any(args[0] == "npm" for args, _ in self.commands))
        self.assertFalse(self.destination.exists())

    def test_control_checkout_cannot_drift(self):
        identity = producer.context(self.target, self.env, "linux")
        with self.assertRaisesRegex(RuntimeError, "CONTROL_CHECKOUT"):
            producer.verify_git_source(identity, lambda args, **kwargs: "0" * 40)

    def test_exact_reference_archive_extraction(self):
        archive, target = self.root / "server.tar", self.root / "reference"
        self.archive(archive)
        producer.extract_reference(archive, target)
        self.assertEqual((target / "src/index.ts").read_text(), "export const x = true;\n")

    def test_reference_archive_rejects_traversal_symlink_and_forbidden_payload(self):
        for index, name in enumerate(("../escape", "src/link", "node_modules/evil.js", ".env", "dist/index.js")):
            item = tarfile.TarInfo(name)
            if name == "src/link":
                item.type, item.linkname = tarfile.SYMTYPE, "/etc/passwd"
            else:
                item.size = 1
            archive = self.root / f"server-{index}.tar"
            self.archive(archive, extra=item)
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                producer.extract_reference(archive, self.root / f"reference-{index}")
        self.assertFalse((self.root.parent / "escape").exists())

    def test_reference_archive_requires_original_project_files(self):
        archive = self.root / "server.tar"
        self.archive(archive, missing="tsconfig.runtime.json")
        with self.assertRaisesRegex(RuntimeError, "SOURCE_REQUIRED"):
            producer.extract_reference(archive, self.root / "reference")

    def test_reference_cleanup_exception_never_leaves_passed_receipt(self):
        original = tempfile.TemporaryDirectory
        class BrokenCleanup:
            def __init__(self, *args, **kwargs):
                self.inner = original(*args, **kwargs)
            def __enter__(self):
                return self.inner.__enter__()
            def __exit__(self, *args):
                self.inner.__exit__(*args)
                raise OSError("simulated late source cleanup failure")
        with patch.object(producer.tempfile, "TemporaryDirectory", BrokenCleanup), self.assertRaises(OSError):
            self.produce()
        receipt = json.loads((self.evidence / "producer-receipt.json").read_text())
        self.assertEqual(receipt["status"], "failed")


class ResourceBridgeTests(unittest.TestCase):
    def exercise(self, *, callback_failure=False, cleanup_failure=False, native_failure=False):
        proof = load("resource_bridge_subject", ROOT / "tests/operations/engine-build-resource-proof.py")
        with tempfile.TemporaryDirectory(dir=os.environ.get("ENGINE_CI_WIRING_TEST_TMP")) as temporary:
            temporary = Path(temporary)
            reference, evidence = temporary / "reference", temporary / "evidence"
            reference.mkdir()
            (reference / "index.js").write_text("actual reference\n")
            seen, events = [], iter((dict(oom_kill=0), dict(oom_kill=1)))
            def run(args, **options):
                rc, output = 0, ""
                if args[0] == "bash":
                    Path(options["env"]["ENGINE_BUILD_CONTEXT_ROOT"]).mkdir()
                    output = "ENGINE_BUILD_MEMORY_PEAK_BYTES=1048576\n"
                elif args[:2] == ["git", "rev-parse"]:
                    output = "c" * 40
                elif args[:2] == ["docker", "cp"]:
                    Path(args[-1]).mkdir()
                    Path(args[-1], "index.js").write_text("actual reference\n")
                elif args[:3] == ["docker", "image", "save"]:
                    Path(args[4]).write_bytes(bytes(2048))
                elif args[:3] == ["docker", "buildx", "build"]:
                    rc = 1
                elif args[:3] == ["docker", "image", "inspect"]:
                    rc = 1
                return subprocess.CompletedProcess(args, rc, output)
            def inspect(name):
                return dict(Id="sha256:" + "d" * 64, State=dict(Running=name != proof.CONTAINER, StartedAt="birth"), RestartCount=0)
            def counter(name):
                if name == "memory.events": return next(events)
                return {"memory.max": str(proof.LIMIT), "memory.swap.max": "0", "cpu.max": "100000 100000",
                        "memory.peak": str(proof.LIMIT)}[name]
            def normalize(raw, target, **identity):
                target.write_bytes(raw.read_bytes())
                return dict(source_sha=identity["source_sha"], server_tree=identity["server_tree"], image_id=identity["image_id"])
            def native(*args):
                if native_failure: raise RuntimeError("native matrix failed")
                return {"status": "passed"}
            modules = iter((types.SimpleNamespace(normalize_engine_archive=normalize), types.SimpleNamespace(prove_import_matrix=native)))
            def spec(*args): return types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda m: None))
            def callback(*args):
                seen.append("callback")
                self.assertTrue(args[0].is_file())
                self.assertEqual(args[2], reference)
                if callback_failure: raise RuntimeError("callback failed")
            def cleanup(receipt, *args):
                seen.append("cleanup")
                receipt.update(neighbor_alive_before_cleanup=not cleanup_failure,
                               cleanup={str(n): not cleanup_failure for n in range(9)}, cleanup_errors=[])
                if cleanup_failure: receipt["status"] = "failed"
                return not cleanup_failure
            with patch.object(proof.sys, "platform", "linux"), patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
                    patch.object(proof, "run", side_effect=run), patch.object(proof, "inspect", side_effect=inspect), \
                    patch.object(proof, "counter", side_effect=counter), patch.object(proof, "wrapper_fault", return_value={"exit_code": 143}), \
                    patch.object(proof, "cleanup_resources", side_effect=cleanup), \
                    patch.object(proof.importlib.util, "spec_from_file_location", side_effect=spec), \
                    patch.object(proof.importlib.util, "module_from_spec", side_effect=lambda spec: next(modules)), \
                    contextlib.redirect_stdout(io.StringIO()):
                error, result = None, None
                try:
                    result = proof.main(target_sha="a" * 40, reference_directory=reference,
                                        evidence_directory=evidence, temporary_root=temporary, image_ready=callback)
                except RuntimeError as caught:
                    error = caught
            return seen, result, error, json.loads((evidence / "receipt.json").read_text())

    def test_actual_resource_runner_returns_only_after_final_cleanup(self):
        seen, result, error, receipt = self.exercise()
        self.assertIsNone(error)
        self.assertEqual(seen, ["callback", "cleanup"])
        self.assertEqual(result["status"], "passed")
        self.assertEqual(receipt["status"], "passed")

    def test_actual_resource_runner_keeps_callback_native_and_cleanup_failures_failed(self):
        for options in ({"callback_failure": True}, {"cleanup_failure": True}, {"native_failure": True}):
            with self.subTest(options=options):
                seen, result, error, receipt = self.exercise(**options)
                self.assertIsNotNone(error)
                self.assertIsNone(result)
                self.assertEqual(seen[-1], "cleanup")
                self.assertEqual(receipt["status"], "failed")
                if options.get("native_failure"):
                    self.assertNotIn("callback", seen)


if __name__ == "__main__":
    unittest.main(verbosity=2)
