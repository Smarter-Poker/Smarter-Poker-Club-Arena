#!/usr/bin/env python3
"""One-shot candidate-only scale qualification in the existing prewarm route.

Never imports application code, opens Inspector, starts an engine or reads its
configuration. A positive receipt qualifies this immutable synthetic fixture,
not production custody or a maintenance certificate. Unknown cleanup is terminal.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import stat
import subprocess
import sys
import time
import urllib.request
import urllib.error

GIB = 1024 ** 3
CAP = 36 * GIB
HOST_MARGIN = 8 * GIB
OUTPUT_CAP = 128 * 1024
ROOT = Path(__file__).resolve().parent
STATE = Path('/var/lib/club-arena/native-census-scale')
LABEL = 'com.smarterpoker.qualification.native-census-scale'
LEGACY = frozenset((
    '2f4e33560bcd23bfb5cc731f31816b2c2e2847e5',
    '758610f3f844406bbbaee2f5100ced36d84fb943',
    'a0ab287d902879280f0c915e44f5222c5db4d7df',
    '8825af51817f379c4261658ca29ecc9d8d81932d',
    'eed06fe51dea622069c661a6213d5b031ff3a9e3'))
PROFILE = {'memoryBytes': CAP, 'swapBytes': 0, 'cpu': 1, 'pids': 32,
           'hostMarginBytes': HOST_MARGIN, 'queryMs': 20000, 'fixtureAndCleanupMs': 40000,
           'cleanupReserveMs': 5000, 'cardinality': 35000000, 'oldSpaceMiB': 4000,
           'semiSpaceMiB': 1, 'outputCapBytes': OUTPUT_CAP}


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def command(args, timeout=5, check=True):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, text=True)
    require(len(result.stdout) + len(result.stderr) <= OUTPUT_CAP, 'metadata output exceeded bound')
    if check:
        require(result.returncode == 0, 'bounded metadata command failed: ' + args[0])
    return result


def serving(run_id):
    # Only selected fields, never Config.Env or a full production inspect.
    template = '{{json .Id}} {{json .Image}} {{json .State.Status}} {{json .State.StartedAt}} {{json (index .Config.Labels "org.opencontainers.image.revision")}}'
    fields = command(['docker', 'inspect', '--format', template, 'club-arena-engine']).stdout.strip()
    decoder = json.JSONDecoder()
    values = []
    while fields:
        item, end = decoder.raw_decode(fields)
        values.append(item)
        fields = fields[end:].lstrip()
    require(len(values) == 5, 'serving container identity malformed')
    container, image, status, started, revision = values
    require(re.fullmatch(r'[0-9a-f]{64}', container or '') and
            re.fullmatch(r'sha256:[0-9a-f]{64}', image or '') and status == 'running' and
            re.fullmatch(r'[0-9a-f]{40}', revision or '') and started, 'serving container identity unknown')
    seal = command([sys.executable, str(ROOT / 'engine-release-seal.py'),
                    'classify-running', '--with-sha']).stdout.strip().split()
    require(seal == ['desired', revision], 'actual serving image and desired seal disagree')
    pending = command([sys.executable, str(ROOT / 'engine-release-seal.py'), 'pending-owner']).stdout.strip().split()
    require(pending == ['none'] or (len(pending) == 4 and pending[0] == 'active' and
            pending[1] == run_id and pending[2] == 'false' and pending[3].isdigit() and
            int(pending[3]) > time.time()), 'unknown or competing pending release owner')
    try:
        response = urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=5)
    except urllib.error.HTTPError as exc:
        # A degraded 503 preserves the same authoritative identity body.
        require(exc.code == 503, 'serving health refused')
        response = exc
    with response:
        require(response.status in (200, 503), 'serving health refused')
        raw = response.read(1024 * 1024 + 1)
    require(len(raw) <= 1024 * 1024, 'serving health exceeded bound')
    health = json.loads(raw)
    require(health.get('running') is True and health.get('releaseSha') == revision and
            re.fullmatch(r'[1-9][0-9]*-[0-9a-f]{8}', str(health.get('instanceId', ''))),
            'local health and protected serving identity disagree')
    # Retain no tables, hands, environment or health business payload.
    return {'container': container, 'image': image, 'revision': revision,
            'startedAt': started, 'instanceId': health['instanceId']}


def candidate_identity(image):
    template = '{{json .Id}} {{json (index .Config.Labels "org.opencontainers.image.revision")}} {{json (index .Config.Labels "com.smarterpoker.engine.source-tree")}} {{json (index .Config.Labels "com.smarterpoker.engine.build-contract")}}'
    raw = command(['docker', 'image', 'inspect', '--format', template, image]).stdout.strip()
    decoder, values = json.JSONDecoder(), []
    while raw:
        value, end = decoder.raw_decode(raw)
        values.append(value)
        raw = raw[end:].lstrip()
    require(len(values) == 4 and values[0] == image and
            all(re.fullmatch(r'[0-9a-f]{40}', str(value)) for value in values[1:3]) and
            values[3] == 'clean-server-archive-v1', 'candidate immutable image metadata refused')
    return dict(zip(('image', 'revision', 'serverTree', 'buildContract'), values))


def secure_directory(path):
    # Every component must already be root-owned and not group/world writable.
    for part in [*reversed(path.parents), path]:
        if part == path and not part.exists():
            part.mkdir(mode=0o700)
            # Persist the namespace before the one-shot intent can authorize
            # Docker creation; fsync(intent/STATE) alone misses this mkdir.
            for directory in (part, part.parent):
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        info = part.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'qualification state directory ownership refused')


def read_state(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and
                info.st_size <= OUTPUT_CAP, 'qualification receipt custody refused')
        return json.load(stream)


def write_state(path, value, exclusive=False):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    temporary = path if exclusive else path.with_suffix('.pending')
    fd = os.open(temporary, flags, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    if not exclusive:
        os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def daemon_lists_no_container(name, timeout):
    # Authoritative absence that does not depend on CLI wording: the daemon
    # answered (exit 0) and lists no container by this exact name.
    listing = command(['docker', 'ps', '--all', '--no-trunc', '--filter', 'name=^/?' + re.escape(name) + '$',
                       '--format', '{{.ID}}'], timeout=timeout, check=False)
    return listing.returncode == 0 and listing.stdout.strip() == ''


def inspect_own(name, key, timeout):
    result = command(['docker', 'inspect', '--format',
                      '{{json .Id}} {{json (index .Config.Labels "' + LABEL + '")}}', name],
                     timeout=timeout, check=False)
    if result.returncode:
        # 2026-10-31: the first production run (receiver 41226449485) removed
        # its container and then refused here, because the host Docker CLI's
        # not-found wording did not match the exact capitalised strings. A
        # not-found answer in any case is absence; anything else is confirmed
        # against the daemon's own listing, and an unconfirmed answer is still
        # unknown.
        stderr = result.stderr.lower()
        require('no such object' in stderr or 'no such container' in stderr or
                daemon_lists_no_container(name, timeout),
                'owned disposable container state unknown')
        return False
    values = result.stdout.strip().split()
    require(len(values) == 2 and json.loads(values[1]) == key and
            re.fullmatch(r'[0-9a-f]{64}', json.loads(values[0])), 'disposable container ownership refused')
    return True


def cleanup(name, key, deadline):
    def remaining():
        value = deadline - time.monotonic()
        require(value > 0, 'disposable cleanup deadline exhausted')
        return min(value, 1.5)
    observed = inspect_own(name, key, remaining())
    if observed:
        command(['docker', 'rm', '-f', name], timeout=remaining())
    require(not inspect_own(name, key, remaining()), 'disposable cleanup not proved')
    return observed


def validate_result(result, fixture_sha):
    require(result.get('schema') == 'legacy-native-scale-fixture/v1' and result.get('ok') is True and
            result.get('qualification') == 'synthetic-cardinality-and-memory-only' and
            result.get('fixtureSHA256') == fixture_sha and result.get('count') == 35000000 and
            result.get('prototypeRestored') is True and result.get('matched') == 11 and
            result.get('node') == 'v22.23.2' and result.get('v8') == '12.4.254.21-node.56' and
            result.get('platform') == 'linux' and result.get('arch') in ('x64', 'arm64') and
            result.get('sourceSHA256') == 'cbd7279fc6595a31bd2044769d2ad85684d63713351acd0bb602dbfcdbdce31e' and
            re.fullmatch(r'[0-9a-f]{64}', result.get('binarySHA256', '')),
            'scale fixture identity or completeness refused')
    before, attempt = result['before'], result['attempt']
    require(before['used'] >= 3913011648 and 32 * 1024 ** 2 + 772608 <= before['available'] <= 322107592 and
            before['process'] >= 8 * before['used'] + 32 * 1024 ** 2 and
            0 < result['queryMs'] <= 20000 and 0 < result['fixtureMs'] <= 35000 and
            0 < result['cgroupPeak'] <= CAP and result['maxRSSKiB'] > 0 and
            attempt['predicateVisits'] >= 35000000 and attempt['arrayAllocated'] is True and
            attempt['deadlineRefused'] is False and result['cgroup'] == {
                'memoryMax': str(CAP), 'swapMax': '0', 'cpuMax': '100000 100000', 'pidsMax': '32'},
            'actual scale measurements, resource controls or reserve refused')


def main(image, run_id, deadline):
    require(os.geteuid() == 0 and sys.platform == 'linux', 'supported Linux provider identity required')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', image) and
            re.fullmatch(r'[1-9][0-9]*(-[1-9][0-9]*)?', run_id) and str(deadline).isdigit(), 'invalid scale identity')
    require(int(deadline) - time.time() > 60, 'insufficient preactivation scale preparation budget')
    before_serving = serving(run_id)
    if before_serving['revision'] not in LEGACY:
        require(serving(run_id) == before_serving, 'serving identity changed during nonlegacy classification')
        print('ENGINE_NATIVE_SCALE=' + json.dumps({'status':'not-required-authoritative-nonlegacy',
                                                  'serving': before_serving}, sort_keys=True))
        return
    candidate = candidate_identity(image)
    fixture_sha = digest((ROOT / 'legacy-census-scale-fixture.mjs').read_bytes())
    binding = {'schema':'legacy-native-scale-binding/v1', 'image':image, 'fixtureSHA256':fixture_sha,
               'controllerSHA256':digest(Path(__file__).read_bytes()), 'profile':PROFILE}
    key = digest(json.dumps(binding, sort_keys=True).encode())
    name = 'ca-native-scale-' + key[:32]
    secure_directory(STATE)
    lock_fd = os.open(STATE / 'resource.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'r+') as lock:
        info = os.fstat(lock.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'qualification resource lock custody refused')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        receipt_path, intent_path = STATE / (key + '.json'), STATE / (key + '.intent')
        if receipt_path.exists():
            receipt = read_state(receipt_path)
            require(receipt.get('binding') == binding, 'existing scale receipt binding refused')
            if receipt.get('status') != 'qualified' and receipt.get('cleanupProved') is not True:
                intent = read_state(intent_path)
                require(intent.get('binding') == binding and intent.get('container') == name,
                        'unresolved scale cleanup custody refused')
                require(cleanup(name, key, time.monotonic() + 5),
                        'prior creation acknowledgement remains unknown; no automatic repeat')
                raise RuntimeError('prior refused scale cleanup proved; no automatic repeat')
            require(receipt.get('candidate') == candidate and receipt.get('status') == 'qualified' and
                    receipt.get('cleanupProved') is True and 0 < receipt.get('elapsedMs', 0) <= 40000,
                    'existing scale outcome is not a qualified receipt; no automatic retry')
            validate_result(receipt['result'], fixture_sha)
            require(serving(run_id) == before_serving, 'serving identity changed before receipt reuse')
            print('ENGINE_NATIVE_SCALE=' + json.dumps({'status':'reused-qualified', 'receipt':str(receipt_path),
                                                      'binding':binding}, sort_keys=True))
            return
        if intent_path.exists():
            intent = read_state(intent_path)
            require(intent.get('binding') == binding and intent.get('container') == name,
                    'existing one-shot intent custody refused')
            require(cleanup(name, key, time.monotonic() + 5),
                    'prior creation acknowledgement remains unknown; no automatic repeat')
            raise RuntimeError('prior scale intent has no positive receipt; own cleanup proved, no automatic repeat')
        require(serving(run_id) == before_serving, 'serving identity changed before allocation')
        available = re.search(r'^MemAvailable:\s+([0-9]+) kB$', Path('/proc/meminfo').read_text(), re.M)
        require(available and int(available[1]) * 1024 >= CAP + HOST_MARGIN,
                'real host headroom below 36 GiB allocation plus 8 GiB live-host margin')
        write_state(intent_path, {'binding':binding, 'container':name, 'runId':run_id,
                                 'hostAvailableBytes':int(available[1])*1024, 'at':time.time()}, exclusive=True)
        started = time.monotonic()
        cleanup_deadline = started + 40
        output_path = STATE / (key + '.output')
        result, error, cleanup_ok = None, None, False
        execution_acknowledged, observed_container = False, False
        try:
            def cap_output():
                resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_CAP, OUTPUT_CAP))
                resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            with open(output_path, 'xb', buffering=0) as output:
                os.chmod(output_path, 0o600)
                args = ['docker', 'run', '--pull', 'never', '--name', name, '--label', LABEL+'='+key,
                        '--restart', 'no', '--no-healthcheck', '--network', 'none', '--read-only', '--memory', str(CAP),
                        '--memory-swap', str(CAP), '--cpus', '1', '--pids-limit', '32', '--log-driver', 'none',
                        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534',
                        '--tmpfs', '/tmp:rw,noexec,nosuid,size=1m', '--ulimit', 'core=0:0',
                        '--entrypoint', '/usr/bin/env', image, '-i', '/usr/local/bin/node',
                        '--max-old-space-size=4000', '--max-semi-space-size=1',
                        '/app/native/legacy-census/scale-fixture.mjs', fixture_sha,
                        str(int((time.time() + 35) * 1000))]
                execution = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=output,
                                           stderr=output, timeout=max(0.1, 35-(time.monotonic()-started)),
                                           preexec_fn=cap_output)
                execution_acknowledged = True
                require(execution.returncode == 0, 'disposable fixed scale fixture failed; no automatic retry')
            require(output_path.stat().st_size <= OUTPUT_CAP, 'fixture output exceeded bound')
            result = json.loads(output_path.read_text())
            validate_result(result, fixture_sha)
        except Exception as exc:
            error = str(exc)
        finally:
            try:
                observed_container = cleanup(name, key, cleanup_deadline)
                # Absence after an unknown Docker client outcome cannot exclude
                # a create still completing in the daemon. Never certify it.
                require(execution_acknowledged or observed_container,
                        'container creation acknowledgement unknown; cleanup remains unknown')
                cleanup_ok = True
            except Exception as exc:
                error = (error + '; ' if error else '') + str(exc)
        elapsed = (time.monotonic() - started) * 1000
        if elapsed > 40000:
            error = (error + '; ' if error else '') + 'full disposable fixture/cleanup exceeded 40 seconds'
        after_serving = None
        try:
            after_serving = serving(run_id)
            require(after_serving == before_serving, 'serving identity changed during qualification')
        except Exception as exc:
            error = (error + '; ' if error else '') + str(exc)
        receipt = {'binding':binding, 'candidate':candidate, 'status':'qualified' if error is None and cleanup_ok else 'refused',
                   'runId':run_id, 'at':time.time(), 'elapsedMs':elapsed, 'cleanupProved':cleanup_ok,
                   'executionAcknowledged':execution_acknowledged, 'observedOwnedContainer':observed_container,
                   'servingBefore':before_serving, 'servingAfter':after_serving, 'result':result,
                   'hostAvailableBytes':int(available[1])*1024, 'error':error}
        write_state(receipt_path, receipt)
        require(receipt['status'] == 'qualified', 'scale preactivation gate refused: ' + str(error))
        print('ENGINE_NATIVE_SCALE=' + json.dumps({'status':'qualified', 'receipt':str(receipt_path),
                                                  'binding':binding, 'result':result}, sort_keys=True))


def refuse_signal(signum, _frame):
    # Raise inside the owning operation so its bounded finally cleanup runs.
    # SIGKILL/power loss still retains the durable one-shot intent for readback.
    raise RuntimeError('disposable qualification interrupted by signal ' + str(signum))


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, refuse_signal)
    signal.signal(signal.SIGINT, refuse_signal)
    signal.signal(signal.SIGHUP, refuse_signal)
    try:
        require(len(sys.argv) == 4, 'usage: legacy-census-scale-preflight.py IMAGE RUN DEADLINE')
        main(*sys.argv[1:])
    except Exception as exc:
        print('[native-census-scale] REFUSED: ' + str(exc), file=sys.stderr)
        raise SystemExit(1)
