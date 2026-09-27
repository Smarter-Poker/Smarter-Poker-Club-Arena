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
HEADER = re.compile(r'^\[[^\]\r\n]{1,160}\]')
MAX_BYTES = 8 * 1024 * 1024
COMMAND = ['docker', 'logs', '--since', '15m', '--tail', '20000', '--timestamps', 'club-arena-engine']


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
                            'symbolicErrors': sorted(set(ERROR.findall(text)))})

    for line in raw.decode('utf-8', errors='replace').splitlines():
        ts = STAMP.match(line)
        body = line[ts.end():] if ts else line
        if HEADER.match(body):
            finish()
            match = CONTEXT.match(body)
            context = match.group(1) if match else None
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
    chunks, size, deadline = [], 0, time.monotonic()+20
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


def health():
    url = 'https://engine.smarter.poker/health?runtime_observation=' + str(time.time_ns())
    with urllib.request.build_opener(NoRedirect).open(url, timeout=10) as r:
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
        scopes = selection(json.loads(base64.b64decode(sys.argv[2], validate=True)))
        raw = capture()
        print(json.dumps({'schema': 'scoped-runtime-errors/v1', 'readOnly': True,
                          'window': 'last 15 minutes; last 20000 physical lines',
                          'inputBytes': len(raw), **extract(raw, scopes)}))
        return
    if len(sys.argv) != 1 or os.environ.get('GITHUB_EVENT_NAME') != 'repository_dispatch':
        raise RuntimeError('Explicit observation dispatch required')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    if event.get('action') != 'audit-production-integrity':
        raise RuntimeError('Wrong event')
    scopes = selection(event.get('client_payload', {}).get('tournament_log_observation'))
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
        encoded = base64.b64encode(json.dumps(scopes).encode()).decode()
        # The caller supplies only validated UUID scope; command, host, account,
        # container and time window cannot be selected through dispatch input.
        args = ['ssh', '-i', str(directory/'key'), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
                '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=/dev/null',
                '-o', 'UserKnownHostsFile='+str(directory/'known_hosts'), '-o', 'ConnectTimeout=10',
                'root@'+host, "python3 - --remote '"+encoded+"'"]
        reply = subprocess.run(args, input=Path(__file__).read_bytes(), capture_output=True, timeout=35)
        if reply.returncode or len(reply.stdout) > 262144:
            raise RuntimeError('Scoped transport unavailable')
        result = json.loads(reply.stdout)
        if result.get('schema') != 'scoped-runtime-errors/v1' or result.get('readOnly') is not True:
            raise RuntimeError('Observation contract unavailable')
        after = health()
        if before != after:
            raise RuntimeError('Engine changed during observation')
        output = {**result, 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'engine': after, 'selection': scopes, 'diagnosticOnly': True}
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
