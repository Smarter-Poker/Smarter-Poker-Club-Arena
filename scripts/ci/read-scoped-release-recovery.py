#!/usr/bin/env python3
"""Explicit read of one completed release's existing recovery reservation."""
import base64
import ast
import datetime
import hashlib
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
    'Inspector read deadline': ('inspector', 'command_deadline'),
    'Inspector read size': ('inspector', 'command_size'),
    'Inspector native unavailable': ('inspector', 'command_nonzero'),
    'Inspector container unknown': ('inspector', 'container_unproved'),
    'Inspector healthy predecessor unknown': ('inspector', 'health_unproved'),
    'Inspector intent unknown': ('inspector', 'intent_unavailable'),
    'Inspector partial request records': ('inspector', 'request_partial'),
    'Inspector control differs': ('inspector', 'control_changed'),
    'Inspector retired failure receipt unknown': ('inspector', 'failure_receipt_unproved'),
    'Inspector log bound': ('inspector', 'history_size'),
    'Inspector historical endpoint unknown': ('inspector', 'history_endpoint_unproved'),
    'Inspector historical time differs': ('inspector', 'history_time_changed'),
    'Inspector historical endpoint ambiguous': ('inspector', 'history_ambiguous'),
    'Inspector probe unknown': ('inspector', 'probe_unproved'),
    'Inspector probe fields': ('inspector', 'probe_fields'),
    'Inspector probe identity': ('inspector', 'probe_identity'),
    'Inspector scalar identity': ('inspector', 'scalar_identity'),
    'Inspector scalar unavailable': ('inspector', 'native_scalar_unavailable'),
    'Inspector scalar overflow': ('inspector', 'scalar_overflow'),
    'Inspector export refused': ('inspector', 'export_fields'),
    'Inspector exported source': ('inspector', 'export_source'),
    'Inspector exported instance': ('inspector', 'export_instance'),
    'Inspector exported endpoint': ('inspector', 'export_endpoint'),
    'Inspector owned export refused': ('inspector', 'export_owned'),
    'Inspector unknown scalar export': ('inspector', 'export_unknown_scalar'),
    'Inspector outcome export': ('inspector', 'export_outcome'),
    'Inspector absence identity export': ('inspector', 'export_absence_identity'),
}
REFUSAL_CODES = set(REFUSALS.values()) | {('remote', 'evidence_refused'), ('inspector', 'intent_unavailable'), ('inspector', 'identity_changed'), ('inspector', 'native_scalar_unavailable')}
REFUSAL_CODES |= {('serving_role', 'binding_unproved'), ('serving_role', 'evidence_unavailable')}


INSPECTOR_COMMAND_STAGES = {'container', 'health', 'image', 'probe', 'history',
                            'recheck_container', 'recheck_health'}
INSPECTOR_COMMAND_ERRORS = {'Inspector read deadline': 'command_deadline',
                            'Inspector read size': 'command_size',
                            'Inspector native unavailable': 'command_nonzero'}
REFUSAL_CODES |= {('inspector_' + stage, code)
                  for stage in INSPECTOR_COMMAND_STAGES
                  for code in INSPECTOR_COMMAND_ERRORS.values()}
PENDING_READ_STAGES = {'directory', 'request_read', 'request_binding', 'unit',
                       'journal', 'recheck_requests', 'recheck_unit'}
REFUSAL_CODES |= {('pending_' + stage, 'evidence_unavailable')
                  for stage in PENDING_READ_STAGES}
REFUSAL_CODES |= {('pending_' + stage, 'records_absent')
                  for stage in ('directory', 'request_read', 'recheck_requests')}
PENDING_JOURNAL_ERRORS = {
    'Pending journal unavailable': 'command_nonzero',
    'Recovery witness output refused': 'output_bound',
    'Pending journal ownership refused': 'ownership_refused',
    'Pending journal shape refused': 'shape_refused',
    'Duplicate persisted field': 'fields_refused',
}
REFUSAL_CODES |= {('pending_journal', code) for code in
    set(PENDING_JOURNAL_ERRORS.values()) | {'command_deadline', 'command_unavailable', 'json_refused'}}


class ScopedRefusal(ValueError):
    def __init__(self, phase, code):
        if (phase, code) not in REFUSAL_CODES:
            raise ValueError('Unqualified refusal code')
        self.phase, self.code = phase, code
        super().__init__('Scoped evidence refused')


def refusal(request, error):
    phase, code = (error.phase, error.code) if isinstance(error, ScopedRefusal) else REFUSALS.get(str(error), ('remote', 'evidence_refused'))
    return {'schema': FAILURE_SCHEMA, 'readOnly': True, **selection(request),
            'phase': phase, 'code': code}


def validate_refusal(value, request):
    request = selection(request)
    fields = {'schema', 'readOnly', 'phase', 'code'} | set(request)
    if (not isinstance(value, dict) or set(value) != fields
            or value['schema'] != FAILURE_SCHEMA or value['readOnly'] is not True
            or any(value[key] != expected for key, expected in request.items())
            or not isinstance(value['phase'], str) or not isinstance(value['code'], str)
            or (value['phase'], value['code']) not in REFUSAL_CODES):
        raise ValueError('Scoped evidence transport unavailable')
    return ScopedRefusal(value['phase'], value['code'])


def selection(value):
    if isinstance(value, dict) and value.get('mode') == 'current_serving_inspector_role':
        if (set(value) != {'mode', 'releaseSha', 'instanceId'}
                or value['releaseSha'] != EED
                or not isinstance(value['instanceId'], str)
                or not re.fullmatch(r'1-[0-9a-f]{8}', value['instanceId'])):
            raise ValueError('Exact current serving identity required')
        return dict(value)
    if (not isinstance(value, dict) or set(value) not in ({'runKey', 'releaseSha'}, {'runKey', 'releaseSha', 'mode'})
            or ('mode' in value and value['mode'] not in {'pending_transaction', 'legacy_checkpoint_inspector', 'main_inspector_retirement'})):
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


def read_json(directory_fd, name, private=False):
    """Fixed relative file, no links, bounded bytes, unchanged inode/time/size."""
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_size > MAX_BYTES
                or (private and (before.st_uid != os.geteuid() or stat.S_IMODE(before.st_mode) != 0o600))):
            raise ValueError('Persisted evidence file refused')
        raw = b''
        while len(raw) <= MAX_BYTES:
            part = os.read(fd, min(4096, MAX_BYTES + 1 - len(raw)))
            if not part:
                break
            raw += part
        after = os.fstat(fd)
        identity = lambda row: (row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns, row.st_ctime_ns, row.st_uid, row.st_mode)
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



PENDING_SCHEMA = 'existing-release-pending-observation/v6'
PENDING_RECOVERY_STATUSES = ('accepted', 'active', 'pending', 'busy', 'expired',
                             'use_hourly', 'unavailable', 'unknown')
PENDING_RECOVERY_CATEGORIES = {
    'recovery_newer_owner', 'recovery_inspector_unproved',
    'recovery_reservation_unestablished', 'recovery_rate_limited',
} | {'recovery_announcement_' + status for status in PENDING_RECOVERY_STATUSES}
PENDING_ENTRY_CATEGORIES = {'lightning_hold_recorded', 'lightning_hold_released', 'lightning_hold_unknown', 'lightning_hold_timeout', 'lightning_hold_helper_unavailable',
    'legacy_entry_admitted', 'legacy_entry_locked', 'legacy_entry_checkpoint',
    'legacy_entry_completed', 'legacy_entry_countdown_refused', 'legacy_entry_checkpoint_refused'}
PENDING_CATEGORIES = {'certificate_shut', 'candidate_budget_missed',
                      'locked_budget_missed', 'legacy_entry_deferred',
                      'certificate_also_shut', 'rollback_readiness_completed',
                      'rollback_certificate_lost', 'weekly_owner_active',
                      'inflight_evidence_unavailable', 'mutation_lock_unavailable',
                      'mutation_lock_deadline', 'hands_in_air'} | PENDING_RECOVERY_CATEGORIES | PENDING_ENTRY_CATEGORIES
# Compact, closed v3 certificate tuple: [remainingMs, unparkedTables,
# handsInFlightTotal, reasonCounts]. reasonCounts follows this order, with
# one final count of UNRECOGNIZED KEYS; private/future names never leave host.
# None retains original None/absent fields. A None details tuple means the
# literal's details could not be qualified, never an empty or quiet gate.
PENDING_REASON_ORDER = (
    'f06_preparation_unresolved', 'f06_preparation_stuck', 'cards_in_air',
    'accounting_unconfirmed', 'accounting_pending', 'bank_park_write_incomplete',
    'stopped_bank_custody_unreadable', 'stopped_bank_custody_unwritten',
    'stopped_bank_custody_unconfirmed', 'stopped_bank_custody_stuck', 'unknown',
    'time_bank_accounting_pending', 'time_bank_accounting_unconfirmed',
    'live_time_banks_retained', 'hand_preparation_pending',
)


