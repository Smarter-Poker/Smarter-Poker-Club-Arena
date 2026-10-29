#!/usr/bin/env python3
"""Explicit read of one completed release's existing recovery reservation."""
import base64
import datetime
import json
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
    fields = {'schema', 'readOnly', 'runKey', 'releaseSha', 'phase', 'code'}
    if (not isinstance(value, dict) or set(value) != fields
            or value['schema'] != FAILURE_SCHEMA or value['readOnly'] is not True
            or value['runKey'] != request['runKey'] or value['releaseSha'] != request['releaseSha']
            or not isinstance(value['phase'], str) or not isinstance(value['code'], str)
            or (value['phase'], value['code']) not in REFUSAL_CODES):
        raise ValueError('Scoped evidence transport unavailable')
    return ScopedRefusal(value['phase'], value['code'])


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


# Explicit active-owner diagnostics share the existing pinned, read-only transport.
ACTIVE_SCHEMA = 'exact-active-release-observation/v1'
UNIT_PROPERTIES = {'LoadState', 'ActiveState', 'Result', 'ExecMainStatus', 'InvocationID'}
ACTIVE_CODES = {
 'control_transient', 'control_permanent', 'control_superseded', 'release_handoff_retry',
 'control_installed', 'release_handed_off', 'image_reused', 'image_built',
 'image_build_resources_bound', 'image_build_lock_refused', 'certificate_deadline',
 'certificate_reserve_refused', 'cards_in_air_refused', 'inflight_unknown',
 'recovery_deferred', 'release_sealed', 'release_already_sealed',
 'certificate_not_ready', 'cards_in_air_certificate_refused',
}


