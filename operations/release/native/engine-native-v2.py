#!/usr/bin/python3
"""Immutable per-operation systemd wiring for the journal-owned v2 actuator."""
import hashlib
import fcntl
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
from uuid import uuid4

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('engine_boundary', Path(__file__).with_name('engine-boundary.py'))
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)
require, secure = BASE.require, BASE.secure
ROOT = Path('/var/lib/club-arena/engine-operation-v2')
UNITS = Path('/etc/systemd/system')
WANTS = UNITS / 'multi-user.target.wants'
LOCK = Path('/var/lock/club-arena-engine-up.lock')
LOCK_ALIAS = Path('/var/lock')
LOCK_CANONICAL_PARENT = Path('/run/lock')
ROOT_UID = 0
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def sync(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def immutable(path, raw, mode=0o600):
    secure(path.parent, file=False)
    temporary = path.with_name('.' + path.name + '.' + uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            os.fchmod(output.fileno(), mode)
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            require(secure(path).read_bytes() == raw and path.stat().st_mode & 0o777 == mode)
        sync(path.parent)
    finally:
        temporary.unlink(missing_ok=True)
        sync(path.parent)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def directory(path):
    missing = []
    cursor = path
    while not cursor.exists():
        missing.append(cursor)
        cursor = cursor.parent
    secure(cursor, file=False)
    for created in reversed(missing):
        created.mkdir(mode=0o700)
        sync(created)
        sync(created.parent)
    secure(path, file=False)


def configuration(config):
    require(config.get('protocol') == 2 and config.get('policy_digest') == digest(BASE.POLICY_BYTES))
    bundle = Path(config['bundle_path'])
    require(bundle.is_absolute() and re.fullmatch(r'/[A-Za-z0-9_./-]+', str(bundle))
            and '..' not in bundle.parts and re.fullmatch(r'[0-9a-f]{64}', bundle.name)
            and config['bundle_digest'] == bundle.name)
    require(re.fullmatch(r'[a-z][a-z0-9_-]{0,50}', config['actuator_credential_name']))
    credential = Path(config['actuator_credential_path'])
    require(credential.is_absolute() and re.fullmatch(r'/[A-Za-z0-9_./-]+', str(credential)))
    authority = Path(config['authority_config_path'])
    require(authority.is_absolute() and re.fullmatch(r'/[A-Za-z0-9_./-]+', str(authority)))
    require(re.fullmatch(r'[0-9a-f]{64}', config['authority_config_digest']))
    return bundle


def verify_configuration(config):
    bundle = configuration(config)
    spec = importlib.util.spec_from_file_location('controller_installer', bundle / 'native/install-controller.py')
    module = importlib.util.module_from_spec(spec)
    # Verify the installed helper itself before loading code from this bundle.
    raw = secure(bundle / 'bundle-manifest.json').read_bytes()
    require(digest(raw) == config['bundle_digest'])
    manifest = json.loads(raw)
    require(digest(secure(bundle / 'native/install-controller.py').read_bytes()) == manifest['files']['native/install-controller.py'])
    spec.loader.exec_module(module)
    module.verify_bundle(bundle, config['bundle_digest'])
    authority_raw = secure(Path(config['authority_config_path'])).read_bytes()
    require(digest(authority_raw) == config['authority_config_digest'])
    authority = json.loads(authority_raw)['engine_actuator']
    require(authority['database_credential_name'] == config['actuator_credential_name'])
    require(re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', authority['database_principal']))
    secure(Path(authority['database_ca_path']))
    # Do not read a credential here: only verify its pre-existing private file.
    credential = secure(Path(config['actuator_credential_path']))
    require(credential.stat().st_mode & 0o077 == 0)
    return manifest


def lock_path(path):
    """Resolve only the operating system's fixed alias for the existing lock."""
    if path != LOCK or not path.parent.is_symlink():
        secure(path.parent, file=False)
        return path
    require(path.parent == LOCK_ALIAS)
    secure(LOCK_ALIAS.parent, file=False)
    alias = LOCK_ALIAS.lstat()
    require(stat.S_ISLNK(alias.st_mode) and alias.st_uid == ROOT_UID)
    destination = Path(os.path.normpath(str(LOCK_ALIAS.parent / os.readlink(LOCK_ALIAS))))
    require(destination == LOCK_CANONICAL_PARENT)
    secure(destination.parent, file=False)
    parent = destination.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == ROOT_UID and
            (parent.st_mode & 0o022 == 0 or stat.S_IMODE(parent.st_mode) == 0o1777))
    return destination / path.name


def lock_identity(path, descriptor=None):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == ROOT_UID and info.st_mode & 0o022 == 0)
    if descriptor is not None:
        opened = os.fstat(descriptor)
        require(stat.S_ISREG(opened.st_mode) and opened.st_uid == ROOT_UID and
                opened.st_mode & 0o022 == 0 and (opened.st_dev, opened.st_ino) == (info.st_dev, info.st_ino))
    return info.st_dev, info.st_ino


@contextmanager
def mutation_lock(path=LOCK, timeout=30):
    canonical = lock_path(path)
    try:
        descriptor = os.open(canonical, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        lock_identity(canonical)
        descriptor = os.open(canonical, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        original = lock_identity(canonical, descriptor)
        limit = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                require(time.monotonic() < limit)
                time.sleep(.05)
        require(lock_path(path) == canonical and lock_identity(canonical, descriptor) == original)
        yield
    finally:
        os.close(descriptor)


def rendered_units(operation, config, folder):
    require(re.fullmatch(UUID, operation))
    bundle = configuration(config)
    require(re.fullmatch(r'/[A-Za-z0-9_./-]+', str(folder)) and '..' not in folder.parts)
    replacements = {'@BUNDLE@': str(bundle), '@OPERATION@': operation, '@FOLDER@': str(folder),
                    '@CREDENTIAL_NAME@': config['actuator_credential_name'], '@CREDENTIAL_PATH@': config['actuator_credential_path']}
    result = {}
    for suffix in ('service', 'path'):
        template = secure(bundle / 'native' / f'club-arena-engine-operation-v2@.{suffix}').read_text()
        for key, value in replacements.items():
            template = template.replace(key, value)
        require(not re.search(r'@[A-Z_]+@', template))
        result[f'club-arena-engine-operation-v2@{operation}.{suffix}'] = template.encode()
    return result


class Manager:
    def command(self, *args):
        result = BASE.command(args)
        require(result.returncode == 0)
        return result.stdout.strip()

    def install(self, files, folder):
        for name, raw in files.items():
            staged = folder / name
            immutable(staged, raw, 0o644)
        self.command('/usr/bin/systemd-analyze', 'verify', *[str(folder / name) for name in files])
        for name, raw in files.items():
            immutable(UNITS / name, raw, 0o644)
        self.command('/usr/bin/systemctl', 'daemon-reload')
        self.verify(files)

    def verify(self, files):
        for name, raw in files.items():
            require(secure(UNITS / name).read_bytes() == raw)
            loaded = self.command('/usr/bin/systemctl', 'show', name, '-p', 'LoadState', '-p', 'FragmentPath', '-p', 'DropInPaths', '-p', 'NeedDaemonReload')
            values = dict(line.split('=', 1) for line in loaded.splitlines() if '=' in line)
            require(values == {'LoadState': 'loaded', 'FragmentPath': str(UNITS / name), 'DropInPaths': '', 'NeedDaemonReload': 'no'})
            # Loaded fields supplement exact disk bytes; an old daemon unit,
            # drop-in or extra executable may not gain execution authority.
            if name.endswith('.service'):
                keys = ['Type', 'User', 'Restart', 'TimeoutStartUSec', 'TimeoutStopUSec', 'KillMode',
                        'ExecStart', 'ExecStopPost', 'RestartPreventExitStatus']
                state = self.command('/usr/bin/systemctl', 'show', name, *[arg for key in keys for arg in ('-p', key)])
                values = dict(line.split('=', 1) for line in state.splitlines() if '=' in line)
                require(all(values.get(key) == value for key, value in {'Type': 'oneshot', 'User': 'root',
                    'Restart': 'on-failure', 'TimeoutStartUSec': '30min', 'TimeoutStopUSec': '11min',
                    'KillMode': 'control-group', 'RestartPreventExitStatus': '1'}.items()))
                source = dict(line.split('=', 1) for line in raw.decode().splitlines() if '=' in line)
                for key in ('ExecStart', 'ExecStopPost'):
                    observed = values.get(key, '')
                    require(observed.count('argv[]=') == 1 and observed.count('path=') == 1 and
                            'path=/usr/bin/python3 ;' in observed and f"argv[]={source[key]} ;" in observed)
            else:
                state = self.command('/usr/bin/systemctl', 'show', name, '-p', 'Paths', '-p', 'Unit')
                values = dict(line.split('=', 1) for line in state.splitlines() if '=' in line)
                source = dict(line.split('=', 1) for line in raw.decode().splitlines() if '=' in line)
                require(values.get('Paths') == source['PathExists'] + ' (PathExists)' and values.get('Unit') == source['Unit'])

    def arm(self, operation):
        service = f'club-arena-engine-operation-v2@{operation}.service'
        path = f'club-arena-engine-operation-v2@{operation}.path'
        self.command('/usr/bin/systemctl', 'enable', service, path)
        require(self.command('/usr/bin/systemctl', 'is-enabled', service) == 'enabled')
        require(self.command('/usr/bin/systemctl', 'is-enabled', path) == 'enabled')
        sync(WANTS)
        self.command('/usr/bin/systemctl', 'start', path)
        require(self.command('/usr/bin/systemctl', 'is-active', path) == 'active')

    def retire(self, operation):
        path = f'club-arena-engine-operation-v2@{operation}.path'
        service = f'club-arena-engine-operation-v2@{operation}.service'
        self.command('/usr/bin/systemctl', 'stop', path)
        self.command('/usr/bin/systemctl', 'disable', path, service)
        for name in (path, service):
            result = BASE.command(['/usr/bin/systemctl', 'is-enabled', name])
            require(result.stdout.strip() == 'disabled')
        sync(WANTS)


def prepare(envelope, config, manager=None, root=ROOT, interrupt=lambda stage: None):
    """Before returning accepted, a durable native event already owns this item."""
    manager = manager or Manager()
    operation = envelope['operation_id']
    folder = root / operation
    files = rendered_units(operation, config, folder)
    directory(folder)
    immutable(folder / 'intent.json', canonical(envelope))
    immutable(folder / 'configuration.json', canonical(config))
    pin = {'operation_id': operation, 'envelope_digest': digest(canonical(envelope)),
           'configuration_digest': digest(canonical(config)), 'bundle_digest': config['bundle_digest'],
           'unit_digests': {name: digest(raw) for name, raw in files.items()}}
    immutable(folder / 'installation.json', canonical(pin))
    interrupt('PINNED')
    if (folder / 'acceptance.json').exists() or (folder / 'execution-owner.json').exists():
        for name in ('acceptance.json', 'execution-owner.json'):
            if (folder / name).exists():
                require(json.loads(secure(folder / name).read_text()) == pin)
        manager.verify(files)
        return {'accepted': True, 'requires_readback': True, 'replayed': True}
    manager.install(files, folder)
    interrupt('INSTALLED')
    manager.arm(operation)
    interrupt('ARMED')
    # PathExists watches this atomic, fsynced publication. Caller/SSH loss after
    # it cannot remove the immediate event or the already-persisted boot edge.
    immutable(folder / 'acceptance.json', canonical(pin))
    interrupt('ACCEPTED')
    return {'accepted': True, 'requires_readback': True, 'replayed': False}


def claim_event(folder):
    pin = json.loads(secure(folder / 'installation.json').read_text())
    require(digest(secure(folder / 'intent.json').read_bytes()) == pin['envelope_digest'])
    require(digest(secure(folder / 'configuration.json').read_bytes()) == pin['configuration_digest'])
    acceptance = folder / 'acceptance.json'
    if acceptance.exists():
        require(json.loads(secure(acceptance).read_text()) == pin)
        immutable(folder / 'execution-owner.json', canonical(pin))
        acceptance.unlink()
        sync(folder)
    else:
        require(json.loads(secure(folder / 'execution-owner.json').read_text()) == pin)
    return pin


def pinned_configuration(folder, *, executable=None):
    pin = json.loads(secure(folder / 'installation.json').read_text())
    raw = secure(folder / 'configuration.json').read_bytes()
    require(digest(raw) == pin['configuration_digest'])
    config = json.loads(raw)
    require(config['bundle_digest'] == pin['bundle_digest'])
    if executable is not None:
        require(Path(executable).resolve().parent.parent == Path(config['bundle_path']))
    files = rendered_units(pin['operation_id'], config, folder)
    require(pin['unit_digests'] == {name: digest(raw) for name, raw in files.items()})
    return config, files


def invocation(folder, native_id, mode, max_attempts=12):
    require(re.fullmatch(r'[0-9a-f]{32}', native_id) and mode in ('apply', 'recover'))
    attempts = folder / 'invocations'
    directory(attempts)
    entries = sorted(attempts.glob('*.json'))
    for path in entries:
        require(re.fullmatch(r'[0-9a-f]{32}\.json', path.name))
        value = json.loads(secure(path).read_text())
        require(value['invocation_id'] == path.stem and value['operation_id'] == folder.name)
    receipt = attempts / (native_id + '.json')
    if receipt.exists():
        return True
    if mode == 'recover' or len(entries) >= max_attempts:
        return False
    immutable(receipt, canonical({'operation_id': folder.name, 'invocation_id': native_id,
                                 'ordinal': len(entries) + 1}))
    return True
