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


def entry_state(run):
    """Read-only restart gate: an unknown one-shot cannot become absent history.

    No listener/process action occurs here. A completed receipt proves only
    this exact immutable operation's retirement; the caller still checks live
    listener absence, health and its ordinary maintenance authority.
    """
    deadline = time.monotonic() + 2.5

    def remaining():
        left = deadline - time.monotonic()
        if left <= 0:
            raise ValueError('state_deadline')
        return left

    def read_owned(path, limit):
        remaining()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            metadata = os.fstat(fd)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0:
                raise ValueError('state_file_identity')
            with os.fdopen(fd, 'rb', closefd=False) as handle:
                value = handle.read(limit + 1)
            if len(value) > limit:
                raise ValueError('state_file_bound')
            return value
        finally:
            os.close(fd)

    def positive(completed, claim):
        if not isinstance(completed, dict) or completed.get('claim') != claim:
            return False
        outcome = completed.get('outcome')
        return (isinstance(outcome, dict)
                and all(outcome.get(key) is True for key in (
                    'ok', 'closeRequested', 'closeAcknowledged', 'connectionClosed', 'listenerAbsent'))
                and outcome.get('retryAllowed') is False)

    def container_identity(value):
        if not isinstance(value, str):
            raise ValueError('state_container_identity')
        fields = value.split()
        if (len(fields) != 5 or not re.fullmatch(r'[0-9a-f]{64}', fields[0])
                or fields[1] != IMAGE or fields[2] != 'true'
                or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z', fields[3])
                or not re.fullmatch(r'[1-9][0-9]*', fields[4])):
            raise ValueError('state_container_identity')
        return tuple(fields)

    try:
        if os.geteuid() != 0 or not re.fullmatch(r'[1-9][0-9]*(?:-[1-9][0-9]*)?', run):
            return 1
        root = Path(os.environ.get('ENGINE_RELEASE_REQUEST_ROOT', '/var/lib/club-arena/engine-release-requests'))
        if not root.is_absolute() or root.is_symlink() or not root.is_dir():
            return 1
        history = {}
        suffixes = ('.main-inspector-retirement-intent', '.main-inspector-retirement-receipt')
        with os.scandir(root) as entries:
            for item in entries:
                remaining()
                suffix = next((s for s in suffixes if item.name.endswith(s)), None)
                if suffix is None:
                    continue
                owner = item.name[:-len(suffix)]
                if not re.fullmatch(r'[1-9][0-9]*(?:-[1-9][0-9]*)?', owner):
                    return 1
                history.setdefault(owner, {})[suffix] = root / item.name
                if len(history) > 256:
                    return 1
        foreign = {owner: paths for owner, paths in history.items() if owner != run}
        if foreign:
            live = subprocess.run(['docker', 'inspect', '--format',
                '{{.Id}} {{.Image}} {{.State.Running}} {{.State.StartedAt}} {{.State.Pid}}',
                'club-arena-engine'], check=True, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, timeout=min(2, remaining())).stdout
            live_identity = container_identity(live.decode('ascii').strip())
            for owner, paths in foreign.items():
                remaining()
                prior = json.loads(read_owned(paths[suffixes[0]], 32768)) if suffixes[0] in paths else None
                completed = json.loads(read_owned(paths[suffixes[1]], 65536)) if suffixes[1] in paths else None
                candidates = ([prior] if suffixes[0] in paths else [])
                if suffixes[1] in paths:
                    if not isinstance(completed, dict):
                        return 1
                    candidates.append(completed.get('claim'))
                same = False
                for claim in candidates:
                    if (not isinstance(claim, dict)
                            or claim.get('schema') != 'main-inspector-retirement-claim/v1'
                            or claim.get('runId') != owner or claim.get('retryAllowed') is not False):
                        return 1
                    same |= container_identity(claim.get('containerIdentity')) == live_identity
                if same and (prior is None or not positive(completed, prior)):
                    return 1
        intent = root / (run + '.main-inspector-retirement-intent')
        receipt = root / (run + '.main-inspector-retirement-receipt')
        def present(path):
            try:
                path.lstat()
                return True
            except FileNotFoundError:
                return False
        # Do not coerce an unreadable path into absence. lstat also preserves
        # dangling symlinks as existing, unqualified operation history.
        intent_present, receipt_present = present(intent), present(receipt)
        if not intent_present and not receipt_present:
            return 0
        if not intent_present or not receipt_present:
            return 1
        claim = json.loads(read_owned(intent, 32768))
        completed = json.loads(read_owned(receipt, 65536))
        request_bytes = read_owned(root / (run + '.request'), 16384)
        request = request_bytes.decode('utf8').splitlines()
        control_sha = read_owned(CONTROL / 'control-sha', 128).decode('ascii').strip()
        if (not isinstance(claim, dict) or not isinstance(completed, dict)
                or completed.get('claim') != claim
                or claim.get('schema') != 'main-inspector-retirement-claim/v1'
                or claim.get('runId') != run or claim.get('controlSha') != control_sha
                or not re.fullmatch(r'[0-9a-f]{40}', control_sha)
                or len(request) != 6 or request[3] != str(CONTROL) or request[4] != control_sha
                or not re.fullmatch(r'[0-9a-f]{40}', request[0])
                or claim.get('target') != request[0]
                or claim.get('requestSha256') != hashlib.sha256(request_bytes).hexdigest()
                or claim.get('retryAllowed') is not False):
            return 1
        if not positive(completed, claim):
            return 1
        remaining()
        return 0
    except (OSError, ValueError, TypeError, UnicodeError, RecursionError, subprocess.SubprocessError):
        return 1


