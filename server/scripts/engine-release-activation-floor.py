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
OWNER_CAPABILITY = 'engine-release-activation-floor/v2-owner-window'


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
    owner_mode = isinstance(doc, dict) and doc.get('schema') == OWNER_CAPABILITY
    keys = {'schema', 'preparationAt', 'activationAt', 'expiresAt', 'timeZone'}
    if owner_mode: keys.update(('ownerWindowId', 'clientPublicationAt'))
    if not isinstance(doc, dict) or set(doc) != keys:
        raise ValueError('activation floor schema is unavailable')
    if doc['schema'] not in (CAPABILITY, OWNER_CAPABILITY) or doc['timeZone'] != 'America/Chicago':
        raise ValueError('activation floor capability/timezone refused')
    times = []
    for key in ('preparationAt', 'activationAt', 'expiresAt'):
        value = doc[key]
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', value):
            raise ValueError('activation floor timestamp refused')
        times.append(datetime.fromisoformat(value.replace('Z', '+00:00')))
    preparation, activation, expiry = times
    local = activation.astimezone(ZoneInfo(doc['timeZone']))
    owner_id = None
    publication = activation
    if owner_mode:
        value = doc['clientPublicationAt']
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', value):
            raise ValueError('client publication boundary refused')
        publication = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if publication < activation:
            raise ValueError('client publication precedes owner admission')
        owner_id = doc['ownerWindowId']
        if not isinstance(owner_id, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', owner_id):
            raise ValueError('owner window identity refused')
        if preparation != activation or not (420 <= (expiry-activation).total_seconds() <= 21600):
            raise ValueError('owner window bounds refused')
        windows = json.loads(git(repo, 'show', target + ':server/release/owner-maintenance-windows.json'), object_pairs_hook=unique)
        matches = [w for w in windows.get('windows', []) if isinstance(w, dict) and w.get('id') == owner_id]
        if windows.get('version') != 1 or len(matches) != 1:
            raise ValueError('exact owner window unavailable')
        window = matches[0]
        if (window.get('notBefore') != doc['activationAt'] or window.get('notAfter') != doc['expiresAt']
                or not isinstance(window.get('ownerOrder'), str) or len(window['ownerOrder'].strip()) < 10
                or not re.fullmatch(r'[0-9a-f]{40}', window.get('contains', ''))
                or window.get('migrations') != []):
            raise ValueError('owner authorization does not bind the immutable floor')
        if window.get('releaseWitness') != {'path': MANIFEST, 'sha256': hashlib.sha256(raw).hexdigest()}:
            raise ValueError('owner window feature witness differs')
        git(repo, 'merge-base', '--is-ancestor', window['contains'], target)
        if git(repo, 'show', control + ':server/release/owner-maintenance-windows.json') != git(repo, 'show', target + ':server/release/owner-maintenance-windows.json'):
            raise ValueError('control owner authorization differs')
    else:
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
    return {'schema': doc['schema'], 'ownerWindowId': owner_id, 'targetSha': target, 'controlSha': control,
            'manifestSha256': hashlib.sha256(raw).hexdigest(), 'clientPublicationEpoch': int(publication.timestamp()),
            'preparationEpoch': int(preparation.timestamp()),
            'activationEpoch': int(activation.timestamp()), 'expiresEpoch': int(expiry.timestamp())}


def effective(record, now):
    """AN EXPIRED FLOOR IS NO FLOOR (2026-10-30).

    A floor manifest is one-time: a v1 daily boundary or a v2 owner window names
    one activation and one expiry. Until today an expired manifest kept refusing
    EVERY later target that still carried it ("one-time activation window
    expired"), so the day after an owner window lapsed nothing on protected main
    could be released until a human edited the manifest - the routine 04:00
    route was never consulted. The floor exists to hold a release back until
    its boundary, never to strand every release after it; once its expiry has
    passed, the target is read exactly as a target with no manifest, and the
    routine daily maintenance route (the 04:00 America/Chicago certificate,
    section 13) applies. Said out loud on stderr so a log shows which route ran.
    A still-live window is untouched, and an entry or reservation already owned
    inside a window keeps its exact record (callers that recover an in-flight
    owner never go through here).
    """
    if record is None or type(now) is not int or now < record['expiresEpoch']:
        return record
    print('activation floor %s (%s) expired at epoch %d; the routine daily maintenance route applies'
          % (record['schema'], record.get('ownerWindowId') or 'daily', record['expiresEpoch']), file=sys.stderr)
    return None


def check_window(record, now, deadline, mode):
    if type(now) is not int or type(deadline) is not int or now <= 0 or deadline <= now:
        raise ValueError('activation floor clock/deadline unavailable')
    if record is None:
        return
    # Static publication has no five-minute engine replacement deadline.
    if mode == 'publish':
        if now < record.get('clientPublicationEpoch', record['activationEpoch']):
            raise ValueError('client publication is not yet permitted')
        return
    if now >= record['expiresEpoch']:
        raise ValueError('one-time activation window expired')
    if record.get('ownerWindowId'):
        if mode in ('prepare', 'admit') and min(deadline, record['expiresEpoch']) < now + 420:
            raise ValueError('owner window cannot retain its full announcement and cutover budget')
    elif record['activationEpoch'] + 300 > deadline:
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
    keys = {'schema', 'runId', 'targetSha', 'controlSha', 'manifestSha256'}
    if isinstance(value, dict) and value.get('schema') == OWNER_CAPABILITY: keys.add('phase')
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError('runtime entry shape refused')
    if value['schema'] not in (CAPABILITY, OWNER_CAPABILITY) or value['runId'] != run_id or value['targetSha'] != target or value['controlSha'] != control:
        raise ValueError('runtime entry does not bind this request')
    if not isinstance(value['manifestSha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', value['manifestSha256']):
        raise ValueError('runtime entry manifest identity refused')
    if value['schema'] == OWNER_CAPABILITY and value.get('phase') not in ('announcement', 'runtime'):
        raise ValueError('runtime entry phase refused')
    return value


def entry_state(record, root, run_id, create, now, deadline, announcement=False):
    if record is None:
        return 'legacy'
    if not re.fullmatch(r'[1-9][0-9]*(-[1-9][0-9]*)?', run_id or ''):
        raise ValueError('runtime entry run identity unavailable')
    directory = Path(root)
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError('runtime entry directory unavailable')
    path = directory / (run_id + '.activation-entry')
    expected = {'schema': record['schema'], 'runId': run_id,
                'targetSha': record['targetSha'], 'controlSha': record['controlSha'],
                'manifestSha256': record['manifestSha256']}
    if record['schema'] == OWNER_CAPABILITY:
        expected['phase'] = 'announcement' if announcement else 'runtime'
    prior = existing_entry(root, run_id, record['targetSha'], record['controlSha'])
    if prior is not None:
        identity = {k: v for k, v in prior.items() if k != 'phase'}
        if identity != {k: v for k, v in expected.items() if k != 'phase'}:
            raise ValueError('runtime entry does not bind this request')
        if prior.get('phase') != 'announcement': return 'entered'
        if not create or announcement: return 'announced'
        # Promote announcement ownership before the first checkpoint/prepare.
        # The old durable announcement survives any interrupted replacement.
        check_window(record, now, deadline, 'runtime')
        import tempfile
        fd, temporary = tempfile.mkstemp(prefix='.' + run_id + '.activation-entry.', dir=directory)
        try:
            with os.fdopen(fd, 'w') as output:
                json.dump(expected, output, sort_keys=True)
                output.flush(); os.fsync(output.fileno())
            os.replace(temporary, path)
            parent = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
            try: os.fsync(parent)
            finally: os.close(parent)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)
        return 'entered'
    if not create:
        return 'never-entered'
    check_window(record, now, deadline, 'admit' if announcement or not record.get('ownerWindowId') else 'runtime')
    # Exclusive intent, file fsync and parent fsync precede the first action.
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
    return 'announced' if announcement else 'entered'


def reservation(record, root, run_id):
    if not record or not record.get('ownerWindowId') or not re.fullmatch(r'[1-9][0-9]*(-[1-9][0-9]*)?', run_id or ''):
        raise ValueError('owner reservation identity unavailable')
    path = Path(root) / ('engine-recovery-window-' + run_id + '.json')
    import stat
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError('owner reservation type/ownership refused')
    value = json.loads(path.read_bytes())
    stamp = value.get('announcedAt')
    if (value.get('runId') != run_id or value.get('sha') != record['targetSha'] or value.get('cause') != 'urgent'
            or type(stamp) is not int or stamp < record['activationEpoch'] * 1000
            or stamp + 420000 > record['expiresEpoch'] * 1000):
        raise ValueError('owner reservation does not bind target/window')
    return stamp


def checkpoint_no_action(record, root, state_root, run_id):
    directory = Path(root)
    if os.path.lexists(directory / (run_id + '.legacy-checkpoint-intent')):
        raise ValueError('checkpoint intent exists; runtime ownership retained')
    reservation(record, state_root, run_id)
    value = existing_entry(root, run_id, record['targetSha'], record['controlSha'])
    if not value or value['schema'] != OWNER_CAPABILITY or value['manifestSha256'] != record['manifestSha256']:
        raise ValueError('checkpoint no-action ownership unavailable')
    value['phase'] = 'announcement'
    import tempfile
    fd, temporary = tempfile.mkstemp(prefix='.' + run_id + '.activation-entry.', dir=directory)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, sort_keys=True)
            output.flush(); os.fsync(output.fileno())
        os.replace(temporary, directory / (run_id + '.activation-entry'))
        parent = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try: os.fsync(parent)
        finally: os.close(parent)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    return 'announced'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('prepare', 'admit', 'wait', 'publish', 'entry', 'entry-check', 'disposition', 'reservation', 'announcement-entry', 'checkpoint-no-action'))
    parser.add_argument('--repo', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--control', required=True)
    parser.add_argument('--deadline', required=True, type=int)
    parser.add_argument('--request-root')
    parser.add_argument('--run-id')
    parser.add_argument('--state-root', default='/var/lib/club-arena')
    args = parser.parse_args()
    if args.mode in ('entry', 'entry-check', 'disposition', 'announcement-entry'):
        prior = existing_entry(args.request_root, args.run_id, args.target, args.control)
        if prior and not (args.mode == 'entry' and prior.get('phase') == 'announcement'):
            # Runtime recovery never gains a mutable Git dependency. An
            # announcement-only owner is retained but cannot restore runtime.
            print('announced' if prior.get('phase') == 'announcement' else 'entered')
            return
    record = policy(args.repo, args.target, args.control)
    if args.mode not in ('checkpoint-no-action', 'reservation'):
        # In-flight owner reads keep the exact record; every fresh admission,
        # entry and publication read reads an expired floor as no floor.
        record = effective(record, int(time.time()))
    if args.mode == 'checkpoint-no-action':
        print(checkpoint_no_action(record, args.request_root, args.state_root, args.run_id))
        return
    if args.mode == 'reservation':
        print(reservation(record, args.state_root, args.run_id))
        return
    if args.mode in ('entry', 'entry-check', 'disposition', 'announcement-entry'):
        state = entry_state(record, args.request_root, args.run_id, args.mode in ('entry', 'announcement-entry'), int(time.time()), args.deadline, args.mode == 'announcement-entry')
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
        current = effective(policy(args.repo, args.target, args.control), int(time.time()))
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
