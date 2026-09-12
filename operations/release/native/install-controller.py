#!/usr/bin/python3
"""Root-owned native oneshot: install/resume a journal-owned controller upgrade.

No new account, credentials, database migration, activation, provider submit, or
journal terminal claim. A successful start still requires fresh reconciliation.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import re
import stat
import subprocess
import sys
import time

ROOT = Path('/opt/club-arena-release-controller')
STATE = Path('/var/lib/club-arena-release-controller-upgrades')
UNIT = Path('/etc/systemd/system/club-arena-release-controller.service')
STARTUP = Path('/var/lib/club-arena-release-controller/startup.json')
SERVICE = 'club-arena-release-controller.service'

def require(value):
    if not value:
        raise ValueError('RELEASE_NATIVE_UPGRADE_REFUSED')

def secure(path):
    for entry in [path, *path.parents]:
        info = entry.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode))
    return path

def sync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def atomic_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    with open(temporary, 'w') as file:
        json.dump(value, file, sort_keys=True)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)
    sync_dir(path.parent)

def verify_bundle(directory, digest, read=lambda p: secure(p).read_bytes()):
    require(re.fullmatch('[a-f0-9]{64}', digest))
    raw = read(directory / 'bundle-manifest.json')
    require(hashlib.sha256(raw).hexdigest() == digest)
    manifest = json.loads(raw)
    require(manifest.get('operation_policy_digest') == '1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda')
    require(manifest['format'] == 1 and manifest['schema_version'] == 1 and manifest['provider_schema_version'] == 1)
    require(len(manifest['files']) >= 5)
    for name, expected in manifest['files'].items():
        require(not Path(name).is_absolute() and '..' not in Path(name).parts)
        require(hashlib.sha256(read(directory / name)).hexdigest() == expected)
    actual = {p.relative_to(directory).as_posix() for p in directory.rglob('*') if p.is_file() or p.is_symlink()}
    require(actual == set(manifest['files']) | {'bundle-manifest.json'})
    return manifest

class NativeManager:
    def validate(self, source):
        result = subprocess.run(['/usr/bin/systemd-analyze', 'verify', str(source / 'native' / SERVICE)], capture_output=True, timeout=30)
        require(result.returncode == 0)
        node = subprocess.run(['/usr/bin/node', '--version'], capture_output=True, text=True, timeout=10)
        require(node.returncode == 0 and int(node.stdout.strip().lstrip('v').split('.')[0]) >= 22)

    def run(self, *args):
        result = subprocess.run(['/usr/bin/systemctl', *args], capture_output=True, text=True, timeout=95)
        require(result.returncode == 0)
        return result.stdout.strip()

    def stop(self):
        self.run('stop', SERVICE)

    def install(self, source):
        # Service bytes are in the verified bundle; no request-supplied command.
        raw = (source / 'native' / SERVICE).read_bytes()
        temporary = UNIT.with_name(UNIT.name + '.new')
        with open(temporary, 'wb') as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, UNIT)
        sync_dir(UNIT.parent)
        self.run('daemon-reload')

    def start(self):
        self.run('start', SERVICE)

    def ready(self, digest, prior_epoch, instance_id):
        limit = time.monotonic() + 30
        while time.monotonic() < limit:
            try:
                receipt = json.loads(STARTUP.read_text())
                require(receipt['pid'] == int(self.run('show', SERVICE, '-p', 'MainPID', '--value')))
                require(self.run('is-active', SERVICE) == 'active')
                require(receipt['bundle_digest'] == digest and receipt['epoch'] != prior_epoch)
                require(receipt['instance_id'] == instance_id and receipt['reconciliation_required'] is True)
                return receipt
            except Exception:
                time.sleep(0.25)
        raise ValueError('RELEASE_SUCCESSOR_STARTUP_FAILED')

def journal_check(filename, prior_directory):
    result = subprocess.run(['/usr/bin/node', str(prior_directory / 'upgrade-check.mjs'), str(filename)],
                            capture_output=True, timeout=30, text=True)
    require(result.returncode == 0 and json.loads(result.stdout).get('pending') is True)

def bootstrap(digest, *, root=ROOT, state=STATE, manager=None, verifier=verify_bundle, check_journal=None):
    manager = manager or NativeManager()
    target = root / 'versions' / digest
    verifier(target, digest)
    if hasattr(manager, 'validate'):
        manager.validate(target)
    proof = check_journal()
    require(proof.get('bootstrap_observe_only') is True)
    checkpoint = state / ('bootstrap-' + digest + '.json')
    record = {'bundle_digest': digest, 'mode': 'OBSERVE', 'state': 'INTENT'}
    current = root / 'current'
    if checkpoint.exists():
        record = json.loads(checkpoint.read_text())
        require(record['bundle_digest'] == digest and record['mode'] == 'OBSERVE')
        if record['state'] == 'STARTED_RECONCILIATION_REQUIRED':
            return record
    else:
        require(not current.exists() and not current.is_symlink())
        atomic_json(checkpoint, record)
    if not current.is_symlink():
        os.symlink('versions/' + digest, current)
        sync_dir(root)
    require(os.readlink(current) == 'versions/' + digest)
    manager.install(target)
    manager.start()
    receipt = manager.ready(digest, proof['epoch'], proof['instance_id'])
    record.update(state='STARTED_RECONCILIATION_REQUIRED', startup=receipt)
    atomic_json(checkpoint, record)
    return record

def install(intent, *, root=ROOT, state=STATE, manager=None, verifier=verify_bundle, check_journal=None, interrupt=None):
    manager = manager or NativeManager()
    upgrade = intent['native_upgrade']
    operation = intent['operation_id']
    require(re.fullmatch('[a-f0-9-]{36}', operation))
    before, after = upgrade['prior_bundle_digest'], upgrade['bundle_digest']
    require(before != after and re.fullmatch('[a-f0-9]{64}', before) and re.fullmatch('[a-f0-9]{64}', after))
    require(upgrade['service'] == SERVICE and upgrade['schema_version'] == 1 and upgrade['provider_schema_version'] == 1)
    prior, target = root / 'versions' / before, root / 'versions' / after
    verifier(prior, before)
    verifier(target, after)
    if hasattr(manager, 'validate'):
        manager.validate(prior)
        manager.validate(target)
    checkpoint = state / (operation + '.checkpoint.json')
    record = {'operation_id': operation, 'intent': intent, 'state': 'INTENT'}
    if checkpoint.exists():
        record = json.loads(checkpoint.read_text())
        require(record['intent'] == intent)
    else:
        atomic_json(checkpoint, record)  # Durable recovery identity BEFORE stop.
    check_journal()
    current = root / 'current'
    require(os.readlink(current) in ('versions/' + before, 'versions/' + after))
    if record['state'] in ('STARTED_RECONCILIATION_REQUIRED', 'ROLLED_BACK_RECONCILIATION_REQUIRED'):
        return record  # Read receipt only; never repeat a completed upgrade.
    def step(name, **extra):
        record.update(state=name, **extra)
        atomic_json(checkpoint, record)
        if interrupt:
            interrupt(name)
    def point(digest):
        temporary = root / 'current.new'
        if temporary.is_symlink():
            temporary.unlink()
        os.symlink('versions/' + digest, temporary)
        os.replace(temporary, current)
        sync_dir(root)
    def restore():
        manager.stop()
        point(before)
        manager.install(prior)
        manager.start()
        receipt = manager.ready(before, upgrade['prior_epoch'], intent['instance_id'])
        step('ROLLED_BACK_RECONCILIATION_REQUIRED', startup=receipt)
    if record['state'] == 'RESTORING':
        restore()
        return record
    try:
        manager.stop()
        step('STOPPED')
        point(after)
        manager.install(target)
        step('INSTALLED')
        manager.start()
        receipt = manager.ready(after, upgrade['prior_epoch'], intent['instance_id'])
        step('STARTED_RECONCILIATION_REQUIRED', startup=receipt)
    except Exception:
        step('RESTORING')
        restore()
    return record

if __name__ == '__main__':
    try:
        require(os.geteuid() == 0 and len(sys.argv) == 3 and sys.argv[1] in ('--intent', '--bootstrap'))
        secure(ROOT)
        secure(STATE)
        if sys.argv[1] == '--bootstrap':
            digest = sys.argv[2]
            manifest = verify_bundle(ROOT / 'versions' / digest, digest)
            pwd.getpwnam(manifest['service_user'])
            grp.getgrnam(manifest['service_group'])
            config = json.loads(secure(Path('/etc/club-arena-release-controller/controller.json')).read_text())
            require(config.get('mode', 'OBSERVE') == 'OBSERVE')
            def bootstrap_check():
                result = subprocess.run(['/usr/bin/node', str(ROOT / 'versions' / digest / 'upgrade-check.mjs'), '--bootstrap'], capture_output=True, timeout=30, text=True)
                require(result.returncode == 0)
                return json.loads(result.stdout)
            with open(STATE / 'installer.lock', 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                print(json.dumps(bootstrap(digest, check_journal=bootstrap_check)))
            sys.exit(0)
        filename = Path(sys.argv[2])
        require(filename.parent == STATE and re.fullmatch(r'[a-f0-9-]{36}\.json', filename.name))
        intent = json.loads(secure(filename).read_text())
        require(filename.stem == intent['operation_id'])
        for digest in [intent['native_upgrade']['prior_bundle_digest'], intent['native_upgrade']['bundle_digest']]:
            manifest = verify_bundle(ROOT / 'versions' / digest, digest)
            pwd.getpwnam(manifest['service_user'])
            grp.getgrnam(manifest['service_group'])
        with open(STATE / 'installer.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = install(intent, check_journal=lambda: journal_check(filename, ROOT / 'versions' / intent['native_upgrade']['prior_bundle_digest']))
            print(json.dumps(result))
    except Exception:
        print(json.dumps({'error': 'RELEASE_NATIVE_UPGRADE_REFUSED'}))
        sys.exit(1)