def read_request_lines(directory_fd, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 4096:
            raise ValueError('Active request refused')
        raw = b''
        while len(raw) <= 4096:
            part = os.read(fd, min(1024, 4097-len(raw)))
            if not part:
                break
            raw += part
        after = os.fstat(fd)
        identity = lambda row: (row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns, row.st_ctime_ns)
        if identity(before) != identity(after) or len(raw) != before.st_size or len(raw) > 4096:
            raise ValueError('Active request changed')
        return raw.decode('utf-8').splitlines()
    finally:
        os.close(fd)


def active_request(root_fd, kind, request):
    directory = 'engine-intake-requests' if kind == 'intake' else 'engine-release-requests'
    try:
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    except FileNotFoundError:
        return {'status': 'unknown_absent'}
    try:
        try:
            lines = read_request_lines(directory_fd, request['runKey'] + '.request')
        except FileNotFoundError:
            return {'status': 'unknown_absent'}
    finally:
        os.close(directory_fd)
    if len(lines) != (5 if kind == 'intake' else 6) or lines[0] != request['releaseSha']:
        raise ValueError('Active request identity differs')
    control, url, deadline = (lines[1], lines[2], lines[4]) if kind == 'intake' else (lines[4], lines[1], lines[5])
    expected_url = 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/' + request['runKey'].split('-')[0]
    if not SHA.fullmatch(control) or url != expected_url or not re.fullmatch(r'[1-9][0-9]{0,9}', deadline):
        raise ValueError('Active request metadata differs')
    return {'status': 'matched', 'controlSha': control, 'notAfterEpoch': int(deadline)}


def active_unit(raw):
    if len(raw) > 1024:
        raise ValueError('Active unit output refused')
    lines = raw.decode('utf-8').splitlines()
    data = {}
    for line in lines:
        key, separator, value = line.partition('=')
        if not separator or key in data or key not in UNIT_PROPERTIES:
            raise ValueError('Active unit fields refused')
        data[key] = value
    if set(data) != UNIT_PROPERTIES:
        raise ValueError('Active unit properties missing')
    if (data['LoadState'] not in {'loaded', 'not-found', 'error', 'masked', 'bad-setting'}
            or data['ActiveState'] not in {'active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading', 'maintenance', 'refreshing'}
            or data['Result'] not in {'', 'success', 'exit-code', 'signal', 'core-dump', 'timeout', 'watchdog', 'start-limit-hit', 'resources', 'protocol', 'oom-kill', 'exec-condition', 'assert', 'dependency', 'skipped'}
            or not re.fullmatch(r'[0-9]{1,3}', data['ExecMainStatus'])
            or int(data['ExecMainStatus']) > 255
            or data['InvocationID'] != '' and not INVOCATION.fullmatch(data['InvocationID'])):
        raise ValueError('Active unit state refused')
    return {'loadState': data['LoadState'], 'activeState': data['ActiveState'],
            'result': data['Result'] or None, 'execMainStatus': int(data['ExecMainStatus']),
            'invocationId': data['InvocationID'] or None}


def active_code(message):
    # Exact maintained certificate producer, with a bounded scalar repr shape.
    # Never evaluate or export repr text, arbitrary reason names, or its values.
    shut = re.fullmatch(
      r"\[engine-release-transaction\] the restart certificate is shut with [0-9]{1,7}ms of the break left: unparkedTables=(?:None|[0-9]{1,10}) unparkedReasons=(None|\{(?:'[a-z0-9_]{1,64}': [0-9]{1,10}(?:, )?){0,32}\}) handsInFlightTotal=(?:None|[0-9]{1,10})", message)
    if shut:
        airborne = re.search(r"(?:\{|, )'cards_in_air': ([0-9]{1,10})(?:, |\})", shut[1])
        return 'cards_in_air_certificate_refused' if airborne and int(airborne[1]) > 0 else 'certificate_not_ready'
    literals = {
      '[engine-release-intake] RETRY: control-generation installation encountered a transient host dependency': 'control_transient',
      '[engine-release-intake] FATAL: intake control SHA was superseded; this immutable request cannot adopt newer control bytes': 'control_superseded',
      'ENGINE_RELEASE_HANDOFF=durable': 'release_handed_off',
      'ENGINE_RELEASE_HANDOFF=completed': 'release_already_sealed',
      'ENGINE_IMAGE_REUSED=true': 'image_reused',
      'ENGINE_IMAGE_REUSED=false': 'image_built',
      'FATAL: could not acquire the engine image build lock': 'image_build_lock_refused',
      '[engine-release-transaction] FATAL: the engine did not present a restart certificate with enough proof time remaining': 'certificate_deadline',
      '[engine-release-transaction] the database says a hand IS in the air; the cutover stays refused': 'cards_in_air_refused',
      '[engine-release-transaction] the database could not tell whether the felt is quiet; the cutover stays refused': 'inflight_unknown',
      '[engine-release-transaction] WARN: deferred recovery to ExecStopPost because the engine lock is not held': 'recovery_deferred',
      'ENGINE_RELEASE_RESULT=sealed': 'release_sealed',
    }
    if message in literals:
        return literals[message]
    patterns = [
      (r'\[engine-release-intake\] FATAL: control-generation installation failed permanently \(status [0-9]{1,3}\)', 'control_permanent'),
      (r'\[engine-release-intake\] RETRY: durable release-unit handoff did not complete \(status [0-9]{1,3}\)', 'release_handoff_retry'),
      (r'ENGINE_CONTROL_INSTALL_SHA=[0-9a-f]{40}', 'control_installed'),
      (r'ENGINE_BUILD_RESOURCE_BOUNDARY=memory:[0-9]+,swap:[0-9]+,cpu:[0-9]+ [0-9]+', 'image_build_resources_bound'),
      (r'\[engine-release-transaction\] the (durable|locked) table break has [0-9]+ms remaining, below the [0-9]+ms candidate-and-recovery budget; (refusing before mutation and )?waiting for a later certificate', 'certificate_reserve_refused'),
    ]
    return next((code for pattern, code in patterns if re.fullmatch(pattern, message)), None)


def active_journal(raw, unit, invocation):
    if len(raw) > 8192 or len(raw.splitlines()) > 8:
        raise ValueError('Active journal output refused')
    events, unknown = [], 0
    for line in raw.splitlines():
        row = json.loads(line, object_pairs_hook=unique_object)
        if (not isinstance(row, dict) or not {'MESSAGE', '_SYSTEMD_UNIT', '_SYSTEMD_INVOCATION_ID', '__REALTIME_TIMESTAMP'} <= set(row)
                or row['_SYSTEMD_UNIT'] != unit or row['_SYSTEMD_INVOCATION_ID'] != invocation
                or not isinstance(row['__REALTIME_TIMESTAMP'], str)
                or not re.fullmatch(r'[0-9]{16}', row['__REALTIME_TIMESTAMP'])
                or not isinstance(row['MESSAGE'], str) or len(row['MESSAGE']) > 2048):
            raise ValueError('Active journal identity refused')
        # Native journal metadata is discarded; only fixed codes cross transport.
        code = active_code(row['MESSAGE'])
        if code:
            events.append({'code': code, 'observedAtMs': timestamp(int(row['__REALTIME_TIMESTAMP']) // 1000)})
        else:
            unknown += 1
    return {'status': 'read', 'events': events, 'unrecognizedRows': unknown}


def remote_active(request):
    request = selection(request)
    root_fd = os.open(STATE_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        requests = {kind: active_request(root_fd, kind, request) for kind in ('intake', 'release')}
        units = {}
        for kind in ('intake', 'release'):
            unit = 'club-arena-engine-' + kind + '-v1@' + request['runKey'] + '.service'
            args = ['systemctl', 'show', '--no-pager', '--property=' + ','.join(sorted(UNIT_PROPERTIES)), unit]
            try:
                reply = bounded_journal(args)
            except (OSError, subprocess.TimeoutExpired):
                reply = None
            if reply is None or reply.returncode:
                units[kind] = {'status': 'unknown_unavailable'}
                continue
            state = active_unit(reply.stdout)
            journal = {'status': 'unknown_no_invocation', 'events': [], 'unrecognizedRows': 0}
            if state['invocationId']:
                args = ['journalctl', '--no-pager', '--output=json', '--lines=8',
                  '--output-fields=MESSAGE,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID,__REALTIME_TIMESTAMP',
                  '--grep=^(\\[engine-release-(transaction|intake)\\]|ENGINE_(CONTROL_INSTALL_SHA|RELEASE_HANDOFF|RELEASE_RESULT|IMAGE_REUSED|BUILD_RESOURCE_BOUNDARY)=|FATAL: could not acquire the engine image build lock)',
                  '_SYSTEMD_UNIT=' + unit, '_SYSTEMD_INVOCATION_ID=' + state['invocationId']]
                try:
                    rows = bounded_journal(args)
                except (OSError, subprocess.TimeoutExpired):
                    rows = None
                if rows is None or rows.returncode:
                    journal['status'] = 'unknown_unavailable'
                else:
                    journal = active_journal(rows.stdout, unit, state['invocationId'])
            # Refuse a unit restart during collection, rather than combining invocations.
            after = bounded_journal(['systemctl', 'show', '--no-pager', '--property=' + ','.join(sorted(UNIT_PROPERTIES)), unit])
            if after.returncode or active_unit(after.stdout) != state:
                raise ValueError('Active unit changed across read')
            units[kind] = {**state, 'journal': journal}
        if requests != {kind: active_request(root_fd, kind, request) for kind in ('intake', 'release')}:
            raise ValueError('Active request changed across read')
        return {'schema': ACTIVE_SCHEMA, 'readOnly': True, **request, 'requests': requests,
                'units': units, 'verdict': 'observation_only_not_activation_or_recovery_authority'}
    finally:
        os.close(root_fd)


def validate_active_reply(value, request):
    if (not isinstance(value, dict) or set(value) != {'schema','readOnly','runKey','releaseSha','requests','units','verdict'}
            or value['schema'] != ACTIVE_SCHEMA or value['readOnly'] is not True
            or value['runKey'] != request['runKey'] or value['releaseSha'] != request['releaseSha']
            or value['verdict'] != 'observation_only_not_activation_or_recovery_authority'):
        raise ValueError('Active export refused')
    for group in ('requests', 'units'):
        if not isinstance(value[group], dict) or set(value[group]) != {'intake','release'}:
            raise ValueError('Active export fields refused')
    for row in value['requests'].values():
        if row == {'status':'unknown_absent'}:
            continue
        if (set(row) != {'status','controlSha','notAfterEpoch'} or row['status'] != 'matched'
                or not isinstance(row['controlSha'], str) or not SHA.fullmatch(row['controlSha'])
                or type(row['notAfterEpoch']) is not int or not 1 <= row['notAfterEpoch'] < 10000000000):
            raise ValueError('Active request export refused')
    for row in value['units'].values():
        if row == {'status':'unknown_unavailable'}:
            continue
        if not isinstance(row, dict) or set(row) != {'loadState','activeState','result','execMainStatus','invocationId','journal'}:
            raise ValueError('Active unit export refused')
        native = '\n'.join([f'LoadState={row["loadState"]}', f'ActiveState={row["activeState"]}',
                           f'Result={row["result"] or ""}', f'ExecMainStatus={row["execMainStatus"]}',
                           f'InvocationID={row["invocationId"] or ""}']).encode()
        if {**active_unit(native),'journal':row['journal']} != row:
            raise ValueError('Active unit export differs')
        journal = row['journal']
        if (not isinstance(journal, dict) or set(journal) != {'status','events','unrecognizedRows'}
                or journal['status'] not in {'read','unknown_no_invocation','unknown_unavailable'}
                or type(journal['unrecognizedRows']) is not int or not 0 <= journal['unrecognizedRows'] <= 8
                or not isinstance(journal['events'], list) or len(journal['events']) + journal['unrecognizedRows'] > 8):
            raise ValueError('Active journal export refused')
        for event in journal['events']:
            if not isinstance(event, dict) or set(event) != {'code','observedAtMs'} or event['code'] not in ACTIVE_CODES:
                raise ValueError('Active event export refused')
            timestamp(event['observedAtMs'])
        if journal['status'] != 'read' and (journal['events'] or journal['unrecognizedRows']):
            raise ValueError('Active unknown export refused')
    return value


def main():
    if len(sys.argv) == 3 and sys.argv[1] in {'--remote', '--remote-active'}:
        request = selection(json.loads(base64.b64decode(sys.argv[2], validate=True)))
        try:
            print(json.dumps(remote_active(request) if sys.argv[1] == '--remote-active' else remote(request)))
        except Exception as error:
            print(json.dumps(refusal(request, error)))
            raise SystemExit(1)
        return
    active = sys.argv[1:] == ['--active']
    if (len(sys.argv) != 1 and not active) or os.environ.get('GITHUB_EVENT_NAME') != 'repository_dispatch':
        raise ValueError('Explicit observation dispatch required')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    if event.get('action') != 'audit-production-integrity':
        raise ValueError('Wrong observation event')
    payload = event.get('client_payload', {})
    field = 'active_release_observation' if active else 'release_recovery_observation'
    if active and set(payload) != {field}:
        raise ValueError('Active observation must be the only requested mode')
    request = selection(payload.get(field))
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
                'root@' + host, "python3 - " + ('--remote-active' if active else '--remote') + " '" + encoded + "'"]
        reply = subprocess.run(args, input=Path(__file__).read_bytes(), capture_output=True, timeout=30)
        if len(reply.stdout) > (8192 if active else 4096):
            raise ValueError('Scoped evidence transport unavailable')
        if reply.returncode:
            try:
                failure = json.loads(reply.stdout, object_pairs_hook=unique_object)
            except (ValueError, UnicodeError):
                raise ValueError('Scoped evidence transport unavailable') from None
            raise validate_refusal(failure, request)
        validator = validate_active_reply if active else validate_reply
        answer = validator(json.loads(reply.stdout, object_pairs_hook=unique_object), request)
        answer['observedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        serialized = json.dumps(answer, indent=2) + '\n'
        if key in serialized or pin in serialized:
            raise ValueError('Observation export refused')
        destination = Path('artifacts/active-release-observation' if active else 'artifacts/release-recovery-observation')
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
