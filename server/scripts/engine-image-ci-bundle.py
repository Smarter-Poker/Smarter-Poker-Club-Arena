#!/usr/bin/env python3
"""Bind an engine archive to an exact same-run CI producer; never load an image.

Expected values must come from the current workflow's successful producer job
outputs. A descriptor downloaded alongside an archive is not its own authority.
This module deliberately owns no host transport, deployment or Docker command.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

REPOSITORY = "Smarter-Poker/Smarter-Poker-Club-Arena"
WORKFLOW = ".github/workflows/auto-deploy-hetzner.yml"
PRODUCER_JOB = "Produce The Exact Engine Image In CI"
CONTRACT = "clean-server-archive-v1"
ARCHIVE_LIMIT = 2 * 1024 * 1024 * 1024
DESCRIPTOR_LIMIT = 2 * 1024 * 1024
RUNTIME_LIMIT = 20000


def require(ok, reason):
    if not ok:
        raise ValueError("ENGINE_CI_IMAGE_" + reason)


def exact_keys(value, keys, reason):
    require(isinstance(value, dict) and set(value) == set(keys), reason)


def hex_value(value, count):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{" + str(count) + "}", value) is not None


def positive(value):
    return isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,19}", value) is not None


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def decode(raw):
    return json.loads(raw, object_pairs_hook=unique_object)


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def read_regular(path, maximum, *, retain=False):
    """Hold one bounded regular inode; detect edits before returning its hash."""
    path = Path(path)
    require(path.is_absolute(), "ABSOLUTE_PATH")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= maximum,
                "BOUNDED_REGULAR_FILE")
        digest = hashlib.sha256()
        chunks = []
        with os.fdopen(fd, "rb", closefd=False) as stream:
            total = 0
            while chunk := stream.read(1024 * 1024):
                total += len(chunk)
                require(total <= maximum, "FILE_GREW")
                digest.update(chunk)
                if retain:
                    chunks.append(chunk)
        after = os.fstat(fd)
        fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
        require(total == before.st_size and all(getattr(before, key) == getattr(after, key)
                                               for key in fields), "FILE_CHANGED")
        named = path.lstat()
        require(stat.S_ISREG(named.st_mode) and (named.st_dev, named.st_ino) ==
                (after.st_dev, after.st_ino), "FILE_REPLACED")
        return {"sha256": digest.hexdigest(), "bytes": total}, b"".join(chunks)
    finally:
        os.close(fd)


def file_identity(path, maximum):
    return read_regular(path, maximum)[0]


def check_runtime(runtime):
    require(isinstance(runtime, dict) and 0 < len(runtime) <= RUNTIME_LIMIT, "RUNTIME_COUNT")
    for name, digest in runtime.items():
        require(isinstance(name, str) and len(name) <= 512 and
                re.fullmatch(r"[A-Za-z0-9_./-]+", name) is not None and
                all(part not in {"", ".", "..", "__tests__"} for part in name.split("/")) and
                not name.endswith((".test.js", ".spec.js", ".d.ts", ".d.ts.map", ".tsbuildinfo")) and
                hex_value(digest, 64), "RUNTIME_ENTRY")


def check_identity(identity):
    exact_keys(identity, ("repository", "workflow", "workflow_control_sha", "source_sha",
                          "server_tree", "run_id", "run_attempt", "image_id"), "IDENTITY_SHAPE")
    require(identity["repository"] == REPOSITORY and identity["workflow"] == WORKFLOW,
            "PRODUCER_REPOSITORY_WORKFLOW")
    require(all(hex_value(identity[key], 40) for key in
                ("workflow_control_sha", "source_sha", "server_tree")), "SOURCE_IDENTITY")
    require(positive(identity["run_id"]) and positive(identity["run_attempt"]), "RUN_IDENTITY")
    require(isinstance(identity["image_id"], str) and
            re.fullmatch(r"sha256:[0-9a-f]{64}", identity["image_id"]) is not None,
            "IMAGE_IDENTITY")


def descriptor(identity, normalization, runtime_hashes, reference_hashes):
    """Create only after the caller's actual image/reference comparison passed.

    normalize_engine_archive supplies normalization. This function validates
    its exact contract but does not manufacture a build or native proof.
    """
    check_identity(identity)
    check_runtime(runtime_hashes)
    check_runtime(reference_hashes)
    require(runtime_hashes == reference_hashes, "REFERENCE_RUNTIME_MISMATCH")
    exact_keys(normalization, ("version", "scope", "image_id", "source_sha", "server_tree",
                              "build_contract", "input_sha256", "archive_sha256", "archive_bytes",
                              "layers", "platform", "producer_authenticated", "host_import_qualified"),
               "NORMALIZATION_SHAPE")
    require(type(normalization["version"]) is int and normalization["version"] == 1 and
            normalization["scope"] == "engine-image-archive-normalization", "NORMALIZATION_VERSION")
    require(all(normalization[key] == identity[key] for key in
                ("image_id", "source_sha", "server_tree")), "NORMALIZATION_IDENTITY")
    require(normalization["build_contract"] == CONTRACT and normalization["platform"] == "linux/amd64" and
            normalization["producer_authenticated"] is False and
            normalization["host_import_qualified"] is False, "NORMALIZATION_CONTRACT")
    require(hex_value(normalization["archive_sha256"], 64) and
            hex_value(normalization["input_sha256"], 64) and
            type(normalization["archive_bytes"]) is int and
            1024 <= normalization["archive_bytes"] <= ARCHIVE_LIMIT and
            type(normalization["layers"]) is int and 1 <= normalization["layers"] <= 64,
            "ARCHIVE_IDENTITY")
    return {"schema": "engine-ci-image-v1", "identity": identity,
            "build_contract": CONTRACT, "platform": "linux/amd64",
            "archive": {"file": "engine-image.tar", "sha256": normalization["archive_sha256"],
                        "bytes": normalization["archive_bytes"]},
            "runtime_hashes": runtime_hashes,
            "host_import_qualified": False, "deployment_authorized": False}


def runtime_directory_hashes(directory):
    directory = Path(directory)
    require(directory.is_absolute() and directory.is_dir() and not directory.is_symlink(), "RUNTIME_DIRECTORY")
    result, total = {}, 0
    for current, directories, files in os.walk(directory, followlinks=False):
        require(all(not Path(current, name).is_symlink() for name in directories), "RUNTIME_SYMLINK")
        for name in files:
            path = Path(current, name)
            require(not path.is_symlink(), "RUNTIME_SYMLINK")
            if name.endswith((".d.ts", ".d.ts.map", ".tsbuildinfo")):
                continue
            identity = file_identity(path, 32 * 1024 * 1024)
            total += identity["bytes"]
            result[path.relative_to(directory).as_posix()] = identity["sha256"]
            require(total <= 512 * 1024 * 1024 and len(result) <= RUNTIME_LIMIT, "RUNTIME_SIZE")
    check_runtime(result)
    return result


def write_bundle(destination, archive, identity, normalization, reference_directory, image_directory):
    """Package an already built/normalized image in the existing CI job.

    The caller supplies the image's actual copied runtime directory and the
    independently typechecked reference. No extra compiler or daemon is started.
    The canonical tar is hardlinked on the same filesystem, avoiding another
    full image copy; the later consumer must still rehash its received bytes.
    A failure never returns upload outputs and never deletes an existing bundle.
    """
    reference = runtime_directory_hashes(reference_directory)
    image = runtime_directory_hashes(image_directory)
    value = descriptor(identity, normalization, image, reference)
    archive = Path(archive)
    expected_archive = {"sha256": value["archive"]["sha256"], "bytes": value["archive"]["bytes"]}
    require(file_identity(archive, ARCHIVE_LIMIT) == expected_archive, "PRODUCER_ARCHIVE_BYTES")
    destination = Path(destination)
    require(destination.is_absolute(), "BUNDLE_DESTINATION")
    # The parent directory belongs to the workflow's private temporary area.
    # mkdir refuses an existing directory, file or symlink without replacing it.
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    os.link(archive, destination / "engine-image.tar", follow_symlinks=False)
    require(file_identity(destination / "engine-image.tar", ARCHIVE_LIMIT) == expected_archive,
            "PRODUCER_ARCHIVE_CHANGED")
    raw = encode(value)
    require(len(raw) <= DESCRIPTOR_LIMIT, "PRODUCER_DESCRIPTOR_SIZE")
    with (destination / "engine-image.json").open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    directory_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    return {"identity": identity, "archive_sha256": expected_archive["sha256"],
            "archive_bytes": expected_archive["bytes"],
            "descriptor_sha256": hashlib.sha256(raw).hexdigest(),
            "typechecked_runtime_files_matched": len(image),
            "host_import_qualified": False, "deployment_authorized": False}


def validate_descriptor(value, expected):
    check_identity(expected["identity"])
    exact_keys(expected, ("identity", "archive_sha256", "archive_bytes", "descriptor_sha256",
                          "artifact_id", "artifact_digest"), "EXPECTED_SHAPE")
    require(positive(expected["artifact_id"]) and hex_value(expected["artifact_digest"], 64) and
            hex_value(expected["descriptor_sha256"], 64) and hex_value(expected["archive_sha256"], 64) and
            type(expected["archive_bytes"]) is int and 1024 <= expected["archive_bytes"] <= ARCHIVE_LIMIT,
            "EXPECTED_OUTPUTS")
    exact_keys(value, ("schema", "identity", "build_contract", "platform", "archive", "runtime_hashes",
                       "host_import_qualified", "deployment_authorized"), "DESCRIPTOR_SHAPE")
    require(value["schema"] == "engine-ci-image-v1" and value["identity"] == expected["identity"],
            "DESCRIPTOR_IDENTITY")
    require(value["build_contract"] == CONTRACT and value["platform"] == "linux/amd64" and
            value["host_import_qualified"] is False and value["deployment_authorized"] is False,
            "DESCRIPTOR_CONTRACT")
    check_runtime(value["runtime_hashes"])
    require(value["archive"] == {"file": "engine-image.tar", "sha256": expected["archive_sha256"],
                                  "bytes": expected["archive_bytes"]}, "DESCRIPTOR_ARCHIVE")


def validate_github_metadata(repository, run, artifact, jobs, expected, environment):
    """Accept only authenticated GitHub API objects fetched by the CLI below.

    The pure function is testable; callers supplying their own objects do not
    gain a GitHub authentication claim. No metadata from the bundle is trusted.
    """
    identity = expected["identity"]
    check_identity(identity)
    require(environment.get("GITHUB_ACTIONS") == "true" and
            environment.get("GITHUB_REPOSITORY") == REPOSITORY and
            environment.get("GITHUB_RUN_ID") == identity["run_id"] and
            environment.get("GITHUB_RUN_ATTEMPT") == identity["run_attempt"] and
            environment.get("GITHUB_SHA") == identity["workflow_control_sha"] and
            environment.get("GITHUB_EVENT_NAME") == "repository_dispatch", "CURRENT_WORKFLOW_CONTEXT")
    require(repository.get("full_name") == REPOSITORY and type(repository.get("id")) is int and
            repository["id"] > 0, "GITHUB_REPOSITORY")
    repo_id = repository["id"]
    require(type(run.get("id")) is int and str(run["id"]) == identity["run_id"] and
            type(run.get("run_attempt")) is int and str(run["run_attempt"]) == identity["run_attempt"] and
            run.get("event") == "repository_dispatch" and run.get("path") == WORKFLOW and
            run.get("head_sha") == identity["workflow_control_sha"] and
            (run.get("repository") or {}).get("id") == repo_id and
            (run.get("head_repository") or {}).get("id") == repo_id and
            (run.get("status"), run.get("conclusion")) in
            {("in_progress", None), ("completed", "success")}, "GITHUB_RUN")
    require(type(artifact.get("id")) is int and str(artifact["id"]) == expected["artifact_id"] and
            artifact.get("name") == f"engine-image-{identity['run_id']}-{identity['run_attempt']}" and
            artifact.get("digest") == "sha256:" + expected["artifact_digest"] and
            artifact.get("expired") is False and
            (artifact.get("workflow_run") or {}).get("id") == run["id"] and
            (artifact.get("workflow_run") or {}).get("head_sha") == identity["workflow_control_sha"] and
            (artifact.get("workflow_run") or {}).get("repository_id") == repo_id and
            (artifact.get("workflow_run") or {}).get("head_repository_id") == repo_id,
            "GITHUB_ARTIFACT")
    require(type(jobs.get("total_count")) is int and 0 < jobs["total_count"] <= 100 and
            isinstance(jobs.get("jobs"), list) and len(jobs["jobs"]) == jobs["total_count"],
            "GITHUB_JOB_PAGE")
    producers = [job for job in jobs["jobs"] if job.get("name") == PRODUCER_JOB]
    require(len(producers) == 1, "GITHUB_PRODUCER_UNIQUE")
    producer = producers[0]
    require(producer.get("run_id") == run["id"] and
            producer.get("head_sha") == identity["workflow_control_sha"] and
            producer.get("status") == "completed" and producer.get("conclusion") == "success" and
            type(producer.get("id")) is int and producer["id"] > 0,
            "GITHUB_PRODUCER_SUCCESS")
    return producer["id"]


def validate_files(directory, expected):
    directory = Path(directory)
    require(directory.is_absolute() and directory.is_dir() and not directory.is_symlink(), "OWNED_DIRECTORY")
    require({p.name for p in directory.iterdir()} == {"engine-image.tar", "engine-image.json"}, "BUNDLE_MEMBERS")
    descriptor_path = directory / "engine-image.json"
    first, raw = read_regular(descriptor_path, DESCRIPTOR_LIMIT, retain=True)
    require(first["sha256"] == expected["descriptor_sha256"], "DESCRIPTOR_DIGEST")
    value = decode(raw)
    validate_descriptor(value, expected)
    require(file_identity(directory / "engine-image.tar", ARCHIVE_LIMIT) ==
            {"sha256": expected["archive_sha256"], "bytes": expected["archive_bytes"]}, "ARCHIVE_DIGEST")
    return value


def github_api(endpoint):
    allowed = (r"repos/" + re.escape(REPOSITORY) +
               r"(?:/actions/(?:runs/[1-9][0-9]{0,19}/attempts/[1-9][0-9]{0,19}"
               r"(?:/jobs\?per_page=100)?|artifacts/[1-9][0-9]{0,19})"
               r"|/git/commits/[0-9a-f]{40}"
               r"|/compare/[0-9a-f]{40}\.\.\.[0-9a-f]{40}\?per_page=1&page=1)?")
    require(re.fullmatch(allowed, endpoint) is not None, "GITHUB_ENDPOINT")
    environment = dict(os.environ)
    # Force the authenticated public API host, never an injected GH_HOST.
    environment["GH_HOST"] = "github.com"
    result = subprocess.run(["gh", "api", "--hostname", "github.com", "--method", "GET", endpoint],
                            capture_output=True, timeout=30, env=environment)
    require(result.returncode == 0 and len(result.stdout) <= 4 * 1024 * 1024, "GITHUB_READ")
    value = decode(result.stdout)
    require(isinstance(value, dict), "GITHUB_OBJECT")
    return value


def admit_bundle(directory, expected):
    """Authenticate current production custody; this does not authorize a host load.

    Shared by the existing CLI and the versioned request preparer. Metadata
    still comes only from the fixed authenticated API, never a saved receipt.
    """
    validate_descriptor(validate_files(directory, expected), expected)
    identity = expected["identity"]
    run_id, attempt, artifact_id = identity["run_id"], identity["run_attempt"], expected["artifact_id"]
    repository = github_api("repos/" + REPOSITORY)
    run = github_api(f"repos/{REPOSITORY}/actions/runs/{run_id}/attempts/{attempt}")
    artifact = github_api(f"repos/{REPOSITORY}/actions/artifacts/{artifact_id}")
    jobs = github_api(f"repos/{REPOSITORY}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
    job_id = validate_github_metadata(repository, run, artifact, jobs, expected, os.environ)
    # API checks can take time. Do not emit admission for bytes that changed
    # during those reads. A future host loader still verifies its own inode.
    validate_files(directory, expected)
    return {"scope": "same-run-engine-image-admission", "status": "passed",
                      "producer_job_id": job_id, "artifact_id": artifact_id,
                      "identity": identity, "archive_sha256": expected["archive_sha256"],
                      "archive_bytes": expected["archive_bytes"],
                      "descriptor_sha256": expected["descriptor_sha256"],
                      "host_import_qualified": False, "deployment_authorized": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--expected", required=True,
                        help="Trusted current-workflow outputs file; never download this in the bundle")
    args = parser.parse_args()
    path = Path(args.expected)
    require(path.is_absolute(), "EXPECTED_PATH")
    _, raw = read_regular(path, 16384, retain=True)
    expected = decode(raw)
    print(json.dumps(admit_bundle(args.directory, expected)))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        reason = str(exc) if isinstance(exc, ValueError) and str(exc).startswith("ENGINE_CI_IMAGE_") else type(exc).__name__
        raise SystemExit("engine CI image admission refused: " + reason)
