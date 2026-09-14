#!/usr/bin/env python3
"""Bind prepared image requests to an exact installed control generation.

This read-only host verifier creates only inert .release.prepared-v2 evidence.
It does not install, dispatch, import, update a seal, or grant recovery authority.
The future v2 launcher must retain the controller's locks and revalidate before
execution; this point-in-time readback is not a lease on filesystem contents.
"""
import argparse
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

# Importing dependencies must not add unmanifested files to the generation.
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "image_request", Path(__file__).with_name("engine-release-image-request.py"))
request = importlib.util.module_from_spec(spec)
spec.loader.exec_module(request)

GENERATION_ROOT = Path("/usr/local/lib/club-arena/engine-control-generations")
FILE_LIMIT = 2 * 1024 * 1024
TOTAL_LIMIT = 16 * 1024 * 1024
FILES_LIMIT = 128
PROOF_SECONDS = 45
V2_FILES = {"engine-image-ci-bundle.py", "engine-release-image-request.py",
            "engine-release-image-result.py", "engine-release-image-request-v2.schema",
            "engine-release-image-generation.py"}
V1_SCHEMA_DIGEST = "7c5aba4d2bc572edc5ef84c5280e1ffe517e5949b41788c18eeb003abea74044"


def require(ok, reason):
    if not ok:
        raise ValueError("ENGINE_IMAGE_GENERATION_" + reason)


def remaining(deadline):
    value = deadline - time.monotonic()
    require(value > 0, "PROOF_DEADLINE")
    return min(value, 10)


def git(repo, args, deadline):
    # Only local object/ref reads. Ambient Git location/replacement/config
    # overrides cannot redirect the explicitly selected repository.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_NO_REPLACE_OBJECTS="1", GIT_TERMINAL_PROMPT="0")
    result = subprocess.run(["git", "--no-pager", "-C", str(repo), *args], env=env,
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=remaining(deadline), check=False)
    require(result.returncode == 0, "LOCAL_GIT_PROOF")
    return result.stdout


def git_blob(repo, sha, name, deadline):
    key = sha + ":server/scripts/" + name
    size = git(repo, ["cat-file", "-s", key], deadline)
    require(re.fullmatch(rb"[1-9][0-9]{0,7}\n", size) is not None and
            int(size) <= FILE_LIMIT, "SOURCE_FILE_SIZE")
    raw = git(repo, ["cat-file", "blob", key], deadline)
    require(len(raw) == int(size), "SOURCE_FILE_CHANGED")
    return raw


def required_files(installer):
    # Parse the actual protected installer declaration, never evaluate shell.
    matches = re.findall(rb"^REQUIRED_FILES=\(\n([^)]*)\n\)$", installer, re.MULTILINE)
    require(len(matches) == 1, "INSTALLER_MANIFEST")
    lines = matches[0].splitlines()
    require(0 < len(lines) <= FILES_LIMIT and all(
        re.fullmatch(rb"  [A-Za-z0-9][A-Za-z0-9._-]*", line) for line in lines),
        "INSTALLER_MANIFEST")
    names = [line.strip().decode("ascii") for line in lines]
    require(len(names) == len(set(names)) and V2_FILES.issubset(names) and
            {"install-engine-supervisor.sh", "engine-release-protocol-v1.schema"}.issubset(names) and
            not {"control-sha", "generation-files"}.intersection(names), "MANIFEST_CLOSURE")
    return names


def identity(info):
    return tuple(getattr(info, name) for name in
                 ("st_dev", "st_ino", "st_mode", "st_uid", "st_size", "st_mtime_ns", "st_ctime_ns"))


def hold_file(directory, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.geteuid() and
                not stat.S_IMODE(before.st_mode) & 0o022 and 0 < before.st_size <= FILE_LIMIT,
                "INSTALLED_FILE")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(FILE_LIMIT + 1)
        require(len(raw) == before.st_size and identity(before) == identity(os.fstat(fd)),
                "INSTALLED_FILE_CHANGED")
        return fd, before, raw
    except BaseException:
        os.close(fd)
        raise


