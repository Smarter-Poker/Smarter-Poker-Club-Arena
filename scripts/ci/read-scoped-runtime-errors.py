#!/usr/bin/env python3
"""One explicit, bounded read of existing engine logs. Never a release route."""
import base64
import datetime
import json
import math
import os
import re
import selectors
import stat
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.parse
from pathlib import Path

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
STAMP = re.compile(r'^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+')
# Retain only named symbolic failure families, never arbitrary log messages,
# player objects, credentials, SQL parameters, or stack traces.
ERROR = re.compile(r'\b(?:F06|STOPPED_BANK|MOVEMENT|DRAINED_CUSTODY|HAND_SUBMISSION|RETIRED_CASH|RETIREMENT)_[A-Z0-9_]{1,80}\b|\bf06_[a-z0-9_]{1,80}\b|\bLEDGER_INVARIANT_REFUSED\b')
# The native retired-cash owner embeds one SQLSTATE directly after this
# fixed outer refusal. Do not extract arbitrary numbers or object fields.
POSTCOMMIT_SQLSTATE = re.compile(r'\bRETIRED_CASH_ORIGINAL_POSTCOMMIT_REFUSED: ([0-9A-Z]{5})(?=[ \t]|$)')
CASH_EARNING_REFUSAL = re.compile(r'(?<![a-zA-Z0-9_])cash_earning_seat_provenance_missing_or_ambiguous(?![a-zA-Z0-9_])')
CONTEXT = re.compile(r'^\[(Tournament(?:ManagerBase)?\.[a-zA-Z0-9_]{1,80})\]')
# Managers emit this marker immediately after the Error label. A prefix is
# inferred attribution only, never evidence that the full UUID was logged.
EVENT_PREFIX = re.compile(r'^\[Tournament(?:ManagerBase)?\.[a-zA-Z0-9_]{1,80}\] Error: \[Tournament:([0-9a-f]{8})\](?:[ \t]|$)')
# Fixed existing manager transitions, with bounded counts only. Never export
# the rest of a console line, a generic message, or an arbitrary object.
BALANCE_PROGRESS = re.compile(r'^\[Tournament:([0-9a-f]{8})\] (?:(consolidation outstanding - sweeps move to the consolidation lane|consolidation finished - sweeps return to the general lanes)|Resumed - ([0-9]{1,4}) tables, level ([0-9]{1,4}))$')
BALANCE_REFUSAL = re.compile(r'^\[Tournament:([0-9a-f]{8})\] Break ([0-9a-f]{8}) (not begun|members not dispatched|not retired): ([a-z_]{1,64})(?::.{0,512})?$')
BREAK_REFUSAL_REASONS = frozenset({
    'source_engine_absent', 'source_retention_refused', 'source_park_probe_missed',
    'source_engine_replaced', 'mutation_not_allowed', 'source_roster_unread',
    'source_roster_empty', 'source_seat_unfunded_or_unbound',
    'source_registrations_unread', 'source_roster_disagrees', 'destinations_unread',
    'destinations_full', 'movement_unproven', 'begin_refused',
    'seat_move_outcome_pending', 'source_boundary_unclaimed',
    'terminal_handoff_required', 'original_owner_lifecycle_changed',
    'members_unresolved', 'state_not_retirable', 'manager_authority_unavailable',
    'reconcile_refused', 'amendment_refused',
})
# Keep the original deal refusals as well as their later watchdog consequence.
# Only these emitted call sites, with an exactly selected table, are admitted.
ENGINE_CONTEXT = re.compile(r'^\[ServerTableEngine\.([0-9a-f-]{36})\.(watchdog_kill|deal_error_attempt_(?:[1-9]|10)|too_many_errors_stopping|failed_to_start)\]')
ENGINE_REASON = re.compile(r'Engine self-terminating for restart: (tournament_table_zombie|cash_table_zombie|cash_lease_proof_expired|tournament_lease_proof_expired|dealing_loop_threw|post_hand_settlement_failed|authoritative_hand_commit_not_proved|atomic_stack_settlement_refused|post_commit_stack_refresh_failed|stalled_no_seat)\b')
# Successor admission is owned by GameServer, before or while a new manager
# recovers its originals. Keep this an exact call-site list, never GameServer.*.
ADMISSION_CONTEXT = re.compile(r'^\[(GameServer\.(?:Tournament_resume_failed_for_t|tournament_admission_retry_failed|mixed_original_recovery_retained|retained_hand_refusal_holds_table|retained_hand_refused_cleanup_unconfirmed|direct_table_recovery_admission_threw|discovery_table_admission_threw|stalled_elimination_successor_drain_requested|stuck_tournament_successor_drain_requested))\]')
# These are the existing successor caller's fixed message and literal sweep
# phases. Preserve elapsed counts, never its arbitrary error/metadata payload.
SUCCESSOR_STALL = re.compile(r'\bTournament ([0-9a-f-]{36}) bust stage stalled \(sweep in flight ([0-9]{1,10})s, oldest bust waiting ([0-9]{1,10})s, stage (-?[0-9]{1,3})(?:, stuck in ([A-Za-z0-9_:]{1,100}) for ([0-9]{1,10})s)?\)')
SWEEP_STEPS = frozenset({
    'admitted', 'broadcast', 'checkDynamicTableExpansion', 'checkFinalTableDeal',
    'checkSatelliteQualifierCompletion', 'checkTableBalance',
    'db:fn_get_tournament_satellite_entitlement_depth',
    'db:fn_open_tournament_rebuy_decisions', 'db:tournament_players',
    'eliminatePlayer', 'finishTournament', 'maybeActivateMysteryBounty',
    'reconcileTournamentEntryWindow', 'recoverPendingBountyObligations',
    'refreshChipCapInputs', 'resumeCommittedTerminalCleanup',
    'seatAcceptedEntrantsAwaitingChairs', 'tryTournamentAddOns', 'tryTournamentRebuys',
})
POSTCOMMIT_CONTEXT = re.compile(r'^\[(ServerTableEngine\.post_commit_obligations_pending)\]')
HEADER = re.compile(r'^\[[^\]\r\n]{1,160}\]')
MAX_BYTES = 8 * 1024 * 1024
HEALTH_TIMEOUT = 10
CAPTURE_TIMEOUT = 20
CONNECT_TIMEOUT = 10
# Both host identity reads surround capture; the outer transport owns their
# complete budget plus connection setup and a finite transfer allowance.
TRANSPORT_TIMEOUT = 2 * HEALTH_TIMEOUT + CAPTURE_TIMEOUT + CONNECT_TIMEOUT + 5
LEASE_METRICS_TIMEOUT = 5
LEASE_METRIC_NAMES = frozenset({
    'poker_lease_heartbeat_outcomes_total', 'poker_lease_renewal_passes_total',
    'poker_lease_renewal_loop_running', 'poker_lease_renewal_loop_relaunches_total',
    'poker_lease_renewal_outstanding_total', 'poker_lease_heartbeat_session_enabled',
    'poker_lease_heartbeat_session_connected', 'poker_lease_heartbeat_statements_total',
    'poker_lease_heartbeat_session_disconnects_total', 'poker_event_loop_delay_p50_ms',
    'poker_event_loop_delay_p99_ms', 'poker_fleet_table_stall_max_ms',
})
LEASE_METRIC_LABELS = {
    'scope': {'table', 'tournament'},
    'state': {'kept', 'busy', 'taken', 'stale', 'missing', 'malformed'},
    'transport': {'dedicated', 'shared'},
    'outcome': {'completed', 'threw', 'abandoned'},
    'half': {'cash', 'tournament'},
}
# Prometheus attaches these maintained static labels to every engine scrape.
# Accept only their configured values and never include them in evidence.
LEASE_METRIC_TARGET_LABELS = {
    'host': 'engine-01', 'role': 'engine', 'app': 'club-arena-engine',
}
COMMAND = ['docker', 'logs', '--since', '15m', '--tail', '20000', '--timestamps', 'club-arena-engine']


