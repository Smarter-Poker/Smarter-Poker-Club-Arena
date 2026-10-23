#!/usr/bin/env python3
"""Withdraw one waiting original transaction, never a serving engine or wrapper.

The original v1 wrapper owns recovery, its failure tombstone and retirement.
This command supplies only the transaction's existing terminal INT boundary.
It has no image, seal-write, restart, freeze-write or alternate publisher path.
"""
import base64
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

SHA = re.compile(r'[0-9a-f]{40}')
RUN = re.compile(r'[1-9][0-9]{0,19}-[1-9][0-9]{0,3}')
INSTANCE = re.compile(r'[1-9][0-9]*-[0-9a-f]{8}')
ROOT = Path('/var/lib/club-arena')
PARENT = Path('/usr/local/lib/club-arena')
PROC = Path('/proc')
ENGINE_LOCK = Path('/var/lock/club-arena-engine-up.lock')
SCHEMA = 'waiting-engine-release-withdrawal/v1'


def require(condition):
    if not condition:
        raise ValueError('Exact waiting release admission refused')


def selection(value):
    fields = {'runKey', 'releaseSha', 'controlSha', 'desiredSha', 'instanceId'}
    require(isinstance(value, dict) and set(value) == fields)
    require(all(isinstance(v, str) for v in value.values()))
    require(RUN.fullmatch(value['runKey']) is not None)
    require(all(SHA.fullmatch(value[k]) for k in ('releaseSha', 'controlSha', 'desiredSha')))
    require(INSTANCE.fullmatch(value['instanceId']) is not None)
    require(value['releaseSha'] != value['desiredSha'])
    return dict(value)


def command(args, timeout=5):
    result = subprocess.run(args, capture_output=True, timeout=timeout, check=True)
    require(len(result.stdout) <= 65536)
    return result.stdout.decode().strip()


def regular(path, mode=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_size <= 65536)
        require(mode is None or stat.S_IMODE(before.st_mode) == mode)
        data = os.read(fd, 65537)
        after = os.fstat(fd)
        signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(signature(before) == signature(after) and len(data) <= 65536)
        return data.decode()
    finally:
        os.close(fd)


def properties(unit):
    raw = command(['systemctl', 'show', unit, '-p', 'MainPID', '-p', 'InvocationID',
                   '-p', 'ActiveState', '-p', 'Result', '-p', 'ExecMainStatus'])
    result = dict(line.split('=', 1) for line in raw.splitlines())
    require(set(result) == {'MainPID', 'InvocationID', 'ActiveState', 'Result', 'ExecMainStatus'})
    return result


def process(pid):
    require(type(pid) is int and pid > 1)
    root = PROC / str(pid)
    s = (root / 'stat').read_text().rsplit(')', 1)[1].split()
    argv = (root / 'cmdline').read_bytes().rstrip(b'\0').decode().split('\0')
    return {'pid': pid, 'parent': int(s[1]), 'start': s[19], 'argv': argv}


def bash_command(argv, expected):
    return len(argv) == len(expected) + 1 and argv[0] in ('bash', '/bin/bash', '/usr/bin/bash') and argv[1:] == expected


def healthy(value, request):
    require(value.get('releaseSha') == request['desiredSha'])
    require(value.get('instanceId') == request['instanceId'])
    require(value.get('running') is True and value.get('liveness') == 'ok')
    maintenance = value.get('maintenance') or {}
    require(maintenance.get('active') is False and maintenance.get('phase') == 'idle')


def health_pair(request):
    # No redirects to a caller-selected destination; only these fixed endpoints.
    for url in ('http://127.0.0.1:8080/health', 'https://engine.smarter.poker/health'):
        with urllib.request.urlopen(url + '?withdraw=' + str(time.time_ns()), timeout=5) as response:
            require(response.geturl().split('?', 1)[0] == url)
            raw = response.read(65537)
            require(len(raw) <= 65536)
            healthy(json.loads(raw), request)


def container_identity(request):
    # Inspect only immutable identity fields. A full Docker inspect would also
    # read runtime environment values, which this operation never needs.
    template = ('{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},'
                '"running":{{json .State.Running}},"image":{{json .Image}},'
                '"releaseSha":{{json (index .Config.Labels "sp.release.sha")}}}')
    d = json.loads(command(['docker', 'container', 'inspect', '--format', template, 'club-arena-engine']))
    require(set(d) == {'id', 'startedAt', 'running', 'image', 'releaseSha'})
    require(d['running'] is True and d['releaseSha'] == request['desiredSha'])
    require(re.fullmatch(r'[0-9a-f]{64}', d['id']) is not None)
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', d['image']) is not None)
    return {'id': d['id'], 'startedAt': d['startedAt'], 'image': d['image']}


