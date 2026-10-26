#!/usr/bin/env python3
"""One manual read-only host diagnostic; raw log bytes never leave this process."""
import datetime
import json
import re
import selectors
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

CONTAINER = 'club-arena-engine'
MAX_BYTES = 4 * 1024 * 1024
EVENTS = (
    'sng_atomic_creation_failed', 'spin_atomic_creation_failed',
    'sng_atomic_identity_mismatch', 'spin_atomic_identity_mismatch',
    'board_error', 'board_read_failed', 'board_joinability_read_failed',
    'sng_tick_failed', 'spin_tick_failed', 'initial_sng_tick_failed',
    'initial_spin_tick_failed', 'spin_owners_read_failed', 'SNG_creation_failed',
    'SNG_atomic_table_missing', 'createSNG_error', 'createSpin_error',
    'Spin_state_update_failed_for_s', 'SNG_state_update_failed_for_sn',
    'seat_first_seat_rpc_failed', 'seat_first_roster_read_failed',
    'horse_fleet_read_failed', 'horse_load_seats_failed',
    'horse_load_registrations_failed', 'bankroll_gate',
    'top_up_refused_fleet_held', 'top_up_refused_pool_finalized',
)
LITERALS = {
    'service_started': 'Service started - MTTs every 5 min',
    'register_no_candidates': 'registerHorses found no candidates:',
    'seat_first_no_fill': 'seat-first fill added nobody',
    'seat_first_precheck': 'seat-first-precheck ',
    'seat_first_rpc_noop': 'the seat RPC answered ok:false',
    'board_tick_overlap': 'board tick still running - skipping this one',
    'board_opened': 'Opened ',
    'held_empty': 'held-empty:',
}
CATEGORIES = ('insufficient_chips', 'insufficient_balance', 'fleet_held',
              'table_full', 'maintenance_frozen', 'permission denied',
              'statement timeout', 'deadlock detected', 'null value in column',
              'does not exist', 'no candidates', 'fleet read incomplete',
              'SEAT_FIRST_CREATE_INVALID_REQUEST', 'SEAT_FIRST_CREATE_UNKNOWN_CONFIG_KEY',
              'SEAT_FIRST_CREATE_INVALID_CONFIG', 'SEAT_FIRST_CREATE_INVALID_BLINDS',
              'SEAT_FIRST_CREATE_IDEMPOTENCY_MISMATCH', 'SEAT_FIRST_ATOMIC_PARTIAL_STATE',
              'platform_frozen', 'invalid response')
COUNT_LABELS = ('fleet', 'at-capacity/entered', 'not-a-club-member',
                'lane/window-excluded', 'shortfall', 'rpc_called', 'skipped_already_seated',
                'skipped_table_full', 'verify_reads', 'seated', 'rpc_already_seated',
                'rpc_table_full', 'rpc_refused', 'rpc_other_noop')


def summarize(raw):
    result = {}
    active = []
    origin = None
    continuation_budget = 0
    seen_categories = {}
    seen_codes = {}
    classified = set()
    for line in raw.splitlines():
        if len(line) > 4096:
            active = []
            continue
        stamp = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z\s', line)
        event_time = None
        if stamp:
            try:
                event_time = datetime.datetime.fromisoformat(stamp.group(1) + '+00:00')
            except ValueError:
                pass
        payload = line[stamp.end():] if stamp else line
        if re.search(r'\[TournamentRecurring(?:\]|\.)', payload):
            keys = [key for key, text in LITERALS.items() if text in payload]
            keys += [key for key in EVENTS if re.search(r'TournamentRecurring\.' + re.escape(key) + r'(?![A-Za-z0-9_])', payload)]
            active = list(set(keys))
            origin = event_time
            continuation_budget = 12
            seen_categories = {key: set() for key in active}
            seen_codes = {key: set() for key in active}
            classified = set()
            for key in active:
                entry = result.setdefault(key, {'count': 0, 'unclassifiedCount': 0, 'lastTimestamp': None, 'sqlstates': {}, 'categories': {}, 'counts': {}})
                entry['count'] += 1
                entry['unclassifiedCount'] += 1
                if event_time:
                    entry['lastTimestamp'] = stamp.group(1) + 'Z'
        else:
            # Node console.error(context, Error) prints indented stack/property
            # continuations. Only immediate timestamped lines within two seconds
            # and twelve records can classify the original event. Never print them.
            if not active or not origin or not event_time or continuation_budget <= 0 or not 0 <= (event_time - origin).total_seconds() <= 2 or not payload.startswith((' ', '\t')) or payload.lstrip().startswith('['):
                active = []
                continue
            continuation_budget -= 1
        for key in active:
            entry = result[key]
            codes = set(re.findall(r'(?:SQLSTATE[=: ]+|code[=: ]+[\"\x27]?)([0-9A-Z]{5})(?![0-9A-Z])', payload))
            codes &= {'22023', '22P02', '23502', '23503', '23505', '23514', '42501', '42703', '42883', '40P01', '57014', '55000'}
            categories = {category for category in CATEGORIES if re.search(r'(?<![A-Za-z0-9_])' + re.escape(category) + r'(?![A-Za-z0-9_])', payload)}
            if (codes or categories) and key not in classified:
                entry['unclassifiedCount'] -= 1
                classified.add(key)
            for code in codes - seen_codes[key]:
                entry['sqlstates'][code] = entry['sqlstates'].get(code, 0) + 1
            seen_codes[key].update(codes)
            for category in categories - seen_categories[key]:
                entry['categories'][category] = entry['categories'].get(category, 0) + 1
            seen_categories[key].update(categories)
            for label in COUNT_LABELS:
                match = re.search(r'(?<![A-Za-z0-9_/-])' + re.escape(label) + r'[ =](\d{1,7})(?!\d)', payload)
                if match:
                    entry['counts'][label] = int(match.group(1))
    return result


