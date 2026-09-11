#!/usr/bin/python3
"""Fixed v2 intake router; accepted operations retain their original bundle."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
CURRENT = Path('/etc/club-arena-release-controller/engine-operation-v2.json')
STATE = Path('/var/lib/club-arena/engine-operation-v2')


def require(value):
    if not value:
        raise ValueError('RELEASE_V2_DISPATCH_REFUSED')


def trusted(path):
    for value in (path, *path.parents):
        info = value.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode))
    require(path.is_file())
    return path.read_bytes()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def select(envelope, *, current=CURRENT, state=STATE, read=trusted):
    operation = envelope['operation_id']
    require(re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', operation))
    folder = state / operation
    if (folder / 'installation.json').exists():
        pin = json.loads(read(folder / 'installation.json'))
        raw = read(folder / 'configuration.json')
        require(digest(raw) == pin['configuration_digest'] and pin['operation_id'] == operation)
        intent = read(folder / 'intent.json')
        require(digest(intent) == pin['envelope_digest'] and json.loads(intent) == envelope)
    else:
        raw = read(current)
    config = json.loads(raw)
    if (folder / 'installation.json').exists():
        require(pin['bundle_digest'] == config['bundle_digest'])
    bundle = Path(config['bundle_path'])
    require(config['protocol'] == 2 and bundle.is_absolute() and
            re.fullmatch(r'[0-9a-f]{64}', bundle.name) and bundle.name == config['bundle_digest'])
    manifest_raw = read(bundle / 'bundle-manifest.json')
    require(digest(manifest_raw) == config['bundle_digest'])
    manifest = json.loads(manifest_raw)
    require(manifest['format'] == 1 and manifest['schema_version'] == 1 and manifest['provider_schema_version'] == 1)
    entrypoint = bundle / 'native/engine-intake-v2.py'
    require(digest(read(entrypoint)) == manifest['files']['native/engine-intake-v2.py'])
    # The selected entrypoint independently verifies the complete bundle before
    # processing input. No request may supply an executable or environment.
    return entrypoint


def main():
    require(os.geteuid() == 0 and len(sys.argv) == 2 and
            sys.argv[1] in ('preflight', 'submit', 'observe', 'resume-acceptance', 'maintenance-need', 'maintenance-safe-resume'))
    raw = sys.stdin.buffer.read(65537); require(len(raw) <= 65536)
    entrypoint = select(json.loads(raw))
    child = subprocess.Popen(['/usr/bin/python3', '-B', str(entrypoint), sys.argv[1]], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin'}, start_new_session=True)
    try:
        output, _ = child.communicate(raw, timeout=65)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL); child.communicate(timeout=5)
        raise
    require(len(output) <= 65536 and child.returncode == 0)
    sys.stdout.buffer.write(output)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error': 'RELEASE_V2_DISPATCH_REFUSED'}))
        sys.exit(1)
