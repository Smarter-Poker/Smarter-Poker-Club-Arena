#!/usr/bin/env python3
"""Original invocation stdout collector; no engine access or release authority."""
import hashlib
import json
import math
import os
import re
import sys
import stat

PREFIX = b'LEGACY_CHECKPOINT_GUARD_OBSERVATION='
FIELDS = {'schema', 'runId', 'controlSha', 'sourceSha', 'instanceId',
          'intentSha256', 'cleanupStatus', 'retryAllowed', 'checkpoint'}
COUNTS = {'attemptedTables', 'completedCalls', 'verifiedTables', 'bankCount',
          'uninitializedSeats', 'sealedManagers'}
ENUMS = {
    'schema': {'legacy-engine-checkpoint/v1'},
    'stage': {'preflight', 'mixed_custody', 'checkpoint', 'readback', 'complete'},
    'checkpointOutcome': {'not_started', 'unconfirmed', 'verified_at_observation'},
    'paidAccountingQualification': {'legacy_untracked', 'native_pending_registry_drained',
                                    'native_pending_registry_unqualified'},
}

def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate field')
        result[key] = value
    return result

def validate(value, intent_text):
    intent = json.loads(intent_text, object_pairs_hook=unique)
    if (not isinstance(value, dict) or set(value) != FIELDS
            or value['schema'] != 'legacy-checkpoint-guard-observation/v1'
            or value['cleanupStatus'] != 'not_yet_verified' or value['retryAllowed'] is not False
            or value['runId'] != intent['runId'] or not re.fullmatch(r'[1-9][0-9]*(-[1-9][0-9]*)?', value['runId'])
            or value['controlSha'] != intent['controlSha'] or not re.fullmatch('[0-9a-f]{40}', value['controlSha'])
            or value['sourceSha'] != intent['source'] or not re.fullmatch('[0-9a-f]{40}', value['sourceSha'])
            or value['instanceId'] != intent['instance'] or not re.fullmatch('1-[0-9a-f]{8}', value['instanceId'])
            or value['intentSha256'] != hashlib.sha256(intent_text.encode()).hexdigest()):
        raise ValueError('observation binding refused')
    checkpoint = value['checkpoint']
    if not isinstance(checkpoint, dict) or type(checkpoint.get('ok')) is not bool:
        raise ValueError('checkpoint observation refused')
    for key, item in checkpoint.items():
        valid = False
        if key in COUNTS:
            valid = type(item) is int and 0 <= item <= 9007199254740991
        elif key in ENUMS:
            valid = type(item) is str and item in ENUMS[key]
        elif key in {'ok', 'readyForRestart'}:
            valid = type(item) is bool
        elif key == 'restartAuthorized':
            valid = item is False
        elif key == 'reason':
            valid = type(item) is str and len(item) <= 128 and re.fullmatch(r'[a-z][a-z0-9]*(?:_[a-z0-9]+)+', item)
        elif key == 'remainingMs':
            valid = type(item) in {int, float} and math.isfinite(item) and item >= 0
        if not valid:
            raise ValueError('checkpoint field refused')
    return value

def collect(intent_text, path, source, output, observations):
    # Compare the exact original fsynced intent, not just caller-provided text.
    suffix = '.legacy-checkpoint-intent'
    if not path.endswith(suffix):
        raise ValueError('observation path refused')
    intent = json.loads(intent_text, object_pairs_hook=unique)
    if os.path.basename(path) != intent['runId'] + suffix:
        raise ValueError('original run path refused')
    intent_path = path
    # A proven non-acting deferral may retire this intent and re-enter under
    # the same run key. Preserve each distinct original receipt, never replace.
    path = path[:-len(suffix)] + '.legacy-checkpoint-observation-' + hashlib.sha256(intent_text.encode()).hexdigest()
    fd = os.open(intent_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as handle:
        metadata = os.fstat(handle.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_size > 8192
                or handle.read(8193) != intent_text.encode() + b'\n'):
            raise ValueError('original intent refused')
    retained = False
    total = 0
    for line in iter(lambda: source.readline(8193), b''):
        total += len(line)
        if len(line) > 8192 or total > 65536 or not line.endswith(b'\n'):
            raise ValueError('observation stream bound')
        if not line.startswith(PREFIX):
            output.write(line)
            output.flush()
            continue
        if retained:
            raise ValueError('duplicate observation')
        value = validate(json.loads(line[len(PREFIX):], object_pairs_hook=unique), intent_text)
        data = json.dumps(value, separators=(',', ':'), allow_nan=False).encode() + b'\n'
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'wb') as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            directory = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except BaseException:
            # Partial/unknown files are retained; never overwrite or turn into authority.
            raise
        retained = True
        observations.write(PREFIX + data)
        observations.flush()
    return retained

if __name__ == '__main__':
    try:
        collect(sys.argv[1], sys.argv[2], sys.stdin.buffer, sys.stdout.buffer, sys.stderr.buffer)
    except Exception:
        print('[legacy-engine-checkpoint] guard observation retention refused; outcome remains nonretryable', file=sys.stderr)
        sys.exit(1)