def log_window(value, now=None):
    """One original incident window, never a wider or caller-chosen command."""
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', value):
        raise ValueError('Invalid observation window')
    start = datetime.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    end = start + datetime.timedelta(minutes=15)
    # A next-day digest can name yesterday morning more than 24 hours later.
    # Keep one completed 15-minute interval and every existing transport bound.
    if start < now - datetime.timedelta(hours=48) or end > now:
        raise ValueError('Observation window is not a completed recent interval')
    return {'since': value, 'until': end.strftime('%Y-%m-%dT%H:%M:%SZ')}


def log_command(window):
    if window is None:
        return COMMAND.copy()
    return ['docker', 'logs', '--since', window['since'], '--until', window['until'],
            '--tail', '20000', '--timestamps', 'club-arena-engine']


def window_description(window):
    return ({**window, 'durationMinutes': 15, 'maximumPhysicalLines': 20000}
            if window else 'last 15 minutes; last 20000 physical lines')


def lease_metrics_requested(value, window):
    if value is None:
        return False
    if value is not True or window is None:
        raise ValueError('Lease metrics require an explicit completed incident window')
    return True


def extract_lease_metrics(value, window):
    """A fixed fleet-only matrix, never arbitrary series, labels or provider errors."""
    data = value.get('data') if isinstance(value, dict) else None
    if not isinstance(value, dict) or value.get('status') != 'success' or not isinstance(data, dict) or data.get('resultType') != 'matrix':
        raise ValueError('Metrics response unavailable')
    rows = data.get('result')
    if not isinstance(rows, list) or len(rows) > 64:
        raise ValueError('Metrics series bound refused')
    start, end = [datetime.datetime.fromisoformat(window[k].replace('Z', '+00:00')).timestamp()
                  for k in ('since', 'until')]
    series, unknown = [], 0
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('metric'), dict):
            raise ValueError('Metrics series refused')
        metric = row['metric']
        name = metric.get('__name__')
        if not isinstance(name, str) or name not in LEASE_METRIC_NAMES or set(metric)-{'__name__', 'job', 'instance'}-set(LEASE_METRIC_LABELS)-set(LEASE_METRIC_TARGET_LABELS):
            raise ValueError('Metrics identity refused')
        if any(metric[key] != expected for key, expected in LEASE_METRIC_TARGET_LABELS.items() if key in metric):
            raise ValueError('Metrics target refused')
        labels = {k: v for k, v in metric.items() if k in LEASE_METRIC_LABELS}
        if any(not isinstance(v, str) or v not in LEASE_METRIC_LABELS[k] for k, v in labels.items()):
            raise ValueError('Metrics labels refused')
        points = row.get('values')
        if not isinstance(points, list) or not 1 <= len(points) <= 61:
            raise ValueError('Metrics sample bound refused')
        clean, previous = [], start-1
        for point in points:
            if not isinstance(point, list) or len(point) != 2:
                raise ValueError('Metrics sample refused')
            stamp, reading = point
            if type(stamp) not in (int, float) or not math.isfinite(stamp) or not start <= stamp <= end or stamp <= previous:
                raise ValueError('Metrics timestamp refused')
            if not isinstance(reading, str) or len(reading) > 40:
                raise ValueError('Metrics value refused')
            numeric = float(reading)
            if not math.isfinite(numeric):
                numeric = None
                unknown += 1
            elif numeric < 0:
                raise ValueError('Metrics value refused')
            clean.append([stamp, numeric])
            previous = stamp
        series.append({'name': name, 'labels': labels, 'values': clean})
    missing = sorted(LEASE_METRIC_NAMES-{row['name'] for row in series})
    return {'status': ('partial' if missing else 'observed') if series else 'no_series',
            'series': series, 'missingMetrics': missing,
            'unknownSamples': unknown,
            'sampleTimes': 'evaluation times; Prometheus lookback may reuse an older scrape'}