def bounded_native_facts(value):
    """Project only maintained native enums/strict booleans; absent means unknown."""
    if not isinstance(value, dict) or value.get('ok') is not False or value.get('retryAllowed') is not False:
        return None
    stages = {'invocation', 'attach', 'connect', 'pid', 'close', 'native_close', 'complete'}
    reasons = {'invocation_refused', 'deadline_exhausted', 'qualification_refused',
               'connection_closed', 'connection_error', 'protocol_refused', 'evaluation_refused',
               'pid_mismatch', 'send_outcome_unknown', 'close_ack_refused', 'outcome_unknown',
               'main_inspector_retirement_unproved'}
    reasons |= {'runtime_version_unproved', 'runtime_source_unproved', 'runtime_cmdline_unproved',
                'runtime_unproved', 'discovery_unproved', 'kernel_unproved', 'proposal_unproved',
                'grant_unproved', 'transport_unproved', 'absence_unproved',
                'retirement_discovery_bound', 'retirement_endpoint', 'retirement_discovery_timeout',
                'main_inspector_socket_unproved', 'retirement_claim_timeout', 'retirement_claim_bound',
                'retirement_claim_missing', 'retirement_claim_mismatch', 'retirement_listener_retained',
                'retirement_absence_timeout'}
    entry_stages = {'runtime', 'discovery', 'kernel', 'proposal', 'grant', 'transport', 'absence'}
    result = {'ok': False, 'retryAllowed': False}
    kernel_steps = {'members', 'identities', 'namespace', 'socket_rows', 'listener',
                    'descriptors', 'listener_owner', 'clients', 'identity_recheck',
                    'snapshot_recheck', 'binding_recheck'}
    if (value.get('reason') == 'main_inspector_socket_unproved'
            and isinstance(value.get('kernelStep'), str) and value['kernelStep'] in kernel_steps):
        result['kernelStep'] = value['kernelStep']
    result['entryStage'] = (value.get('entryStage') if isinstance(value.get('entryStage'), str)
                            and value.get('entryStage') in entry_stages else None)
    result['stage'] = value.get('stage') if isinstance(value.get('stage'), str) and value.get('stage') in stages else None
    result['reason'] = value.get('reason') if isinstance(value.get('reason'), str) and value.get('reason') in reasons else None
    for name in ('closeRequested', 'closeAcknowledged', 'connectionClosed', 'listenerAbsent'):
        result[name] = value.get(name) if type(value.get(name)) is bool else None
    return result