def read_metadata(raw):
    records = raw.splitlines()
    stamps = []
    for line in records:
        match = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)\s', line)
        if not match:
            continue
        try:
            parsed = datetime.datetime.fromisoformat(match.group(1).replace('Z', '+00:00'))
        except ValueError:
            continue
        stamps.append((parsed, match.group(1)))
    return {
        'semantics': 'bounded-tail',
        'recordsRead': len(records),
        'timestampedRecords': len(stamps),
        'oldestTimestamp': min(stamps)[1] if stamps else None,
        'newestTimestamp': max(stamps)[1] if stamps else None,
        'tailLimitReached': len(records) >= 10000,
        'full45MinuteCoverageProven': False,
        'healthyRefillProven': False,
    }


def worker_receipt_errors(raw):
    """Only the original reporter's table context and named refusal leave here.

    The Error currently carries no request/hand coordinate. Do not borrow one
    from a nearby gameplay line, error property, stack or another table.
    """
    result = {'matchingRecords': 0, 'events': [], 'eventsTruncated': False,
              'handCoordinateAvailable': False}
    expression = re.compile(
        r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)\s+'
        r'\[ServerTableEngine\.([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-'
        r'[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'
        r'\.horse_decision_worker_failed\] Error: '
        r'horse decision worker returned invalid policy receipt: reference_shape\s*$')
    for line in raw.splitlines():
        if len(line) > 4096:
            continue
        match = expression.fullmatch(line)
        if not match:
            continue
        try:
            datetime.datetime.fromisoformat(match.group(1).replace('Z', '+00:00'))
        except ValueError:
            continue
        result['matchingRecords'] += 1
        event = {'timestamp': match.group(1), 'code': 'reference_shape',
                 'tableId': match.group(2).lower()}
        # Retain the newest bounded witnesses in input order. Coverage remains
        # the existing bounded stream/tail, never an all-errors claim.
        if len(result['events']) == 128:
            result['events'].pop(0)
            result['eventsTruncated'] = True
        result['events'].append(event)
    return result


def merge_worker_receipt_errors(target, addition):
    target['matchingRecords'] += addition['matchingRecords']
    combined = target['events'] + addition['events']
    target['eventsTruncated'] = (target['eventsTruncated'] or
                                addition['eventsTruncated'] or len(combined) > 128)
    target['events'] = combined[-128:]


def bounded_command(args):
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    payload = bytearray()
    deadline = time.monotonic() + 25
    try:
        while True:
            if time.monotonic() >= deadline:
                raise RuntimeError('read_deadline')
            ready = selector.select(min(1, max(0, deadline - time.monotonic())))
            if not ready:
                continue
            chunk = process.stdout.read1(65536)
            if not chunk:
                break
            payload.extend(chunk)
            if len(payload) > MAX_BYTES:
                raise RuntimeError('read_size_bound')
        if process.wait(timeout=2) != 0:
            raise RuntimeError('read_command_refused')
        return payload.decode('utf-8', errors='replace')
    finally:
        selector.close()
        process.stdout.close()
        if process.poll() is None:
            process.kill()  # Only this read-only diagnostic child, never the engine.
            process.wait(timeout=2)