def terminal(request, invocation=None):
    result = json.loads(regular(ROOT / 'engine-release-results' / (request['runKey'] + '.json')))
    require(result['result'] == 'failed' and result['transactionExitStatus'] == 130)
    require(result['runId'] == request['runKey'] and result['sha'] == request['releaseSha'])
    require(result['controlSha'] == request['controlSha'])
    require(result['recoveredDesiredSha'] == request['desiredSha'])
    require(re.fullmatch(r'[0-9a-f]{32}', result['invocationId']) is not None)
    require(invocation is None or result['invocationId'] == invocation)
    generation = PARENT / 'engine-control-generations' / request['controlSha']
    command([str(generation / 'engine-release-seal.py'), 'attest-failure', '--sha',
             request['releaseSha'], '--run-id', request['runKey'], '--control-sha',
             request['controlSha'], '--invocation-id', result['invocationId']])
    key = request['runKey']
    for directory, suffixes in [('engine-release-requests', ['intent', 'request', 'break-deadline', 'awaiting-certificate']),
                                ('engine-intake-requests', ['intent', 'request']),
                                ('engine-release-generation-pins', ['generation']),
                                ('engine-image-leases', ['lease'])]:
        require(all(not os.path.lexists(ROOT / directory / (key + '.' + suffix)) for suffix in suffixes))
    for unit in ('club-arena-engine-release-v1@' + key + '.service',
                 'club-arena-engine-intake-v1@' + key + '.service',
                 'club-arena-engine-intake-v1@' + key + '.path'):
        require(not os.path.lexists(Path('/etc/systemd/system/multi-user.target.wants') / unit))
        if unit.endswith('.path'):
            require(command(['systemctl', 'show', unit, '-p', 'ActiveState', '--value']) == 'inactive')
        else:
            d = properties(unit)
            require(d['ActiveState'] in ('inactive', 'failed') and d['MainPID'] == '0')
    health_pair(request)
    return {'schema': SCHEMA, **request, 'result': 'withdrawn-before-mutation',
            'invocationId': result['invocationId'], 'originalTransactionExitStatus': 130,
            'servingInstanceUnchanged': True, 'originalTerminalEdgesRetired': True}


