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
              'does not exist', 'no candidates', 'fleet read incomplete')
COUNT_LABELS = ('fleet', 'at-capacity/entered', 'not-a-club-member',
                'lane/window-excluded', 'shortfall', 'rpc_called', 'skipped_already_seated',
                'skipped_table_full', 'verify_reads', 'seated', 'rpc_already_seated',
                'rpc_table_full', 'rpc_refused', 'rpc_other_noop')


def summarize(raw):
    result = {}
    for line in raw.splitlines():
        if len(line) > 4096 or not re.search(r'\[TournamentRecurring(?:\]|\.)', line):
            continue
        keys = [key for key, text in LITERALS.items() if text in line]
        keys += [key for key in EVENTS if re.search(r'TournamentRecurring\.' + re.escape(key) + r'(?![A-Za-z0-9_])', line)]
        if not keys:
            continue
        stamp = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z\s', line)
        for key in set(keys):
            entry = result.setdefault(key, {'count': 0, 'lastTimestamp': None, 'sqlstates': {}, 'categories': {}, 'counts': {}})
            entry['count'] += 1
            if stamp:
                entry['lastTimestamp'] = stamp.group(1) + 'Z'
            for code in re.findall(r'(?:SQLSTATE[=: ]+|code[=: ]+[\"\x27]?)([0-9A-Z]{5})(?![0-9A-Z])', line):
                if code in ('23502', '23503', '23505', '42501', '42703', '42883', '40P01', '57014', '55000'):
                    entry['sqlstates'][code] = entry['sqlstates'].get(code, 0) + 1
            for category in CATEGORIES:
                if category in line:
                    entry['categories'][category] = entry['categories'].get(category, 0) + 1
            for label in COUNT_LABELS:
                match = re.search(r'(?<![A-Za-z0-9_/-])' + re.escape(label) + r'[ =](\d{1,7})(?!\d)', line)
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
    request = urllib.request.Request('http://127.0.0.1:8080/health', headers={'Cache-Control': 'no-cache, no-store'})
    with urllib.request.urlopen(request, timeout=10) as response:
        body = response.read(65537)
    if len(body) > 65536:
        raise RuntimeError('health_size_bound')
    health = json.loads(body)
    instance = health.get('instanceId')
    if health.get('releaseSha') != expected or health.get('running') is not True or health.get('liveness') != 'ok' or not isinstance(instance, str) or not re.fullmatch(r'[1-9][0-9]*-[0-9a-f]{8}', instance):
        raise RuntimeError('health_identity_refused')
    label = bounded_command(['docker', 'container', 'inspect', '-f', '{{index .Config.Labels "sp.release.sha"}}', CONTAINER]).strip()
    if label != expected:
        raise RuntimeError('container_identity_refused')
    return instance


def main(expected):
    if not re.fullmatch(r'[0-9a-f]{40}', expected):
        raise RuntimeError('expected_sha_refused')
    before = identity(expected)
    raw = bounded_command(['docker', 'logs', '--since', '45m', '--tail', '10000', '--timestamps', CONTAINER])
    events = summarize(raw)
    after = identity(expected)
    if before != after:
        raise RuntimeError('engine_changed_during_read')
    print(json.dumps({'schemaVersion': 1, 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'engineSha': expected, 'instanceId': before, 'windowMinutes': 45, 'tailLimit': 10000, 'events': events, 'coverage': read_metadata(raw), 'rawLogsExported': False, 'readOnly': True}, sort_keys=True))


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