def identity(expected):
    # Docker's immutable selection is available even while Node is down. Never
    # make healthy service a prerequisite for diagnosing why service is down.
    raw = bounded_command(['docker', 'container', 'inspect', '-f',
        '{{.Id}} {{.Image}} {{index .Config.Labels "sp.release.sha"}}', CONTAINER]).strip()
    fields = raw.split()
    if (len(fields) != 3 or not re.fullmatch(r'[0-9a-f]{64}', fields[0])
            or not re.fullmatch(r'sha256:[0-9a-f]{64}', fields[1]) or fields[2] != expected):
        raise RuntimeError('container_identity_refused')
    result = {'containerId': fields[0], 'imageId': fields[1], 'health': 'unavailable',
              'instanceId': None}
    request = urllib.request.Request('http://127.0.0.1:8080/health', headers={'Cache-Control': 'no-cache, no-store'})
    try:
        try:
            response = urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as error:
            # /health deliberately answers 503 on standby and degraded states.
            if error.code != 503:
                return result
            response = error
        with response:
            body = response.read(65537)
        if len(body) > 65536:
            raise RuntimeError('health_size_bound')
        health = json.loads(body)
    except (urllib.error.URLError, TimeoutError, OSError):
        return result
    except (ValueError, TypeError):
        result['health'] = 'unreadable'
        return result
    if not isinstance(health, dict):
        result['health'] = 'unreadable'
        return result
    if health.get('releaseSha') != expected:
        raise RuntimeError('health_identity_refused')
    instance = health.get('instanceId')
    if not isinstance(instance, str) or not re.fullmatch(r'[1-9][0-9]*-[0-9a-f]{8}', instance):
        raise RuntimeError('health_identity_refused')
    result['instanceId'] = instance
    result['health'] = health.get('liveness') if health.get('liveness') in ('ok', 'standby', 'dead') else 'degraded'
    return result


PROCESS_SIGNALS = {
    'fatal_uncaught': '[GameServer] FATAL (GameServer.Uncaught_exception)',
    'fatal_rejection': '[GameServer] FATAL (GameServer.Unhandled_rejection)',
    'fatal_boot': '[GameServer] FATAL (GameServer.Fatal_error)',
    'shutdown_requested': '[GameServer] Received shutdown signal',
    'shutdown_fleet_started': '[GameServer] Shutting down...',
    'shutdown_horse_fleet_stopped': '[HorseFleet] Stopped',
    'shutdown_scheduled_stopped': '[ScheduledTournaments] Stopped',
    'shutdown_recurring_stopped': '[TournamentRecurring] Stopped',
    'shutdown_lifecycle_stopped': '[Lifecycle] Stopped',
    'shutdown_settler_stopped': '[RakebackSettler] Stopped',
    'shutdown_tables_drained': '[GameServer] Drained all ',
    'shutdown_table_drain_elapsed': '[GameServer] Drain window elapsed with ',
    'shutdown_ownership_complete': '[GameServer] Shutdown complete.',
    'shutdown_deadline': '[GameServer] graceful shutdown exceeded',
    'shutdown_failed': '[GameServer] GameServer.shutdown_failed',
    'leadership_lost': '[leadership] LOST LEADERSHIP',
    'standby_promoted': 'but booted as a standby, so it has',
    'v8_heap_exhausted': 'FATAL ERROR: Reached heap limit',
    'v8_ineffective_gc': 'FATAL ERROR: Ineffective mark-compacts near heap limit',
}
PROCESS_CONTEXTS = ('GameServer.Uncaught_exception', 'GameServer.Unhandled_rejection',
    'GameServer.Fatal_error', 'GameServer.shutdown_deadline', 'GameServer.shutdown_failed',
    'Leadership.lost', 'Leadership.shutdown_failed', 'Tournament.abandoned_generation_refused')
PROCESS_CAUSES = ('F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT', 'F06_ABANDONED_ROSTER_CHANGED',
    'F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION', 'F06_ABANDONED_PARK_CHANGED',
    'worker execution deadline', 'worker exited', 'out of memory', 'heap out of memory',
    'statement timeout', 'deadlock detected', 'fetch failed', 'ECONNRESET', 'ETIMEDOUT',
    'execution deadline after dispatch', 'live horse decision worker exited with code',
    'live horse decision worker READY timed out', 'Cannot read properties of undefined')