def failure_reason(error):
    if isinstance(error, TimeoutError): return 'deadline'
    if isinstance(error, subprocess.TimeoutExpired): return 'command_deadline'
    if isinstance(error, subprocess.SubprocessError): return 'command_failed'
    if isinstance(error, OSError): return 'io_unproved'
    # Values are internal fixed literals, never arbitrary exception text.
    allowed = {'root_operation', 'operation_identity', 'lock_identity', 'request_root',
               'request_file', 'immutable_request', 'prior_retirement_unresolved',
               'checkpoint_already_entered', 'native_receipt_budget', 'deadline',
               'native_operation_changed', 'retirement_already_entered', 'sealed_predecessor',
               'container_name', 'container_identity', 'health_bound', 'live_preannouncement_identity',
               'native_deadline', 'native_outcome_unknown', 'native_output_bound', 'native_proposal',
               'claim_preimage_changed', 'short_write', 'grant_preimage_changed',
               'retirement_outcome_unproved', 'native_outcome_shape', 'post_health_identity_changed'}
    return str(error) if type(error) is ValueError and str(error) in allowed else 'invalid_outcome'


def publish_failure(value, absolute_until):
    """One unbuffered write, bounded inside the original host deadline.

    retire's SIGALRM handler raises, so a blocked write is interrupted rather
    than restarted. No inherited descriptor flags or stream buffers are changed.
    """
    try:
        encoded = (json.dumps(value, separators=(',', ':')) + '\n').encode('ascii')
        available = min(0.1, absolute_until - time.monotonic() - 0.1)
        if len(encoded) > 4096 or available <= 0:
            return False
        signal.setitimer(signal.ITIMER_REAL, available)
        return os.write(2, encoded) == len(encoded)
    except (OSError, ValueError, TypeError):
        return False
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