def read_lease_metrics(window):
    # One fixed localhost GET, no auth material, arbitrary PromQL or redirects.
    query = '{job="engine_game_server",__name__=~"'+'|'.join(sorted(LEASE_METRIC_NAMES))+'"}'
    params = urllib.parse.urlencode({'query': query, 'start': window['since'],
                                    'end': window['until'], 'step': '15s'})
    try:
        with urllib.request.build_opener(NoRedirect).open(
                'http://127.0.0.1:9090/api/v1/query_range?'+params,
                timeout=LEASE_METRICS_TIMEOUT) as response:
            if response.status != 200:
                raise ValueError('Metrics unavailable')
            body = response.read(262145)
        if len(body) > 262144:
            raise ValueError('Metrics response bound refused')
        return extract_lease_metrics(json.loads(body), window)
    except Exception:
        # The original log evidence remains usable; an absent metric is UNKNOWN.
        return {'status': 'unavailable', 'reason': 'transport_or_response_refused',
                'series': [], 'unknownSamples': 0}


def mux_timing_requested(value, window):
    # Anonymous transport phases cannot be scoped to a table. Require a
    # separate explicit opt-in and the original completed incident interval.
    if value is None:
        return False
    if value is not True or window is None:
        raise ValueError('Anonymous timing requires an explicit completed window')
    return True


def extract_mux_timings(raw):
    prefix = '[EngineWS] mux subscription timing '
    offsets = {'authorityReturnedAtMs', 'ensureStartedAtMs', 'tableReadyAtMs',
               'ackQueuedAtMs', 'firstHubFrameQueuedAtMs', 'hubSubscribedAtMs'}
    outcomes = {'interrupted', 'access_refused', 'banned', 'table_unavailable',
                'ip_restricted', 'subscribed', 'error'}
    fields = offsets | {'attempt', 'startedAt', 'outcome', 'totalMs'}
    records, invalid = [], 0

    def number(value, maximum):
        return (type(value) in (int, float) and 0 <= value <= maximum
                and (type(value) is int or math.isfinite(value)))

    for line in raw.decode('utf-8', errors='replace').splitlines():
        stamp = STAMP.match(line)
        body = line[stamp.end():] if stamp else line
        if not body.startswith(prefix):
            continue
        try:
            if stamp is None or len(body) > 4096:
                raise ValueError('Unbounded or undated timing')
            record = json.loads(body[len(prefix):])
            if not isinstance(record, dict) or set(record) != fields:
                raise ValueError('Unknown timing fields')
            if record['outcome'] not in outcomes:
                raise ValueError('Unknown timing outcome')
            for field in ['attempt', 'startedAt']:
                if type(record[field]) is not int or not 0 < record[field] <= 9007199254740991:
                    raise ValueError('Invalid timing identity')
            if not number(record['totalMs'], 900000):
                raise ValueError('Invalid duration')
            for field in offsets:
                if record[field] is not None and not number(record[field], record['totalMs']):
                    raise ValueError('Invalid timing offset')
            records.append({'timestamp': stamp.group(1), **record})
        except (ValueError, TypeError):
            invalid += 1
    return {'records': records[-50:], 'matchingRecords': len(records),
            'omittedRecords': max(0, len(records)-50), 'invalidRecords': invalid,
            'attribution': 'anonymous phases cannot identify a table or user; offsets end at enqueue, not browser receipt',
            'absenceMeans': 'unknown; bounded retained logs may omit attempts'}


def lightning_fold_timing_requested(value, window):
    if value is None:
        return False
    if value is not True or window is None:
        raise ValueError('Lightning timing requires an explicit completed window')
    return True