PROCESS_FRAMES = {'index.js', 'GameServer.js', 'services/leadership.js',
    'engine/horseDecision/client.js', 'engine/LiveHorseDecisionWorkerHealth.js',
    'engine/EquityWorkerPool.js', 'services/supabase/client.js'}


def process_signals(raw):
    result = {}
    active = None
    remaining = 0
    for line in raw.splitlines():
        if len(line) > 4096:
            active = None
            continue
        stamp = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z\s', line)
        if not stamp:
            active = None
            continue
        try:
            instant = datetime.datetime.fromisoformat(stamp.group(1) + '+00:00')
        except ValueError:
            active = None
            continue
        payload = line[stamp.end():]
        keys = [key for key, literal in PROCESS_SIGNALS.items() if literal in payload]
        keys += [key for key in PROCESS_CONTEXTS if payload.startswith('[' + key + ']')]
        if keys:
            active = (keys, instant)
            remaining = 12
            for key in keys:
                entry = result.setdefault(key, {'count': 0, 'lastTimestamp': None, 'causes': {}, 'frames': []})
                entry['count'] += 1
                entry['lastTimestamp'] = stamp.group(1) + 'Z'
        elif (not active or remaining <= 0 or not payload.startswith((' ', '\t'))
              or not 0 <= (instant - active[1]).total_seconds() <= 2):
            active = None
        else:
            remaining -= 1
        if active:
            for key in active[0]:
                for path, number in re.findall(r'/app/dist/([A-Za-z0-9_./-]+\.js):(\d{1,7}):\d{1,5}', payload):
                    if path not in PROCESS_FRAMES:
                        continue
                    frame = {'path': path, 'line': int(number)}
                    frames = result[key]['frames']
                    if frame not in frames and len(frames) < 8:
                        frames.append(frame)
                for cause in PROCESS_CAUSES:
                    if re.search(r'(?<![A-Za-z0-9_])' + re.escape(cause) + r'(?![A-Za-z0-9_])', payload):
                        counts = result[key]['causes']
                        counts[cause] = counts.get(cause, 0) + 1
    return result


def merge_signals(target, addition):
    for key, value in addition.items():
        entry = target.setdefault(key, {'count': 0, 'lastTimestamp': None, 'causes': {}, 'frames': []})
        entry['count'] += value['count']
        if value['lastTimestamp'] and (entry['lastTimestamp'] is None or value['lastTimestamp'] > entry['lastTimestamp']):
            entry['lastTimestamp'] = value['lastTimestamp']
        for cause, count in value['causes'].items():
            entry['causes'][cause] = entry['causes'].get(cause, 0) + count
        for frame in value['frames']:
            if frame not in entry['frames'] and len(entry['frames']) < 8:
                entry['frames'].append(frame)


def process_history(args=None, max_bytes=256 * 1024 * 1024, seconds=20):
    # Stream the retained history instead of truncating it at the newest 10k
    # noisy gameplay lines. Keep only one bounded error block in memory. Raw
    # lines are never returned, persisted or printed, even on read failure.
    args = args or ['docker', 'logs', '--since', '2h', '--timestamps', CONTAINER]
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + seconds
    signals = {}
    worker_errors = worker_receipt_errors('')
    block = []
    pending = b''
    dropping = False
    total = 0
    records = 0
    oldest = None
    newest = None
    outcome = 'complete'
    markers = ('[GameServer.', '[GameServer] FATAL', '[GameServer] Received shutdown',
               '[GameServer] graceful shutdown', '[GameServer] GameServer.shutdown_failed', '[leadership]', '[Leadership.',
               '[Tournament.abandoned_generation_refused]', 'FATAL ERROR:', *PROCESS_SIGNALS.values())

    def flush_block():
        nonlocal block
        text = '\n'.join(block)
        merge_signals(signals, process_signals(text))
        merge_worker_receipt_errors(worker_errors, worker_receipt_errors(text))
        block = []

    def record(raw):
        nonlocal records, block, oldest, newest
        records += 1
        if len(raw) > 4096:
            if block:
                flush_block()
            return
        line = raw.decode('utf-8', errors='replace')
        stamp = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z\s', line)
        if stamp:
            try:
                datetime.datetime.fromisoformat(stamp.group(1) + '+00:00')
                oldest = min(oldest, stamp.group(1)) if oldest else stamp.group(1)
                newest = max(newest, stamp.group(1)) if newest else stamp.group(1)
            except ValueError:
                pass
        if any(marker in line for marker in markers) or (
                '[ServerTableEngine.' in line and '.horse_decision_worker_failed]' in line):
            if block:
                flush_block()
            block = [line]
        elif block:
            block.append(line)
            if len(block) >= 13:
                flush_block()

    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                outcome = 'time_bound'
                break
            if not selector.select(min(0.2, remaining)):
                continue
            chunk = process.stdout.read1(65536)
            if not chunk:
                if pending and not dropping:
                    record(pending)
                if process.wait(timeout=2) != 0:
                    outcome = 'command_failed'
                break
            total += len(chunk)
            if total > max_bytes:
                outcome = 'size_bound'
                break
            parts = (pending + chunk).split(b'\n')
            pending = parts.pop()
            for line in parts:
                if dropping:
                    dropping = False
                    continue
                record(line)
            if len(pending) > 4096:
                pending = b''
                dropping = True
        if block:
            flush_block()
        return {'signals': signals, 'workerReceiptErrors': worker_errors,
                'coverage': {'status': outcome,
                'bytesRead': total, 'recordsRead': records,
                'oldestTimestamp': oldest + 'Z' if oldest else None,
                'newestTimestamp': newest + 'Z' if newest else None,
                'fullTwoHourCoverageProven': False}}
    finally:
        selector.close()
        process.stdout.close()
        if process.poll() is None:
            process.kill()  # Only our read child; never the engine.
            process.wait(timeout=2)