def validate_generation(repo, control_sha, deadline):
    require(request.bundle.hex_value(control_sha, 40), "CONTROL_SHA")
    generation = GENERATION_ROOT / control_sha
    require(generation.resolve(strict=True) == generation, "CANONICAL_GENERATION")
    directory = os.open(generation, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    held = []
    try:
        original = os.fstat(directory)
        require(original.st_uid == os.geteuid() and not stat.S_IMODE(original.st_mode) & 0o022,
                "GENERATION_OWNER_MODE")
        git(repo, ["merge-base", "--is-ancestor", control_sha, "refs/remotes/origin/main"], deadline)
        installer = git_blob(repo, control_sha, "install-engine-supervisor.sh", deadline)
        names = required_files(installer)
        expected = names + ["control-sha", "generation-files"]
        require(set(os.listdir(directory)) == set(expected), "GENERATION_ENTRIES")
        raw_files = {}
        total = 0
        for name in expected:
            remaining(deadline)
            fd, info, raw = hold_file(directory, name)
            held.append((name, fd, info))
            raw_files[name] = raw
            total += len(raw)
            require(total <= TOTAL_LIMIT, "GENERATION_SIZE")
        require(raw_files["control-sha"] == (control_sha + "\n").encode(), "CONTROL_MANIFEST")
        require(raw_files["generation-files"] == ("\n".join(names) + "\n").encode(),
                "FILE_MANIFEST")
        for name in names:
            raw = installer if name == "install-engine-supervisor.sh" else git_blob(
                repo, control_sha, name, deadline)
            require(raw_files[name] == raw, "PROTECTED_SOURCE_MISMATCH")
        require(request.digest(raw_files["engine-release-protocol-v1.schema"]) == V1_SCHEMA_DIGEST,
                "FROZEN_V1_PROTOCOL")
        for name, fd, before in held:
            require(identity(before) == identity(os.fstat(fd)) and identity(before) == identity(
                os.stat(name, dir_fd=directory, follow_symlinks=False)), "GENERATION_CHANGED")
        require(set(os.listdir(directory)) == set(expected) and
                identity(original) == identity(os.fstat(directory)) and
                identity(original) == identity(generation.lstat()) and
                generation.resolve(strict=True) == generation, "GENERATION_REPLACED")
        remaining(deadline)
        return {"control_sha": control_sha, "generation_path": str(generation),
                "files": {name: hashlib.sha256(raw_files[name]).hexdigest() for name in expected}}
    finally:
        for _, fd, _ in held:
            os.close(fd)
        os.close(directory)


def bind_installed_generation(intake_raw, run_key, independent_digest, repo):
    value = request.verify_bound_request(intake_raw, "intake", run_key, independent_digest)
    request.require_unexpired(value, int(time.time()))
    proof = validate_generation(repo, value["control_sha"], time.monotonic() + PROOF_SECONDS)
    raw = request.derive_release(intake_raw, run_key, proof["generation_path"], independent_digest)
    request.require_unexpired(value, int(time.time()))
    return raw, proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--intake", required=True)
    parser.add_argument("--intake-sha256", required=True,
                        help="Independent digest from the existing trusted intake channel")
    parser.add_argument("--run-key", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    _, raw = request.bundle.read_regular(Path(args.intake), request.LIMIT, retain=True)
    release, proof = bind_installed_generation(raw, args.run_key, args.intake_sha256, Path("/opt/club-arena"))
    result = request.write_prepared(args.output, release, "release", args.run_key)
    request.require_unexpired(request.parse(release, "release", args.run_key), int(time.time()))
    result["generation_readback"] = proof
    result["execution_authorized"] = False
    print(request.bundle.encode(result).decode(), end="")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        reason = str(exc) if isinstance(exc, ValueError) and str(exc).startswith("ENGINE_") else type(exc).__name__
        raise SystemExit("engine image generation refused: " + reason)
