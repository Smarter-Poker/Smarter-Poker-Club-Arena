#!/usr/bin/env python3
"""Build and qualify one exact engine image on a disposable Actions runner.

No host SSH or import is owned here. A provisional bundle becomes uploadable
only after the enclosing native proof returns with its final cleanup verdict.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = "Smarter-Poker/Smarter-Poker-Club-Arena"
WORKFLOW = ".github/workflows/auto-deploy-hetzner.yml"
SOURCE_LIMIT = 512 * 1024 * 1024
SOURCE_FILE_LIMIT = 64 * 1024 * 1024
SOURCE_COUNT_LIMIT = 20000


def require(ok, reason):
    if not ok:
        raise RuntimeError("ENGINE_CI_PRODUCER_" + reason)


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def command(args, *, cwd=ROOT, timeout=120, output=None, environment=None):
    result = subprocess.run(args, cwd=cwd, env=environment, capture_output=True, timeout=timeout)
    if output is not None:
        Path(output).write_bytes(result.stdout + result.stderr)
    require(result.returncode == 0, "COMMAND_FAILED")
    return result.stdout.decode().strip()


def context(target, environment, platform):
    require(platform == "linux" and environment.get("GITHUB_ACTIONS") == "true", "DISPOSABLE_CI_REQUIRED")
    require(environment.get("GITHUB_REPOSITORY") == REPOSITORY and
            environment.get("GITHUB_EVENT_NAME") == "repository_dispatch", "RELEASE_CONTEXT_REQUIRED")
    control = environment.get("GITHUB_SHA", "")
    run_id, attempt = environment.get("GITHUB_RUN_ID", ""), environment.get("GITHUB_RUN_ATTEMPT", "")
    require(all(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value)
                for value in (target, control)), "SOURCE_IDENTITY")
    require(all(re.fullmatch(r"[1-9][0-9]{0,19}", value) for value in (run_id, attempt)), "RUN_IDENTITY")
    return {"repository": REPOSITORY, "workflow": WORKFLOW, "workflow_control_sha": control,
            "source_sha": target, "run_id": run_id, "run_attempt": attempt}


def verify_git_source(identity, run=command):
    require(run(["git", "rev-parse", "HEAD"]) == identity["workflow_control_sha"], "CONTROL_CHECKOUT")
    require(run(["git", "rev-parse", "--verify", identity["source_sha"] + "^{commit}"]) ==
            identity["source_sha"], "EXACT_TARGET")
    run(["git", "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], timeout=120)
    current = run(["git", "rev-parse", "origin/main"])
    for sha in (identity["source_sha"], identity["workflow_control_sha"]):
        run(["git", "merge-base", "--is-ancestor", sha, current])
    # This is the immutable admitted target, not a moving selection of main.
    # Both source and executor must remain in protected history. The host's
    # sealed high-water check separately prevents an actual backward cutover.
    # A later merge must not starve an already tested forward release here.
    tree = run(["git", "rev-parse", identity["source_sha"] + ":server"])
    require(re.fullmatch(r"[0-9a-f]{40}", tree) is not None, "SERVER_TREE")
    return tree


def extract_reference(archive, destination):
    """Extract only bounded regular Git archive files into a new owned root."""
    archive, destination = Path(archive), Path(destination)
    require(archive.is_absolute() and destination.is_absolute(), "REFERENCE_PATHS")
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and 1024 <= before.st_size <= SOURCE_LIMIT, "REFERENCE_ARCHIVE")
        destination.mkdir(mode=0o700, exist_ok=False)
        with os.fdopen(fd, "rb", closefd=False) as stream, tarfile.open(fileobj=stream, mode="r:") as source:
            members, total = [], 0
            names = set()
            for entry in source:
                require(len(members) < SOURCE_COUNT_LIMIT, "SOURCE_COUNT")
                name = entry.name.rstrip("/")
                parts = name.split("/")
                require(isinstance(name, str) and 0 < len(name) <= 512 and
                        re.fullmatch(r"[A-Za-z0-9_./+@-]+", name) is not None and
                        all(part not in {"", ".", ".."} for part in parts) and name not in names,
                        "SOURCE_PATH")
                require(entry.isdir() or entry.isreg(), "SOURCE_TYPE")
                require(0 <= entry.size <= SOURCE_FILE_LIMIT and (not entry.isdir() or entry.size == 0), "SOURCE_SIZE")
                total += entry.size
                require(total <= SOURCE_LIMIT, "SOURCE_TOTAL")
                require(parts[0] not in {".env", ".git", "node_modules", "dist"}, "FORBIDDEN_SOURCE")
                members.append(entry)
                names.add(name)
            for entry in members:
                target = destination / entry.name
                if entry.isdir():
                    target.mkdir(mode=0o700, parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with source.extractfile(entry) as original, target.open("xb") as output:
                    remaining = entry.size
                    while remaining:
                        chunk = original.read(min(1024 * 1024, remaining))
                        require(chunk, "TRUNCATED_SOURCE")
                        output.write(chunk)
                        remaining -= len(chunk)
        after = os.fstat(fd)
        require(all(getattr(before, key) == getattr(after, key)
                    for key in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")), "SOURCE_CHANGED")
    finally:
        os.close(fd)
    require(all((destination / name).is_file() for name in
                ("package.json", "package-lock.json", "tsconfig.json", "tsconfig.runtime.json", "Dockerfile"))
            and (destination / "src").is_dir(), "SOURCE_REQUIRED_FILES")


def assert_final_proof(receipt, identity):
    require(isinstance(receipt, dict) and receipt.get("status") == "passed" and
            receipt.get("source_sha") == identity["source_sha"] and
            receipt.get("production_certificate") is False and
            receipt.get("neighbor_alive_before_cleanup") is True and receipt.get("sentinel_unchanged") is True,
            "FINAL_PROOF")
    cleanup = receipt.get("cleanup")
    require(isinstance(cleanup, dict) and len(cleanup) >= 9 and
            all(value is True for value in cleanup.values()) and receipt.get("cleanup_errors") == [],
            "FINAL_CLEANUP")
    native = receipt.get("isolated_native_import")
    require(isinstance(native, dict) and native.get("status") == "passed" and
            set(native.get("cases", {})) == {"success", "image_identity", "runtime_bytes", "external_cancellation"}
            and native.get("production_host_import_qualified") is False,
            "NATIVE_MATRIX")
    require(type(receipt.get("fault_exit_code")) is int and receipt["fault_exit_code"] != 0 and
            receipt["events_after"]["oom_kill"] > receipt["events_before"]["oom_kill"], "CONTAINED_OOM")
    for key in ("wrapper_failure", "wrapper_cancellation", "wrapper_parent_cancellation"):
        value = receipt.get(key)
        require(isinstance(value, dict) and type(value.get("exit_code")) is int and value["exit_code"] != 0,
                "WRAPPER_FAULTS")


def verify_provisional_files(directory, expected, bundle_module):
    # Artifact IDs do not exist before upload. This is only local byte custody,
    # not the later authenticated GitHub producer/artifact admission.
    require({path.name for path in directory.iterdir()} == {"engine-image.tar", "engine-image.json"},
            "PROVISIONAL_MEMBERS")
    bundle_module.check_identity(expected["identity"])
    archive = bundle_module.file_identity(directory / "engine-image.tar", bundle_module.ARCHIVE_LIMIT)
    descriptor = bundle_module.file_identity(directory / "engine-image.json", bundle_module.DESCRIPTOR_LIMIT)
    require(archive == {"sha256": expected["archive_sha256"], "bytes": expected["archive_bytes"]} and
            descriptor["sha256"] == expected["descriptor_sha256"], "PROVISIONAL_BYTES")


def promote_bundle(staging, destination, expected, bundle_module):
    # No file from a failed native proof reaches this function. The destination
    # is newly claimed and contains only two explicitly hardlinked regular files.
    verify_provisional_files(staging, expected, bundle_module)
    destination.mkdir(mode=0o700, exist_ok=False)
    for name in ("engine-image.tar", "engine-image.json"):
        os.link(staging / name, destination / name, follow_symlinks=False)
    verify_provisional_files(destination, expected, bundle_module)
    fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def produce(target, destination, evidence, *, environment=None, platform=None,
            run=command, proof_module=None, bundle_module=None, profile="production"):
    require(profile in {"production", "qualification"}, "PROFILE")
    environment = dict(os.environ if environment is None else environment)
    selected_context, selected_source = context, verify_git_source
    if profile == "qualification":
        qualification = module("engine_ci_qualification", ROOT / "server/scripts/engine-image-ci-qualification.py")
        selected_context, selected_source = qualification.context, qualification.verify_git_source
        require(bundle_module is None, "QUALIFICATION_BUNDLE_PROFILE")
        bundle_module = qualification
    identity = selected_context(target, environment, sys.platform if platform is None else platform)
    output_prefix = "engine-image-qualification" if profile == "qualification" else "engine-image"
    evidence_prefix = "engine-image-qualification-evidence" if profile == "qualification" else "engine-image-evidence"
    destination, evidence = Path(destination), Path(evidence)
    runner_temp = Path(environment.get("RUNNER_TEMP", ""))
    require(runner_temp.is_absolute() and runner_temp.is_dir() and not runner_temp.is_symlink(), "RUNNER_TEMP")
    require(destination.is_absolute() and destination.parent.resolve() == runner_temp.resolve() and
            destination.name == f"{output_prefix}-{identity['run_id']}-{identity['run_attempt']}" and
            not destination.exists() and not destination.is_symlink(), "OWNED_BUNDLE_DESTINATION")
    require(evidence.is_absolute() and evidence.parent.resolve() == runner_temp.resolve() and
            evidence.name == f"{evidence_prefix}-{identity['run_id']}-{identity['run_attempt']}" and
            not evidence.exists() and not evidence.is_symlink(), "OWNED_EVIDENCE_DESTINATION")
    evidence.mkdir(mode=0o700)
    # Neither Git replacement refs nor a mutable worktree may redefine source.
    environment["GIT_NO_REPLACE_OBJECTS"] = "1"
    def git_run(args, **options):
        return run(args, environment=environment, **options)
    audit = {"scope": "engine-ci-image-producer", "profile": profile, "status": "failed", "identity": dict(identity),
             "host_import_qualified": False, "deployment_authorized": False}
    try:
        identity["server_tree"] = selected_source(identity, git_run)
        bundle_module = bundle_module or module("engine_ci_bundle", ROOT / "server/scripts/engine-image-ci-bundle.py")
        proof_module = proof_module or module("engine_native_build_proof", ROOT / "tests/operations/engine-build-resource-proof.py")
        with tempfile.TemporaryDirectory(prefix="engine-image-source-", dir=runner_temp) as temporary:
            temporary = Path(temporary)
            source_tar, reference = temporary / "server.tar", temporary / "server"
            git_run(["git", "archive", "--format=tar", "--output=" + str(source_tar), identity["server_tree"]])
            extract_reference(source_tar, reference)
            git_run(["npm", "ci", "--no-audit", "--no-fund"], cwd=reference, timeout=600,
                    output=evidence / "reference-install.log")
            git_run(["npm", "run", "build", "--", "--project", "tsconfig.runtime.json"], cwd=reference,
                    timeout=600, output=evidence / "reference-typecheck.log")
            provisional = temporary / "bundle"
            outputs = None
            def image_ready(archive, normalization, reference_directory, image_directory):
                nonlocal outputs
                require(outputs is None, "DUPLICATE_IMAGE_CALLBACK")
                complete_identity = {**identity, "image_id": normalization["image_id"]}
                outputs = bundle_module.write_bundle(provisional, archive, complete_identity, normalization,
                                                      reference_directory, image_directory)
            receipt = proof_module.main(target_sha=target, reference_directory=reference / "dist",
                                        evidence_directory=evidence / "native", temporary_root=temporary,
                                        image_ready=image_ready)
            assert_final_proof(receipt, identity)
            require(outputs is not None, "MISSING_IMAGE_CALLBACK")
            require(outputs["identity"]["image_id"] == receipt["image_id"] and
                    outputs["archive_sha256"] == receipt["archive_normalization"]["archive_sha256"] and
                    outputs["archive_bytes"] == receipt["archive_normalization"]["archive_bytes"] and
                    outputs["typechecked_runtime_files_matched"] == receipt["typechecked_runtime_files_matched"],
                    "FINAL_IMAGE_IDENTITY")
            expected = {key: outputs[key] for key in
                        ("identity", "archive_sha256", "archive_bytes", "descriptor_sha256")}
            promote_bundle(provisional, destination, expected, bundle_module)
            audit.update(identity=outputs["identity"], bundle=expected,
                         typechecked_runtime_files_matched=outputs["typechecked_runtime_files_matched"])
        # This point is after the reference tree, npm dependencies and source
        # archive were removed, as well as all native resource cleanup.
        audit["owned_reference_source_removed"] = not temporary.exists()
        require(audit["owned_reference_source_removed"], "REFERENCE_CLEANUP")
        audit["status"] = "passed"
        return expected
    except BaseException as error:
        audit["status"] = "failed"
        audit["failure_type"] = type(error).__name__
        raise
    finally:
        (evidence / "producer-receipt.json").write_text(json.dumps(audit, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("production", "qualification"), default="production")
    parser.add_argument("--target-sha", required=True)
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()
    result = produce(args.target_sha, args.bundle, args.evidence, profile=args.profile)
    outputs = Path(os.environ["GITHUB_OUTPUT"])
    with outputs.open("a") as stream:
        for name in ("archive_sha256", "archive_bytes", "descriptor_sha256"):
            stream.write(f"{name}={result[name]}\n")
        for name in ("source_sha", "server_tree", "image_id"):
            stream.write(f"{name}={result['identity'][name]}\n")
        stream.write("identity_json=" + json.dumps(result["identity"], separators=(",", ":")) + "\n")
    print(json.dumps({"scope": "engine-ci-image-producer", "profile": args.profile, "status": "passed", **result,
                      "host_import_qualified": False, "deployment_authorized": False}))


if __name__ == "__main__":
    main()