def archived_process_history(directory='/var/log/club-arena-engine'):
    # The sole engine run-spec saves its outgoing logs here before a sealed
    # replacement. Read at most two recent regular archives; no arbitrary path,
    # shell expansion, environment file or runtime mutation is admitted.
    archives = []
    pattern = re.compile(r'engine-\d{8}T\d{6}Z-started\d{8}T\d{6}-([0-9a-f]{12})-([0-9a-f]{8})\.log\.gz')
    try:
        candidates = []
        for path in Path(directory).glob('engine-*.log.gz'):
            match = pattern.fullmatch(path.name)
            if not match or path.is_symlink() or not path.is_file():
                continue
            stamp = path.stat().st_mtime
            if 0 <= time.time() - stamp <= 2 * 60 * 60:
                candidates.append((stamp, path, match.group(1), match.group(2)))
        for _, path, container_prefix, image_prefix in sorted(candidates, reverse=True)[:2]:
            result = process_history(['gzip', '-cd', str(path)], seconds=10)
            archives.append({'imageIdPrefix': image_prefix, 'containerIdPrefix': container_prefix, **result})
        return {'status': 'observed', 'archives': archives, 'fullTwoHourCoverageProven': False}
    except Exception:
        return {'status': 'unavailable', 'archives': archives, 'fullTwoHourCoverageProven': False}


def kernel_oom_signals(raw, container_prefixes):
    events = []
    context_id = None
    context_time = None
    for line in raw.splitlines():
        if len(line) > 4096:
            continue
        stamp = re.match(r'^(\d{4}-\d{2}-\d{2}T[0-9:.,+-]+)\s', line)
        if not stamp:
            continue
        try:
            instant = datetime.datetime.fromisoformat(stamp.group(1).replace(',', '.'))
            if instant.tzinfo is None:
                continue
        except ValueError:
            continue
        container = re.search(r'(?:docker-|/docker/)([0-9a-f]{64})(?:\.scope|[/,\s])', line)
        if container:
            context_id = container.group(1)[:12]
            context_time = instant
        if not re.search(r'(?:Out of memory|Memory cgroup out of memory|oom-kill|Killed process)', line, re.IGNORECASE):
            continue
        pid = re.search(r'Killed process ([0-9]{1,10}) \(node\)', line)
        if not pid:
            continue
        same_context = context_time is not None and 0 <= (instant - context_time).total_seconds() <= 2
        prefix = context_id if same_context and context_id in container_prefixes else None
        events.append({'timestamp': instant.astimezone(datetime.timezone.utc).isoformat(),
                       'nodePid': int(pid.group(1)), 'engineContainerMatched': prefix is not None,
                       'containerIdPrefix': prefix})
        if len(events) >= 128:
            break
    return {'events': events, 'fullHistoryProven': False}


def autoheal_signals(raw, container_id):
    result = {}
    for line in raw.splitlines():
        if len(line) > 4096 or not (CONTAINER in line or container_id[:12] in line):
            continue
        stamp = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z\s', line)
        if not stamp:
            continue
        for key, expression in [('unhealthy', r'\bunhealthy\b'),
                                ('restart', r'\brestart(?:ing|ed)?\b'),
                                ('restart_failed', r'\b(?:failed|error)\b')]:
            if re.search(expression, line, re.IGNORECASE):
                entry = result.setdefault(key, {'count': 0, 'lastTimestamp': None})
                entry['count'] += 1
                entry['lastTimestamp'] = stamp.group(1) + 'Z'
    return result