def remote(request):
    require(os.getuid() == 0 and hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'))
    result_path = ROOT / 'engine-release-results' / (request['runKey'] + '.json')
    if os.path.lexists(result_path):
        return terminal(request)  # Lost acknowledgement never repeats the signal.
    key = request['runKey']
    generation = PARENT / 'engine-control-generations' / request['controlSha']
    require(generation.resolve(strict=True) == generation)
    require(regular(generation / 'control-sha').strip() == request['controlSha'])
    request_path = ROOT / 'engine-release-requests' / (key + '.request')
    expected_pin = str(generation) + '\n' + request['controlSha'] + '\n'
    lock_fd = os.open(ENGINE_LOCK, os.O_RDWR | os.O_NOFOLLOW)
    try:
        require(stat.S_ISREG(os.fstat(lock_fd).st_mode) and os.fstat(lock_fd).st_uid == 0)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        lines = regular(request_path, 0o600).splitlines()
        require(len(lines) == 6 and lines[0] == request['releaseSha'])
        require(lines[3:5] == [str(generation), request['controlSha']])
        require(regular(ROOT / 'engine-release-generation-pins' / (key + '.generation'), 0o600) == expected_pin)
        require(regular(ROOT / 'engine-release-requests' / (key + '.awaiting-certificate')).strip() == request['releaseSha'])
        require(not os.path.lexists(ROOT / 'engine-release-requests' / (key + '.break-deadline')))
        seal = str(generation / 'engine-release-seal.py')
        require(command([seal, 'pending-owner']) == 'none')
        require(command([seal, 'get', 'desired-sha']) == request['desiredSha'])
        unit = 'club-arena-engine-release-v1@' + key + '.service'
        state = properties(unit)
        require(state['ActiveState'] in ('active', 'activating'))
        require(re.fullmatch(r'[0-9a-f]{32}', state['InvocationID']) is not None)
        parent = process(int(state['MainPID']))
        require(bash_command(parent['argv'], [str(PARENT / 'engine-release-unit-wrapper-v1.sh'), 'start', key]))
        children = (PROC / str(parent['pid']) / 'task' / str(parent['pid']) / 'children').read_text().split()
        matches = [process(int(pid)) for pid in children]
        matches = [p for p in matches if bash_command(p['argv'], [str(generation / 'engine-release-transaction.sh'), '--run-id', key])]
        require(len(matches) == 1 and matches[0]['parent'] == parent['pid'])
        child = matches[0]
        pid_fd = os.pidfd_open(child['pid'])
        try:
            before = container_identity(request)
            health_pair(request)
            command([str(generation / 'engine-release-database-proof.py'), '--env-file',
                     '/opt/club-arena/server/.env', '--sha', request['desiredSha'],
                     '--instance-id', request['instanceId'], '--timeout-seconds', '15',
                     '--poll-seconds', '5', '--max-heartbeat-age-seconds', '15'], timeout=17)
            require(properties(unit) == state and process(parent['pid']) == parent and process(child['pid']) == child)
            require(command([seal, 'pending-owner']) == 'none')
            require(container_identity(request) == before)
            health_pair(request)
            # Signal the pidfd-bound transaction, never its wrapper, unit or cgroup.
            signal.pidfd_send_signal(pid_fd, signal.SIGINT)
        finally:
            os.close(pid_fd)
    finally:
        os.close(lock_fd)  # Original wrapper must immediately regain its recovery lock.
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            answer = terminal(request, state['InvocationID'])
            require(container_identity(request) == before)
            return answer
        except (ValueError, OSError, subprocess.SubprocessError, KeyError):
            time.sleep(1)
    raise ValueError('Original terminal outcome remains unknown; do not replay')


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--remote':
        request = selection(json.loads(base64.b64decode(sys.argv[2], validate=True)))
        print(json.dumps(remote(request)))
        return
    require(len(sys.argv) == 1 and os.environ.get('GITHUB_EVENT_NAME') == 'repository_dispatch')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    require(event.get('action') == 'withdraw-club-arena-engine')
    request = selection(event.get('client_payload', {}).get('withdrawal'))
    host, key, pin = [os.environ.get(k, '') for k in ('HETZNER_HOST', 'HETZNER_SSH_PRIVATE_KEY', 'HETZNER_HOST_KEY')]
    require(re.fullmatch(r'[A-Za-z0-9.-]+', host) is not None and not host.startswith('-') and key.strip() and pin.strip())
    directory = Path(tempfile.mkdtemp(prefix='engine-withdrawal-', dir=os.environ['RUNNER_TEMP']))
    try:
        for name, content in [('key', key), ('known_hosts', pin)]:
            path = directory / name
            path.write_text(content + '\n')
            path.chmod(0o600)
        for args in [['ssh-keygen', '-y', '-f', str(directory / 'key')], ['ssh-keygen', '-l', '-f', str(directory / 'known_hosts')]]:
            subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=5)
        encoded = base64.b64encode(json.dumps(request).encode()).decode()
        args = ['ssh', '-i', str(directory / 'key'), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
                '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=/dev/null',
                '-o', 'UserKnownHostsFile=' + str(directory / 'known_hosts'), '-o', 'ConnectTimeout=10',
                'root@' + host, "python3 - --remote '" + encoded + "'"]
        reply = subprocess.run(args, input=Path(__file__).read_bytes(), capture_output=True, timeout=150)
        require(reply.returncode == 0 and len(reply.stdout) <= 4096)
        answer = json.loads(reply.stdout)
        require(set(answer) == set(request) | {'schema', 'result', 'invocationId',
                'originalTransactionExitStatus', 'servingInstanceUnchanged', 'originalTerminalEdgesRetired'})
        require(all(answer.get(k) == v for k, v in request.items()))
        require(answer.get('schema') == SCHEMA and answer.get('result') == 'withdrawn-before-mutation')
        require(answer.get('originalTransactionExitStatus') == 130)
        require(re.fullmatch(r'[0-9a-f]{32}', answer.get('invocationId', '')) is not None)
        require(answer.get('servingInstanceUnchanged') is True and answer.get('originalTerminalEdgesRetired') is True)
        answer['observedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        destination = Path('artifacts/engine-withdrawal')
        destination.mkdir(parents=True, exist_ok=True)
        (destination / 'receipt.json').write_text(json.dumps(answer, indent=2) + '\n')
        print('Original waiting transaction withdrawn; exact serving instance unchanged.')
    finally:
        shutil.rmtree(directory)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Withdrawal unproved. Read the original exact run before any further action.', file=sys.stderr)
        sys.exit(1)
