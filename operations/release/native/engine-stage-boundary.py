#!/usr/bin/python3
"""Bounded native image transfer/staging, separate from frozen release intake.

The service never restarts an engine. Docker-load uncertainty remains owned;
its committed load intent cannot be submitted a second time.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time
import zipfile

SPEC = importlib.util.spec_from_file_location('engine_boundary', Path(__file__).with_name('engine-boundary.py'))
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)
require, secure, persist, command = BASE.require, BASE.secure, BASE.persist, BASE.command
CONFIG = Path('/etc/club-arena-release-controller/engine-staging.json')
STATE = Path('/var/lib/club-arena/engine-provider-staging')
UNIT = 'club-arena-engine-stage-v1@.service'
BUILD_LOCK = Path('/var/lock/club-arena-engine-build.lock')
LIMIT = 3 * 1024 * 1024 * 1024


def digest_file(path):
    h = hashlib.sha256()
    with secure(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return 'sha256:' + h.hexdigest()


def sync_file(path):
    with path.open('rb') as source:
        os.fsync(source.fileno())


def directory_sync(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def check(envelope, config):
    require(re.fullmatch(r'[0-9a-f-]{36}', envelope['operation_id']))
    require(re.fullmatch(r'[0-9a-f-]{36}', envelope['epoch']))
    r = envelope['request']
    require(r['target'] == 'club-arena-engine' and r['control_sha'] == config['trusted_control_sha'])
    require(all(re.fullmatch(r'[0-9a-f]{40}', r[k]) for k in ('source_sha', 'control_sha', 'server_tree_sha')))
    require(re.fullmatch(r'[0-9a-f]{64}', r['manifest_digest']))
    require(re.fullmatch(r'[1-9][0-9]*-1', r['run_key']))
    require(re.fullmatch(r'[1-9][0-9]*', r['github_artifact_id']))
    require(re.fullmatch(r'[0-9a-f-]{36}', r['build_operation_id']))
    require(all(re.fullmatch(r'sha256:[0-9a-f]{64}', r[k]) for k in
                ('archive_digest', 'github_archive_digest', 'artifact_image_id')))
    require(all(type(r[k]) is int and 0 < r[k] <= LIMIT for k in ('archive_bytes', 'github_archive_bytes')))
    require(type(r['not_after_epoch']) is int)
    control_root = Path('/opt/club-arena-release-controls') / r['control_sha']
    scripts = secure(control_root / 'server/scripts', file=False)
    files = {p.relative_to(scripts).as_posix(): p for p in scripts.rglob('*') if p.is_file() or p.is_symlink()}
    require(set(files) == set(config['control_files']))
    for name, path in files.items():
        require(digest_file(path) == 'sha256:' + config['control_files'][name])
    return r, scripts


def unit_state(operation_id):
    result = command(['/usr/bin/systemctl', 'show', UNIT.replace('@.', '@' + operation_id + '.'),
                      '-p', 'LoadState', '-p', 'ActiveState', '-p', 'Job'])
    require(result.returncode == 0)
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)


def inspect_image(identity, r):
    result = command(['/usr/bin/docker', 'image', 'inspect', '--format', '{{json .}}', identity])
    if result.returncode != 0:
        return False
    image = json.loads(result.stdout)
    labels = image.get('Config', {}).get('Labels', {})
    require(image['Id'] == r['artifact_image_id'])
    require(labels.get('org.opencontainers.image.revision') == r['source_sha'])
    require(labels.get('com.smarterpoker.engine.source-tree') == r['server_tree_sha'])
    require(labels.get('com.smarterpoker.engine.build-contract') == 'clean-server-archive-v1')
    return True


def prior_seal(scripts, r):
    for field, expected in [('desired-sha', r['expected_current']['source_sha']),
                            ('desired-image-id', r['expected_current']['image_id'])]:
        actual = command([scripts / 'engine-release-seal.py', 'get', field])
        require(actual.returncode == 0 and actual.stdout.strip() == expected)


def preflight(envelope, config):
    r, scripts = check(envelope, config)
    require(time.time() < r['not_after_epoch'] <= time.time() + 21600)
    require(command(['/usr/bin/systemd-analyze', 'verify', secure(Path('/etc/systemd/system') / UNIT)]).returncode == 0)
    prior_seal(scripts, r)
    return {'ready': True, **r['expected_current']}


def current(envelope, config):
    r, scripts = check(envelope, config)
    values = {}
    for field, key in [('desired-sha', 'source_sha'), ('desired-image-id', 'image_id')]:
        result = command([scripts / 'engine-release-seal.py', 'get', field])
        require(result.returncode == 0)
        values[key] = result.stdout.strip()
    return values


def receive(envelope, stream, config):
    r, scripts = check(envelope, config)
    require(time.time() < r['not_after_epoch'] <= time.time() + 21600)
    require(command(['/usr/bin/systemd-analyze', 'verify', secure(Path('/etc/systemd/system') / UNIT)]).returncode == 0)
    prior_seal(scripts, r)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    secure(STATE, file=False)
    require(shutil.disk_usage(STATE).free > 3 * r['archive_bytes'] + r['github_archive_bytes'] + 2 * 1024**3)
    folder = STATE / envelope['operation_id']
    folder.mkdir(mode=0o700, exist_ok=True)
    secure(folder, file=False)
    with (folder / 'receive.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not persist(folder / 'intent.json', envelope):
            return {'terminal': False, 'reason': 'EXISTING_STAGE_INTENT_REQUIRES_READBACK'}
        destination = folder / 'artifact.zip'
        h = hashlib.sha256()
        remaining = r['github_archive_bytes']
        with destination.open('xb') as output:
            while remaining:
                block = stream.read(min(1024 * 1024, remaining))
                require(block)
                output.write(block)
                h.update(block)
                remaining -= len(block)
            require(not stream.read(1))
            output.flush()
            os.fsync(output.fileno())
        require('sha256:' + h.hexdigest() == r['github_archive_digest'])
        persist(folder / 'archive-accepted.json', {'github_archive_digest': r['github_archive_digest']})
        directory_sync(folder)
        result = command(['/usr/bin/systemctl', 'start', '--no-block', UNIT.replace('@.', '@' + envelope['operation_id'] + '.')])
        require(result.returncode == 0)
        return {'terminal': False, 'reason': 'NATIVE_STAGE_ACCEPTED_REQUIRES_READBACK'}


def extract_archive(folder, r):
    source = secure(folder / 'artifact.zip')
    require(digest_file(source) == r['github_archive_digest'])
    destination = folder / 'engine-image.tar'
    if destination.exists():
        require(destination.stat().st_size == r['archive_bytes'] and digest_file(destination) == r['archive_digest'])
        return destination
    temporary = folder / 'engine-image.tar.partial'
    if temporary.exists():
        secure(temporary).unlink()
    with zipfile.ZipFile(source) as archive:
        members = archive.infolist()
        require(len(members) == 1 and members[0].filename == 'engine-image.tar' and
                members[0].file_size == r['archive_bytes'] and not members[0].flag_bits & 1)
        with archive.open(members[0]) as input_file, temporary.open('xb') as output:
            shutil.copyfileobj(input_file, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
    require(temporary.stat().st_size == r['archive_bytes'] and digest_file(temporary) == r['archive_digest'])
    os.replace(temporary, destination)
    directory_sync(folder)
    # Docker save must contain one exact image and only the trusted build tag.
    with tarfile.open(destination, mode='r:') as archive:
        member = archive.getmember('manifest.json')
        require(member.isfile() and member.size <= 65536)
        manifest = json.load(archive.extractfile(member))
        require(len(manifest) == 1 and manifest[0]['RepoTags'] == ['club-arena-release-candidate:' + r['build_operation_id']])
        config = archive.getmember(manifest[0]['Config'])
        require(config.isfile() and config.size <= 2 * 1024 * 1024)
        require('sha256:' + hashlib.sha256(archive.extractfile(config).read()).hexdigest() == r['artifact_image_id'])
    return destination


def apply(operation_id, config):
    with BUILD_LOCK.open('a') as lock:
        deadline = time.monotonic() + 30
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                require(time.monotonic() < deadline)
                time.sleep(0.1)
        return apply_locked(operation_id, config)


def apply_locked(operation_id, config):
    require(re.fullmatch(r'[0-9a-f-]{36}', operation_id))
    folder = secure(STATE / operation_id, file=False)
    envelope = json.loads(secure(folder / 'intent.json').read_text())
    r, scripts = check(envelope, config)
    require(envelope['operation_id'] == operation_id)
    with (folder / 'apply.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (folder / 'result.json').exists():
            return json.loads(secure(folder / 'result.json').read_text())
        require(time.time() < r['not_after_epoch'])
        require((folder / 'archive-accepted.json').exists())
        archive = extract_archive(folder, r)
        prior_seal(scripts, r)
        if not inspect_image(r['artifact_image_id'], r):
            if not persist(folder / 'load-intent.json', {'image_id': r['artifact_image_id'], 'archive_digest': r['archive_digest']}):
                return {'terminal': False, 'reason': 'DOCKER_LOAD_OUTCOME_UNKNOWN'}
            result = subprocess.run(['/usr/bin/docker', 'load', '--input', str(archive)], env=BASE.ENV,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1200, check=False)
            require(result.returncode == 0 and inspect_image(r['artifact_image_id'], r))
        require(command(['/usr/bin/docker', 'tag', r['artifact_image_id'], 'club-arena-engine:' + r['source_sha']]).returncode == 0)
        stage = BASE.STAGING / r['run_key']
        if not stage.exists():
            stage.mkdir(mode=0o700, parents=True)
            shutil.copytree(scripts, stage / 'server/scripts')
            for item in (stage / 'server/scripts').rglob('*'):
                if item.is_file():
                    sync_file(item)
            for item in sorted([p for p in stage.rglob('*') if p.is_dir()], reverse=True):
                directory_sync(item)
            directory_sync(stage)
            directory_sync(stage.parent)
        staged_files = {p.relative_to(stage / 'server/scripts').as_posix(): p for p in (stage / 'server/scripts').rglob('*') if p.is_file() or p.is_symlink()}
        require(set(staged_files) == set(config['control_files']))
        for name, item in staged_files.items():
            require(digest_file(item) == 'sha256:' + config['control_files'][name])
        BASE.LEASE_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
        secure(BASE.LEASE_ROOT, file=False)
        lease = BASE.LEASE_ROOT / (r['run_key'] + '.lease')
        raw = (r['source_sha'] + '\n').encode()
        if lease.exists():
            require(secure(lease).read_bytes() == raw)
        else:
            with lease.open('xb') as output:
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
            directory_sync(lease.parent)
        prior_seal(scripts, r)
        result = {'terminal': True, 'outcome': 'SUCCEEDED', 'operation_id': operation_id,
                  'source_sha': r['source_sha'], 'control_sha': r['control_sha'], 'run_key': r['run_key'],
                  'image_id': r['artifact_image_id'], 'archive_digest': r['archive_digest']}
        persist(folder / 'result.json', result)
        return result


def observe(envelope, config):
    r, _ = check(envelope, config)
    folder = STATE / envelope['operation_id']
    if not folder.exists():
        return {'terminal': False, 'reason': 'NO_NATIVE_STAGE_RECEIPT'}
    require(json.loads(secure(folder / 'intent.json').read_text()) == envelope)
    if (folder / 'result.json').exists():
        return json.loads(secure(folder / 'result.json').read_text())
    state = unit_state(envelope['operation_id'])
    if state.get('ActiveState') in ('activating', 'active', 'deactivating') or state.get('Job') not in ('0', '', None):
        return {'terminal': False, 'reason': 'NATIVE_STAGE_RUNNING'}
    # A receiver still streaming bytes may be the only live native process.
    with (folder / 'receive.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'terminal': False, 'reason': 'NATIVE_TRANSFER_RUNNING'}
        loaded = (folder / 'load-intent.json').exists()
        image_present = inspect_image(r['artifact_image_id'], r) if loaded else False
        if not (folder / 'archive-accepted.json').exists() or (time.time() >= r['not_after_epoch'] and (not loaded or image_present)):
            # The receiver is gone, the native unit has no job, and either no
            # load was admitted or its exact image is now visible. Future
            # native retries fail their immutable deadline before mutation.
            result = {'terminal': True, 'outcome': 'FAILED', 'operation_id': envelope['operation_id'],
                      'source_sha': r['source_sha'], 'control_sha': r['control_sha'], 'run_key': r['run_key'],
                      'image_id': r['artifact_image_id'], 'archive_digest': r['archive_digest'],
                      'reason': 'TRANSFER_ENDED_OR_STAGE_DEADLINE_EXPIRED'}
            persist(folder / 'result.json', result)
            return result
        if loaded:
            if image_present:
                return apply(envelope['operation_id'], config)
            return {'terminal': False, 'reason': 'DOCKER_LOAD_OUTCOME_UNKNOWN'}
        # Archive acceptance is durable. The same bounded native service can
        # resume after a receiver crash before its systemd acknowledgment.
        require(time.time() < r['not_after_epoch'])
        result = command(['/usr/bin/systemctl', 'start', '--no-block', UNIT.replace('@.', '@' + envelope['operation_id'] + '.')])
        require(result.returncode == 0)
        return {'terminal': False, 'reason': 'NATIVE_STAGE_REATTACHED'}


if __name__ == '__main__':
    try:
        require(os.geteuid() == 0 and len(sys.argv) >= 2)
        config = json.loads(secure(CONFIG).read_text())
        if sys.argv[1] == 'apply':
            result = apply(sys.argv[2], config)
        else:
            header = sys.stdin.buffer.readline(65538)
            require(header.endswith(b'\n') and len(header) <= 65536)
            envelope = json.loads(header)
            if sys.argv[1] == 'receive':
                result = receive(envelope, sys.stdin.buffer, config)
            elif sys.argv[1] == 'current':
                result = current(envelope, config)
            elif sys.argv[1] == 'preflight':
                result = preflight(envelope, config)
            elif sys.argv[1] == 'observe':
                result = observe(envelope, config)
            else:
                raise ValueError('Unsupported operation')
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'terminal': False, 'error': 'RELEASE_ENGINE_STAGE_UNRESOLVED'}))
        sys.exit(1)
