"""P11.3 completion reader, stage 1 (engine host, read-only).

Prints one JSON line per journaled PLO5/PLO6/PLO8 decision of ONE pack, made on
ONE engine release, decided in [from, to), first looks only (DECIDE_FAST;
a DEEP second look is counted apart by name): {"eventId", "decisionTimeMs",
"gameMode", "receipt"} where receipt is body.decision.omahaVariantPolicy as
journaled (null when absent). Stage 2 (server/src/scripts/phase11CompletionRecord.ts)
counts them with the authority's own horsePhase11CompletionCounts and writes the
horse-phase11-completion-v1 record, so no counting rule lives here.

Reads closed archive segment files only (never the live journal), verifying
each segment's sha256 name. Run under nice 19 / ionice idle.

argv: <from-iso> <to-iso> <release-sha40> <variant plo5|plo6|plo8>
stderr: a JSON summary (segments read, records, excluded by name).
"""
import os, sys, gzip, json, hashlib, calendar, time
from collections import Counter

DIRS = ['/var/lib/club-arena/horse-decisions/archive/segments',
        '/var/lib/club-arena/horse-decisions/archive-shard-1/segments']
if os.environ.get('PHASE11_EXTRACT_SEGMENT_DIRS'):  # tests only
    DIRS = os.environ['PHASE11_EXTRACT_SEGMENT_DIRS'].split(':')
frm, to, release, variant = sys.argv[1:5]
assert variant in ('plo5', 'plo6', 'plo8') and len(release) == 40
def ms(iso):
    return calendar.timegm(time.strptime(iso.replace('Z', '').split('.')[0], '%Y-%m-%dT%H:%M:%S')) * 1000
FROM, TO = ms(frm), ms(to)
summary = Counter()
for d in DIRS:
    for e in os.scandir(d):
        if not e.name.endswith('.ndjson.gz'): continue
        try:
            if e.stat().st_mtime * 1000 < FROM - 120000: continue
            raw = gzip.decompress(open(e.path, 'rb').read())
        except FileNotFoundError:
            summary['segment_retired_during_scan'] += 1; continue
        if hashlib.sha256(raw).hexdigest() != e.name[:-len('.ndjson.gz')]:
            summary['segment_digest_mismatch'] += 1; continue
        summary['segments_read'] += 1
        for line in raw.decode('utf-8').splitlines():
            r = json.loads(line)
            if r.get('kind') != 'decision': continue
            body = json.loads(r['body'])
            s = body.get('snapshot') or {}
            gs = s.get('gameState') or {}
            dt = s.get('decisionTimeMs')
            if not isinstance(dt, int) or not (FROM <= dt < TO): continue
            if gs.get('gameVariant') != variant: continue
            # One natural decision per turn: a DEEP second look is journaled as
            # a second 'decision' record for the same turn.
            if s.get('type') != 'DECIDE_FAST':
                summary['excluded_deep_second_look'] += 1; continue
            if r.get('sourceRelease') != release:
                summary['excluded_release_other'] += 1; continue
            if gs.get('boardCount', 1) not in (1, None) or gs.get('communityCards2') or gs.get('communityCards3'):
                summary['excluded_multiboard'] += 1; continue
            summary['records'] += 1
            print(json.dumps({'eventId': r['eventId'], 'decisionTimeMs': dt, 'gameMode': gs.get('gameMode'),
                              'receipt': (body.get('decision') or {}).get('omahaVariantPolicy')},
                             separators=(',', ':')))
print(json.dumps(dict(summary), sort_keys=True), file=sys.stderr)