def pending_integer(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def pending_reason_counts(text):
    tree = ast.parse(text, mode='eval').body
    if isinstance(tree, ast.Constant) and tree.value is None:
        return None
    if not isinstance(tree, ast.Dict) or len(tree.keys) > 32:
        raise ValueError('Pending literal reasons refused')
    keys = [ast.literal_eval(key) for key in tree.keys]
    values = [ast.literal_eval(value) for value in tree.values]
    if (any(type(key) is not str for key in keys) or len(set(keys)) != len(keys)
            or any(not pending_integer(value) for value in values)):
        raise ValueError('Pending literal reasons refused')
    counts = dict(zip(keys, values))
    return [counts.get(key, 0) for key in PENDING_REASON_ORDER] + [
        sum(key not in PENDING_REASON_ORDER for key in keys)]


def pending_certificate_details(message, also=False):
    prefix = r'\[engine-release-transaction\] the restart certificate is '
    pattern = (prefix + r'also shut: unparkedTables=(None|[0-9]+) unparkedReasons=(.+)'
               if also else prefix + r'shut with ([0-9]+)ms of the break left: '
               r'unparkedTables=(None|[0-9]+) unparkedReasons=(.+) handsInFlightTotal=(None|[0-9]+)')
    match = re.fullmatch(pattern, message)
    if not match:
        return None
    try:
        remaining, unparked, reasons, hands = ((None, *match.groups(), None)
                                              if also else match.groups())
        scalar = lambda value: None if value in (None, 'None') else int(value)
        result = [scalar(remaining), scalar(unparked), scalar(hands), pending_reason_counts(reasons)]
        validate_pending_details('certificate_also_shut' if also else 'certificate_shut', result)
        return result
    except (SyntaxError, ValueError, TypeError, RecursionError):
        return None


def pending_recovery_category(message):
    # Existing producer literals only. Validate, then discard every source,
    # run, cause and announcement timestamp. These signs grant no authority.
    prefix = r'\[engine-release-transaction\] '
    if re.fullmatch(prefix + r'newer release [0-9a-f]{40} \(run [1-9][0-9]{0,19}(?:-[1-9][0-9]{0,3})?\) is in flight and owns any off-cycle window; this release waits for the scheduled break', message):
        return 'recovery_newer_owner'
    fixed = {
        '[engine-release-transaction] legacy inspector absence is not proved; no recovery window requested and no inspector was touched': 'recovery_inspector_unproved',
        '[engine-release-transaction] recovery announcement reservation could not be established; no window was announced, waiting for the scheduled break': 'recovery_reservation_unestablished',
    }
    if message in fixed:
        return fixed[message]
    cause = (r'(?:owner-ordered [a-z0-9][a-z0-9-]{0,63}|engine-degraded '
             r'(?:liveness=dead(?:,wholeFleetStalled)?(?:,tournamentManagersQuarantined=[1-9][0-9]*)?'
             r'|wholeFleetStalled(?:,tournamentManagersQuarantined=[1-9][0-9]*)?'
             r'|tournamentManagersQuarantined=[1-9][0-9]*))')
    if re.fullmatch(prefix + r'off-cycle window wanted \(' + cause + r'\) but one was already announced in the last hour; waiting for the scheduled break', message):
        return 'recovery_rate_limited'
    match = re.fullmatch(prefix + r'fixed recovery announcement ([1-9][0-9]{12}): ('
                         + '|'.join(PENDING_RECOVERY_STATUSES)
                         + r'); existing certificate and rollback budget remain required', message)
    if match:
        try:
            timestamp(int(match.group(1)))
        except ValueError:
            return None
        return 'recovery_announcement_' + match.group(2)
    return None


def pending_entry_category(message):
    # Existing producers only. Numeric values and transport errors stay private;
    # the exact invocation-bound journal timestamp is the ordering witness.
    if re.fullmatch(r'\[engine-release-lightning-hold\] Lightning hold recorded: [0-9]+ owned, [0-9]+ foreign, [0-9]+ refused', message):
        return 'lightning_hold_recorded'
    if re.fullmatch(r'\[engine-release-lightning-hold\] Lightning hold released: [0-9]+ owned Cluster\(s\)', message):
        return 'lightning_hold_released'
    if message.startswith('[engine-release-lightning-hold] UNKNOWN: '):
        return 'lightning_hold_unknown'
    if re.fullmatch(r'\[engine-release-transaction\] WARN: the Lightning hold answered UNKNOWN \(exit (124|137)\); it is retried on the next pass', message):
        return 'lightning_hold_timeout'
    if re.fullmatch(r'\[engine-release-transaction\] WARN: the Lightning hold answered UNKNOWN \(exit [0-9]+\); it is retried on the next pass', message):
        return 'lightning_hold_unknown'
    if re.fullmatch(r'\[engine-release-transaction\] WARN: the Lightning hold helper could not run \(exit (126|127)\); Lightning was NEVER ASKED to pause this pass and the census guard decides on its own', message):
        return 'lightning_hold_helper_unavailable'
    match = re.fullmatch(r'\[engine-release-transaction\] legacy entry phase=(admitted|locked|checkpoint|completed|refused) reason=(verified|countdown_refused|checkpoint_refused) elapsedEntryMs=[0-9]+ remainingEntryMs=-?[0-9]+ remainingWindowMs=-?[0-9]+', message)
    if match:
        phase, reason = match.groups()
        if phase == 'refused' and reason in {'countdown_refused', 'checkpoint_refused'}:
            return 'legacy_entry_' + reason
        if phase != 'refused' and reason == 'verified':
            return 'legacy_entry_' + phase
    return None


def validate_pending_details(category, details):
    if details is None:
        return
    if not isinstance(details, list):
        raise ValueError('Pending details refused')
    if category in {'certificate_shut', 'certificate_also_shut'}:
        if (len(details) != 4 or any(value is not None and not pending_integer(value) for value in details[:3])
                or (category == 'certificate_shut' and details[0] is None)
                or (category == 'certificate_also_shut' and (details[0] is not None or details[2] is not None))):
            raise ValueError('Pending certificate details refused')
        reasons = details[3]
        if reasons is not None and (not isinstance(reasons, list)
                or len(reasons) != len(PENDING_REASON_ORDER) + 1
                or any(not pending_integer(value) for value in reasons)):
            raise ValueError('Pending reason counts refused')
        return
    lengths = {'candidate_budget_missed': 2, 'locked_budget_missed': 2,
               'rollback_readiness_completed': 3, 'rollback_certificate_lost': 3,
               'hands_in_air': 2}
    if category not in lengths or len(details) != lengths[category] or any(not pending_integer(value) for value in details):
        raise ValueError('Pending numeric details refused')


def pending_legacy_intent(request, directory, control):
    # Only an exact-file ENOENT is absence AT THESE READS. Never permission to
    # retry a one-shot or proof that it did not exist earlier. No native probe.
    try:
        value = inspector_intent(request, directory)
    except FileNotFoundError:
        return {'status': 'absent_at_read', 'code': None}, None
    except (OSError, ValueError, UnicodeError):
        return {'status': 'unknown', 'code': 'evidence_unavailable'}, None
    if value['controlSha'] != control:
        return {'status': 'unknown', 'code': 'binding_refused'}, None
    return {'status': 'bound_at_read', 'code': None}, json.dumps(value, sort_keys=True)


def validate_pending_intent(value):
    if (not isinstance(value, dict) or set(value) != {'status', 'code'}
            or not isinstance(value['status'], str)
            or (value['code'] is not None and not isinstance(value['code'], str))
            or (value['status'], value['code']) not in {
                ('absent_at_read', None), ('bound_at_read', None),
                ('unknown', 'not_read'), ('unknown', 'evidence_unavailable'),
                ('unknown', 'binding_refused'), ('unknown', 'changed_during_read')}):
        raise ValueError('Pending intent export refused')


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
        # Below-budget "also shut" chatter must not evict the early causal
        # refusal from the existing twelve-row selection. Absence stays unknown.
        '--grep=^(\\[engine-release-lightning-hold\\] (Lightning hold recorded: |Lightning hold released: |UNKNOWN: )|\\[engine-release-transaction\\] (WARN: the Lightning hold |legacy entry phase=|the restart certificate is shut with |the durable table break has |the locked table break has |the legacy checkpoint entry did not fit|newer release [0-9a-f]{40} \\(run [1-9][0-9]*(-[1-9][0-9]*)?\\) is in flight and owns any off-cycle window; |legacy inspector absence is not proved; |recovery announcement reservation could not be established; |off-cycle window wanted \\(|fixed recovery announcement [1-9][0-9]{12}: |prove_rollback_readiness took |FATAL: (legacy checkpoint did not retain |could not acquire the engine mutation lock for maintenance cutover|deadline expired before maintenance cutover))|\\[engine-release-inflight-hands\\] (weekly payout owns the boundary; refusing cutover|UNKNOWN:|[0-9]+ hand\\(s\\) in the air within ))',
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
        category = pending_recovery_category(message) or pending_entry_category(message)
        details = None
        # Literal producer prefixes in engine-release-transaction.sh. Unknown
        # messages remain unknown; their text never leaves the host.
        if message.startswith('[engine-release-transaction] the restart certificate is shut with '):
            category = 'certificate_shut'
            details = pending_certificate_details(message)
        elif message.startswith('[engine-release-transaction] the restart certificate is also shut: '):
            category = 'certificate_also_shut'
            details = pending_certificate_details(message, also=True)
        elif (message.startswith('[engine-release-transaction] the durable table break has ')
              and message.endswith('candidate-and-recovery budget; refusing before mutation and waiting for a later certificate')):
            category = 'candidate_budget_missed'
        elif (message.startswith('[engine-release-transaction] the locked table break has ')
              and message.endswith('candidate-and-recovery budget; waiting for a later certificate')):
            category = 'locked_budget_missed'
        elif message == '[engine-release-transaction] the legacy checkpoint entry did not fit inside this break and nothing was attempted; waiting for a later certificate':
            category = 'legacy_entry_deferred'
        elif message == '[engine-release-inflight-hands] weekly payout owns the boundary; refusing cutover':
            category = 'weekly_owner_active'
        elif message.startswith('[engine-release-inflight-hands] UNKNOWN: '):
            category = 'inflight_evidence_unavailable'
        elif message == '[engine-release-transaction] FATAL: could not acquire the engine mutation lock for maintenance cutover':
            category = 'mutation_lock_unavailable'
        elif message == '[engine-release-transaction] FATAL: deadline expired before maintenance cutover':
            category = 'mutation_lock_deadline'
        numeric = [
            ('candidate_budget_missed', r'\[engine-release-transaction\] the durable table break has ([0-9]+)ms remaining, below the ([0-9]+)ms candidate-and-recovery budget; refusing before mutation and waiting for a later certificate'),
            ('locked_budget_missed', r'\[engine-release-transaction\] the locked table break has ([0-9]+)ms remaining, below the ([0-9]+)ms candidate-and-recovery budget; waiting for a later certificate'),
            ('rollback_readiness_completed', r'\[engine-release-transaction\] prove_rollback_readiness took ([0-9]+)ms of the ([0-9]+)ms entry allowance inside the ([0-9]+)s legacy checkpoint budget'),
            ('rollback_certificate_lost', r'\[engine-release-transaction\] FATAL: legacy checkpoint did not retain the full restart certificate and ([0-9]+)ms legacy reserve \(([0-9]+)ms remaining, certificate rc ([0-9]+)\)'),
            ('hands_in_air', r'\[engine-release-inflight-hands\] ([0-9]+) hand\(s\) in the air within ([0-9]+)s - refusing the cutover:'),
        ]
        for candidate, pattern in numeric:
            match = re.fullmatch(pattern, message)
            if match:
                category = candidate
                details = [int(value) for value in match.groups()]
                try:
                    validate_pending_details(category, details)
                except ValueError:
                    details = None
                break
        if category:
            sign = {'category': category, 'observedAtMs': int(stamp) // 1000, 'details': details}
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


def validate_pending_tcp(value):
    unknown_codes = {'not_read', 'command_deadline', 'command_size', 'command_nonzero',
                     'container_unproved', 'health_unproved', 'image_unproved',
                     'identity_changed', 'probe_unproved', 'evidence_unavailable'}
    if (not isinstance(value, dict) or set(value) != {'state', 'binding', 'code'}
            or any(not isinstance(value[key], str) for key in value)):
        raise ValueError('Pending TCP export refused')
    if ((value['state'], value['binding'], value['code']) not in {
            ('closed', 'matched', 'connection_refused'),
            ('listening', 'matched', 'connection_established')}
            and not (value['state'] == 'unknown' and value['binding'] == 'unproved'
                     and value['code'] in unknown_codes)):
        raise ValueError('Pending TCP export refused')


def validate_pending_owner(value, tcp):
    if (not isinstance(value, str) or value not in {'main', 'other_container_process', 'unknown'}
            or (value != 'unknown' and tcp != {'state': 'listening', 'binding': 'matched', 'code': 'connection_established'})):
        raise ValueError('Pending socket owner refused')


def validate_kernel_owner_evidence(value, owner, *, allow_not_observed=False):
    if (not isinstance(value, dict) or set(value) != {'stage', 'code'}
            or not isinstance(value['stage'], str) or value['stage'] not in KERNEL_OWNER_STAGES
            or not isinstance(value['code'], str) or value['code'] not in KERNEL_OWNER_CODES):
        raise ValueError('Kernel owner evidence refused')
    if ((value['stage'] == 'complete' or value['code'] == 'exclusive')
            != (owner != 'unknown')
            or (owner != 'unknown' and value != {'stage': 'complete', 'code': 'exclusive'})
            or (value['stage'] == 'not_observed' and (not allow_not_observed
                or value['code'] not in {'not_read', 'not_listening', 'tcp_unproved'}))
            or (value['stage'] != 'not_observed'
                and value['code'] in {'not_read', 'not_listening', 'tcp_unproved'})):
        raise ValueError('Kernel owner evidence refused')
    return value


def pending_observation(request, rows, intent, marker, deadline, unit, signs, journal_failure=None, legacy_intent=None, inspector_tcp=None, inspector_owner=None, inspector_owner_evidence=None):
    control, stamp, break_deadline = pending_metadata(request, rows, intent, marker, deadline)
    validate_pending_unit(unit)
    validate_pending_journal(signs, journal_failure)
    legacy_intent = legacy_intent if legacy_intent is not None else {'status': 'unknown', 'code': 'not_read'}
    validate_pending_intent(legacy_intent)
    inspector_tcp = inspector_tcp if inspector_tcp is not None else {'state': 'unknown', 'binding': 'unproved', 'code': 'not_read'}
    validate_pending_tcp(inspector_tcp)
    inspector_owner = inspector_owner if inspector_owner is not None else 'unknown'
    validate_pending_owner(inspector_owner, inspector_tcp)
    inspector_owner_evidence = (inspector_owner_evidence if inspector_owner_evidence is not None
                               else {'stage': 'not_observed', 'code': 'not_read'})
    validate_kernel_owner_evidence(inspector_owner_evidence, inspector_owner, allow_not_observed=True)
    return {'schema': PENDING_SCHEMA, 'readOnly': True, **request, 'controlSha': control,
        'requestDeadlineEpoch': stamp, 'breakDeadlineEpoch': break_deadline,
        'stage': 'awaiting_certificate_marker_retained' if marker else 'unknown_not_retained',
        'unit': unit, 'journalSigns': signs,
        'legacyIntent': legacy_intent,
        'inspectorTcp': inspector_tcp,
        'inspectorOwner': inspector_owner,
        'inspectorOwnerEvidence': inspector_owner_evidence,
        'journalStatus': 'unavailable' if journal_failure else 'observed',
        'journalFailure': journal_failure,
        'absenceMeans': 'unknown; bounded latest journal rows do not prove absence'}


def validate_pending_journal(signs, failure):
    if failure is None:
        validate_pending_signs(signs)
        return
    if (signs is not None or not isinstance(failure, dict)
            or set(failure) != {'phase', 'code'}
            or failure['phase'] != 'pending_journal' or not isinstance(failure['code'], str)
            or (failure['phase'], failure['code']) not in REFUSAL_CODES):
        raise ValueError('Pending journal unknown export refused')


def validate_pending_signs(signs):
    if not isinstance(signs, list) or len(signs) > 12:
        raise ValueError('Pending signs refused')
    for sign in signs:
        if (not isinstance(sign, dict) or set(sign) != {'category', 'observedAtMs', 'details'}
                or not isinstance(sign['category'], str)
                or sign['category'] not in PENDING_CATEGORIES):
            raise ValueError('Pending sign refused')
        timestamp(sign['observedAtMs'])
        validate_pending_details(sign['category'], sign['details'])


def pending_stage(stage, read):
    if stage not in PENDING_READ_STAGES:
        raise ValueError('Unqualified pending read stage')
    try:
        return read()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        if isinstance(error, ScopedRefusal):
            raise
        if stage == 'journal':
            code = ('command_deadline' if isinstance(error, subprocess.TimeoutExpired) else
                    'command_unavailable' if isinstance(error, OSError) else
                    'json_refused' if isinstance(error, json.JSONDecodeError) else
                    PENDING_JOURNAL_ERRORS.get(str(error), 'evidence_unavailable'))
            raise ScopedRefusal('pending_journal', code) from None
        absent = isinstance(error, FileNotFoundError) and stage in {
            'directory', 'request_read', 'recheck_requests'}
        raise ScopedRefusal('pending_' + stage,
                            'records_absent' if absent else 'evidence_unavailable') from None


def pending_remote(request, root_fd):
    directory = pending_stage('directory', lambda: os.open(
        'engine-release-requests', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd))
    try:
        names = [request['runKey'] + suffix for suffix in
                 ('.request', '.intent', '.awaiting-certificate', '.break-deadline')]
        read = lambda: [read_lines(directory, name, optional=index > 1) for index, name in enumerate(names)]
        before = pending_stage('request_read', read)
        pending_stage('request_binding', lambda: pending_metadata(request, *before))
        unit = pending_stage('unit', lambda: pending_unit(request))
        legacy_intent, legacy_binding = pending_legacy_intent(request, directory, before[0][4])
        journal_failure = None
        try:
            signs = pending_stage('journal', lambda: pending_journal(request, unit))
        except ScopedRefusal as error:
            if error.phase != 'pending_journal':
                raise
            signs = None
            journal_failure = {'phase': error.phase, 'code': error.code}
        # Supplemental current TCP presence needs no historical checkpoint
        # intent. Its unknown outcome never bypasses the mandatory rechecks.
        try:
            inspector_tcp, inspector_owner, inspector_owner_evidence = pending_tcp_presence(include_owner_evidence=True)
            validate_pending_tcp(inspector_tcp)
            validate_pending_owner(inspector_owner, inspector_tcp)
            validate_kernel_owner_evidence(inspector_owner_evidence, inspector_owner, allow_not_observed=True)
        except (OSError, ValueError, subprocess.SubprocessError):
            inspector_tcp = {'state': 'unknown', 'binding': 'unproved', 'code': 'evidence_unavailable'}
            inspector_owner = 'unknown'
            inspector_owner_evidence = {'stage': 'not_observed', 'code': 'tcp_unproved'}
        if (legacy_intent, legacy_binding) != pending_legacy_intent(request, directory, before[0][4]):
            legacy_intent = {'status': 'unknown', 'code': 'changed_during_read'}
        if before != pending_stage('recheck_requests', read):
            raise ScopedRefusal('pending_recheck_requests', 'evidence_unavailable')
        if unit != pending_stage('recheck_unit', lambda: pending_unit(request)):
            raise ScopedRefusal('pending_recheck_unit', 'evidence_unavailable')
        return pending_observation(request, *before, unit, signs, journal_failure, legacy_intent, inspector_tcp, inspector_owner, inspector_owner_evidence)
    finally:
        os.close(directory)


# Fixed TCP-only presence: one connection, no bytes sent, HTTP, WebSocket,
# evaluation, process signals or inspector lifecycle calls. The child destroys
# only its own socket. Python binds this scalar to the current stable runtime.
TCP_PRESENCE_NODE = r"""
import net from 'node:net';
let socket, timer, finished=false;
const done=(state,code)=>{
 if(finished)return;finished=true;clearTimeout(timer);
 if(socket)socket.destroy();
 console.log(JSON.stringify({state,code}));
};
timer=setTimeout(()=>done('unknown','probe_unproved'),1500);
try{
 socket=net.createConnection({host:'127.0.0.1',port:9229});
 socket.setTimeout(1000,()=>done('unknown','probe_unproved'));
 socket.once('connect',()=>done('listening','connection_established'));
 socket.once('error',error=>error.code==='ECONNREFUSED'
  ?done('closed','connection_refused'):done('unknown','probe_unproved'));
}catch{done('unknown','probe_unproved');}
"""


def pending_tcp_health(deadline):
    raw = inspector_command(['curl', '--noproxy', '*', '--silent', '--show-error', '--fail',
        '--max-time', '2', 'http://127.0.0.1:8080/health'], deadline, limit=262144)
    value = json.loads(raw, object_pairs_hook=unique_object)
    source = value.get('releaseSha') if isinstance(value, dict) else None
    if (not isinstance(value, dict) or value.get('running') is not True
            or value.get('status') != 'ok' or not isinstance(source, str)
            or not SHA.fullmatch(source) or value.get('version') != source[:8]
            or not isinstance(value.get('instanceId'), str)
            or not re.fullmatch('1-[0-9a-f]{8}', value['instanceId'])):
        raise ValueError('Pending TCP health unproved')
    return {'source': source, 'instance': value['instanceId']}


KERNEL_PROC_ROOT = Path('/proc')
KERNEL_INSPECTOR_PORT = 9229
KERNEL_OWNER_STAGES = {'not_observed', 'identity', 'members', 'process_stat', 'namespace',
    'listeners', 'descriptors', 'recheck_process', 'recheck_members', 'recheck_listeners',
    'snapshot', 'complete'}
KERNEL_OWNER_CODES = {'not_read', 'not_listening', 'tcp_unproved', 'unsupported',
    'unproved', 'unavailable', 'permission_denied', 'changed', 'ambiguous', 'bound',
    'deadline', 'command_failed', 'invalid_encoding', 'exclusive'}


class KernelOwnerFailure(ValueError):
    def __init__(self, stage, code):
        if stage not in KERNEL_OWNER_STAGES or code not in KERNEL_OWNER_CODES:
            raise ValueError('Kernel owner evidence refused')
        self.evidence = {'stage': stage, 'code': code}
        super().__init__('Kernel owner observation unproved')


def _kernel_error_code(error):
    # Project a closed vocabulary only. Native messages, paths and process
    # names never become exported diagnostic text.
    if isinstance(error, subprocess.TimeoutExpired):
        return 'deadline'
    if isinstance(error, PermissionError):
        return 'permission_denied'
    if isinstance(error, FileNotFoundError):
        return 'changed'
    if isinstance(error, UnicodeError):
        return 'invalid_encoding'
    if isinstance(error, ScopedRefusal):
        return {'command_deadline': 'deadline', 'command_size': 'bound',
                'command_nonzero': 'command_failed'}.get(error.code, 'unavailable')
    if isinstance(error, OSError):
        return 'unavailable'
    return {
        'Inspector native unavailable': 'command_failed',
        'Inspector read deadline': 'deadline',
        'Inspector read size': 'bound',
        'Kernel owner deadline': 'deadline',
        'Kernel owner file bound': 'bound',
        'Kernel owner socket bound': 'bound',
        'Kernel owner descriptor bound': 'bound',
        'Kernel owner listener ambiguous': 'ambiguous',
        'Kernel owner descriptor ambiguous': 'ambiguous',
        'Kernel owner namespace differs': 'changed',
        'Kernel owner process changed': 'changed',
        'Kernel owner snapshot changed': 'changed',
    }.get(str(error), 'unproved')


def _kernel_observe(stage, operation):
    try:
        return operation()
    except KernelOwnerFailure:
        raise
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise KernelOwnerFailure(stage, _kernel_error_code(error)) from None


def _kernel_deadline(deadline):
    if time.monotonic() >= deadline:
        raise ValueError('Kernel owner deadline')


def _kernel_read(path, limit, deadline):
    _kernel_deadline(deadline)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        chunks = bytearray()
        while True:
            _kernel_deadline(deadline)
            part = os.read(fd, min(4096, limit + 1 - len(chunks)))
            if not part:
                return bytes(chunks)
            chunks.extend(part)
            if len(chunks) > limit:
                raise ValueError('Kernel owner file bound')
    finally:
        os.close(fd)


def _kernel_members(identity, deadline):
    _kernel_deadline(deadline)
    raw = inspector_command(['docker', 'top', identity['container'], '-eo', 'pid'],
                            deadline, limit=4096).decode('ascii').splitlines()
    if (not raw or raw[0].strip() != 'PID' or not 1 <= len(raw) - 1 <= 256):
        raise ValueError('Kernel owner members unproved')
    members = tuple(line.strip() for line in raw[1:])
    if (any(not re.fullmatch(r'[1-9][0-9]{0,9}', pid) for pid in members)
            or len(set(members)) != len(members) or identity['hostPid'] not in members):
        raise ValueError('Kernel owner members unproved')
    return tuple(sorted(members, key=int))


def _kernel_pid_stat(pid, deadline):
    if not isinstance(pid, str) or not re.fullmatch(r'[1-9][0-9]{0,9}', pid):
        raise ValueError('Kernel owner process unproved')
    raw = _kernel_read(KERNEL_PROC_ROOT / pid / 'stat', 4096, deadline)
    prefix, separator, tail = raw.rpartition(b')')
    fields = tail.split()
    # Field22 is starttime; the private comm field can itself contain spaces
    # or parentheses, so never split the whole proc record on whitespace.
    if (not separator or not prefix.startswith(pid.encode('ascii') + b' (') or len(fields) < 20
            or not re.fullmatch(rb'[0-9]{1,20}', fields[19])):
        raise ValueError('Kernel owner process unproved')
    return fields[19].decode('ascii')


def _kernel_listeners(main_pid, deadline):
    selected = set()
    for family in ('tcp', 'tcp6'):
        raw = _kernel_read(KERNEL_PROC_ROOT / main_pid / 'net' / family,
                           131072, deadline).decode('ascii')
        lines = raw.splitlines()
        if not lines or 'inode' not in lines[0]:
            raise ValueError('Kernel owner sockets unproved')
        for line in lines[1:]:
            _kernel_deadline(deadline)
            fields = line.split()
            if len(fields) < 10:
                raise ValueError('Kernel owner sockets unproved')
            endpoint = fields[1].split(':')
            if (len(endpoint) != 2 or not re.fullmatch(r'[0-9A-Fa-f]{4}', endpoint[1])
                    or not re.fullmatch(r'[0-9A-Fa-f]{2}', fields[3])):
                raise ValueError('Kernel owner sockets unproved')
            if int(endpoint[1], 16) == KERNEL_INSPECTOR_PORT and fields[3].upper() == '0A':
                if not re.fullmatch(r'[1-9][0-9]{0,19}', fields[9]):
                    raise ValueError('Kernel owner sockets unproved')
                selected.add(fields[9])
                if len(selected) > 8:
                    raise ValueError('Kernel owner socket bound')
    if len(selected) != 1:
        raise ValueError('Kernel owner listener ambiguous')
    return next(iter(selected))


def _socket_owner_snapshot(identity, deadline, budget=None):
    budget = budget if budget is not None else {'fds': 0}
    stage = 'members'
    try:
        members = _kernel_members(identity, deadline)
        main = identity['hostPid']
        processes = []
        namespace = None
        for pid in members:
            stage = 'process_stat'
            _kernel_deadline(deadline)
            started = _kernel_pid_stat(pid, deadline)
            stage = 'namespace'
            network = os.readlink(KERNEL_PROC_ROOT / pid / 'ns' / 'net')
            if not re.fullmatch(r'net:\[[1-9][0-9]{0,19}\]', network):
                raise ValueError('Kernel owner namespace unproved')
            if namespace is None:
                namespace = network
            if network != namespace:
                raise ValueError('Kernel owner namespace differs')
            processes.append((pid, started))
        stage = 'listeners'
        inode = _kernel_listeners(main, deadline)
        owners = set()
        stage = 'descriptors'
        for pid in members:
            with os.scandir(KERNEL_PROC_ROOT / pid / 'fd') as entries:
                for entry in entries:
                    _kernel_deadline(deadline)
                    budget['fds'] += 1
                    if budget['fds'] > 16384 or not re.fullmatch(r'[0-9]{1,10}', entry.name):
                        raise ValueError('Kernel owner descriptor bound')
                    target = os.readlink(entry.path)
                    if len(target) > 4096:
                        raise ValueError('Kernel owner descriptor bound')
                    if target == 'socket:[' + inode + ']':
                        owners.add(pid)
        # Shared descriptors and unmapped listeners are not exclusive ownership.
        if len(owners) != 1:
            raise ValueError('Kernel owner descriptor ambiguous')
        stage = 'recheck_process'
        for pid, started in processes:
            if (_kernel_pid_stat(pid, deadline) != started
                    or os.readlink(KERNEL_PROC_ROOT / pid / 'ns' / 'net') != namespace):
                raise ValueError('Kernel owner process changed')
        stage = 'recheck_members'
        if _kernel_members(identity, deadline) != members:
            raise ValueError('Kernel owner snapshot changed')
        stage = 'recheck_listeners'
        if _kernel_listeners(main, deadline) != inode:
            raise ValueError('Kernel owner snapshot changed')
        return {'members': members, 'processes': tuple(processes), 'namespace': namespace,
                'inode': inode, 'owners': tuple(sorted(owners, key=int))}
    except KernelOwnerFailure:
        raise
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise KernelOwnerFailure(stage, _kernel_error_code(error)) from None


def pending_socket_owner_details(identity, deadline):
    # The reason is a closed stage/code pair, never native exception text.
    # Two equal complete snapshots and one shared FD/deadline budget remain
    # mandatory. Partial ownership never becomes a positive observation.
    if sys.platform != 'linux':
        return 'unknown', {'stage': 'identity', 'code': 'unsupported'}
    if (not isinstance(identity, dict) or not isinstance(identity.get('container'), str)
            or not re.fullmatch('[0-9a-f]{64}', identity['container'])
            or not isinstance(identity.get('hostPid'), str)
            or not re.fullmatch(r'[1-9][0-9]{0,9}', identity['hostPid'])):
        return 'unknown', {'stage': 'identity', 'code': 'unproved'}
    try:
        budget = {'fds': 0}
        before = _kernel_observe('snapshot', lambda: _socket_owner_snapshot(identity, deadline, budget))
        after = _kernel_observe('snapshot', lambda: _socket_owner_snapshot(identity, deadline, budget))
        _kernel_observe('snapshot', lambda: _kernel_deadline(deadline))
        if before != after:
            return 'unknown', {'stage': 'snapshot', 'code': 'changed'}
        owner = 'main' if before['owners'] == (identity['hostPid'],) else 'other_container_process'
        return owner, {'stage': 'complete', 'code': 'exclusive'}
    except KernelOwnerFailure as error:
        return 'unknown', error.evidence


def pending_socket_owner(identity, deadline):
    return pending_socket_owner_details(identity, deadline)[0]


def pending_tcp_presence(*, include_owner_evidence=False):
    # One shared supplemental deadline, not eight seconds per native command.
    # No identities or native exception text leave this helper.
    deadline = time.monotonic() + 8
    unknown = lambda code: {'state': 'unknown', 'binding': 'unproved', 'code': code}
    def result(tcp, owner='unknown', evidence=None):
        evidence = evidence if evidence is not None else {'stage': 'not_observed', 'code': 'tcp_unproved'}
        validate_kernel_owner_evidence(evidence, owner, allow_not_observed=True)
        return (tcp, owner, evidence) if include_owner_evidence else (tcp, owner)
    failure = 'container_unproved'
    try:
        before = inspector_identity(deadline)
        failure = 'health_unproved'
        health = pending_tcp_health(deadline)
        failure = 'image_unproved'
        label = inspector_command(['docker', 'image', 'inspect', '--format',
            '{{index .Config.Labels "org.opencontainers.image.revision"}}', before['image']],
            deadline, limit=256).decode().strip()
        if label != health['source']:
            return result(unknown('image_unproved'))
        failure = 'probe_unproved'
        # Match the original gate's three-second native child ceiling; the
        # eight-second envelope also includes identity/health binding reads.
        probe_deadline = min(deadline, time.monotonic() + 3)
        # Isolate only this reader child: inherited inspector flags or preloads
        # must not create the very listener whose prior presence we observe.
        raw = inspector_command(['docker', 'exec', '-i', '-e', 'NODE_OPTIONS=',
            before['container'], 'node', '--no-inspect', '--input-type=module', '-'],
            probe_deadline, input_bytes=TCP_PRESENCE_NODE.encode(), limit=1024)
        probe = json.loads(raw, object_pairs_hook=unique_object)
        if (not isinstance(probe, dict) or set(probe) != {'state', 'code'}
                or any(not isinstance(probe[key], str) for key in probe)
                or (probe.get('state'), probe.get('code')) not in {
                    ('closed', 'connection_refused'), ('listening', 'connection_established'),
                    ('unknown', 'probe_unproved')}):
            return result(unknown('probe_unproved'))
        owner = 'unknown'
        owner_evidence = {'stage': 'not_observed', 'code': 'not_listening' if probe['state'] == 'closed' else 'tcp_unproved'}
        if probe['state'] == 'listening':
            try:
                owner, owner_evidence = pending_socket_owner_details(before, deadline)
                if not isinstance(owner, str) or owner not in {'main', 'other_container_process', 'unknown'}:
                    raise ValueError('Kernel owner evidence refused')
                validate_kernel_owner_evidence(owner_evidence, owner)
            except (OSError, ValueError, subprocess.SubprocessError):
                # An optional kernel read failure alone cannot erase an
                # independently rebound TCP result; exhausted binding time can.
                owner = 'unknown'
                owner_evidence = {'stage': 'snapshot', 'code': 'unavailable'}
        failure = 'container_unproved'
        after = inspector_identity(deadline, stage='recheck_container')
        failure = 'health_unproved'
        after_health = pending_tcp_health(deadline)
        if before != after or health != after_health:
            return result(unknown('identity_changed'))
        answer = ({**probe, 'binding': 'matched'} if probe['state'] != 'unknown'
                  else unknown('probe_unproved'))
        validate_pending_tcp(answer)
        return result(answer, owner, owner_evidence)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        code = ('command_deadline' if isinstance(error, subprocess.TimeoutExpired)
                else error.code if isinstance(error, ScopedRefusal)
                else INSPECTOR_COMMAND_ERRORS.get(str(error)))
        return result(unknown(code if code in {'command_deadline', 'command_size', 'command_nonzero'}
                       else failure))


# This mode observes the original one-shot checkpoint only. It never opens or
# closes an inspector, signals PID 1, or enumerates application objects.
INSPECTOR_SCHEMA = 'existing-legacy-checkpoint-inspector-observation/v1'
EED = 'eed06fe51dea622069c661a6213d5b031ff3a9e3'
DIGEST = re.compile(r'^[0-9a-f]{64}$')
ENDPOINT = re.compile(r'^ws://127\.0\.0\.1:9229/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
# One native helper; fixed loopback HTTP first, no proxy environment, redirects,
# application imports, environment/cmdline reads or inspector lifecycle calls.
INSPECTOR_NODE = r"""
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
const phase=process.argv[2], expected=process.argv[3];
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const endpoint=/^ws:\/\/127\.0\.0\.1:9229\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const target=()=>new Promise((resolve,reject)=>{
 const req=http.get({hostname:'127.0.0.1',port:9229,path:'/json/list',agent:false,timeout:1000},res=>{
  if(res.statusCode!==200){res.resume();reject(Error('http'));return;}
  let n=0;const chunks=[];res.on('data',b=>{n+=b.length;if(n>16384){req.destroy();reject(Error('size'));}else chunks.push(b)});
  res.on('end',()=>{try{const rows=JSON.parse(Buffer.concat(chunks));if(!Array.isArray(rows)||rows.length!==1||!endpoint.test(rows[0]?.webSocketDebuggerUrl))throw Error('shape');resolve(rows[0].webSocketDebuggerUrl)}catch{reject(Error('shape'))}});
 });req.on('timeout',()=>req.destroy(Error('deadline')));req.on('error',e=>e.code==='ECONNREFUSED'?resolve(null):reject(Error('http')));
});
const connections=()=>{
 let count=0;
 for(const path of ['/proc/net/tcp','/proc/net/tcp6']){
  const raw=fs.readFileSync(path,'utf8');if(raw.length>1048576)throw Error('socket_bound');
  for(const line of raw.trim().split('\n').slice(1)){const x=line.trim().split(/\s+/);if(x.length<10)throw Error('socket_shape');if(x[1].split(':')[1]==='240D'&&x[3]==='01')count++;}
 }return count;
};
const evaluate="(() => { const v=process.getBuiltinModule('node:v8').getHeapStatistics(); return {pid:process.pid,usedHeapBytes:v.used_heap_size,availableHeapBytes:v.total_available_size,heapLimitBytes:v.heap_size_limit,availableProcessBytes:typeof process.availableMemory==='function'?process.availableMemory():null}; })()";
let socket;
try{
 const url=await target();
 if(url===null){console.log(JSON.stringify({state:'closed',endpointSha256:null}));}
 else if(phase==='probe'){console.log(JSON.stringify({state:'open',endpointSha256:hash(url)}));}
 else{
  if(phase!=='read'||!expected||hash(url)!==expected)throw Error('identity');
  if(connections()!==0){console.log(JSON.stringify({state:'foreign',endpointSha256:hash(url)}));}
  else{
   const value=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('deadline')),1500);
    const done=(fn,v)=>{clearTimeout(timer);fn(v)};
    socket=new WebSocket(url);
    socket.addEventListener('error',()=>done(reject,Error('socket')),{once:true});
    socket.addEventListener('open',()=>{try{if(connections()!==1)throw Error('foreign');socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:evaluate,returnByValue:true,timeout:500}}))}catch{done(reject,Error('foreign'))}},{once:true});
    socket.addEventListener('message',event=>{try{if(typeof event.data!=='string'||Buffer.byteLength(event.data)>4096)throw Error('frame');const row=JSON.parse(event.data);if(row.id!==1||row.error||row.result?.exceptionDetails)throw Error('response');const v=row.result?.result?.value;if(v?.pid!==1||Object.keys(v).length!==5)throw Error('pid');done(resolve,v)}catch{done(reject,Error('response'))}},{once:true});
   });
   if(await target()!==url||connections()!==1)throw Error('identity');
   console.log(JSON.stringify({state:'owned',endpointSha256:hash(url),native:value}));
  }
 }
}catch{console.log(JSON.stringify({state:'unproved',endpointSha256:null}));}
finally{
 // Disconnect THIS client only. Never call node:inspector.close or signal.
 if(socket){socket.close();const timer=setTimeout(()=>process.exit(0),250);socket.addEventListener('close',()=>clearTimeout(timer),{once:true});}
}
"""


def inspector_command(args, deadline, *, stderr=False, input_bytes=None, limit=65536, stage=None):
    if stage is not None and stage not in INSPECTOR_COMMAND_STAGES:
        raise ValueError('Unqualified inspector command stage')
    try:
        return _inspector_command(args, deadline, stderr=stderr, input_bytes=input_bytes, limit=limit)
    except ValueError as error:
        code = INSPECTOR_COMMAND_ERRORS.get(str(error))
        if stage is not None and code is not None:
            raise ScopedRefusal('inspector_' + stage, code) from None
        raise


def _inspector_command(args, deadline, *, stderr=False, input_bytes=None, limit=65536):
    """Fixed native child reads, one overall budget, bounded pipes and stderr."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ValueError('Inspector read deadline')
    child = subprocess.Popen(args, stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if input_bytes is not None:
        child.stdin.write(input_bytes)
        child.stdin.close()
    chunks = {False: bytearray(), True: bytearray()}
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, False)
            selector.register(child.stderr, selectors.EVENT_READ, True)
            while selector.get_map():
                left = deadline - time.monotonic()
                if left <= 0:
                    raise ValueError('Inspector read deadline')
                ready = selector.select(min(left, 3))
                if not ready:
                    continue
                for key, _ in ready:
                    part = os.read(key.fileobj.fileno(), 4096)
                    if not part:
                        selector.unregister(key.fileobj)
                    else:
                        chunks[key.data].extend(part)
                        if len(chunks[key.data]) > limit:
                            raise ValueError('Inspector read size')
        if child.wait(timeout=max(.001, deadline-time.monotonic())):
            raise ValueError('Inspector native unavailable')
        return bytes(chunks[stderr])
    finally:
        if child.poll() is None:
            child.kill()  # Only the owned reader, never the engine/container.
        child.wait(timeout=1)
        child.stdout.close()
        child.stderr.close()


def inspector_identity(deadline, *, stage='container'):
    fmt = '{{.Id}} {{.Image}} {{.State.Running}} {{.State.StartedAt}} {{.State.Pid}} {{.RestartCount}}'
    raw = inspector_command(['docker', 'inspect', '--format', fmt, 'club-arena-engine'], deadline, limit=2048, stage=stage).decode().strip().split()
    if (len(raw) != 6 or not re.fullmatch('[0-9a-f]{64}', raw[0])
            or not re.fullmatch('sha256:[0-9a-f]{64}', raw[1]) or raw[2] != 'true'
            or not re.fullmatch(r'\d{4}-\d\d-\d\dT[\d:.]+Z', raw[3])
            or not re.fullmatch('[1-9][0-9]{0,9}', raw[4]) or not raw[5].isdigit()):
        raise ValueError('Inspector container unknown')
    return dict(zip(['container', 'image', 'running', 'startedAt', 'hostPid', 'restarts'], raw))


def inspector_health(deadline, *, stage='health'):
    raw = inspector_command(['curl', '--noproxy', '*', '--silent', '--show-error', '--fail',
        '--max-time', '2', 'http://127.0.0.1:8080/health'], deadline, limit=262144, stage=stage)
    value = json.loads(raw, object_pairs_hook=unique_object)
    if (not isinstance(value, dict) or value.get('running') is not True
            or value.get('releaseSha') != EED or value.get('version') != EED[:8]
            or not isinstance(value.get('instanceId'), str)
            or not re.fullmatch('1-[0-9a-f]{8}', value['instanceId'])):
        raise ValueError('Inspector healthy predecessor unknown')
    return {'source': EED, 'instance': value['instanceId']}


def inspector_intent(request, directory):
    value = read_json(directory, request['runKey'] + '.legacy-checkpoint-intent', private=True)
    fields = {'instance', 'container', 'startedAt', 'hostPid', 'source', 'runId', 'controlSha', 'at', 'retryAllowed'}
    if (set(value) != fields or value['runId'] != request['runKey'] or value['source'] != EED
            or not isinstance(value['controlSha'], str) or not SHA.fullmatch(value['controlSha'])
            or not isinstance(value['instance'], str) or not re.fullmatch('1-[0-9a-f]{8}', value['instance'])
            or not isinstance(value['container'], str) or not re.fullmatch('[0-9a-f]{64}', value['container'])
            or not isinstance(value['startedAt'], str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT[\d:.]+Z', value['startedAt'])
            or type(value['hostPid']) is not int or not 1 <= value['hostPid'] <= 2147483647
            or type(value['at']) not in (int, float) or not 946684800 <= value['at'] < 4102444800
            or value['retryAllowed'] is not False):
        raise ValueError('Inspector intent unknown')
    return value


def inspector_binding(request, directory, root_fd, intent):
    # Terminal failure retires BOTH request records, not the independent
    # checkpoint intent. Partial retirement never selects the receipt route.
    rows = read_lines(directory, request['runKey'] + '.request', optional=True)
    original = read_lines(directory, request['runKey'] + '.intent', optional=True)
    if rows is not None or original is not None:
        if rows is None or original is None:
            raise ValueError('Inspector partial request records')
        control, _, _ = pending_metadata(request, rows, original, None, None)
        if control != intent['controlSha']:
            raise ValueError('Inspector control differs')
        return {'kind': 'retained_request', 'rows': rows, 'intent': original}
    result_fd = os.open('engine-release-results', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    try:
        result = read_json(result_fd, request['runKey'] + '.json', private=True)
    finally:
        os.close(result_fd)
    fields = {'schema', 'runId', 'result', 'sha', 'controlSha', 'invocationId',
              'transactionExitStatus', 'recoveredDesiredSha', 'recoveredDesiredImageId', 'completedAt'}
    if (set(result) != fields or type(result['schema']) is not int or result['schema'] != 1
            or result['runId'] != request['runKey'] or result['result'] != 'failed'
            or result['sha'] != request['releaseSha'] or result['controlSha'] != intent['controlSha']
            or result['recoveredDesiredSha'] != intent['source']
            or not isinstance(result['invocationId'], str) or not INVOCATION.fullmatch(result['invocationId'])
            or not isinstance(result['recoveredDesiredImageId'], str)
            or not re.fullmatch('sha256:[0-9a-f]{64}', result['recoveredDesiredImageId'])
            or type(result['transactionExitStatus']) is not int or not 1 <= result['transactionExitStatus'] <= 255
            or type(result['completedAt']) is not int or not intent['at'] <= result['completedAt'] < 4102444800):
        raise ValueError('Inspector retired failure receipt unknown')
    return {'kind': 'retired_failure', 'result': result}


def inspector_endpoint(raw, at):
    # Docker's native timestamp followed by the exact Node debugger literal.
    if len(raw) > 65536:
        raise ValueError('Inspector log bound')
    found = []
    for row in raw.decode('utf8').splitlines():
        match = re.fullmatch(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z) Debugger listening on (.+)', row)
        if not match:
            continue
        if not ENDPOINT.fullmatch(match[2]):
            raise ValueError('Inspector historical endpoint unknown')
        stamp = datetime.datetime.fromisoformat(match[1].replace('Z', '+00:00')).timestamp()
        if not at <= stamp <= at + 10:
            raise ValueError('Inspector historical time differs')
        found.append(hashlib.sha256(match[2].encode()).hexdigest())
    if len(found) != 1:
        raise ValueError('Inspector historical endpoint ambiguous')
    return found[0]


def inspector_probe(container, deadline, expected=None):
    # Keep inherited inspector flags/preloads out of this reader child too;
    # opening its own endpoint would corrupt the original target observation.
    raw = inspector_command(['docker', 'exec', '-i', '-e', 'NODE_OPTIONS=',
        container, 'node', '--no-inspect', '--input-type=module', '-',
        'read' if expected else 'probe', expected or ''], deadline,
        input_bytes=INSPECTOR_NODE.encode(), limit=16384, stage='probe')
    value = json.loads(raw, object_pairs_hook=unique_object)
    state = value.get('state') if isinstance(value, dict) else None
    if state not in {'closed', 'open', 'owned', 'foreign', 'unproved'}:
        raise ValueError('Inspector probe unknown')
    fields = {'state', 'endpointSha256'} | ({'native'} if state == 'owned' else set())
    if set(value) != fields or (value['endpointSha256'] is not None
            and (not isinstance(value['endpointSha256'], str) or not DIGEST.fullmatch(value['endpointSha256']))):
        raise ValueError('Inspector probe fields')
    if ((state in {'closed', 'unproved'}) != (value['endpointSha256'] is None)):
        raise ValueError('Inspector probe identity')
    return value


def inspector_memory(value):
    fields = {'pid', 'usedHeapBytes', 'availableHeapBytes', 'heapLimitBytes', 'availableProcessBytes'}
    if not isinstance(value, dict) or set(value) != fields or value['pid'] != 1 or type(value['pid']) is not int:
        raise ValueError('Inspector scalar identity')
    if any(type(value[k]) is not int or not 0 < value[k] <= 9007199254740991 for k in fields - {'pid'}):
        raise ValueError('Inspector scalar unavailable')
    reserve = 32 * 1024 * 1024
    heap = value['usedHeapBytes'] + reserve
    process = value['usedHeapBytes'] * 8 + reserve
    if process > 9007199254740991:
        raise ValueError('Inspector scalar overflow')
    return {**value, 'requiredHeapBytes': heap, 'requiredProcessBytes': process,
            'predicate': '4fef_32MiB_8x', 'predicateSatisfied': value['availableHeapBytes'] >= heap and value['availableProcessBytes'] >= process}


def inspector_remote(request, root_fd):
    deadline = time.monotonic() + 18
    answer = {'schema': INSPECTOR_SCHEMA, 'readOnly': True, **request,
              'status': 'unproved', 'reason': 'evidence_unavailable', 'controlSha': None,
              'originalSourceSha': None, 'instanceId': None, 'endpointSha256': None,
              'nativeMemory': None, 'readiness': 'unknown_not_certified_by_metadata'}
    directory = os.open('engine-release-requests', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    try:
        try:
            intent = inspector_intent(request, directory)
            binding = inspector_binding(request, directory, root_fd, intent)
        except (OSError, ValueError):
            raise ScopedRefusal('inspector', 'intent_unavailable') from None
        before = inspector_identity(deadline)
        health = inspector_health(deadline)
        if (intent['container'] != before['container'] or intent['startedAt'] != before['startedAt']
                or str(intent['hostPid']) != before['hostPid'] or intent['instance'] != health['instance']):
            return answer
        if (binding['kind'] == 'retired_failure'
                and binding['result']['recoveredDesiredImageId'] != before['image']):
            raise ScopedRefusal('inspector', 'identity_changed')
        label = inspector_command(['docker', 'image', 'inspect', '--format',
            '{{index .Config.Labels "org.opencontainers.image.revision"}}', before['image']], deadline, limit=256, stage='image').decode().strip()
        if label != intent['source']:
            return answer
        answer.update(controlSha=intent['controlSha'], originalSourceSha=EED, instanceId=intent['instance'])
        probe = inspector_probe(before['container'], deadline)
        if probe['state'] == 'closed':
            answer.update(status='closed', reason='fixed_loopback_connection_refused')
        elif probe['state'] == 'open':
            # Docker logs emits the container stderr stream on stderr. Never
            # export raw logs, URL, socket rows, host PID, container ID or paths.
            raw = inspector_command(['docker', 'logs', '--timestamps', '--since', str(intent['at']),
                '--until', str(intent['at'] + 10), before['container']], deadline, stderr=True, stage='history')
            try:
                historical = inspector_endpoint(raw, intent['at'])
            except ValueError:
                answer['reason'] = 'historical_endpoint_unavailable'
            else:
                if historical != probe['endpointSha256']:
                    answer.update(status='foreign', reason='historical_endpoint_differs')
                else:
                    native = inspector_probe(before['container'], deadline, historical)
                    if native['state'] == 'owned' and native['endpointSha256'] == historical:
                        try:
                            memory = inspector_memory(native['native'])
                        except ValueError:
                            raise ScopedRefusal('inspector', 'native_scalar_unavailable') from None
                        answer.update(status='owned', reason='original_endpoint_native_scalar_read',
                                      endpointSha256=historical, nativeMemory=memory)
                    elif native['state'] == 'foreign':
                        answer.update(status='foreign', reason='established_inspector_client')
                    else:
                        answer['reason'] = 'native_read_unproved'
        if (before != inspector_identity(deadline, stage='recheck_container') or health != inspector_health(deadline, stage='recheck_health')
                or intent != inspector_intent(request, directory)
                or binding != inspector_binding(request, directory, root_fd, intent)):
            raise ScopedRefusal('inspector', 'identity_changed')
        return answer
    finally:
        os.close(directory)


def validate_inspector(value, request):
    fields = {'schema', 'readOnly', 'runKey', 'releaseSha', 'mode', 'status', 'reason', 'controlSha',
              'originalSourceSha', 'instanceId', 'endpointSha256', 'nativeMemory', 'readiness'}
    reasons = {'evidence_unavailable', 'fixed_loopback_connection_refused', 'historical_endpoint_unavailable',
               'historical_endpoint_differs', 'original_endpoint_native_scalar_read',
               'established_inspector_client', 'native_read_unproved'}
    if (not isinstance(value, dict) or set(value) != fields or value['schema'] != INSPECTOR_SCHEMA
            or value['readOnly'] is not True or any(value[k] != request[k] for k in request)
            or value['status'] not in {'closed', 'owned', 'foreign', 'unproved'} or value['reason'] not in reasons
            or value['readiness'] != 'unknown_not_certified_by_metadata'):
        raise ValueError('Inspector export refused')
    for key in ['controlSha', 'originalSourceSha']:
        if value[key] is not None and (not isinstance(value[key], str) or not SHA.fullmatch(value[key])):
            raise ValueError('Inspector exported source')
    if value['instanceId'] is not None and (not isinstance(value['instanceId'], str) or not re.fullmatch('1-[0-9a-f]{8}', value['instanceId'])):
        raise ValueError('Inspector exported instance')
    if value['endpointSha256'] is not None and (not isinstance(value['endpointSha256'], str) or not DIGEST.fullmatch(value['endpointSha256'])):
        raise ValueError('Inspector exported endpoint')
    if value['status'] == 'owned':
        native = value['nativeMemory']
        raw = {k: native[k] for k in ['pid', 'usedHeapBytes', 'availableHeapBytes', 'heapLimitBytes', 'availableProcessBytes']} if isinstance(native, dict) else None
        if (value['reason'] != 'original_endpoint_native_scalar_read' or native != inspector_memory(raw)
                or value['originalSourceSha'] != EED or not value['controlSha'] or not value['instanceId'] or not value['endpointSha256']):
            raise ValueError('Inspector owned export refused')
    elif value['nativeMemory'] is not None or value['endpointSha256'] is not None:
        raise ValueError('Inspector unknown scalar export')
    pairs = {
        'closed': {'fixed_loopback_connection_refused'},
        'owned': {'original_endpoint_native_scalar_read'},
        'foreign': {'historical_endpoint_differs', 'established_inspector_client'},
        'unproved': {'evidence_unavailable', 'historical_endpoint_unavailable', 'native_read_unproved'},
    }
    if value['reason'] not in pairs[value['status']]:
        raise ValueError('Inspector outcome export')
    if value['status'] != 'unproved' and (value['originalSourceSha'] != EED
            or not value['controlSha'] or not value['instanceId']):
        raise ValueError('Inspector absence identity export')
    return value


SERVING_ROLE_SCHEMA = 'current-serving-inspector-role/v2'
SERVING_ROLE_LIMITATION = 'Kernel role only; no inspector ownership, provenance or action authority.'


def _serving_boot_id(deadline):
    value = _kernel_read(Path('/proc/sys/kernel/random/boot_id'), 64, deadline).decode('ascii').strip()
    if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', value):
        raise ValueError('Serving boot identity unavailable')
    return value


def serving_role_remote(request):
    request = selection(request)
    if request.get('mode') != 'current_serving_inspector_role':
        raise ValueError('Exact current serving identity required')
    deadline = time.monotonic() + 8
    try:
        boot = _serving_boot_id(deadline)
        before = inspector_identity(deadline)
        started = _kernel_pid_stat(before['hostPid'], deadline)
        health = pending_tcp_health(deadline)
        if health != {'source': request['releaseSha'], 'instance': request['instanceId']}:
            raise ScopedRefusal('serving_role', 'binding_unproved')
        label = inspector_command(['docker', 'image', 'inspect', '--format',
            '{{index .Config.Labels "org.opencontainers.image.revision"}}', before['image']],
            deadline, limit=256).decode().strip()
        if label != request['releaseSha']:
            raise ScopedRefusal('serving_role', 'binding_unproved')
        owner = 'unknown'
        owner_evidence = {'stage': 'snapshot', 'code': 'unavailable'}
        try:
            projected, evidence = pending_socket_owner_details(before, deadline)
            if not isinstance(projected, str) or projected not in {'main', 'other_container_process', 'unknown'}:
                raise ValueError('Kernel owner evidence refused')
            validate_kernel_owner_evidence(evidence, projected)
            owner, owner_evidence = projected, evidence
        except (OSError, ValueError, TypeError, subprocess.SubprocessError):
            pass
        # A failed optional projection never removes these mandatory current
        # runtime bindings. No retired release records are read or recreated.
        after_boot = _serving_boot_id(deadline)
        after_started = _kernel_pid_stat(before['hostPid'], deadline)
        after = inspector_identity(deadline, stage='recheck_container')
        after_health = pending_tcp_health(deadline)
        _kernel_deadline(deadline)
        if (boot != after_boot or started != after_started or before != after
                or health != after_health):
            raise ScopedRefusal('serving_role', 'binding_unproved')
        return {'schema': SERVING_ROLE_SCHEMA, 'readOnly': True, **request,
                'inspectorOwner': owner, 'inspectorOwnerEvidence': owner_evidence,
                'limitation': SERVING_ROLE_LIMITATION}
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        if isinstance(error, ScopedRefusal) and error.phase == 'serving_role':
            raise
        raise ScopedRefusal('serving_role', 'evidence_unavailable') from None


def validate_serving_role(value, request):
    request = selection(request)
    if (not isinstance(value, dict)
            or set(value) != {'schema', 'readOnly', 'mode', 'releaseSha', 'instanceId', 'inspectorOwner', 'inspectorOwnerEvidence', 'limitation'}
            or value['schema'] != SERVING_ROLE_SCHEMA or value['readOnly'] is not True
            or request.get('mode') != 'current_serving_inspector_role'
            or any(value[key] != expected for key, expected in request.items())
            or not isinstance(value['inspectorOwner'], str)
            or value['inspectorOwner'] not in {'main', 'other_container_process', 'unknown'}
            or value['limitation'] != SERVING_ROLE_LIMITATION):
        raise ValueError('Serving role export refused')
    validate_kernel_owner_evidence(value['inspectorOwnerEvidence'], value['inspectorOwner'])
    return value


RETIREMENT_SCHEMA = 'existing-main-inspector-retirement-records/v1'
RETIREMENT_LIMITATION = 'Historical files only; no current process, listener, cleanup, retry or action authority.'
RETIREMENT_IMAGE = 'sha256:2eb1c5a7279032240c5fff8a6b3ecf5dc6af735cc1227a51430d50dcae1b065b'
RETIREMENT_PREDICATES = ('ok', 'closeRequested', 'closeAcknowledged', 'connectionClosed', 'listenerAbsent')


def retirement_records(request, root_fd):
    # Only five exact files under fixed directories. No process, network,
    # Inspector, journal, seal command, directory census or remote writes.
    deadline = time.monotonic() + 3
    def check():
        if time.monotonic() >= deadline:
            raise ValueError('retirement file deadline')
    def read(directory, name, limit):
        check()
        try:
            parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        except OSError:
            return ('unknown', None)
        try:
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            except FileNotFoundError:
                return ('absent_at_read', None)
            except OSError:
                return ('unknown', None)
            try:
                before = os.fstat(fd)
                if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0
                        or stat.S_IMODE(before.st_mode) != 0o600 or before.st_size > limit):
                    return ('unknown', None)
                raw = bytearray()
                while len(raw) <= limit:
                    check()
                    chunk = os.read(fd, min(4096, limit + 1 - len(raw)))
                    if not chunk:
                        break
                    raw.extend(chunk)
                after = os.fstat(fd)
                identity = lambda x: (x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns, x.st_ctime_ns, x.st_uid, x.st_mode)
                if identity(before) != identity(after) or len(raw) != before.st_size or len(raw) > limit:
                    return ('unknown', None)
                check()
                return ('present_at_read', bytes(raw))
            finally:
                os.close(fd)
        finally:
            os.close(parent)
    files = [('engine-release-requests', request['runKey'] + suffix, limit) for suffix, limit in (
        ('.request', 4096), ('.intent', 4096),
        ('.main-inspector-retirement-intent', 32768),
        ('.main-inspector-retirement-receipt', 65536))]
    files.append(('engine-release-results', request['runKey'] + '.json', 65536))
    def snapshot():
        return [read(*item) for item in files]
    def parse(record):
        if record[0] != 'present_at_read':
            raise ValueError('retirement record unavailable')
        value = json.loads(record[1], object_pairs_hook=unique_object)
        if not isinstance(value, dict):
            raise ValueError('retirement record shape')
        return value
    answer = {'schema': RETIREMENT_SCHEMA, 'readOnly': True, **request,
              'intentPresence': 'unknown', 'receiptPresence': 'unknown',
              'status': 'unknown', 'bindingKind': None, 'controlSha': None,
              'claimIdentity': None, 'receiptMatchesClaim': False,
              'outcomePredicates': None, 'positiveReceipt': False,
              'retryAllowed': False, 'limitation': RETIREMENT_LIMITATION}
    before = snapshot()
    answer.update(intentPresence=before[2][0], receiptPresence=before[3][0])
    try:
        if before[0][0] == before[1][0] == 'present_at_read':
            rows, original = [value[1].decode('utf8').splitlines() for value in before[:2]]
            control, request_deadline, _ = pending_metadata(request, rows, original, None, None)
            binding = {'kind': 'retained_request', 'control': control, 'invocation': None, 'deadline':request_deadline, 'completedAt':None}
        elif before[0][0] == before[1][0] == 'absent_at_read':
            result = parse(before[4])
            fields = {'schema', 'runId', 'result', 'sha', 'controlSha', 'invocationId',
                      'transactionExitStatus', 'recoveredDesiredSha', 'recoveredDesiredImageId', 'completedAt'}
            if (set(result) != fields or type(result['schema']) is not int or result['schema'] != 1
                    or result['runId'] != request['runKey'] or result['sha'] != request['releaseSha']
                    or result['result'] != 'failed' or not SHA.fullmatch(result['controlSha'])
                    or not INVOCATION.fullmatch(result['invocationId'])
                    or result['recoveredDesiredSha'] != EED or result['recoveredDesiredImageId'] != RETIREMENT_IMAGE
                    or type(result['transactionExitStatus']) is not int or not 1 <= result['transactionExitStatus'] <= 255
                    or type(result['completedAt']) is not int or not 946684800 <= result['completedAt'] < 4102444800):
                raise ValueError('retirement terminal binding')
            binding = {'kind': 'terminal_failure', 'control': result['controlSha'], 'invocation': result['invocationId'], 'deadline':None, 'completedAt':result['completedAt']}
        else:
            raise ValueError('retirement partial request')
        answer.update(bindingKind=binding['kind'], controlSha=binding['control'])
        if before[2][0] == before[3][0] == 'absent_at_read':
            answer['status'] = 'both_absent_at_read'
        else:
            claim = parse(before[2])
            expected = {'schema','runId','invocationId','controlSha','requestDeadline','target','requestSha256',
                        'nativeUnit','source','instance','containerIdentity','proposal','proposalSha256','deadlineMs','retryAllowed'}
            proposal = claim.get('proposal')
            if (set(claim) != expected or claim['schema'] != 'main-inspector-retirement-claim/v1'
                    or claim['runId'] != request['runKey'] or claim['target'] != request['releaseSha']
                    or claim['controlSha'] != binding['control'] or claim['source'] != EED
                    or claim['retryAllowed'] is not False or not INVOCATION.fullmatch(claim['invocationId'])
                    or (binding['invocation'] is not None and claim['invocationId'] != binding['invocation'])
                    or not re.fullmatch(r'1-[0-9a-f]{8}', claim['instance'])
                    or not re.fullmatch(r'[0-9a-f]{64}', claim['requestSha256'])
                    or type(claim['requestDeadline']) is not int or not 946684800 <= claim['requestDeadline'] < 4102444800
                    or (binding['deadline'] is not None and claim['requestDeadline'] != binding['deadline'])
                    or type(claim['deadlineMs']) is not int or not 946684800000 <= claim['deadlineMs'] <= claim['requestDeadline'] * 1000
                    or claim['nativeUnit'] not in [{'InvocationID':claim['invocationId'],'ActiveState':a,'SubState':b}
                        for a in ('active','activating') for b in ('running','start')]
                    or not isinstance(proposal, dict) or set(proposal) != {'schema','endpoint','binding'}
                    or proposal['schema'] != 'main-inspector-retirement/v1'
                    or not re.fullmatch(r'ws://127\.0\.0\.1:9229/[0-9a-f-]{36}', proposal['endpoint'], re.I)
                    or not isinstance(proposal['binding'], dict)
                    or claim['proposalSha256'] != hashlib.sha256(json.dumps(proposal, separators=(',', ':')).encode()).hexdigest()):
                raise ValueError('retirement claim binding')
            native = proposal['binding']
            if (set(native) != {'schema','pid','startTicks','namespace','listener'}
                    or native['schema'] != 'main-inspector-socket-binding/v1' or type(native['pid']) is not int or native['pid'] != 1
                    or not re.fullmatch('[0-9]{1,20}',native['startTicks'])
                    or not re.fullmatch(r'net:\[[1-9][0-9]*\]',native['namespace'])
                    or not isinstance(native['listener'],dict) or set(native['listener']) != {'family','local','inode'}
                    or native['listener']['family'] not in {'tcp','tcp6'}
                    or native['listener']['local'] != {'tcp':'0100007F:240D','tcp6':'00000000000000000000000001000000:240D'}.get(native['listener']['family'])
                    or not re.fullmatch('[1-9][0-9]*',native['listener']['inode'])):
                raise ValueError('retirement proposal binding')
            container = claim['containerIdentity'].split()
            if (len(container) != 5 or not re.fullmatch('[0-9a-f]{64}', container[0])
                    or container[1:3] != [RETIREMENT_IMAGE,'true']
                    or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z', container[3])
                    or not re.fullmatch(r'[1-9][0-9]*', container[4])):
                raise ValueError('retirement container binding')
            if binding['kind'] == 'retained_request' and claim['requestSha256'] != hashlib.sha256(before[0][1]).hexdigest():
                raise ValueError('retirement request hash')
            answer['claimIdentity'] = {'invocationId': claim['invocationId'], 'sourceSha': EED,
                'instanceId': claim['instance'], 'proposalSha256': claim['proposalSha256'],
                'containerIdentitySha256': hashlib.sha256(claim['containerIdentity'].encode()).hexdigest()}
            completed = parse(before[3])
            if set(completed) != {'claim','outcome','observedAt'} or completed['claim'] != claim:
                raise ValueError('retirement receipt binding')
            if (type(completed['observedAt']) not in {int,float}
                    or not 946684800 <= completed['observedAt'] <= claim['requestDeadline']
                    or (binding['completedAt'] is not None and not completed['observedAt'] < binding['completedAt'] + 1)):
                raise ValueError('retirement receipt timestamp')
            answer['receiptMatchesClaim'] = True
            outcome = completed['outcome']
            if not isinstance(outcome, dict) or outcome.get('retryAllowed') is not False:
                raise ValueError('retirement outcome binding')
            answer['outcomePredicates'] = {key: outcome.get(key) is True for key in RETIREMENT_PREDICATES}
            answer['positiveReceipt'] = all(answer['outcomePredicates'].values())
            if answer['positiveReceipt']:
                answer['status'] = 'bound_positive_historical_receipt'
    except (OSError, ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        pass
    if answer['bindingKind'] is None:
        answer.update(intentPresence='unknown', receiptPresence='unknown')
    if before != snapshot():
        answer.update(status='unknown', bindingKind=None, controlSha=None, claimIdentity=None,
                      receiptMatchesClaim=False, outcomePredicates=None, positiveReceipt=False,
                      intentPresence='unknown', receiptPresence='unknown')
    return validate_retirement_records(answer, request)


def validate_retirement_records(value, request):
    fields = {'schema','readOnly','runKey','releaseSha','mode','intentPresence','receiptPresence',
              'status','bindingKind','controlSha','claimIdentity','receiptMatchesClaim',
              'outcomePredicates','positiveReceipt','retryAllowed','limitation'}
    if (not isinstance(value, dict) or set(value) != fields or value['schema'] != RETIREMENT_SCHEMA
            or value['readOnly'] is not True or any(value[k] != request[k] for k in request)
            or value['mode'] != 'main_inspector_retirement' or value['retryAllowed'] is not False
            or value['limitation'] != RETIREMENT_LIMITATION
            or any(value[k] not in {'unknown','present_at_read','absent_at_read'} for k in ('intentPresence','receiptPresence'))
            or value['status'] not in {'unknown','both_absent_at_read','bound_positive_historical_receipt'}
            or value['bindingKind'] not in {None,'retained_request','terminal_failure'}
            or (value['controlSha'] is not None and not SHA.fullmatch(value['controlSha']))
            or type(value['receiptMatchesClaim']) is not bool or type(value['positiveReceipt']) is not bool):
        raise ValueError('Retirement export refused')
    claim = value['claimIdentity']
    if claim is not None and (not isinstance(claim,dict) or set(claim) != {'invocationId','sourceSha','instanceId','proposalSha256','containerIdentitySha256'}
            or not INVOCATION.fullmatch(claim['invocationId']) or claim['sourceSha'] != EED
            or not re.fullmatch(r'1-[0-9a-f]{8}',claim['instanceId'])
            or any(not re.fullmatch('[0-9a-f]{64}',claim[k]) for k in ('proposalSha256','containerIdentitySha256'))):
        raise ValueError('Retirement claim export refused')
    predicates = value['outcomePredicates']
    if predicates is not None and (not isinstance(predicates,dict) or set(predicates) != set(RETIREMENT_PREDICATES)
            or any(type(item) is not bool for item in predicates.values())):
        raise ValueError('Retirement predicate export refused')
    positive = (value['bindingKind'] is not None and value['controlSha'] is not None and claim is not None
                and value['intentPresence'] == value['receiptPresence'] == 'present_at_read'
                and value['receiptMatchesClaim'] is True and predicates is not None and all(predicates.values()))
    absent = (value['bindingKind'] is not None and value['controlSha'] is not None
              and value['intentPresence'] == value['receiptPresence'] == 'absent_at_read')
    if (value['bindingKind'] is None and any(value[k] is not None for k in ('controlSha','claimIdentity','outcomePredicates'))
            or (absent and (claim is not None or value['receiptMatchesClaim'] or predicates is not None))
            or value['positiveReceipt'] != positive
            or (value['status'] == 'bound_positive_historical_receipt') != positive
            or (value['status'] == 'both_absent_at_read') != absent):
        raise ValueError('Retirement outcome export refused')
    return value


def remote(request):
    request = selection(request)
    if request.get('mode') == 'current_serving_inspector_role':
        return validate_serving_role(serving_role_remote(request), request)
    # All production paths are fixed. No environment/caller path override.
    root_fd = os.open(STATE_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if request.get('mode') == 'main_inspector_retirement':
            return retirement_records(request, root_fd)
        if request.get('mode') == 'legacy_checkpoint_inspector':
            return validate_inspector(inspector_remote(request, root_fd), request)
        if request.get('mode') == 'pending_transaction':
            return pending_remote(request, root_fd)
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
    if request.get('mode') == 'main_inspector_retirement':
        return validate_retirement_records(value, request)
    if request.get('mode') == 'current_serving_inspector_role':
        return validate_serving_role(value, request)
    if request.get('mode') == 'legacy_checkpoint_inspector':
        return validate_inspector(value, request)
    if request.get('mode') == 'pending_transaction':
        fields = {'schema', 'readOnly', 'runKey', 'releaseSha', 'mode', 'controlSha', 'requestDeadlineEpoch', 'breakDeadlineEpoch', 'stage', 'unit', 'journalSigns', 'journalStatus', 'journalFailure', 'legacyIntent', 'inspectorTcp', 'inspectorOwner', 'inspectorOwnerEvidence', 'absenceMeans'}
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
        validate_pending_intent(value['legacyIntent'])
        validate_pending_tcp(value['inspectorTcp'])
        validate_pending_owner(value['inspectorOwner'], value['inspectorTcp'])
        validate_kernel_owner_evidence(value['inspectorOwnerEvidence'], value['inspectorOwner'], allow_not_observed=True)
        validate_pending_journal(value['journalSigns'], value['journalFailure'])
        if value['journalStatus'] != ('observed' if value['journalFailure'] is None else 'unavailable'):
            raise ValueError('Pending journal status refused')
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