def restart_evidence():
    # Explicit state fields only: never serialize Config.Env or arbitrary labels.
    raw = bounded_command(['docker', 'container', 'inspect', '-f',
        '{{json .State}}', CONTAINER])
    state = json.loads(raw)
    restarts = bounded_command(['docker', 'container', 'inspect', '-f',
        '{{.RestartCount}}', CONTAINER]).strip()
    events = bounded_command(['docker', 'events', '--since', '24h', '--until',
        datetime.datetime.now(datetime.timezone.utc).isoformat(),
        '--filter', 'type=container', '--filter', 'container=' + CONTAINER, '--format', '{{json .}}'])
    return sanitize_restart_evidence(state, restarts, events)


def sanitize_restart_evidence(state, restarts, raw_events):
    if not isinstance(state, dict) or not re.fullmatch(r'[0-9]{1,9}', restarts):
        raise RuntimeError('container_state_refused')
    result = {'oomKilled': state.get('OOMKilled') is True,
              'exitCode': state.get('ExitCode') if type(state.get('ExitCode')) is int else None,
              'restartCount': int(restarts), 'events': []}
    for line in raw_events.splitlines():
        event = json.loads(line)
        attrs = event.get('Actor', {}).get('Attributes', {})
        if attrs.get('name') != CONTAINER:
            continue
        action = event.get('Action')
        if action not in ('oom', 'die', 'restart', 'start', 'stop', 'kill'):
            continue
        stamp = event.get('time')
        if type(stamp) is not int:
            continue
        item = {'action': action, 'unixTime': stamp}
        for key in ('exitCode', 'signal'):
            value = attrs.get(key)
            if isinstance(value, str) and re.fullmatch(r'[0-9]{1,3}', value):
                item[key] = int(value)
        result['events'].append(item)
    return result


def main(expected):
    if not re.fullmatch(r'[0-9a-f]{40}', expected):
        raise RuntimeError('expected_sha_refused')
    before = identity(expected)
    raw = bounded_command(['docker', 'logs', '--since', '45m', '--tail', '10000', '--timestamps', CONTAINER])
    events = summarize(raw)
    restarts = restart_evidence()
    history = process_history()
    archives = archived_process_history()
    try:
        kernel_raw = bounded_command(['dmesg', '--time-format', 'iso'])
        prefixes = {before['containerId'][:12]} | {a['containerIdPrefix'] for a in archives['archives']}
        kernel = {'status': 'observed', **kernel_oom_signals(kernel_raw, prefixes)}
    except Exception:
        kernel = {'status': 'unavailable', 'events': [], 'fullHistoryProven': False}
    try:
        autoheal_raw = bounded_command(['docker', 'logs', '--since', '2h', '--tail', '2000', '--timestamps', 'sp-autoheal'])
        autoheal = {'status': 'observed', 'signals': autoheal_signals(autoheal_raw, before['containerId'])}
    except Exception:
        autoheal = {'status': 'unavailable', 'signals': {}}
    after = identity(expected)
    if any(before[key] != after[key] for key in ('containerId', 'imageId')):
        raise RuntimeError('engine_changed_during_read')
    runtime_stable = before == after
    print(json.dumps({'schemaVersion': 1, 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'engineSha': expected, 'instanceId': before['instanceId'], 'identityBefore': before, 'identityAfter': after, 'runtimeStable': runtime_stable, 'windowMinutes': 45, 'tailLimit': 10000, 'events': events, 'restarts': restarts, 'processSignals': process_signals(raw), 'workerReceiptErrors': worker_receipt_errors(raw), 'processHistory': history, 'archivedProcessHistory': archives, 'kernelOom': kernel, 'autoheal': autoheal, 'coverage': read_metadata(raw), 'rawLogsExported': False, 'readOnly': True}, sort_keys=True))


def cli(argv):
    try:
        if len(argv) != 2:
            raise RuntimeError('argument_refused')
        main(argv[1])
        return 0
    except Exception:
        # Never emit subprocess output, exception messages, URLs or log bodies.
        print('{"readOnly":true,"status":"diagnostic_refused","rawLogsExported":false}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(cli(sys.argv))
