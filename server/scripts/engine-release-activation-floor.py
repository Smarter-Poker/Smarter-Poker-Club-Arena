#!/usr/bin/env python3
"""Read one immutable target's activation floor; never mutate the engine."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

MANIFEST = 'server/release/activation-floor.json'
HELPER = 'server/scripts/engine-release-activation-floor.py'
CAPABILITY = 'engine-release-activation-floor/v1'


def git(repo, *args):
    return subprocess.run(['git', '-C', repo, *args], check=True, capture_output=True,
                          env={**os.environ, 'GIT_NO_REPLACE_OBJECTS': '1'}, timeout=10).stdout


def policy(repo, target, control):
    if not all(re.fullmatch(r'[0-9a-f]{40}', value) for value in (target, control)):
        raise ValueError('immutable target/control identity unavailable')
    for value in (target, control):
        git(repo, 'cat-file', '-e', value + '^{commit}')
        git(repo, 'merge-base', '--is-ancestor', value, 'refs/remotes/origin/main')
    listing = git(repo, 'ls-tree', target, '--', MANIFEST).decode().strip()
    if not listing:
        return None
    if not re.fullmatch(r'100644 blob [0-9a-f]{40}\t' + re.escape(MANIFEST), listing):
        raise ValueError('activation floor is not a regular immutable source blob')
    raw = git(repo, 'show', target + ':' + MANIFEST)
    def unique(pairs):
        out = {}
        for key, value in pairs:
            if key in out:
                raise ValueError('duplicate activation-floor key')
            out[key] = value
        return out
    doc = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(doc, dict) or set(doc) != {'schema', 'preparationAt', 'activationAt', 'expiresAt', 'timeZone'}:
        raise ValueError('activation floor schema is unavailable')
    if doc['schema'] != CAPABILITY or doc['timeZone'] != 'America/Chicago':
        raise ValueError('activation floor capability/timezone refused')
    times = []
    for key in ('preparationAt', 'activationAt', 'expiresAt'):
        value = doc[key]
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', value):
            raise ValueError('activation floor timestamp refused')
        times.append(datetime.fromisoformat(value.replace('Z', '+00:00')))
    preparation, activation, expiry = times
    local = activation.astimezone(ZoneInfo(doc['timeZone']))
    if (local.hour, local.minute, local.second) != (4, 0, 0):
        raise ValueError('activation floor must name the daily Chicago boundary')
    if (activation - preparation).total_seconds() != 1800 or (expiry - activation).total_seconds() != 300:
        raise ValueError('activation floor notice/window bounds refused')
    # An old control cannot silently ignore a newer target's scheduling contract.
    # Exact maintained helper bytes bind the parsed semantics to this control.
    own = Path(__file__).read_bytes()
    if git(repo, 'show', control + ':' + HELPER) != own:
        raise ValueError('control activation-floor capability is not exact')
    if git(repo, 'show', control + ':' + MANIFEST) != raw:
        raise ValueError('control and target activation policies differ')
    intake = git(repo, 'show', control + ':server/scripts/engine-release-intake.sh').decode()
    guard = 'engine-release-activation-floor.py" admit'
    if intake.count(guard) != 1 or intake.index(guard) > intake.index('INSTALL_OUTPUT='):
        raise ValueError('control has no pre-install activation admission')
    transaction = git(repo, 'show', control + ':server/scripts/engine-release-transaction.sh').decode()
    recovery = git(repo, 'show', control + ':server/scripts/engine-release-recover.sh').decode()
    if 'record_floor_runtime_entry\n    LEGACY_CHECKPOINT_ATTEMPTED=1' not in transaction or 'record_floor_runtime_entry\n  set +e\n  PREPARE_OUTPUT=' not in transaction:
        raise ValueError('control runtime entry is not gated')
    if recovery.index('engine-release-activation-floor.py" disposition') > recovery.index('exec 9>"$ENGINE_LOCK"'):
        raise ValueError('control recovery does not classify entry before runtime writes')
    return {'schema': CAPABILITY, 'targetSha': target, 'controlSha': control,
            'manifestSha256': hashlib.sha256(raw).hexdigest(),
            'preparationEpoch': int(preparation.timestamp()),
            'activationEpoch': int(activation.timestamp()), 'expiresEpoch': int(expiry.timestamp())}


def check_window(record, now, deadline, mode):
    if type(now) is not int or type(deadline) is not int or now <= 0 or deadline <= now:
        raise ValueError('activation floor clock/deadline unavailable')
    if record is None:
        return
    # Static publication has no five-minute engine replacement deadline.
    if mode == 'publish':
        if now < record['activationEpoch']:
            raise ValueError('client publication is not yet permitted')
        return
    if now >= record['expiresEpoch']:
        raise ValueError('one-time activation window expired')
    if record['activationEpoch'] + 300 > deadline:
        raise ValueError('absolute deadline cannot contain the full daily window')
    lower = record['activationEpoch'] if mode == 'admit' else record['preparationEpoch']
    if now < lower:
        raise ValueError('activation admission is not yet permitted' if mode == 'admit' else 'preparation is not yet permitted')



def existing_entry(root, run_id, target, control):
    if not re.fullmatch(r'[1-9][0-9]*(-[1-9][0-9]*)?', run_id or ''):
        raise ValueError('runtime entry run identity unavailable')
    if not all(re.fullmatch(r'[0-9a-f]{40}', value) for value in (target, control)):
        raise ValueError('runtime entry source identity unavailable')
    directory = Path(root)
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError('runtime entry directory unavailable')
    path = directory / (run_id + '.activation-entry')
    if not os.path.lexists(path):
        return None
    import stat
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError('runtime entry ownership/type refused')
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict) or set(value) != {'schema', 'runId', 'targetSha', 'controlSha', 'manifestSha256'}:
        raise ValueError('runtime entry shape refused')
    if value['schema'] != CAPABILITY or value['runId'] != run_id or value['targetSha'] != target or value['controlSha'] != control:
        raise ValueError('runtime entry does not bind this request')
    if not isinstance(value['manifestSha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', value['manifestSha256']):
        raise ValueError('runtime entry manifest identity refused')
    return value


def entry_state(record, root, run_id, create, now, deadline):
    if record is None:
        return 'legacy'
    if not re.fullmatch(r'[1-9][0-9]*(-[1-9][0-9]*)?', run_id or ''):
        raise ValueError('runtime entry run identity unavailable')
    directory = Path(root)
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError('runtime entry directory unavailable')
    path = directory / (run_id + '.activation-entry')
    expected = {'schema': CAPABILITY, 'runId': run_id,
                'targetSha': record['targetSha'], 'controlSha': record['controlSha'],
                'manifestSha256': record['manifestSha256']}
    if os.path.lexists(path):
        info = path.lstat()
        import stat
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('runtime entry ownership/type refused')
        if json.loads(path.read_bytes()) != expected:
            raise ValueError('runtime entry does not bind this request')
        return 'entered'
    if not create:
        return 'never-entered'
    check_window(record, now, deadline, 'admit')
    # Exclusive intent, file fsync and parent fsync all precede the first
    # checkpoint or seal preparation. A partial/corrupt intent is UNKNOWN.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(expected, output, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return 'entered'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('prepare', 'admit', 'wait', 'publish', 'entry', 'entry-check', 'disposition'))
    parser.add_argument('--repo', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--control', required=True)
    parser.add_argument('--deadline', required=True, type=int)
    parser.add_argument('--request-root')
    parser.add_argument('--run-id')
    args = parser.parse_args()
    if args.mode in ('entry', 'entry-check', 'disposition') and existing_entry(args.request_root, args.run_id, args.target, args.control):
        # Durable entry already proved the immutable capability before any
        # runtime action. Recovery must not acquire a new Git/network dependency.
        print('entered')
        return
    record = policy(args.repo, args.target, args.control)
    if args.mode in ('entry', 'entry-check', 'disposition'):
        state = entry_state(record, args.request_root, args.run_id, args.mode == 'entry', int(time.time()), args.deadline)
        if args.mode == 'entry-check' and state == 'never-entered':
            check_window(record, int(time.time()), args.deadline, 'admit')
        print(state)
        return
    check_window(record, int(time.time()), args.deadline, args.mode if args.mode in ('admit', 'publish') else 'prepare')
    if args.mode == 'wait' and record:
        # Passive wait inside the existing owning workflow, never an engine timer.
        # Re-read the immutable source and actual clock before admitting intake.
        while int(time.time()) < record['activationEpoch']:
            check_window(record, int(time.time()), args.deadline, 'prepare')
            time.sleep(max(0, min(5, record['activationEpoch'] - int(time.time()))))
        current = policy(args.repo, args.target, args.control)
        if current != record:
            raise ValueError('activation policy changed while waiting')
        check_window(record, int(time.time()), args.deadline, 'admit')
    print(json.dumps(record or {'schema': 'legacy-no-activation-floor'}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('activation floor refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
