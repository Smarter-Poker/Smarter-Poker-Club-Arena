#!/usr/bin/env python3
"""Explicit read of one completed release's existing recovery reservation."""
import base64
import datetime
import json
import math
import os
import re
import shutil
import selectors
import time
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

SCHEMA = 'existing-release-recovery-observation/v2'
STATE_ROOT = Path('/var/lib/club-arena')
RUN = re.compile(r'^[1-9][0-9]{0,19}-[1-9][0-9]{0,3}$')
SHA = re.compile(r'^[0-9a-f]{40}$')
CAUSES = {'urgent', 'engine-degraded', 'deadline'}
MAX_BYTES = 65536
FAILURE_SCHEMA = 'existing-release-recovery-refusal/v1'
# Literal, reviewed codes only. Exception text and transport output never cross
# this protocol, including unknown errors from the selected native reader.
REFUSALS = {
    'Recovery journal fields refused': ('journal', 'fields_refused'),
    'Recovery journal metadata refused': ('journal', 'metadata_refused'),
    'Recovery journal sequence metadata refused': ('journal', 'sequence_refused'),
    'Recovery journal ownership differs': ('journal', 'ownership_refused'),
    'Recovery journal timestamp refused': ('journal', 'timestamp_refused'),
    'Recovery journal literal differs': ('journal', 'literal_refused'),
    'Recovery journal sign refused': ('journal', 'sign_refused'),
    'Ambiguous recovery witness': ('journal', 'ambiguous_witness'),
    'Recovery witness output refused': ('journal', 'output_refused'),
    'Recovery witness invocation differs': ('journal', 'invocation_refused'),
    'Original recovery invocation refused': ('journal', 'invocation_refused'),
    'Recovery witness time differs': ('journal', 'time_refused'),
    'Recovery witness cause differs': ('journal', 'cause_refused'),
    'Recovery witness sign refused': ('journal', 'sign_refused'),
    'Duplicate recovery witness sign': ('journal', 'sign_refused'),
}
REFUSAL_CODES = set(REFUSALS.values()) | {('remote', 'evidence_refused')}


class ScopedRefusal(ValueError):
    def __init__(self, phase, code):
        if (phase, code) not in REFUSAL_CODES:
            raise ValueError('Unqualified refusal code')
        self.phase, self.code = phase, code
        super().__init__('Scoped evidence refused')


def refusal(request, error):
    phase, code = REFUSALS.get(str(error), ('remote', 'evidence_refused'))
    return {'schema': FAILURE_SCHEMA, 'readOnly': True, **selection(request),
            'phase': phase, 'code': code}


def validate_refusal(value, request):
    fields = {'schema', 'readOnly', 'runKey', 'releaseSha', 'phase', 'code'} | ({'mode'} if 'mode' in request else set())
    if (not isinstance(value, dict) or set(value) != fields
            or value['schema'] != FAILURE_SCHEMA or value['readOnly'] is not True
            or value['runKey'] != request['runKey'] or value['releaseSha'] != request['releaseSha']
            or value.get('mode') != request.get('mode')
            or not isinstance(value['phase'], str) or not isinstance(value['code'], str)
            or (value['phase'], value['code']) not in REFUSAL_CODES):
        raise ValueError('Scoped evidence transport unavailable')
    return ScopedRefusal(value['phase'], value['code'])


def selection(value):
    if (not isinstance(value, dict) or set(value) not in ({'runKey', 'releaseSha'}, {'runKey', 'releaseSha', 'mode'})
            or ('mode' in value and (not isinstance(value['mode'], str) or value['mode'] not in {'pending_transaction', 'checkpoint_admission'}))):
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
        'emergencyBasis': None,
    }



INVOCATION = re.compile(r'^[0-9a-f]{32}$')
REASON_PREFIX = '[engine-release-transaction] off-cycle recovery window reason: '


