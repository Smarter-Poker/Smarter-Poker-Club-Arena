#!/usr/bin/env python3
"""One manual read-only host diagnostic for tournament table balancing.

Reads the serving engine's own log for the named tournaments and prints only
masked line TEMPLATES with counts and first/last timestamps: every uuid, hex
id and number is replaced before anything leaves this process, so no raw log
line, user id, stack or chip amount is exported. It never writes, restarts,
signals or changes anything on the host.
"""
import datetime
import json
import re
import selectors
import subprocess
import sys
import time

CONTAINER = 'club-arena-engine'
MAX_LINES = 3_000_000
READ_BUDGET_S = 80
MAX_TEMPLATES_PER_EVENT = 160
STAMP = re.compile(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z\s')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.IGNORECASE)
HEX = re.compile(r'\b[0-9a-f]{6,}\b', re.IGNORECASE)
NUM = re.compile(r'(?<![A-Za-z_])-?\d+(?:\.\d+)?')
QUOTED = re.compile(r"'[^']{0,200}'|\"[^\"]{0,200}\"")


def mask(payload, prefixes):
    text = payload
    for prefix in prefixes:
        text = text.replace(prefix, '<T>')
    text = UUID.sub('<id>', text)
    text = HEX.sub('<id>', text)
    text = QUOTED.sub('<s>', text)
    text = NUM.sub('<n>', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text[:220]


def identity(expected):
    # Docker's immutable selection, the same identity the refill diagnostic reads.
    raw = subprocess.run(['docker', 'container', 'inspect', '-f',
                          '{{.Id}} {{.Image}} {{index .Config.Labels "sp.release.sha"}}', CONTAINER],
                         capture_output=True, text=True, timeout=20).stdout.strip()
    fields = raw.split()
    if (len(fields) != 3 or not re.fullmatch(r'[0-9a-f]{64}', fields[0])
            or not re.fullmatch(r'sha256:[0-9a-f]{64}', fields[1]) or fields[2] != expected):
        raise RuntimeError('container_identity_refused')
    return {'containerId': fields[0][:12], 'imageId': fields[1][7:19], 'releaseSha': fields[2]}


def read_log(minutes, prefixes):
    process = subprocess.Popen(['docker', 'logs', '--since', f'{minutes}m', '--timestamps', CONTAINER],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                               errors='replace', bufsize=1)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    started = time.monotonic()
    events = {prefix: {} for prefix in prefixes}
    scanned = 0
    truncated = False
    try:
        while True:
            if time.monotonic() - started > READ_BUDGET_S or scanned >= MAX_LINES:
                truncated = True
                break
            if not selector.select(timeout=1):
                if process.poll() is not None:
                    break
                continue
            line = process.stdout.readline()
            if not line:
                break
            scanned += 1
            if len(line) > 8192:
                continue
            hits = [prefix for prefix in prefixes if prefix in line]
            if not hits:
                continue
            stamp = STAMP.match(line)
            when = stamp.group(1) + 'Z' if stamp else None
            payload = line[stamp.end():] if stamp else line
            template = mask(payload, prefixes)
            for prefix in hits:
                bucket = events[prefix]
                entry = bucket.get(template)
                if entry is None:
                    if len(bucket) >= MAX_TEMPLATES_PER_EVENT:
                        bucket.setdefault('<more templates>', {'count': 0, 'first': when, 'last': when})['count'] += 1
                        continue
                    entry = bucket[template] = {'count': 0, 'first': when, 'last': when}
                entry['count'] += 1
                entry['last'] = when
    finally:
        try:
            process.kill()
        except Exception:
            pass
    return events, scanned, truncated


def main(expected, prefixes_arg, minutes_arg):
    if not re.fullmatch(r'[0-9a-f]{40}', expected):
        raise RuntimeError('expected_sha_refused')
    if not re.fullmatch(r'[0-9a-f]{8}(,[0-9a-f]{8}){0,11}', prefixes_arg):
        raise RuntimeError('prefixes_refused')
    if not re.fullmatch(r'[0-9]{1,3}', minutes_arg) or not 5 <= int(minutes_arg) <= 240:
        raise RuntimeError('window_refused')
    prefixes = sorted(set(prefixes_arg.split(',')))
    before = identity(expected)
    events, scanned, truncated = read_log(int(minutes_arg), prefixes)
    after = identity(expected)
    report = {}
    for prefix, bucket in events.items():
        ordered = sorted(bucket.items(), key=lambda item: -item[1]['count'])
        report[prefix] = [{'template': template, **entry} for template, entry in ordered]
    print(json.dumps({'schemaVersion': 1,
                      'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      'engineSha': expected, 'identityBefore': before, 'identityAfter': after,
                      'windowMinutes': int(minutes_arg), 'linesScanned': scanned,
                      'readTruncated': truncated, 'tournaments': report,
                      'rawLogsExported': False, 'readOnly': True}, sort_keys=True))


def cli(argv):
    try:
        if len(argv) != 4:
            raise RuntimeError('argument_refused')
        main(argv[1], argv[2], argv[3])
        return 0
    except Exception:
        # Never emit subprocess output, exception messages, URLs or log bodies.
        print('{"readOnly":true,"status":"diagnostic_refused","rawLogsExported":false}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(cli(sys.argv))
