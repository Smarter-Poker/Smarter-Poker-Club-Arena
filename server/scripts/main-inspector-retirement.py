#!/usr/bin/env python3
"""One current-operation, preannouncement retirement of a clientless EED main Inspector.

The inherited engine lock, immutable request/control, sealed image and live process
are authority. Historical intent absence and the role-reader report are not.
No retries, releases, maintenance writes, game calls or replacement occur here.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import urllib.request

CONTROL = Path(__file__).resolve().parent
SOURCE = 'eed06fe51dea622069c661a6213d5b031ff3a9e3'
IMAGE = 'sha256:2eb1c5a7279032240c5fff8a6b3ecf5dc6af735cc1227a51430d50dcae1b065b'


def retire():
    until = time.monotonic() + 20
    deadline_ms = int(time.time() * 1000) + 20000
    child = None
    previous_alarm = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    def expire(_signum, _frame):
        raise TimeoutError('absolute retirement deadline')
    signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, 20)

    def remaining():
        left = until - time.monotonic()
        if left <= 0:
            raise ValueError('deadline')
        return left

    def command(args):
        return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=remaining()).stdout

    def durable(path, value):
        encoded = (json.dumps(value, separators=(',', ':')) + '\n').encode()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            if os.write(fd, encoded) != len(encoded):
                raise ValueError('short_write')
            os.fsync(fd)
        finally:
            os.close(fd)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)

    try:
        if os.geteuid() != 0 or sys.platform != 'linux' or len(sys.argv) != 3:
            raise ValueError('root_operation')
        run, invocation = sys.argv[1:]
        if not re.fullmatch(r'[1-9][0-9]*(?:-[1-9][0-9]*)?', run) or not re.fullmatch(r'[0-9a-f]{32}', invocation):
            raise ValueError('operation_identity')
        lock = Path(os.environ.get('ENGINE_LOCK_FILE', '/var/lock/club-arena-engine-up.lock'))
        held, configured = os.fstat(9), lock.stat()
        if (held.st_dev, held.st_ino) != (configured.st_dev, configured.st_ino):
            raise ValueError('lock_identity')
        fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
        root = Path(os.environ.get('ENGINE_RELEASE_REQUEST_ROOT', '/var/lib/club-arena/engine-release-requests'))
        if not root.is_absolute() or root.is_symlink():
            raise ValueError('request_root')
        request_path = root / (run + '.request')
        request_stat = request_path.lstat()
        if not stat.S_ISREG(request_stat.st_mode) or request_stat.st_uid != 0:
            raise ValueError('request_file')
        request = request_path.read_text().splitlines()
        control_sha = (CONTROL / 'control-sha').read_text().strip()
        if (len(request) != 6 or request[3] != str(CONTROL) or request[4] != control_sha
                or not re.fullmatch(r'[0-9a-f]{40}', control_sha)
                or not request[5].isdigit() or time.time() >= int(request[5])):
            raise ValueError('immutable_request')
        checkpoint_intent = root / (run + '.legacy-checkpoint-intent')
        if checkpoint_intent.exists() or checkpoint_intent.is_symlink():
            raise ValueError('checkpoint_already_entered')
        deadline_ms = min(deadline_ms, int(request[5]) * 1000)
        until = min(until, time.monotonic() + (deadline_ms / 1000 - time.time()))
        remaining()
        signal.setitimer(signal.ITIMER_REAL, remaining())
        unit_args = ['systemctl', 'show', 'club-arena-engine-release-v1@' + run + '.service',
                     '-p', 'InvocationID', '-p', 'ActiveState', '-p', 'SubState']
        def current_unit():
            values = dict(line.split('=', 1) for line in command(unit_args).decode().splitlines())
            if (values.get('InvocationID') != invocation
                    or values.get('ActiveState') not in {'active', 'activating'}
                    or values.get('SubState') not in {'running', 'start'}):
                raise ValueError('native_operation_changed')
            return values
        unit = current_unit()
        intent_path = root / (run + '.main-inspector-retirement-intent')
        if intent_path.exists() or intent_path.is_symlink():
            raise ValueError('retirement_already_entered')
        seal = str(CONTROL / 'engine-release-seal.py')
        if (command([seal, 'get', 'desired-sha']).decode().strip() != SOURCE
                or command([seal, 'get', 'desired-image-id']).decode().strip() != IMAGE):
            raise ValueError('sealed_predecessor')
        container = os.environ.get('CONTAINER', 'club-arena-engine')
        if container != 'club-arena-engine':
            raise ValueError('container_name')
        inspect_args = ['docker', 'inspect', '--format',
                        '{{.Id}} {{.Image}} {{.State.Running}} {{.State.StartedAt}} {{.State.Pid}}', container]
        identity = command(inspect_args).decode().strip()
        fields = identity.split()
        if (len(fields) != 5 or not re.fullmatch(r'[0-9a-f]{64}', fields[0])
                or fields[1] != IMAGE or fields[2] != 'true'
                or not re.fullmatch(r'[1-9][0-9]*', fields[4])):
            raise ValueError('container_identity')
        def read_health():
            with urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=min(3, remaining())) as response:
                raw = response.read(131073)
            if len(raw) > 131072:
                raise ValueError('health_bound')
            health = json.loads(raw)
            maintenance = health.get('maintenance') or {}
            uptime = health.get('uptime')
            if (health.get('releaseSha') != SOURCE or health.get('running') is not True
                    or health.get('status') != 'ok' or health.get('liveness') != 'ok'
                    or not isinstance(uptime, (int, float)) or isinstance(uptime, bool)
                    or not 0 <= uptime < float('inf')
                    or not re.fullmatch(r'1-[0-9a-f]{8}', health.get('instanceId', ''))
                    or maintenance.get('active') is not False or maintenance.get('phase') != 'idle'):
                raise ValueError('live_preannouncement_identity')
            return health
        health = read_health()
        script = '\n'.join((CONTROL / name).read_text() for name in (
            'retire-owned-main-inspector.mjs', 'main-inspector-socket-qualification.mjs',
            'main-inspector-retirement-entry.mjs'))
        args = ['docker', 'exec', '-i', fields[0], 'sh', '-c',
                'case "${NODE_OPTIONS-}" in *--inspect*|*--debug*) exit 1;; esac\n'
                'exec env -u NODE_OPTIONS -u NODE_PATH node --no-inspect "$@"',
                'main-inspector-retirement', '--input-type=module', '-e', script, str(deadline_ms)]
        child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL)
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        buffered = bytearray()

        def line():
            while b'\n' not in buffered:
                if not selector.select(remaining()):
                    raise ValueError('native_deadline')
                chunk = os.read(child.stdout.fileno(), 4096)
                if not chunk:
                    raise ValueError('native_outcome_unknown')
                buffered.extend(chunk)
                if len(buffered) > 32768:
                    raise ValueError('native_output_bound')
            first, rest = bytes(buffered).split(b'\n', 1)
            buffered[:] = rest
            return first

        proposal_bytes = line()
        proposal = json.loads(proposal_bytes)
        if (proposal.get('schema') != 'main-inspector-retirement/v1'
                or not re.fullmatch(r'ws://127\.0\.0\.1:9229/[0-9a-f-]{36}', proposal.get('endpoint', ''), re.I)
                or not isinstance(proposal.get('binding'), dict)):
            raise ValueError('native_proposal')
        # Revalidate full host tuple and exact operation before granting attach.
        if (command(inspect_args).decode().strip() != identity
                or request_path.read_text().splitlines() != request
                or time.time() >= int(request[5])):
            raise ValueError('claim_preimage_changed')
        claim = {'schema': 'main-inspector-retirement-claim/v1', 'runId': run,
                 'invocationId': invocation, 'controlSha': control_sha,
                 'requestDeadline': int(request[5]), 'target': request[0],
                 'requestSha256': hashlib.sha256(request_path.read_bytes()).hexdigest(),
                 'nativeUnit': unit, 'source': SOURCE,
                 'instance': health['instanceId'], 'containerIdentity': identity,
                 'proposal': proposal, 'proposalSha256': hashlib.sha256(proposal_bytes).hexdigest(),
                 'deadlineMs': deadline_ms, 'retryAllowed': False}
        durable(intent_path, claim)
        if (time.time() >= int(request[5]) or current_unit() != unit
                or command(inspect_args).decode().strip() != identity
                or request_path.read_text().splitlines() != request):
            raise ValueError('grant_preimage_changed')
        remaining()
        child.stdin.write((claim['proposalSha256'] + '\n').encode())
        child.stdin.flush()
        # Keep stdin open until the child consumes the acknowledgement.
        outcome = json.loads(line())
        if (child.wait(timeout=remaining()) != 0 or outcome.get('ok') is not True
                or outcome.get('closeAcknowledged') is not True
                or outcome.get('connectionClosed') is not True
                or outcome.get('listenerAbsent') is not True
                or outcome.get('retryAllowed') is not False
                or command(inspect_args).decode().strip() != identity
                or current_unit() != unit):
            raise ValueError('retirement_outcome_unproved')
        after_health = read_health()
        if (after_health['instanceId'] != health['instanceId']
                or after_health['uptime'] < health['uptime']):
            raise ValueError('post_health_identity_changed')
        durable(root / (run + '.main-inspector-retirement-receipt'),
                {'claim': claim, 'outcome': outcome, 'observedAt': time.time()})
        print(json.dumps({'ok': True, 'listenerAbsent': True, 'sameProcess': True,
                          'runId': run, 'retryAllowed': False}))
        return 0
    except (OSError, ValueError, subprocess.SubprocessError):
        print('main Inspector retirement refused or unknown; intent retained, no retry', file=sys.stderr)
        return 1
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_alarm)
        if previous_timer[0]:
            signal.setitimer(signal.ITIMER_REAL, *previous_timer)
        if child is not None:
            if child.poll() is None:
                # Only our docker client; native helper also has its own absolute
                # process deadline. Never signal the engine/container/Inspector.
                child.kill()
            if child.stdin:
                child.stdin.close()
            if child.stdout:
                child.stdout.close()


if __name__ == '__main__':
    raise SystemExit(retire())
