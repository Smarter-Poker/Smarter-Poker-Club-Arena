#!/usr/bin/env python3
"""Explicit read of one completed release's existing recovery reservation."""
import base64
import datetime
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

SCHEMA = 'existing-release-recovery-observation/v1'
STATE_ROOT = Path('/var/lib/club-arena')
RUN = re.compile(r'^[1-9][0-9]{0,19}-[1-9][0-9]{0,3}$')
SHA = re.compile(r'^[0-9a-f]{40}$')
CAUSES = {'urgent', 'engine-degraded', 'deadline'}
MAX_BYTES = 65536


def selection(value):
    if not isinstance(value, dict) or set(value) != {'runKey', 'releaseSha'}:
        raise ValueError('Exact existing release identity required')
    if not isinstance(value['runKey'], str) or not RUN.fullmatch(value['runKey']):
        raise ValueError('Invalid run key')
    if not isinstance(value['releaseSha'], str) or not SHA.fullmatch(value['releaseSha']):
        raise ValueError('Invalid release SHA')
    return dict(value)


def timestamp(value):
    if type(value) is not int or not 946684800000 <= value < 4102444800000:
        raise ValueError('Invalid persisted timestamp')
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate persisted field')
        result[key] = value
    return result


def read_json(directory_fd, name):
    """Fixed relative file, no links, bounded bytes, unchanged inode/time/size."""
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_BYTES:
            raise ValueError('Persisted evidence file refused')
        raw = b''
        while len(raw) <= MAX_BYTES:
            part = os.read(fd, min(4096, MAX_BYTES + 1 - len(raw)))
            if not part:
                break
            raw += part
        after = os.fstat(fd)
        identity = lambda row: (row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns, row.st_ctime_ns)
        if identity(before) != identity(after) or len(raw) != before.st_size or len(raw) > MAX_BYTES:
            raise ValueError('Persisted evidence changed')
        value = json.loads(raw, object_pairs_hook=unique_object)
        if not isinstance(value, dict):
            raise ValueError('Persisted evidence is not an object')
        return value
    finally:
        os.close(fd)


def observation(request, window, result):
    request = selection(request)
    if not isinstance(window, dict) or set(window) != {'runId', 'sha', 'announcedAt', 'cause'}:
        raise ValueError('Recovery reservation fields refused')
    if window['runId'] != request['runKey'] or window['sha'] != request['releaseSha']:
        raise ValueError('Recovery reservation identity differs')
    if not isinstance(window['cause'], str) or window['cause'] not in CAUSES:
        raise ValueError('Unqualified recovery cause')
    announced = timestamp(window['announcedAt'])
    if not isinstance(result, dict) or type(result.get('schema')) is not int or result['schema'] != 1:
        raise ValueError('Completed release schema differs')
    if result.get('runId') != request['runKey'] or result.get('sha') != request['releaseSha']:
        raise ValueError('Completed release identity differs')
    if result.get('result') != 'sealed':
        raise ValueError('Recovery requires this run to have sealed its release')
    # engine-release-seal.py stores completedAt in epoch SECONDS, whereas
    # reserve-recovery-window stores announcedAt in epoch MILLISECONDS.
    completed_seconds = result.get('completedAt')
    if type(completed_seconds) is not int or not 946684800 <= completed_seconds < 4102444800:
        raise ValueError('Invalid sealed-result timestamp')
    completed = completed_seconds * 1000
    # A reservation alone is not consumed admission. Require this exact run's
    # seal inside its two-minute lead plus five-minute recovery countdown.
    if not announced + 120000 <= completed <= announced + 420000:
        raise ValueError('Seal did not complete inside this recovery window')
    return {
        'schema': SCHEMA, 'readOnly': True, **request,
        'cause': window['cause'], 'announcedAtMs': announced,
        'freezeAtMs': announced + 120000, 'windowEndsAtMs': announced + 420000,
        'sealedAtMs': completed,
        'evidenceBasis': 'exact_run_sealed_inside_its_existing_reserved_window',
        # The reservation records a class, not the health/deadline witness
        # which selected it. Never turn that class into policy-admission proof.
        'emergencyBasisStatus': 'unknown_not_retained_in_selected_receipts',
    }


