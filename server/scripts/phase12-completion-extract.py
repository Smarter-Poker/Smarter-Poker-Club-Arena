"""P12.3 completion reader, stage 1 (engine host, read-only).

Prints one JSON line per journaled Short Deck / Crazy Pineapple / FLH / FLO8
betting decision of ONE pack, made on ONE engine release, decided in
[from, to): {"eventId", "decisionTimeMs", "gameMode", "receipt"} where receipt
is body.decision.remainingVariantPolicy as journaled (null when absent).
Stage 2 (server/src/scripts/phase12CompletionRecord.ts) counts them with the
authority's own horsePhase12CompletionCounts and writes the
horse-phase12-completion-v1 record, so no counting rule lives here.

Pineapple discards are journaled as their own kind (discard_decision); they
are never betting decisions and are counted apart here, by name, never
printed. Only DECIDE_FAST decision records count: a DEEP second look is a
second record for the same turn and is counted apart by name.

Reads closed archive segment files only (never the live journal), verifying
each segment's sha256 name. Run under nice 19 / ionice idle.

argv: <from-iso> <to-iso> <release-sha40> <variant short_deck|pineapple|flh|flo8>
The window bounds use the exact integer-millisecond parser maintained in P13:
UTC or explicit ISO offsets; extra fractional digits truncate, never round.
A bound without an offset or with invalid time fields is refused before output.
stderr: a JSON summary (segments read, records, excluded by name).
env (tests only): PHASE12_EXTRACT_SEGMENT_DIRS, colon-separated segment
directories replacing the host archive directories; PHASE12_EXTRACT_JOURNAL_ROOT,
a journal directory read in place of the host's.
"""
import os, re, sys, gzip, json, hashlib, calendar
from collections import Counter

# Every decision-worker shard's archive, as horseJournalArchiveDirectoryNames
# reads them: shard 0 is 'archive', later shards 'archive-shard-1', '-2', ...
# up to the first missing one. The worker count follows the host since
# 2026-10-12 (lane.ts), so it is not fixed at two.
ROOT = os.environ.get('PHASE12_EXTRACT_JOURNAL_ROOT', '/var/lib/club-arena/horse-decisions')
DIRS = [ROOT + '/archive/segments']
while os.path.isdir('%s/archive-shard-%d' % (ROOT, len(DIRS))):
    DIRS.append('%s/archive-shard-%d/segments' % (ROOT, len(DIRS)))
if os.environ.get('PHASE12_EXTRACT_SEGMENT_DIRS'):
    DIRS = os.environ['PHASE12_EXTRACT_SEGMENT_DIRS'].split(':')
frm, to, release, variant = sys.argv[1:5]
assert variant in ('short_deck', 'pineapple', 'flh', 'flo8') and len(release) == 40
ISO = re.compile(r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$')
def ms(iso):
    # Date.parse for these forms: UTC epoch milliseconds, the fraction
    # truncated (never rounded) to milliseconds, the offset applied.
    m = ISO.match(iso)
    if not m:
        sys.exit('window bound is not an ISO-8601 time with an offset: %r' % iso)
    y, mo, d, h, mi, sec, frac, zone = m.groups()
    y, mo, d, h, mi, sec = int(y), int(mo), int(d), int(h), int(mi), int(sec or 0)
    if not (1 <= mo <= 12 and 1 <= d <= calendar.monthrange(y, mo)[1] and h <= 23 and mi <= 59 and sec <= 59):
        sys.exit('window bound is not a valid time: %r' % iso)
    offset = 0
    if zone != 'Z':
        oh, om = int(zone[1:3]), int(zone[4:6])
        if oh > 23 or om > 59:
            sys.exit('window bound offset is not valid: %r' % iso)
        offset = (oh * 60 + om) * 60000 * (1 if zone[0] == '+' else -1)
    millis = int(((frac or '') + '000')[:3])
    return calendar.timegm((y, mo, d, h, mi, sec, 0, 0, 0)) * 1000 + millis - offset
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
            kind = r.get('kind')
            if kind not in ('decision', 'discard_decision'): continue
            body = json.loads(r['body'])
            s = body.get('snapshot') or {}
            if kind == 'discard_decision':
                # A discard snapshot is a DECIDE_DISCARD request: its variant is
                # top level and its time is the request's own (or the record's).
                ctx = s.get('journalContext') or {}
                at = ctx.get('requestedAtMs', r.get('atMs'))
                if isinstance(at, int) and FROM <= at < TO and s.get('gameVariant') == variant:
                    summary['excluded_discard_decision'] += 1
                continue
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
                              'receipt': (body.get('decision') or {}).get('remainingVariantPolicy')},
                             separators=(',', ':')))
print(json.dumps(dict(summary), sort_keys=True), file=sys.stderr)
