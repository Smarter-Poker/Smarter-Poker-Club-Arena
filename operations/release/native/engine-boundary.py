#!/usr/bin/python3
"""Installed, forced-command, one-shot adapter for the existing frozen intake.

It does not build, stage candidate code, install another coordinator, edit v1
units/contracts, cancel a release, or infer failure from SSH/systemd timeouts.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

CONFIG = Path('/etc/club-arena-release-controller/engine-boundary.json')
STAGING = Path('/var/lib/club-arena/control-staging')
STATE = Path('/var/lib/club-arena/release-provider-operations')
LEASE_ROOT = Path('/var/lib/club-arena/engine-image-leases')
ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
       'ENGINE_RELEASE_OBSERVE_SECONDS': '30', 'ENGINE_RELEASE_INVOCATION_WAIT_SECONDS': '15'}
POLICY_BYTES = (Path(__file__).resolve().parents[1] / 'operationPolicy.json').read_bytes()
if hashlib.sha256(POLICY_BYTES).hexdigest() != '1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda':
    raise ValueError('RELEASE_OPERATION_POLICY_MISMATCH')
POLICY = json.loads(POLICY_BYTES)

def require(value):
    if not value:
        raise ValueError('RELEASE_ENGINE_BOUNDARY_REFUSED')

def secure(path, file=True):
    path = Path(path)
    for entry in [path, *path.parents]:
        info = entry.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode))
    require(not file or path.is_file())
    return path

def command(argv, timeout=35):
    # No inherited .env, no candidate PATH, no shell, and no raw child logs.
    return subprocess.run([str(a) for a in argv], env=ENV, capture_output=True,
                          timeout=timeout, check=False, text=True)

def persist(path, data):
    raw = json.dumps(data, sort_keys=True, separators=(',', ':')).encode()
    if path.exists():
        require(secure(path).read_bytes() == raw)
        return False
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return True

def retired(run):
    for directory, suffix in [('engine-intake-requests', '.intent'), ('engine-intake-requests', '.request'),
                              ('engine-release-requests', '.request'), ('engine-release-generation-pins', '.generation'),
                              ('engine-image-leases', '.lease')]:
        if (Path('/var/lib/club-arena') / directory / (run + suffix)).exists():
            return False
    for unit in ['club-arena-engine-release-v1@' + run + '.service',
                 'club-arena-engine-intake-v1@' + run + '.service', 'club-arena-engine-intake-v1@' + run + '.path']:
        active = command(['/usr/bin/systemctl', 'show', unit, '-p', 'ActiveState', '--value'])
        enabled = command(['/usr/bin/systemctl', 'is-enabled', unit])
        if active.stdout.strip() not in ('inactive', 'failed') or enabled.stdout.strip() not in ('disabled', 'not-found'):
            return False
    return True

def maintenance_proof(observed, envelope, config):
    r = envelope['request']
    retained = command(['/usr/bin/docker', 'image', 'inspect', '--format', '{{json .}}', r['expected_current']['image_id']])
    require(retained.returncode == 0)
    retained = json.loads(retained.stdout)
    require(retained.get('Id') == r['expected_current']['image_id'])
    require(retained.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') == r['expected_current']['source_sha'])
    recovery = config['maintenance_recovery']
    require(all(type(recovery[k]) is int and 0 < recovery[k] <= POLICY['recoveryReserveMs']
                for k in ('actual_recovery_ms', 'recovery_margin_ms')))
    require(recovery['actual_recovery_ms'] + recovery['recovery_margin_ms'] <= POLICY['recoveryReserveMs'])
    require(isinstance(recovery['receipt_refs'], list) and recovery['receipt_refs'] and
            all(isinstance(ref, str) and 0 < len(ref) <= 512 for ref in recovery['receipt_refs']))
    proof = {'observation': observed, 'retained_source_sha': r['expected_current']['source_sha'],
             'retained_image_id': retained['Id'], 'recovery': recovery, 'observed_at_ms': int(time.time() * 1000)}
    proof['digest'] = hashlib.sha256(json.dumps(proof, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return proof

def dispatch(action, envelope, config):
    if action in ('maintenance-need', 'maintenance-safe-resume'):
        # Read-only proof entry point for the independently credentialed verifier.
        # No caller-supplied compatibility or timing assertion is accepted.
        safe_resume = action == 'maintenance-safe-resume'
        observed = dispatch('observe' if safe_resume else 'preflight', envelope, config)
        require(observed.get('terminal') is True and observed.get('outcome') == 'SUCCEEDED'
                if safe_resume else observed.get('ready') is True)
        return maintenance_proof(observed, envelope, config)
    require(action in ('preflight', 'submit', 'observe'))
    require(re.fullmatch(r'[a-f0-9-]{36}', envelope['operation_id']))
    require(re.fullmatch(r'[a-f0-9-]{36}', envelope['epoch']))
    r = envelope['request']
    require(r['target'] == 'club-arena-engine')
    require(re.fullmatch(r'[a-f0-9]{40}', r['source_sha']))
    require(r['control_sha'] == config['trusted_control_sha'])
    require(re.fullmatch(r'[a-f0-9]{40}', r['control_sha']))
    require(re.fullmatch(r'[a-f0-9]{64}', r['manifest_digest']))
    require(re.fullmatch(r'[1-9][0-9]*-[1-9][0-9]*', r['run_key']))
    require(re.fullmatch(r'[\x20-\x7e]{1,128}', r['actor']))
    require(type(r['not_after_epoch']) is int)
    stage = secure(STAGING / r['run_key'], file=False)
    scripts = secure(stage / 'server/scripts', file=False)
    # Every file in the staged script directory is covered by the independently
    # installed manifest, including helpers imported by the frozen scripts.
    files = {p.relative_to(scripts).as_posix(): p for p in scripts.rglob('*') if p.is_file() or p.is_symlink()}
    require(set(files) == set(config['control_files']))
    for name, path in files.items():
        require(hashlib.sha256(secure(path).read_bytes()).hexdigest() == config['control_files'][name])
    seal = scripts / 'engine-release-seal.py'
    def get(field):
        result = command([seal, 'get', field])
        require(result.returncode == 0)
        return result.stdout.strip()
    if action in ('preflight', 'submit'):
        # A separately qualified stager must already hold the existing v1 image
        # lease. This wrapper neither invents a new lease format nor builds an
        # unqualified replacement after a prune between readiness and intake.
        require(secure(LEASE_ROOT / (r['run_key'] + '.lease')).read_text() == r['source_sha'] + '\n')
        units = ['club-arena-engine-release-v1@.service', 'club-arena-engine-intake-v1@.service', 'club-arena-engine-intake-v1@.path']
        unit_paths = [secure(Path('/etc/systemd/system') / name) for name in units]
        require(command(['/usr/bin/systemd-analyze', 'verify', *unit_paths]).returncode == 0)
        for name in units:
            loaded = command(['/usr/bin/systemctl', 'show', name.replace('@.', '@' + r['run_key'] + '.'), '-p', 'LoadState', '--value'])
            require(loaded.returncode == 0 and loaded.stdout.strip() == 'loaded')
        require(time.time() < r['not_after_epoch'] <= time.time() + 21600)
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', r['artifact_image_id']))
        require(re.fullmatch(r'[a-f0-9]{40}', r['server_tree_sha']))
        image = command(['/usr/bin/docker', 'image', 'inspect', '--format', '{{json .}}', 'club-arena-engine:' + r['source_sha']])
        require(image.returncode == 0)
        image = json.loads(image.stdout)
        labels = image.get('Config', {}).get('Labels', {})
        require(image.get('Id') == r['artifact_image_id'])
        require(labels.get('org.opencontainers.image.revision') == r['source_sha'])
        require(labels.get('com.smarterpoker.engine.source-tree') == r['server_tree_sha'])
        require(labels.get('com.smarterpoker.engine.build-contract') == 'clean-server-archive-v1')
        require(get('desired-sha') == r['expected_current']['source_sha'])
        require(get('desired-image-id') == r['expected_current']['image_id'])
        if action == 'preflight':
            return {'ready': True, 'source_sha': get('desired-sha'), 'image_id': get('desired-image-id')}
        # Immutable host correlation is a new sidecar, not a v1 request change.
        # An ambiguous first attempt is never replayed by this wrapper.
        STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
        secure(STATE, file=False)
        with open(STATE / 'submit.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not persist(STATE / (r['run_key'] + '.json'), envelope):
                return {'accepted': None, 'reason': 'EXISTING_HOST_INTENT_REQUIRES_READBACK'}
            require(get('desired-sha') == r['expected_current']['source_sha'])
            require(get('desired-image-id') == r['expected_current']['image_id'])
            result = command([scripts / 'install-engine-intake.sh', '--target-sha', r['source_sha'],
                              '--control-sha', r['control_sha'], '--run-id', r['run_key'],
                              '--actor', r['actor'], '--not-after-epoch', str(r['not_after_epoch'])])
            return {'accepted': result.returncode == 0, 'requires_readback': True}
    base = {'operation_id': envelope['operation_id'], 'run_key': r['run_key'],
            'source_sha': r['source_sha'], 'control_sha': r['control_sha'], 'terminal': False}
    receipt = STATE / (r['run_key'] + '.json')
    if not receipt.exists():
        return base
    require(secure(receipt).read_bytes() == json.dumps(envelope, sort_keys=True, separators=(',', ':')).encode())
    failure = command([seal, 'attest-failure', '--sha', r['source_sha'], '--run-id', r['run_key'], '--control-sha', r['control_sha']])
    if failure.returncode == 0:
        parts = failure.stdout.split()
        require(len(parts) == 7 and parts[0] == 'failed' and parts[1] == r['source_sha'] and parts[2] == r['control_sha'])
        require(re.fullmatch(r'[a-f0-9]{32}', parts[3]) and re.fullmatch(r'[1-9][0-9]*', parts[4]))
        require(re.fullmatch(r'[a-f0-9]{40}', parts[5]) and re.fullmatch(r'sha256:[a-f0-9]{64}', parts[6]))
        if not retired(r['run_key']):
            return base
        require(get('desired-sha') == parts[5] and get('desired-image-id') == parts[6])
        return {**base, 'terminal': True, 'outcome': 'FAILED', 'recovered_sha': parts[5], 'image_id': parts[6]}
    result = command([scripts / 'observe-engine-release.sh', '--sha', r['source_sha'], '--run-id', r['run_key']])
    if result.returncode != 0:
        return base
    values = dict(line.split('=', 1) for line in result.stdout.splitlines() if line.startswith('ENGINE_RELEASE_') and '=' in line)
    require(values.get('ENGINE_RELEASE_UNIT_RESULT') == 'success' and values.get('ENGINE_RELEASE_SHA') == r['source_sha'])
    require(values.get('ENGINE_RELEASE_RESULT') in ('sealed', 'already-released'))
    attestation = command([seal, 'attest-result', '--sha', r['source_sha'], '--run-id', r['run_key']])
    parts = attestation.stdout.split()
    require(attestation.returncode == 0 and len(parts) == 7 and parts[0] == values['ENGINE_RELEASE_RESULT'])
    require(parts[1] == r['source_sha'] and parts[2] == r['artifact_image_id'] and parts[6] == r['control_sha'])
    require(get('desired-image-id') == r['artifact_image_id'])
    return {**base, 'terminal': True, 'outcome': 'SUCCEEDED', 'result': parts[0], 'image_id': parts[2]}

if __name__ == '__main__':
    try:
        require(os.geteuid() == 0 and len(sys.argv) == 2)
        raw = sys.stdin.buffer.read(65537)
        require(len(raw) <= 65536)
        print(json.dumps(dispatch(sys.argv[1], json.loads(raw), json.loads(secure(CONFIG).read_text()))))
    except Exception:
        print(json.dumps({'error': 'RELEASE_ENGINE_BOUNDARY_REFUSED'}))
        sys.exit(1)