def extract_lightning_fold_timings(raw):
    """Allowlisted original-request phases, never payloads or arbitrary errors."""
    prefix = '[LightningFoldTiming] '
    fields = {'version', 'requestId', 'totalMs', 'timerLateMs', 'outcome',
              'attempts', 'attemptsOmitted', 'omitted'}
    attempt_fields = {'startMs', 'headersMs', 'bodyMs', 'status',
                      'providerRequestId', 'upstreamMs', 'outcome'}
    records, invalid = [], 0

    def number(value, maximum=900000):
        return (type(value) in (int, float) and 0 <= value <= maximum
                and (type(value) is int or math.isfinite(value)))

    def count(value):
        return type(value) is int and 0 <= value <= 9007199254740991

    for line in raw.decode('utf-8', errors='replace').splitlines():
        stamp = STAMP.match(line)
        body = line[stamp.end():] if stamp else line
        if not body.startswith(prefix):
            continue
        try:
            if stamp is None or len(body) > 8192:
                raise ValueError('Unbounded or undated timing')
            source = json.loads(body[len(prefix):])
            if not isinstance(source, dict) or not fields <= set(source):
                raise ValueError('Missing timing fields')
            record = {key: source[key] for key in fields}
            if type(record['version']) is not int or record['version'] != 1:
                raise ValueError('Unsupported timing version')
            if not isinstance(record['requestId'], str) or not UUID.fullmatch(record['requestId']):
                raise ValueError('Invalid request correlation')
            if record['outcome'] not in ('fulfilled', 'rejected'):
                raise ValueError('Invalid outcome')
            if not number(record['totalMs']) or not number(record['timerLateMs']):
                raise ValueError('Invalid duration')
            if not count(record['attemptsOmitted']) or not count(record['omitted']):
                raise ValueError('Invalid omission count')
            if not isinstance(record['attempts'], list) or len(record['attempts']) > 6:
                raise ValueError('Invalid attempts')
            attempts = []
            for source_attempt in record['attempts']:
                if not isinstance(source_attempt, dict) or not attempt_fields <= set(source_attempt):
                    raise ValueError('Missing attempt fields')
                attempt = {key: source_attempt[key] for key in attempt_fields}
                if attempt['outcome'] not in ('fulfilled', 'rejected', 'pending'):
                    raise ValueError('Invalid attempt outcome')
                if not number(attempt['startMs'], record['totalMs']):
                    raise ValueError('Invalid start')
                prior = attempt['startMs']
                for key in ['headersMs', 'bodyMs']:
                    value = attempt[key]
                    if value is not None:
                        if not number(value, record['totalMs']) or value < prior:
                            raise ValueError('Invalid phase ordering')
                        prior = value
                status = attempt['status']
                if status is not None and (type(status) is not int or not 100 <= status <= 599):
                    raise ValueError('Invalid status')
                correlation = attempt['providerRequestId']
                if correlation is not None and (not isinstance(correlation, str) or not UUID.fullmatch(correlation)):
                    raise ValueError('Invalid provider correlation')
                if attempt['upstreamMs'] is not None and not number(attempt['upstreamMs']):
                    raise ValueError('Invalid upstream duration')
                attempts.append(attempt)
            record['attempts'] = attempts
            records.append({'timestamp': stamp.group(1), **record})
        except (ValueError, TypeError):
            invalid += 1
    return {'records': records[-50:], 'matchingRecords': len(records),
            'omittedRecords': max(0, len(records)-50), 'invalidRecords': invalid,
            'attribution': 'opaque operation correlation only; no player or table attribution',
            'absenceMeans': 'unknown; bounded retained logs and producer sampling may omit requests'}


