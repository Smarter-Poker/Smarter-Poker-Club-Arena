#!/usr/bin/env python3
"""Import one authenticated workflow image before the existing release intake.

Expected digests arrive from the successful producer job outputs, never from
the downloaded file. This command does not start a container or a release.
"""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import signal
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('engine_archive', HERE / 'engine-image-archive.py')
archive_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive_module)
RECEIPTS = Path('/var/lib/club-arena/engine-prebuilt')
LOCK = Path('/var/lock/club-arena-engine-build.lock')


def require(ok, reason):
    if not ok:
        raise ValueError('ENGINE_PREBUILT_' + reason)


def command(args, deadline, *, input_file=None):
    remaining = deadline - time.time()
    require(remaining > 1, 'DEADLINE')
    result = subprocess.run(args, stdin=input_file, capture_output=True,
                            timeout=min(remaining, 300))
    require(result.returncode == 0, 'COMMAND_FAILED')
    require(len(result.stdout) <= 1024 * 1024 and len(result.stderr) <= 1024 * 1024,
            'COMMAND_OUTPUT')
    return result.stdout


def receipt_bytes(source, tree, image, archive):
    return (json.dumps(dict(source_sha=source, server_tree=tree, image_id=image,
                            archive_sha256=archive, platform='linux/amd64',
                            build_contract=archive_module.CONTRACT),
                       sort_keys=True, separators=(',', ':')) + '\n').encode()


def import_image(repo, source, tree, image, archive, expected_archive, deadline):
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    require(all(re.fullmatch(r'[0-9a-f]{40}', x) for x in (source, tree)) and
            re.fullmatch(r'sha256:[0-9a-f]{64}', image) and
            re.fullmatch(r'[0-9a-f]{64}', expected_archive), 'IDENTITY')
    require(type(deadline) is int and time.time() < deadline, 'DEADLINE')
    repo, archive = Path(repo), Path(archive)
    require(repo.is_absolute() and archive.is_absolute(), 'PATHS')
    actual_tree = command(['git', '--no-replace-objects', '-C', str(repo), 'rev-parse',
                           '--verify', source + ':server'], deadline).decode().strip()
    require(actual_tree == tree, 'SOURCE_TREE')
    command(['git', '--no-replace-objects', '-C', str(repo), 'merge-base', '--is-ancestor',
             source, 'refs/remotes/origin/main'], deadline)
    tag = 'club-arena-engine:' + source
    expected = receipt_bytes(source, tree, image, expected_archive)
    # Every ancestor is a real root-owned directory, unwritable by other UIDs.
    # The fixed host control root must already exist; never follow a redirected
    # parent while creating an authoritative image receipt.
    for parent in reversed(RECEIPTS.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
                not (stat.S_IMODE(info.st_mode) & 0o022), 'RECEIPT_PARENT')
    RECEIPTS.mkdir(mode=0o700, exist_ok=True)
    root = RECEIPTS.lstat()
    require(stat.S_ISDIR(root.st_mode) and root.st_uid == 0 and
            stat.S_IMODE(root.st_mode) == 0o700, 'RECEIPT_ROOT')
    target = RECEIPTS / (source + '.json')
    lock_fd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    def expired(_signal, _frame):
        raise TimeoutError('ENGINE_PREBUILT_DEADLINE')
    previous_handler = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, max(0.001, deadline - time.time()))
    try:
        # One original deadline bounds the lock, archive walk and Docker client.
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        require(time.time() < deadline, 'DEADLINE')
        existing = command(['docker', 'image', 'ls', '--no-trunc', '--quiet', tag], deadline)
        require(existing.decode().split() in ([], [image]), 'EXISTING_IMAGE_CONFLICT')
        if target.exists() or target.is_symlink():
            fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as previous:
                info = os.fstat(previous.fileno())
                require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                        stat.S_IMODE(info.st_mode) == 0o400 and info.st_size == len(expected),
                        'RECEIPT_TYPE')
                require(previous.read(4097) == expected, 'IMMUTABLE_SOURCE_CONFLICT')
        with tempfile.TemporaryDirectory(prefix='.import-', dir=RECEIPTS) as temporary:
            normalized = Path(temporary) / 'image.tar'
            record = archive_module.normalize_engine_archive(
                archive, normalized, source_sha=source, server_tree=tree, image_id=image)
            require(record['input_sha256'] == expected_archive, 'ARCHIVE_DIGEST')
            require(time.time() < deadline, 'DEADLINE')
            with normalized.open('rb') as data:
                command(['docker', 'image', 'load'], deadline, input_file=data)
            inspected = json.loads(command(['docker', 'image', 'inspect', tag], deadline))
            require(isinstance(inspected, list) and len(inspected) == 1, 'INSPECT')
            value = inspected[0]
            require(value.get('Id') == image and value.get('Os') == 'linux' and
                    value.get('Architecture') == 'amd64', 'LOADED_IDENTITY')
            labels = value.get('Config', {}).get('Labels', {})
            require(labels.get('org.opencontainers.image.revision') == source and
                    labels.get('com.smarterpoker.engine.source-tree') == tree and
                    labels.get('com.smarterpoker.engine.build-contract') == archive_module.CONTRACT,
                    'LOADED_LABELS')
            staged = Path(temporary) / 'receipt.json'
            with staged.open('xb') as output:
                output.write(expected)
                output.flush()
                os.fchmod(output.fileno(), 0o400)
                os.fsync(output.fileno())
            if not target.exists():
                os.link(staged, target, follow_symlinks=False)
            directory = os.open(RECEIPTS, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        os.close(lock_fd)
    return json.loads(expected)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('repo', 'source', 'tree', 'image', 'archive', 'archive-sha256'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--deadline', required=True, type=int)
    args = p.parse_args()
    print(json.dumps(import_image(args.repo, args.source, args.tree, args.image,
                                 args.archive, args.archive_sha256, args.deadline), sort_keys=True))


if __name__ == '__main__':
    main()