def remote(request):
    request = selection(request)
    # All production paths are fixed. No environment/caller path override.
    root_fd = os.open(STATE_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        result_fd = os.open('engine-release-results', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=root_fd)
        try:
            name = 'engine-recovery-window-' + request['runKey'] + '.json'
            window = read_json(root_fd, name)
            result = read_json(result_fd, request['runKey'] + '.json')
            answer = observation(request, window, result)
            if window != read_json(root_fd, name) or result != read_json(result_fd, request['runKey'] + '.json'):
                raise ValueError('Persisted evidence changed across the read')
            return answer
        finally:
            os.close(result_fd)
    finally:
        os.close(root_fd)


def validate_reply(value, request):
    fields = {'schema', 'readOnly', 'runKey', 'releaseSha', 'cause', 'announcedAtMs',
              'freezeAtMs', 'windowEndsAtMs', 'sealedAtMs', 'evidenceBasis', 'emergencyBasisStatus'}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError('Unknown exported fields')
    if value['readOnly'] is not True:
        raise ValueError('Read-only export marker differs')
    expected = observation(request,
        {'runId': value['runKey'], 'sha': value['releaseSha'],
         'announcedAt': value['announcedAtMs'], 'cause': value['cause']},
        {'schema': 1, 'runId': value['runKey'], 'sha': value['releaseSha'],
         'result': 'sealed', 'completedAt': value['sealedAtMs'] // 1000
         if type(value['sealedAtMs']) is int else None})
    if value != expected:
        raise ValueError('Exported evidence differs')
    return value


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--remote':
        request = selection(json.loads(base64.b64decode(sys.argv[2], validate=True)))
        print(json.dumps(remote(request)))
        return
    if len(sys.argv) != 1 or os.environ.get('GITHUB_EVENT_NAME') != 'repository_dispatch':
        raise ValueError('Explicit observation dispatch required')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    if event.get('action') != 'audit-production-integrity':
        raise ValueError('Wrong observation event')
    request = selection(event.get('client_payload', {}).get('release_recovery_observation'))
    host = os.environ.get('HETZNER_HOST', '')
    key = os.environ.get('HETZNER_SSH_PRIVATE_KEY', '')
    pin = os.environ.get('HETZNER_HOST_KEY', '')
    if not re.fullmatch(r'[A-Za-z0-9.-]+', host) or host.startswith('-') or not key.strip() or not pin.strip():
        raise ValueError('Configured pinned transport unavailable')
    directory = Path(tempfile.mkdtemp(prefix='release-recovery-read-', dir=os.environ['RUNNER_TEMP']))
    try:
        for name, content in [('key', key), ('known_hosts', pin)]:
            path = directory / name
            path.write_text(content + '\n')
            path.chmod(0o600)
        for args in [['ssh-keygen', '-y', '-f', str(directory / 'key')],
                     ['ssh-keygen', '-l', '-f', str(directory / 'known_hosts')]]:
            subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=5)
        encoded = base64.b64encode(json.dumps(request).encode()).decode()
        args = ['ssh', '-i', str(directory / 'key'), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
                '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=/dev/null',
                '-o', 'UserKnownHostsFile=' + str(directory / 'known_hosts'), '-o', 'ConnectTimeout=10',
                'root@' + host, "python3 - --remote '" + encoded + "'"]
        reply = subprocess.run(args, input=Path(__file__).read_bytes(), capture_output=True, timeout=30)
        if reply.returncode or len(reply.stdout) > 4096:
            raise ValueError('Scoped evidence transport unavailable')
        answer = validate_reply(json.loads(reply.stdout, object_pairs_hook=unique_object), request)
        answer['observedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        serialized = json.dumps(answer, indent=2) + '\n'
        if key in serialized or pin in serialized:
            raise ValueError('Observation export refused')
        destination = Path('artifacts/release-recovery-observation')
        destination.mkdir(parents=True, exist_ok=True)
        target = destination / 'observation.json'
        target.write_text(serialized)
        target.chmod(0o600)
        print('Read-only existing release recovery evidence saved.')
    finally:
        shutil.rmtree(directory)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never expose raw state, transport stderr, paths or credential values.
        print('Existing release recovery evidence unavailable. No production action performed.', file=sys.stderr)
        sys.exit(1)