def selection(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 2:
        raise ValueError('Invalid observation scope')
    result = []
    for item in value:
        if not isinstance(item, dict) or set(item) not in ({'tournamentId', 'tableIds'}, {'tableIds'}):
            raise ValueError('Invalid observation scope')
        ids = ([item['tournamentId']] if 'tournamentId' in item else []) + item['tableIds'] if isinstance(item['tableIds'], list) else []
        if not (2 if 'tournamentId' in item else 1) <= len(ids) <= (9 if 'tournamentId' in item else 8) or any(not isinstance(i, str) or not UUID.fullmatch(i) for i in ids):
            raise ValueError('Invalid observation scope')
        if len(set(ids)) != len(ids):
            raise ValueError('Duplicate observation scope')
        result.append(item)
    if len({i['tournamentId'] for i in result if 'tournamentId' in i}) != sum('tournamentId' in i for i in result) or len({t for i in result for t in i['tableIds']}) != sum(len(i['tableIds']) for i in result):
        raise ValueError('Duplicate observation scope')
    return result


def extract(raw, scopes):
    allowed = {x for s in scopes for x in ([s['tournamentId']] if 'tournamentId' in s else []) + s['tableIds']}
    allowed_tables = {x for s in scopes for x in s['tableIds']}
    event_prefixes = {}
    for scope in scopes:
        if 'tournamentId' in scope:
            event_prefixes.setdefault(scope['tournamentId'][:8], []).append(scope['tournamentId'])
    records, block, context, stamp = [], [], None, None
    oversized = 0

    def finish():
        nonlocal oversized
        if len(block) > 64 or sum(map(len, block)) > 65536:
            oversized += 1
            return
        text = '\n'.join(block)
        matched = sorted(i for i in allowed if re.search(r"(?<![0-9a-f-])" + i + r"(?![0-9a-f-])", text))
        inferred = []
        if context and not matched and block:
            marker = EVENT_PREFIX.match(block[0])
            candidates = event_prefixes.get(marker.group(1), []) if marker else []
            if len(candidates) == 1:
                inferred = candidates
        if context and (matched or inferred):
            record = {'timestamp': stamp, 'context': context, 'scopeIds': matched,
                      'symbolicErrors': sorted(set(ERROR.findall(text))),
                      'engineReasons': sorted(set(ENGINE_REASON.findall(text)))
                      if context == 'ServerTableEngine.watchdog_kill' else []}
            if context == 'GameServer.stalled_elimination_successor_drain_requested':
                stall = SUCCESSOR_STALL.search(text)
                if stall and stall.group(1) in allowed:
                    record['successorStall'] = {
                        'sweepInFlightSeconds': int(stall.group(2)),
                        'bustWaitingSeconds': int(stall.group(3)),
                        'stage': int(stall.group(4)),
                        'step': stall.group(5) if stall.group(5) in SWEEP_STEPS else None,
                        'stepSeconds': int(stall.group(6)) if stall.group(6) else None,
                    }
            nested_states = sorted(set(POSTCOMMIT_SQLSTATE.findall(text)))
            if nested_states:
                record['originalPostcommitSqlstates'] = nested_states
                record['nativeErrorClasses'] = sorted(set(CASH_EARNING_REFUSAL.findall(text)))
            if inferred:
                record.update(inferredScopeIds=inferred,
                              scopeAttribution='canonical_event_prefix_inferred')
            records.append(record)

    for line in raw.decode('utf-8', errors='replace').splitlines():
        ts = STAMP.match(line)
        body = line[ts.end():] if ts else line
        if HEADER.match(body):
            finish()
            refusal = BALANCE_REFUSAL.fullmatch(body)
            if refusal and refusal[4] in BREAK_REFUSAL_REASONS:
                block, context, stamp = [], None, None
                candidates = event_prefixes.get(refusal[1], [])
                if len(candidates) == 1:
                    records.append({'timestamp': ts.group(1) if ts else None,
                                    'context': 'Tournament.break_refused', 'scopeIds': [],
                                    'inferredScopeIds': candidates,
                                    'scopeAttribution': 'canonical_event_prefix_inferred',
                                    'symbolicErrors': sorted(set(ERROR.findall(body))),
                                    'engineReasons': [],
                                    'breakRefusal': {'breakIdPrefix': refusal[2],
                                                     'stage': refusal[3], 'reason': refusal[4]}})
                continue
            progress = BALANCE_PROGRESS.fullmatch(body)
            if progress:
                block, context, stamp = [], None, None
                candidates = event_prefixes.get(progress[1], [])
                if len(candidates) == 1:
                    kind = ('resumed' if progress[3] is not None else
                            'consolidation_outstanding' if progress[2].startswith('consolidation outstanding') else
                            'consolidation_finished')
                    record = {'timestamp': ts.group(1) if ts else None,
                              'context': 'Tournament.'+kind, 'scopeIds': [],
                              'inferredScopeIds': candidates,
                              'scopeAttribution': 'canonical_event_prefix_inferred',
                              'symbolicErrors': [], 'engineReasons': []}
                    if kind == 'resumed':
                        record['resumedBoard'] = {'tables': int(progress[3]), 'level': int(progress[4])}
                    records.append(record)
                continue
            match = CONTEXT.match(body) or ADMISSION_CONTEXT.match(body) or POSTCOMMIT_CONTEXT.match(body)
            context = match.group(1) if match else None
            engine_match = ENGINE_CONTEXT.match(body)
            if engine_match and engine_match.group(1) in allowed_tables:
                context = 'ServerTableEngine.'+engine_match.group(2)
            stamp = ts.group(1) if ts else None
            block = [body]
        elif context:
            # Bound each record even if a malformed logger never closes it.
            if len(block) <= 64:
                block.append(body[:65537])
    finish()
    return {'records': records[-200:], 'matchingRecords': len(records),
            'omittedRecords': max(0, len(records)-200), 'oversizedRecords': oversized,
            'absenceMeans': 'unknown; some owner refusals are not logged, and this is a bounded window'}


def capture(command=COMMAND):
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    stream = selectors.DefaultSelector()
    stream.register(process.stdout, selectors.EVENT_READ)
    chunks, size, deadline = [], 0, time.monotonic()+CAPTURE_TIMEOUT
    try:
        while True:
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise RuntimeError('Log read timed out')
            ready = stream.select(min(remaining, 1))
            if not ready:
                continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_BYTES:
                raise RuntimeError('Log read exceeded bounded input')
            chunks.append(chunk)
        if process.wait(timeout=max(.01, deadline-time.monotonic())) != 0:
            raise RuntimeError('Log source unavailable')
        return b''.join(chunks)
    finally:
        stream.close()
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()


ARCHIVE_DIRECTORY = Path('/var/log/club-arena-engine')
ARCHIVE_NAME = re.compile(r'engine-(\d{8}T\d{6}Z)-started(\d{8}T\d{6})-([0-9a-f]{12})-([0-9a-f]{8})\.log\.gz')
MAX_PHYSICAL_LINES = 20000
MAX_ARCHIVE_EXPANSION = 256 * 1024 * 1024


def archived_window(window, current, seconds=10, scopes=None):
    """Bounded scan of the run-spec's existing outgoing logs, never caller paths.

    Prefixes come from the archive name, not today's host health. Neither an
    archive nor an empty scan proves full coverage or a full engine revision.
    """
    metadata = {'status': 'notRequested', 'archives': [], 'truncated': False,
                'fullWindowCoverageProven': False,
                'absenceMeans': 'unknown; archives or bounded reads may omit the incident'}
    if window is None:
        return [], metadata
    metadata['status'] = 'observed'
    deadline = time.monotonic()+max(0, min(seconds, 10))
    now = datetime.datetime.now(datetime.timezone.utc)
    start = datetime.datetime.fromisoformat(window['since'].replace('Z', '+00:00'))
    until = datetime.datetime.fromisoformat(window['until'].replace('Z', '+00:00'))
    if start < now-datetime.timedelta(hours=24) or until > now or until-start != datetime.timedelta(minutes=15):
        raise ValueError('Invalid archive observation window')
    sources, candidates = [], []
    size, lines = len(current), len(current.splitlines())
    seen = set(current.splitlines())
    expanded = 0
    try:
        # Refuse the directory itself and individual entries if symlinked.
        # O_NOFOLLOW and fstat repeat this check at open to close rename races.
        directory_fd = os.open(ARCHIVE_DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        metadata['status'] = 'unavailable'
        return [], metadata
    try:
        with os.scandir(directory_fd) as entries:
            for index, entry in enumerate(entries):
                if index >= 4096 or time.monotonic() >= deadline:
                    metadata['truncated'] = True
                    break
                match = ARCHIVE_NAME.fullmatch(entry.name)
                if not match or not entry.is_file(follow_symlinks=False):
                    continue
                try:
                    ended = datetime.datetime.strptime(match[1], '%Y%m%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc)
                    started = datetime.datetime.strptime(match[2], '%Y%m%dT%H%M%S').replace(tzinfo=datetime.timezone.utc)
                    if not (now-datetime.timedelta(hours=24) <= ended <= now and started <= ended
                            and started < until and ended >= start):
                        continue
                    candidates.append((ended, entry.name, match[3], match[4]))
                except ValueError:
                    continue
        if len(candidates) > 2:
            metadata['truncated'] = True
        for ended, name, container, image in sorted(candidates, reverse=True)[:2]:
            identity = {'source': 'outgoingArchive', 'containerIdPrefix': container,
                        'imageIdPrefix': image, 'fullEngineRevision': 'unproven; archive filename prefix only'}
            item = {**identity, 'status': 'observed', 'retainedBytes': 0, 'retainedPhysicalLines': 0}
            metadata['archives'].append(item)
            output, pending, block = [], b'', []

            def retain(record):
                nonlocal size, lines
                if not record:
                    return True
                raw_record = b''.join(record)
                # Scope before the retained-input bound. Otherwise unrelated
                # fleet traffic can consume all 20,000 lines before the named
                # event's original refusal, even in an explicitly selected
                # incident window. Extraction remains the same allowlisted,
                # redacted parser; raw records never leave the host.
                if scopes is not None and not extract(raw_record, scopes)['matchingRecords']:
                    return True
                fresh, record_seen = [], set()
                for line in record:
                    key = line.rstrip(b'\n')
                    if key not in seen and key not in record_seen:
                        record_seen.add(key)
                        fresh.append(line)
                byte_count = sum(map(len, fresh))
                if size+byte_count > MAX_BYTES or lines+len(fresh) > MAX_PHYSICAL_LINES:
                    item['status'] = 'inputBound'; metadata['truncated'] = True
                    return False
                for line in fresh:
                    seen.add(line.rstrip(b'\n'))
                output.extend(fresh)
                size += byte_count; lines += len(fresh)
                return True
            process, stream = None, None
            try:
                if time.monotonic() >= deadline:
                    item['status'] = 'timeBound'; metadata['truncated'] = True
                    break
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
                with os.fdopen(fd, 'rb') as source:
                    if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                        raise OSError('Not a regular archive')
                    process = subprocess.Popen(['gzip', '-cd'], stdin=source,
                                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                    stream = selectors.DefaultSelector()
                    stream.register(process.stdout, selectors.EVENT_READ)
                    while True:
                        remaining = deadline-time.monotonic()
                        if remaining <= 0:
                            item['status'] = 'timeBound'; metadata['truncated'] = True
                            break
                        if not stream.select(min(remaining, .1)):
                            continue
                        chunk = os.read(process.stdout.fileno(), 65536)
                        if not chunk:
                            if pending:
                                chunk = b'\n'
                            else:
                                if process.wait(timeout=max(.01, remaining)) != 0:
                                    item['status'] = 'unavailable'
                                break
                        expanded += len(chunk)
                        if expanded > MAX_ARCHIVE_EXPANSION:
                            item['status'] = 'expansionBound'; metadata['truncated'] = True
                            break
                        pending += chunk
                        parts = pending.split(b'\n')
                        pending = parts.pop()
                        if len(pending) > MAX_BYTES:
                            item['status'] = 'lineBound'; metadata['truncated'] = True
                            break
                        stop = False
                        for line in parts:
                            match = STAMP.match(line.decode('utf-8', errors='replace'))
                            if not match:
                                continue
                            try:
                                timestamp = datetime.datetime.fromisoformat(match[1].replace('Z', '+00:00'))
                            except ValueError:
                                continue
                            if not start <= timestamp < until or line in seen:
                                continue
                            if scopes is None:
                                if not retain([line+b'\n']):
                                    stop = True
                                    break
                            else:
                                body = line.decode('utf-8', errors='replace')[match.end():]
                                if HEADER.match(body):
                                    if not retain(block):
                                        stop = True
                                        break
                                    block = []
                                # Same oversized-record refusal as extract():
                                # a later scope cannot attach to a lost header.
                                if len(block) <= 64:
                                    block.append(line[:65537]+b'\n')
                        if stop:
                            break
                if scopes is not None and item['status'] != 'inputBound':
                    retain(block)
                raw = b''.join(output)
                item.update(retainedBytes=len(raw), retainedPhysicalLines=len(output))
                sources.append((raw, identity))
            except (OSError, subprocess.SubprocessError):
                item['status'] = 'unavailable'
            finally:
                if stream is not None:
                    stream.close()
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=1)
                    process.stdout.close()
        if any(a['status'] != 'observed' for a in metadata['archives']):
            metadata['status'] = 'incomplete'
        if not metadata['archives']:
            metadata['status'] = 'unavailable'
        return sources, metadata
    finally:
        os.close(directory_fd)


def extract_sources(raw, archives, scopes):
    result = extract(raw, scopes)
    for record in result['records']:
        record['engineIdentity'] = {'source': 'currentContainer', 'fullEngineRevision': 'unproven; host health is observation identity only'}
    for source, identity in archives:
        extracted = extract(source, scopes)
        for record in extracted['records']:
            record['engineIdentity'] = identity
        result['records'].extend(extracted['records'])
        result['matchingRecords'] += extracted['matchingRecords']
        result['oversizedRecords'] += extracted['oversizedRecords']
    result['records'] = sorted(result['records'], key=lambda r: r.get('timestamp') or '')[-200:]
    result['omittedRecords'] = max(0, result['matchingRecords']-len(result['records']))
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Health redirect refused')


def health(origin='https://engine.smarter.poker'):
    url = origin+'/health?runtime_observation=' + str(time.time_ns())
    with urllib.request.build_opener(NoRedirect).open(url, timeout=HEALTH_TIMEOUT) as r:
        if r.status != 200:
            raise RuntimeError('Health unavailable')
        body = r.read(262145)
    if len(body) > 262144:
        raise RuntimeError('Health size refused')
    value = json.loads(body)
    if not re.fullmatch('[0-9a-f]{8,40}', value.get('version', '')) or not re.fullmatch('[A-Za-z0-9-]{1,100}', value.get('instanceId', '')):
        raise RuntimeError('Health identity unavailable')
    return {k: value[k] for k in ['version', 'instanceId']}


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--remote':
        request = json.loads(base64.b64decode(sys.argv[2], validate=True))
        if isinstance(request, list):
            scopes, window, mux_timing, fold_timing, lease_metrics = selection(request), None, False, False, False
        elif isinstance(request, dict) and {'scopes', 'windowStart'} <= set(request) <= {'scopes', 'windowStart', 'muxTiming', 'lightningFoldTiming', 'leaseIncidentMetrics'}:
            scopes, window = selection(request['scopes']), log_window(request['windowStart'])
            mux_timing = mux_timing_requested(request.get('muxTiming'), window)
            fold_timing = lightning_fold_timing_requested(request.get('lightningFoldTiming'), window)
            lease_metrics = lease_metrics_requested(request.get('leaseIncidentMetrics'), window)
        else:
            raise ValueError('Invalid observation request')
        before = health('http://127.0.0.1:8080')
        capture_started = time.monotonic()
        raw = capture(log_command(window))
        # Docker's --tail bounds current physical lines. Enforce the same
        # shared ceiling even if a source violates that contract.
        if len(raw.splitlines()) > MAX_PHYSICAL_LINES:
            raise RuntimeError('Log read exceeded bounded physical lines')
        archives, archive_metadata = archived_window(
            window, raw, seconds=max(0, CAPTURE_TIMEOUT-(time.monotonic()-capture_started)),
            # Explicit anonymous timing reads retain their existing framing.
            scopes=None if mux_timing or fold_timing else scopes)
        current_raw = raw
        raw += b''.join(source for source, _identity in archives)
        metric_evidence = read_lease_metrics(window) if lease_metrics else None
        after = health('http://127.0.0.1:8080')
        if before != after:
            raise RuntimeError('Host engine changed during observation')
        extra = {'muxSubscriptionTimings': extract_mux_timings(raw)} if mux_timing else {}
        if fold_timing:
            extra['lightningFoldTimings'] = extract_lightning_fold_timings(raw)
        if lease_metrics:
            extra['leaseIncidentMetrics'] = metric_evidence
        print(json.dumps({'schema': 'scoped-runtime-errors/v1', 'readOnly': True,
                          'window': window_description(window),
                          'hostEngineBefore': before, 'hostEngineAfter': after,
                          'perRecordEngineIdentity': 'unproven; the retained window may include an earlier process',
                          'inputBytes': len(raw), 'archiveRead': archive_metadata,
                          **extract_sources(current_raw, archives, scopes), **extra}))
        return
    if len(sys.argv) != 1 or os.environ.get('GITHUB_EVENT_NAME') != 'repository_dispatch':
        raise RuntimeError('Explicit observation dispatch required')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    if event.get('action') != 'audit-production-integrity':
        raise RuntimeError('Wrong event')
    scopes = selection(event.get('client_payload', {}).get('tournament_log_observation'))
    window = log_window(event.get('client_payload', {}).get('tournament_log_window_start'))
    mux_timing = mux_timing_requested(event.get('client_payload', {}).get('mux_subscription_timing'), window)
    fold_timing = lightning_fold_timing_requested(event.get('client_payload', {}).get('lightningFoldTiming'), window)
    lease_metrics = lease_metrics_requested(event.get('client_payload', {}).get('leaseIncidentMetrics'), window)
    host = os.environ.get('HETZNER_HOST', '')
    key = os.environ.get('HETZNER_SSH_PRIVATE_KEY', '')
    pin = os.environ.get('HETZNER_HOST_KEY', '')
    if not re.fullmatch('[A-Za-z0-9.-]+', host) or host.startswith('-') or not key.strip() or not pin.strip():
        raise RuntimeError('Configured read transport unavailable')
    before = health()
    directory = Path(tempfile.mkdtemp(prefix='scoped-engine-read-', dir=os.environ['RUNNER_TEMP']))
    try:
        for name, content in [('key', key), ('known_hosts', pin)]:
            path = directory/name
            path.write_text(content+'\n')
            path.chmod(0o600)
        for args in [['ssh-keygen', '-y', '-f', str(directory/'key')], ['ssh-keygen', '-l', '-f', str(directory/'known_hosts')]]:
            subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=5)
        request = {'scopes': scopes, 'windowStart': window['since'] if window else None}
        if mux_timing:
            request['muxTiming'] = True
        if fold_timing:
            request['lightningFoldTiming'] = True
        if lease_metrics:
            request['leaseIncidentMetrics'] = True
        encoded = base64.b64encode(json.dumps(request).encode()).decode()
        # Only validated UUID scope and an exact recent fifteen-minute interval
        # enter the fixed reader. Host, account, container and command stay fixed.
        args = ['ssh', '-i', str(directory/'key'), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
                '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=/dev/null',
                '-o', 'UserKnownHostsFile='+str(directory/'known_hosts'), '-o', f'ConnectTimeout={CONNECT_TIMEOUT}',
                'root@'+host, "python3 - --remote '"+encoded+"'"]
        reply = subprocess.run(args, input=Path(__file__).read_bytes(), capture_output=True,
                               timeout=TRANSPORT_TIMEOUT+(LEASE_METRICS_TIMEOUT if lease_metrics else 0))
        if reply.returncode or len(reply.stdout) > 262144:
            raise RuntimeError('Scoped transport unavailable')
        result = json.loads(reply.stdout)
        if result.get('schema') != 'scoped-runtime-errors/v1' or result.get('readOnly') is not True:
            raise RuntimeError('Observation contract unavailable')
        if result.get('window') != window_description(window):
            raise RuntimeError('Observation window differs')
        if ('muxSubscriptionTimings' in result) != mux_timing:
            raise RuntimeError('Anonymous timing observation differs')
        if ('lightningFoldTimings' in result) != fold_timing:
            raise RuntimeError('Lightning timing observation differs')
        if ('leaseIncidentMetrics' in result) != lease_metrics:
            raise RuntimeError('Lease metric observation differs')
        after = health()
        if before != after or result.get('hostEngineBefore') != before or result.get('hostEngineAfter') != after:
            raise RuntimeError('Public and host engine identity changed or differ')
        output = {**result, 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'engineAtObservation': after, 'selection': scopes, 'diagnosticOnly': True}
        serialized = json.dumps(output, indent=2)+'\n'
        if key in serialized or pin in serialized:
            raise RuntimeError('Observation refused')
        destination = Path('artifacts/scoped-runtime-errors')
        destination.mkdir(parents=True, exist_ok=True)
        target = destination/'observation.json'
        target.write_text(serialized)
        target.chmod(0o600)
        print('Bounded read-only engine error evidence saved. No production action performed.')
    finally:
        shutil.rmtree(directory)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Scoped runtime observation unavailable. No production action performed.', file=sys.stderr)
        sys.exit(1)