def retire():
    absolute_until = time.monotonic() + 20
    until = absolute_until - 0.2
    deadline_ms = int(time.time() * 1000) + 20000
    child = None
    host_stage, intent_state, ack_state = 'authority', 'not_started', 'not_started'
    native_facts = None
    child_exit = None
    previous_alarm = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    def expire(_signum, _frame):
        raise TimeoutError('absolute retirement deadline')
    signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, 19.8)

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
        if entry_state(run) != 0:
            raise ValueError('prior_retirement_unresolved')
        checkpoint_intent = root / (run + '.legacy-checkpoint-intent')
        if checkpoint_intent.exists() or checkpoint_intent.is_symlink():
            raise ValueError('checkpoint_already_entered')
        deadline_ms = min(deadline_ms, int(request[5]) * 1000)
        absolute_until = min(absolute_until, time.monotonic() + (deadline_ms / 1000 - time.time()))
        until = absolute_until - 0.2
        remaining()
        signal.setitimer(signal.ITIMER_REAL, remaining())
        # Native outcome/exit must arrive before this unchanged host deadline.
        # Reserve one second for Docker forwarding, validation and host receipt.
        native_deadline_ms = deadline_ms - 1000
        if native_deadline_ms <= int(time.time() * 1000):
            raise ValueError('native_receipt_budget')
        host_stage = 'unit'
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
        host_stage = 'seal'
        seal = str(CONTROL / 'engine-release-seal.py')
        if (command([seal, 'get', 'desired-sha']).decode().strip() != SOURCE
                or command([seal, 'get', 'desired-image-id']).decode().strip() != IMAGE):
            raise ValueError('sealed_predecessor')
        container = os.environ.get('CONTAINER', 'club-arena-engine')
        if container != 'club-arena-engine':
            raise ValueError('container_name')
        inspect_args = ['docker', 'inspect', '--format',
                        '{{.Id}} {{.Image}} {{.State.Running}} {{.State.StartedAt}} {{.State.Pid}}', container]
        host_stage = 'container'
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
        host_stage = 'health'
        health = read_health()
        host_stage = 'native_start'
        script = '\n'.join((CONTROL / name).read_text() for name in (
            'retire-owned-main-inspector.mjs', 'main-inspector-socket-qualification.mjs',
            'main-inspector-retirement-entry.mjs'))
        args = ['docker', 'exec', '-i', fields[0], 'sh', '-c',
                'case "${NODE_OPTIONS-}" in *--inspect*|*--debug*) exit 1;; esac\n'
                'exec env -u NODE_OPTIONS -u NODE_PATH node --no-inspect "$@"',
                'main-inspector-retirement', '--input-type=module', '-e', script, str(native_deadline_ms)]
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

        host_stage = 'proposal'
        proposal_bytes = line()
        proposal = json.loads(proposal_bytes)
        native_facts = bounded_native_facts(proposal)
        if (not isinstance(proposal, dict) or proposal.get('schema') != 'main-inspector-retirement/v1'
                or not re.fullmatch(r'ws://127\.0\.0\.1:9229/[0-9a-f-]{36}', proposal.get('endpoint', ''), re.I)
                or not isinstance(proposal.get('binding'), dict)):
            raise ValueError('native_proposal')
        host_stage = 'claim_preimage'
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
                 'deadlineMs': native_deadline_ms, 'retryAllowed': False}
        host_stage = 'intent'
        intent_state = 'write_started'
        durable(intent_path, claim)
        intent_state = 'durable'
        host_stage = 'grant_preimage'
        if (time.time() >= int(request[5]) or current_unit() != unit
                or command(inspect_args).decode().strip() != identity
                or request_path.read_text().splitlines() != request):
            raise ValueError('grant_preimage_changed')
        remaining()
        host_stage = 'ack'
        ack_state = 'write_started'
        child.stdin.write((claim['proposalSha256'] + '\n').encode())
        child.stdin.flush()
        ack_state = 'flushed'
        # Keep stdin open until the child consumes the acknowledgement.
        host_stage = 'outcome'
        outcome = json.loads(line())
        if not isinstance(outcome, dict):
            raise ValueError('native_outcome_shape')
        native_facts = bounded_native_facts(outcome)
        host_stage = 'native_exit'
        child_exit = child.wait(timeout=remaining())
        if (child_exit != 0 or outcome.get('ok') is not True
                or outcome.get('closeAcknowledged') is not True
                or outcome.get('connectionClosed') is not True
                or outcome.get('listenerAbsent') is not True
                or outcome.get('retryAllowed') is not False
                or command(inspect_args).decode().strip() != identity
                or current_unit() != unit):
            raise ValueError('retirement_outcome_unproved')
        host_stage = 'post_health'
        after_health = read_health()
        if (after_health['instanceId'] != health['instanceId']
                or after_health['uptime'] < health['uptime']):
            raise ValueError('post_health_identity_changed')
        host_stage = 'receipt'
        durable(root / (run + '.main-inspector-retirement-receipt'),
                {'claim': claim, 'outcome': outcome, 'observedAt': time.time()})
        print(json.dumps({'ok': True, 'listenerAbsent': True, 'sameProcess': True,
                          'runId': run, 'retryAllowed': False}))
        return 0
    except (OSError, ValueError, TypeError, RecursionError, subprocess.SubprocessError) as error:
        # Closed facts only: never expose exception text, target identifiers or
        # raw native output. A started write is not proof it reached durability.
        diagnostic = {'schema': 'main-inspector-retirement-failure/v1',
                      'ok': False, 'hostStage': host_stage,
                      'reason': failure_reason(error),
                      'intent': intent_state, 'ack': ack_state,
                      'native': native_facts,
                      'childExit': ('zero' if child_exit == 0 else 'nonzero') if type(child_exit) is int else 'unknown',
                      'retryAllowed': False}
        publish_failure(diagnostic, absolute_until)
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
            for stream in (child.stdin, child.stdout):
                if stream:
                    try:
                        stream.close()
                    except OSError:
                        # Failed ACK/pipe cleanup cannot publish a raw traceback
                        # or change the already UNKNOWN/nonretryable result.
                        pass


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--entry-state':
        raise SystemExit(entry_state(sys.argv[2]))
    raise SystemExit(retire())