def validated_basis(value, request, window, result):
    """Only the original completion invocation, not later replays or another run."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {'invocationId', 'observedAtMs', 'signs'}:
        raise ValueError('Recovery witness fields refused')
    original = result.get('completionRuntime')
    invocations = result.get('invocationIds')
    invocation = value['invocationId']
    if (not isinstance(original, dict) or original.get('invocationId') != invocation
            or not isinstance(invocations, list) or not 1 <= len(invocations) <= 8
            or any(not isinstance(item, str) or not INVOCATION.fullmatch(item) for item in invocations)
            or len(set(invocations)) != len(invocations) or invocation not in invocations):
        raise ValueError('Recovery witness invocation differs')
    observed = timestamp(value['observedAtMs'])
    # The producer logs immediately after its fsynced reservation and before
    # the two-minute announcement lead ends. No hour-wide journal selection.
    if not window['announcedAt'] <= observed <= window['announcedAt'] + 120000:
        raise ValueError('Recovery witness time differs')
    signs = value['signs']
    allowed = {'breaksSinceRestartCertified', 'liveness', 'wholeFleetStalled',
               'tournamentManagersQuarantined'}
    if window['cause'] != 'engine-degraded' or not isinstance(signs, dict) or not signs or not set(signs) <= allowed:
        raise ValueError('Recovery witness cause differs')
    for key, item in signs.items():
        if key == 'liveness':
            valid = item == 'dead'
        elif key == 'wholeFleetStalled':
            valid = item is True
        else:
            minimum = 1 if key == 'breaksSinceRestartCertified' else 100
            valid = type(item) is int and minimum <= item <= 2147483647
        if not valid:
            raise ValueError('Recovery witness sign refused')
    return dict(value)


def reason_from_rows(raw, request, window, result):
    if len(raw) > 8192:
        raise ValueError('Recovery witness output refused')
    lines = raw.splitlines()
    if not lines:
        return None
    if len(lines) != 1:
        raise ValueError('Ambiguous recovery witness')
    row = json.loads(lines[0], object_pairs_hook=unique_object)
    fields = {'MESSAGE', '_SYSTEMD_INVOCATION_ID', '_SYSTEMD_UNIT', '__REALTIME_TIMESTAMP',
              '__CURSOR', '__MONOTONIC_TIMESTAMP', '_BOOT_ID'}
    sequence_fields = {'__SEQNUM', '__SEQNUM_ID'}
    if not isinstance(row, dict) or set(row) not in (fields, fields | sequence_fields):
        raise ValueError('Recovery journal fields refused')
    # systemd v254+ adds this PAIR even with --output-fields. Admit only its
    # exact native profile, validate uint64/ID, then discard it with metadata.
    if sequence_fields <= set(row):
        if (not isinstance(row['__SEQNUM'], str)
                or not re.fullmatch(r'[1-9][0-9]{0,19}', row['__SEQNUM'])
                or int(row['__SEQNUM']) > 18446744073709551615
                or not isinstance(row['__SEQNUM_ID'], str)
                or not INVOCATION.fullmatch(row['__SEQNUM_ID'])):
            raise ValueError('Recovery journal sequence metadata refused')
    # Both native profiles add these fields; never export native metadata.
    if (not isinstance(row['_BOOT_ID'], str) or not INVOCATION.fullmatch(row['_BOOT_ID'])
            or not isinstance(row['__MONOTONIC_TIMESTAMP'], str)
            or not re.fullmatch(r'[0-9]{1,20}', row['__MONOTONIC_TIMESTAMP'])
            or not isinstance(row['__CURSOR'], str)
            or not re.fullmatch(r'[a-z]=[0-9a-f]+(?:;[a-z]=[0-9a-f]+){1,9}', row['__CURSOR'])
            or len(row['__CURSOR']) > 512):
        raise ValueError('Recovery journal metadata refused')
    invocation = result['completionRuntime']['invocationId']
    if row['_SYSTEMD_INVOCATION_ID'] != invocation or row['_SYSTEMD_UNIT'] != 'club-arena-engine-release-v1@' + request['runKey'] + '.service':
        raise ValueError('Recovery journal ownership differs')
    stamp = row['__REALTIME_TIMESTAMP']
    if not isinstance(stamp, str) or not re.fullmatch(r'[0-9]{16}', stamp):
        raise ValueError('Recovery journal timestamp refused')
    message = row['MESSAGE']
    prefix = REASON_PREFIX + 'engine-degraded '
    if not isinstance(message, str) or not message.startswith(prefix) or len(message) > 400:
        raise ValueError('Recovery journal literal differs')
    signs = {}
    for token in message[len(prefix):].split(','):
        if token == 'wholeFleetStalled':
            key, value = token, True
        elif token == 'liveness=dead':
            key, value = 'liveness', 'dead'
        else:
            match = re.fullmatch(r'(breaksSinceRestartCertified|tournamentManagersQuarantined)=([1-9][0-9]{0,9})', token)
            if not match:
                raise ValueError('Recovery journal sign refused')
            key, value = match[1], int(match[2])
        if key in signs:
            raise ValueError('Duplicate recovery witness sign')
        signs[key] = value
    return validated_basis({'invocationId': invocation, 'observedAtMs': int(stamp) // 1000,
                            'signs': signs}, request, window, result)



def bounded_journal(args):
    # Finite native read: max 8KiB plus sentinel, five seconds, no raw file.
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    raw = b''
    deadline = time.monotonic() + 5
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise subprocess.TimeoutExpired(args, 5)
                part = os.read(process.stdout.fileno(), min(4096, 8193 - len(raw)))
                if not part:
                    break
                raw += part
                if len(raw) > 8192:
                    raise ValueError('Recovery witness output refused')
        returncode = process.wait(timeout=max(0.001, deadline - time.monotonic()))
        return subprocess.CompletedProcess(args, returncode, stdout=raw)
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=2)
        process.stdout.close()


def retained_reason(request, window, result):
    original = result.get('completionRuntime')
    invocations = result.get('invocationIds')
    if window['cause'] != 'engine-degraded' or not isinstance(original, dict) or not isinstance(invocations, list):
        return None
    invocation = original.get('invocationId')
    if not isinstance(invocation, str) or not INVOCATION.fullmatch(invocation):
        raise ValueError('Original recovery invocation refused')
    # Validate membership before calling any host process.
    validated_basis({'invocationId': invocation, 'observedAtMs': window['announcedAt'],
                     'signs': {'liveness': 'dead'}}, request, window, result)
    args = ['journalctl', '--no-pager', '--output=json',
            '--output-fields=MESSAGE,_SYSTEMD_INVOCATION_ID,_SYSTEMD_UNIT,__REALTIME_TIMESTAMP',
            '--lines=2', '--grep=^\\[engine-release-transaction\\] off-cycle recovery window reason: ',
            '--since=@' + str(window['announcedAt'] // 1000),
            '--until=@' + str((window['announcedAt'] + 120000) // 1000 + 1),
            '_SYSTEMD_INVOCATION_ID=' + invocation,
            '_SYSTEMD_UNIT=club-arena-engine-release-v1@' + request['runKey'] + '.service']
    try:
        # Fixed two-row/8KiB protocol; never export journal stderr or raw rows.
        reply = bounded_journal(args)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if reply.returncode:
        return None
    return reason_from_rows(reply.stdout, request, window, result)



PENDING_SCHEMA = 'existing-release-pending-observation/v1'
PENDING_CATEGORIES = {'certificate_shut', 'candidate_budget_missed',
                      'locked_budget_missed', 'legacy_entry_deferred'}


def read_lines(directory_fd, name, optional=False):
    """Same bounded immutable-file protocol as JSON, without exporting raw text."""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    except FileNotFoundError:
        if optional:
            return None
        raise
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_size > 4096
                or before.st_uid != os.geteuid() or stat.S_IMODE(before.st_mode) != 0o600):
            raise ValueError('Pending metadata refused')
        raw = os.read(fd, 4097)
        after = os.fstat(fd)
        identity = lambda row: (row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns, row.st_ctime_ns, row.st_uid, row.st_gid, row.st_mode)
        if identity(before) != identity(after) or len(raw) != before.st_size:
            raise ValueError('Pending metadata changed')
        return raw.decode('utf-8').splitlines()
    finally:
        os.close(fd)


def pending_unit(request):
    unit = 'club-arena-engine-release-v1@' + request['runKey'] + '.service'
    reply = bounded_journal(['systemctl', 'show', unit, '--no-pager',
        '--property=ActiveState,SubState,InvocationID'])
    if reply.returncode:
        raise ValueError('Pending unit unavailable')
    rows = reply.stdout.decode('ascii').splitlines()
    pairs = [row.split('=', 1) for row in rows]
    if len(pairs) != 3 or any(len(pair) != 2 for pair in pairs):
        raise ValueError('Pending unit refused')
    values = unique_object(pairs)
    if set(values) != {'ActiveState', 'SubState', 'InvocationID'}:
        raise ValueError('Pending unit fields refused')
    answer = {'activeState': values['ActiveState'], 'subState': values['SubState'],
              'invocationId': values['InvocationID']}
    validate_pending_unit(answer)
    return answer


def validate_pending_unit(value):
    if (not isinstance(value, dict) or set(value) != {'activeState', 'subState', 'invocationId'}
            or value['activeState'] not in {'active', 'activating', 'reloading', 'inactive', 'failed', 'deactivating'}
            or value['subState'] not in {'running', 'start', 'start-pre', 'start-post', 'exited',
                'dead', 'failed', 'auto-restart', 'stop', 'stop-sigterm', 'stop-sigkill', 'stop-post', 'final-sigterm', 'final-sigkill'}
            or not isinstance(value['invocationId'], str) or not INVOCATION.fullmatch(value['invocationId'])):
        raise ValueError('Pending unit identity refused')


def pending_journal(request, unit):
    invocation = unit['invocationId']
    name = 'club-arena-engine-release-v1@' + request['runKey'] + '.service'
    reply = bounded_journal(['journalctl', '--no-pager', '--output=json', '--lines=12',
        '--output-fields=MESSAGE,_SYSTEMD_INVOCATION_ID,_SYSTEMD_UNIT,__REALTIME_TIMESTAMP',
        '--grep=^\\[engine-release-transaction\\] (the restart certificate is shut with |the durable table break has |the locked table break has |the legacy checkpoint entry did not fit)',
        '_SYSTEMD_INVOCATION_ID=' + invocation, '_SYSTEMD_UNIT=' + name])
    if reply.returncode:
        raise ValueError('Pending journal unavailable')
    signs = []
    for line in reply.stdout.splitlines():
        row = json.loads(line, object_pairs_hook=unique_object)
        if (not isinstance(row, dict) or row.get('_SYSTEMD_INVOCATION_ID') != invocation
                or row.get('_SYSTEMD_UNIT') != name):
            raise ValueError('Pending journal ownership refused')
        stamp = row.get('__REALTIME_TIMESTAMP')
        message = row.get('MESSAGE')
        if (not isinstance(stamp, str) or not re.fullmatch(r'[0-9]{16}', stamp)
                or not isinstance(message, str) or len(message) > 2048):
            raise ValueError('Pending journal shape refused')
        category = None
        # Literal producer prefixes in engine-release-transaction.sh. Unknown
        # messages remain unknown; their text never leaves the host.
        if message.startswith('[engine-release-transaction] the restart certificate is shut with '):
            category = 'certificate_shut'
        elif (message.startswith('[engine-release-transaction] the durable table break has ')
              and message.endswith('candidate-and-recovery budget; refusing before mutation and waiting for a later certificate')):
            category = 'candidate_budget_missed'
        elif (message.startswith('[engine-release-transaction] the locked table break has ')
              and message.endswith('candidate-and-recovery budget; waiting for a later certificate')):
            category = 'locked_budget_missed'
        elif message == '[engine-release-transaction] the legacy checkpoint entry did not fit inside this break and nothing was attempted; waiting for a later certificate':
            category = 'legacy_entry_deferred'
        if category:
            sign = {'category': category, 'observedAtMs': int(stamp) // 1000}
            timestamp(sign['observedAtMs'])
            signs.append(sign)
    return signs


def pending_metadata(request, rows, intent, marker, deadline):
    if (not isinstance(rows, list) or len(rows) != 6 or rows != intent
            or rows[0] != request['releaseSha']
            or rows[1] not in {
                'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/' + request['runKey'].split('-')[0],
                'https://github.com/Smarter-Software-PIQ/Smarter-Poker-Club-Arena/actions/runs/' + request['runKey'].split('-')[0]}
            or not SHA.fullmatch(rows[4])
            or not re.fullmatch(r'[1-9][0-9]{8,9}', rows[5])):
        raise ValueError('Pending request identity refused')
    # Validate generation ownership without exporting an internal filesystem path.
    if not re.fullmatch(r'/usr/local/lib/club-arena/engine-control-generations/' + rows[4], rows[3]):
        raise ValueError('Pending generation refused')
    stamp = int(rows[5])
    timestamp(stamp * 1000)
    if marker is not None and marker != [request['releaseSha']]:
        raise ValueError('Pending marker identity refused')
    if deadline is not None and (len(deadline) != 1 or not re.fullmatch(r'[1-9][0-9]{8,9}', deadline[0])):
        raise ValueError('Pending deadline refused')
    break_deadline = int(deadline[0]) if deadline else None
    if break_deadline is not None:
        timestamp(break_deadline * 1000)
    return rows[4], stamp, break_deadline


def pending_observation(request, rows, intent, marker, deadline, unit, signs):
    control, stamp, break_deadline = pending_metadata(request, rows, intent, marker, deadline)
    validate_pending_unit(unit)
    validate_pending_signs(signs)
    return {'schema': PENDING_SCHEMA, 'readOnly': True, **request, 'controlSha': control,
        'requestDeadlineEpoch': stamp, 'breakDeadlineEpoch': break_deadline,
        'stage': 'awaiting_certificate_marker_retained' if marker else 'unknown_not_retained',
        'unit': unit, 'journalSigns': signs,
        'absenceMeans': 'unknown; bounded latest journal rows do not prove absence'}


def validate_pending_signs(signs):
    if not isinstance(signs, list) or len(signs) > 12:
        raise ValueError('Pending signs refused')
    for sign in signs:
        if (not isinstance(sign, dict) or set(sign) != {'category', 'observedAtMs'}
                or sign['category'] not in PENDING_CATEGORIES):
            raise ValueError('Pending sign refused')
        timestamp(sign['observedAtMs'])


def pending_remote(request, root_fd):
    directory = os.open('engine-release-requests', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    try:
        names = [request['runKey'] + suffix for suffix in
                 ('.request', '.intent', '.awaiting-certificate', '.break-deadline')]
        read = lambda: [read_lines(directory, name, optional=index > 1) for index, name in enumerate(names)]
        before = read()
        pending_metadata(request, *before)
        unit = pending_unit(request)
        signs = pending_journal(request, unit)
        if before != read() or unit != pending_unit(request):
            raise ValueError('Pending evidence changed across read')
        return pending_observation(request, *before, unit, signs)
    finally:
        os.close(directory)


CHECKPOINT_SCHEMA = 'existing-release-checkpoint-admission-observation/v1'
CHECKPOINT_ABSENCE = 'unknown; missing intent is not proof a checkpoint did not run; unit metadata binds exact run name only, not selected release SHA'
CONTAINER_FORMAT = '{{.Id}} {{.Image}} {{.State.Running}} {{.State.StartedAt}} {{.State.Pid}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
# TCP presence ONLY in the fixed serving container namespace. No inspector HTTP,
# WebSocket, application import, process signal, memory inference or repair.
CHECKPOINT_TCP = r"""
const socket=require('node:net').connect({host:'127.0.0.1',port:9229});
let done=false; const finish=presence=>{if(done)return;done=true;socket.destroy();console.log(JSON.stringify({presence}));};
socket.once('connect',()=>finish('open'));
socket.once('error',error=>finish(error.code==='ECONNREFUSED'?'closed':'unknown'));
socket.setTimeout(500,()=>finish('unknown'));
"""


def checkpoint_intent(rows, request, request_rows, operation_rows):
    if request_rows is not None or operation_rows is not None:
        control, _, _ = pending_metadata(request, request_rows, operation_rows, None, None)
    else:
        control = request['releaseSha']
    if rows is None:
        return None
    if len(rows) != 1:
        raise ValueError('Checkpoint intent shape refused')
    value = json.loads(rows[0], object_pairs_hook=unique_object)
    fields = {'instance', 'container', 'startedAt', 'hostPid', 'source', 'runId', 'controlSha', 'at', 'retryAllowed'}
    if (not isinstance(value, dict) or set(value) != fields
            or value['runId'] != request['runKey'] or value['controlSha'] != control
            or not isinstance(value['controlSha'], str) or not SHA.fullmatch(value['controlSha'])
            or not isinstance(value['source'], str) or not SHA.fullmatch(value['source'])
            or not isinstance(value['instance'], str) or not re.fullmatch(r'1-[0-9a-f]{8}', value['instance'])
            or not isinstance(value['container'], str) or not re.fullmatch(r'[0-9a-f]{64}', value['container'])
            or type(value['hostPid']) is not int or not 1 <= value['hostPid'] <= 2147483647
            or not isinstance(value['startedAt'], str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z', value['startedAt'])
            or type(value['at']) not in (int, float) or not math.isfinite(value['at'])
            or not 946684800 <= value['at'] < 4102444800 or value['retryAllowed'] is not False):
        raise ValueError('Checkpoint intent identity refused')
    datetime.datetime.fromisoformat(value['startedAt'].replace('Z', '+00:00'))
    return value


def checkpoint_unit(request):
    name = 'club-arena-engine-release-v1@' + request['runKey'] + '.service'
    reply = bounded_journal(['systemctl', 'show', name, '--no-pager',
        '--property=LoadState,ActiveState,SubState,InvocationID'])
    if reply.returncode:
        raise ValueError('Checkpoint unit unavailable')
    pairs = [row.split('=', 1) for row in reply.stdout.decode('ascii').splitlines()]
    if len(pairs) != 4 or any(len(pair) != 2 for pair in pairs):
        raise ValueError('Checkpoint unit refused')
    values = unique_object(pairs)
    if set(values) != {'LoadState', 'ActiveState', 'SubState', 'InvocationID'}:
        raise ValueError('Checkpoint unit fields refused')
    answer = dict(zip(('loadState', 'activeState', 'subState', 'invocationId'),
                     (values[key] for key in ('LoadState', 'ActiveState', 'SubState', 'InvocationID'))))
    validate_checkpoint_unit(answer)
    return answer


def validate_checkpoint_unit(value):
    if (not isinstance(value, dict) or set(value) != {'loadState', 'activeState', 'subState', 'invocationId'}
            or not all(isinstance(value[key], str) for key in ('loadState', 'activeState', 'subState', 'invocationId'))
            or value['loadState'] not in {'loaded', 'not-found', 'masked', 'error'}):
        raise ValueError('Checkpoint unit shape refused')
    # A retired/not-found exact unit may have no invocation retained. This is
    # unit-name evidence only, never proof of checkpoint/inspector absence.
    if value['invocationId'] == '' and value['activeState'] == 'inactive' and value['subState'] == 'dead':
        return
    validate_pending_unit({key: value[key] for key in ('activeState', 'subState', 'invocationId')})


def validate_checkpoint_runtime(value):
    if (not isinstance(value, dict) or set(value) != {'container', 'imageId', 'startedAt', 'hostPid', 'source'}
            or not isinstance(value['container'], str) or not re.fullmatch('[0-9a-f]{64}', value['container'])
            or not isinstance(value['imageId'], str) or not re.fullmatch('sha256:[0-9a-f]{64}', value['imageId'])
            or not isinstance(value['startedAt'], str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z', value['startedAt'])
            or type(value['hostPid']) is not int or not 1 <= value['hostPid'] <= 2147483647
            or not isinstance(value['source'], str) or not SHA.fullmatch(value['source'])):
        raise ValueError('Checkpoint runtime identity refused')
    datetime.datetime.fromisoformat(value['startedAt'].replace('Z', '+00:00'))
    return value


def checkpoint_container():
    reply = bounded_journal(['docker', 'inspect', '--format', CONTAINER_FORMAT, 'club-arena-engine'])
    if reply.returncode:
        raise ValueError('Checkpoint runtime unavailable')
    fields = reply.stdout.decode('ascii').strip().split()
    if (len(fields) != 6 or not re.fullmatch('[0-9a-f]{64}', fields[0])
            or not re.fullmatch('sha256:[0-9a-f]{64}', fields[1]) or fields[2] != 'true'
            or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z', fields[3])
            or not re.fullmatch('[1-9][0-9]{0,9}', fields[4]) or int(fields[4]) > 2147483647
            or not SHA.fullmatch(fields[5])):
        raise ValueError('Checkpoint runtime identity refused')
    datetime.datetime.fromisoformat(fields[3].replace('Z', '+00:00'))
    return validate_checkpoint_runtime({'container': fields[0], 'imageId': fields[1], 'startedAt': fields[3],
            'hostPid': int(fields[4]), 'source': fields[5]})


def checkpoint_presence(container):
    try:
        reply = bounded_journal(['docker', 'exec', container['container'], 'node', '-e', CHECKPOINT_TCP])
        if reply.returncode:
            return 'unknown'
        value = json.loads(reply.stdout, object_pairs_hook=unique_object)
        if (not isinstance(value, dict) or set(value) != {'presence'}
                or not isinstance(value['presence'], str) or value['presence'] not in {'open', 'closed', 'unknown'}):
            return 'unknown'
        return value['presence']
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
        return 'unknown'


def read_checkpoint_lines(directory, name):
    def metadata():
        try:
            row = os.stat(name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(row.st_mode) or row.st_uid != os.geteuid() or stat.S_IMODE(row.st_mode) != 0o600:
            raise ValueError('Checkpoint metadata refused')
        return (row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns, row.st_ctime_ns, row.st_uid, row.st_gid, row.st_mode)
    before = metadata()
    rows = read_lines(directory, name, optional=True)
    if before != metadata() or (rows is None) != (before is None):
        raise ValueError('Checkpoint path changed across read')
    return None if before is None else (rows, before)


def checkpoint_remote(request, root_fd):
    directory = os.open('engine-release-requests', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    try:
        names = [request['runKey'] + suffix for suffix in ('.legacy-checkpoint-intent', '.request', '.intent')]
        read = lambda: [read_checkpoint_lines(directory, name) for name in names]
        before = read()
        rows = [item[0] if item is not None else None for item in before]
        intent = checkpoint_intent(rows[0], request, rows[1], rows[2])
        unit = checkpoint_unit(request)
        runtime = checkpoint_container()
        if intent is not None and any(intent[key] != runtime[key] for key in ('container', 'startedAt', 'hostPid', 'source')):
            raise ValueError('Checkpoint predecessor changed')
        presence = checkpoint_presence(runtime)
        if before != read() or unit != checkpoint_unit(request) or runtime != checkpoint_container():
            raise ValueError('Checkpoint observation changed across read')
        return {'schema': CHECKPOINT_SCHEMA, 'readOnly': True, **request,
            'intentStatus': 'retained_exact_identity' if intent else 'missing_unknown',
            'checkpointIntent': intent,
            'operationControlSha': rows[1][4] if rows[1] is not None else (intent['controlSha'] if intent else None),
            'retainedRequestBinding': {'runKey': request['runKey'], 'releaseSha': rows[1][0], 'controlSha': rows[1][4]} if rows[1] is not None else None,
            'operationIdentityBasis': 'retained_request_and_intent' if rows[1] is not None else ('selected_control_sha' if intent else 'missing_unknown'),
            'unit': unit, 'runtime': runtime,
            'tcp9229Presence': presence, 'absenceMeans': CHECKPOINT_ABSENCE}
    finally:
        os.close(directory)


def validate_checkpoint_reply(value, request):
    fields = {'schema', 'readOnly', 'runKey', 'releaseSha', 'mode', 'intentStatus',
              'checkpointIntent', 'operationControlSha', 'retainedRequestBinding', 'operationIdentityBasis', 'unit', 'runtime', 'tcp9229Presence', 'absenceMeans'}
    if (not isinstance(value, dict) or set(value) != fields or value['schema'] != CHECKPOINT_SCHEMA
            or value['readOnly'] is not True or any(value[key] != request[key] for key in request)
            or value['absenceMeans'] != CHECKPOINT_ABSENCE
            or not isinstance(value['tcp9229Presence'], str) or value['tcp9229Presence'] not in {'open', 'closed', 'unknown'}):
        raise ValueError('Checkpoint export refused')
    validate_checkpoint_unit(value['unit'])
    runtime = validate_checkpoint_runtime(value['runtime'])
    control = value['operationControlSha']
    basis = value['operationIdentityBasis']
    if ((control is not None and (not isinstance(control, str) or not SHA.fullmatch(control)))
            or not isinstance(basis, str) or basis not in {'retained_request_and_intent', 'selected_control_sha', 'missing_unknown'}
            or (basis == 'missing_unknown' and control is not None)
            or (basis == 'selected_control_sha' and control != request['releaseSha'])
            or (basis == 'retained_request_and_intent' and control is None)):
        raise ValueError('Checkpoint exported operation binding refused')
    binding = value['retainedRequestBinding']
    if basis == 'retained_request_and_intent':
        if (not isinstance(binding, dict) or set(binding) != {'runKey', 'releaseSha', 'controlSha'}
                or binding != {'runKey': request['runKey'], 'releaseSha': request['releaseSha'], 'controlSha': control}):
            raise ValueError('Checkpoint exported original request binding refused')
    elif binding is not None:
        raise ValueError('Checkpoint exported unexpected original request binding')
    intent = value['checkpointIntent']
    if intent is None:
        if value['intentStatus'] != 'missing_unknown' or basis == 'selected_control_sha':
            raise ValueError('Checkpoint exported absence refused')
    else:
        # Validate exported intent independently, preserving an explicitly bound
        # control generation that may differ from the selected image revision.
        normalized = checkpoint_intent([json.dumps(intent)], {**request, 'releaseSha': control}, None, None)
        if value['intentStatus'] != 'retained_exact_identity' or basis == 'missing_unknown' or any(normalized[key] != runtime[key] for key in ('container', 'startedAt', 'hostPid', 'source')):
            raise ValueError('Checkpoint exported predecessor differs')
    return value


def remote(request):
    request = selection(request)
    # All production paths are fixed. No environment/caller path override.
    root_fd = os.open(STATE_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if request.get('mode') == 'pending_transaction':
            return pending_remote(request, root_fd)
        if request.get('mode') == 'checkpoint_admission':
            return checkpoint_remote(request, root_fd)
        result_fd = os.open('engine-release-results', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=root_fd)
        try:
            name = 'engine-recovery-window-' + request['runKey'] + '.json'
            window = read_json(root_fd, name)
            result = read_json(result_fd, request['runKey'] + '.json')
            answer = observation(request, window, result)
            answer['emergencyBasis'] = retained_reason(request, window, result)
            if answer['emergencyBasis'] is not None:
                answer['emergencyBasisStatus'] = 'retained_exact_invocation_producer_signs'
            if window != read_json(root_fd, name) or result != read_json(result_fd, request['runKey'] + '.json'):
                raise ValueError('Persisted evidence changed across the read')
            return answer
        finally:
            os.close(result_fd)
    finally:
        os.close(root_fd)


def validate_reply(value, request):
    if request.get('mode') == 'checkpoint_admission':
        return validate_checkpoint_reply(value, request)
    if request.get('mode') == 'pending_transaction':
        fields = {'schema', 'readOnly', 'runKey', 'releaseSha', 'mode', 'controlSha', 'requestDeadlineEpoch', 'breakDeadlineEpoch', 'stage', 'unit', 'journalSigns', 'absenceMeans'}
        if (not isinstance(value, dict) or set(value) != fields or value['schema'] != PENDING_SCHEMA
                or value['readOnly'] is not True or any(value[k] != request[k] for k in request)
                or not isinstance(value['controlSha'], str) or not SHA.fullmatch(value['controlSha'])
                or value['stage'] not in {'awaiting_certificate_marker_retained', 'unknown_not_retained'}
                or value['absenceMeans'] != 'unknown; bounded latest journal rows do not prove absence'):
            raise ValueError('Pending export refused')
        for key in ('requestDeadlineEpoch', 'breakDeadlineEpoch'):
            if value[key] is None and key == 'breakDeadlineEpoch':
                continue
            if type(value[key]) is not int:
                raise ValueError('Pending exported deadline refused')
            timestamp(value[key] * 1000)
        validate_pending_unit(value['unit'])
        validate_pending_signs(value['journalSigns'])
        return value
    fields = {'schema', 'readOnly', 'runKey', 'releaseSha', 'cause', 'announcedAtMs',
              'freezeAtMs', 'windowEndsAtMs', 'sealedAtMs', 'evidenceBasis', 'emergencyBasisStatus', 'emergencyBasis'}
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
    basis = value['emergencyBasis']
    if basis is not None:
        invocation = basis.get('invocationId') if isinstance(basis, dict) else None
        window = {'announcedAt': value['announcedAtMs'], 'cause': value['cause']}
        validated_basis(basis, request, window,
                        {'completionRuntime': {'invocationId': invocation}, 'invocationIds': [invocation]})
        expected['emergencyBasis'] = basis
        expected['emergencyBasisStatus'] = 'retained_exact_invocation_producer_signs'
    if value != expected:
        raise ValueError('Exported evidence differs')
    return value


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--remote':
        request = selection(json.loads(base64.b64decode(sys.argv[2], validate=True)))
        try:
            print(json.dumps(remote(request)))
        except Exception as error:
            print(json.dumps(refusal(request, error)))
            raise SystemExit(1)
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
        if len(reply.stdout) > 4096:
            raise ValueError('Scoped evidence transport unavailable')
        if reply.returncode:
            try:
                failure = json.loads(reply.stdout, object_pairs_hook=unique_object)
            except (ValueError, UnicodeError):
                raise ValueError('Scoped evidence transport unavailable') from None
            raise validate_refusal(failure, request)
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
    except Exception as error:
        # Never expose raw state, transport stderr, paths or credential values.
        print('Existing release recovery evidence unavailable. No production action performed.', file=sys.stderr)
        if isinstance(error, ScopedRefusal):
            print('Scoped refusal phase=' + error.phase + ' code=' + error.code, file=sys.stderr)
        sys.exit(1)
