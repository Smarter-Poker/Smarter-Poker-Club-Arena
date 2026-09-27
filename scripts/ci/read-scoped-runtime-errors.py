#!/usr/bin/env python3
"""One explicit, bounded read of existing engine logs. Never a release route."""
import base64
import datetime
import json
import os
import re
import selectors
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
STAMP = re.compile(r'^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+')
# Retain only named symbolic failure families, never arbitrary log messages,
# player objects, credentials, SQL parameters, or stack traces.
ERROR = re.compile(r'\b(?:F06|STOPPED_BANK|MOVEMENT|DRAINED_CUSTODY)_[A-Z0-9_]{1,80}\b|\bf06_[a-z0-9_]{1,80}\b')
CONTEXT = re.compile(r'^\[(Tournament(?:ManagerBase)?\.[a-zA-Z0-9_]{1,80})\]')
ENGINE_CONTEXT = re.compile(r'^\[ServerTableEngine\.([0-9a-f-]{36})\.watchdog_kill\]')
ENGINE_REASON = re.compile(r'Engine self-terminating for restart: (tournament_table_zombie|cash_table_zombie|cash_lease_proof_expired|tournament_lease_proof_expired|dealing_loop_threw|post_hand_settlement_failed|authoritative_hand_commit_not_proved|atomic_stack_settlement_refused|post_commit_stack_refresh_failed|stalled_no_seat)\b')
HEADER = re.compile(r'^\[[^\]\r\n]{1,160}\]')
MAX_BYTES = 8 * 1024 * 1024
HEALTH_TIMEOUT = 10
CAPTURE_TIMEOUT = 20
CONNECT_TIMEOUT = 10
# Both host identity reads surround capture; the outer transport owns their
# complete budget plus connection setup and a finite transfer allowance.
TRANSPORT_TIMEOUT = 2 * HEALTH_TIMEOUT + CAPTURE_TIMEOUT + CONNECT_TIMEOUT + 5
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
    if start < now - datetime.timedelta(hours=24) or end > now:
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


def selection(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 2:
        raise ValueError('Invalid observation scope')
    result = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {'tournamentId', 'tableIds'}:
            raise ValueError('Invalid observation scope')
        ids = [item['tournamentId'], *item['tableIds']] if isinstance(item['tableIds'], list) else []
        if not 2 <= len(ids) <= 9 or any(not isinstance(i, str) or not UUID.fullmatch(i) for i in ids):
            raise ValueError('Invalid observation scope')
        if len(set(ids)) != len(ids):
            raise ValueError('Duplicate observation scope')
        result.append(item)
    if len({i['tournamentId'] for i in result}) != len(result):
        raise ValueError('Duplicate observation scope')
    return result


def extract(raw, scopes):
    allowed = {x for s in scopes for x in [s['tournamentId'], *s['tableIds']]}
    records, block, context, stamp = [], [], None, None
    oversized = 0

    def finish():
        nonlocal oversized
        if len(block) > 64 or sum(map(len, block)) > 65536:
            oversized += 1
            return
        text = '\n'.join(block)
        matched = sorted(i for i in allowed if re.search(r"(?<![0-9a-f-])" + i + r"(?![0-9a-f-])", text))
        if context and matched:
            records.append({'timestamp': stamp, 'context': context, 'scopeIds': matched,
                            'symbolicErrors': sorted(set(ERROR.findall(text))),
                            'engineReasons': sorted(set(ENGINE_REASON.findall(text)))
                            if context == 'ServerTableEngine.watchdog_kill' else []})

    for line in raw.decode('utf-8', errors='replace').splitlines():
        ts = STAMP.match(line)
        body = line[ts.end():] if ts else line
        if HEADER.match(body):
            finish()
            match = CONTEXT.match(body)
            context = match.group(1) if match else None
            engine_match = ENGINE_CONTEXT.match(body)
            if engine_match and engine_match.group(1) in allowed:
                context = 'ServerTableEngine.watchdog_kill'
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
            scopes, window = selection(request), None
        elif isinstance(request, dict) and set(request) == {'scopes', 'windowStart'}:
            scopes, window = selection(request['scopes']), log_window(request['windowStart'])
        else:
            raise ValueError('Invalid observation request')
        before = health('http://127.0.0.1:8080')
        raw = capture(log_command(window))
        after = health('http://127.0.0.1:8080')
        if before != after:
            raise RuntimeError('Host engine changed during observation')
        print(json.dumps({'schema': 'scoped-runtime-errors/v1', 'readOnly': True,
                          'window': window_description(window),
                          'hostEngineBefore': before, 'hostEngineAfter': after,
                          'perRecordEngineIdentity': 'unproven; the retained window may include an earlier process',
                          'inputBytes': len(raw), **extract(raw, scopes)}))
        return
    if len(sys.argv) != 1 or os.environ.get('GITHUB_EVENT_NAME') != 'repository_dispatch':
        raise RuntimeError('Explicit observation dispatch required')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    if event.get('action') != 'audit-production-integrity':
        raise RuntimeError('Wrong event')
    scopes = selection(event.get('client_payload', {}).get('tournament_log_observation'))
    window = log_window(event.get('client_payload', {}).get('tournament_log_window_start'))
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
        encoded = base64.b64encode(json.dumps({'scopes': scopes, 'windowStart':
                                             window['since'] if window else None}).encode()).decode()
        # Only validated UUID scope and an exact recent fifteen-minute interval
        # enter the fixed reader. Host, account, container and command stay fixed.
        args = ['ssh', '-i', str(directory/'key'), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
                '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=/dev/null',
                '-o', 'UserKnownHostsFile='+str(directory/'known_hosts'), '-o', f'ConnectTimeout={CONNECT_TIMEOUT}',
                'root@'+host, "python3 - --remote '"+encoded+"'"]
        reply = subprocess.run(args, input=Path(__file__).read_bytes(), capture_output=True, timeout=TRANSPORT_TIMEOUT)
        if reply.returncode or len(reply.stdout) > 262144:
            raise RuntimeError('Scoped transport unavailable')
        result = json.loads(reply.stdout)
        if result.get('schema') != 'scoped-runtime-errors/v1' or result.get('readOnly') is not True:
            raise RuntimeError('Observation contract unavailable')
        if result.get('window') != window_description(window):
            raise RuntimeError('Observation window differs')
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
